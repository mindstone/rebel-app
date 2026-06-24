import { describe, expect, it } from 'vitest';
import {
  evaluateProviderReadinessRule,
  isProviderReadinessEligibleAutomation,
  summarizeProviderReadinessBlocks,
  type ProviderReadinessDecision,
} from '../automationRules';
import type { AutomationAdmissionBlock } from '@shared/types';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';

function makeBlockedReason(
  code: AutomationAdmissionBlock['code'],
): Extract<ProviderReadinessDecision, { status: 'blocked' }> {
  return {
    status: 'blocked',
    reason: {
      source: 'provider-readiness',
      code,
      errorKind: 'connection-not-configured',
      headlineClass: 'auth',
      provider:
        code === 'codex_disconnected'
          ? 'codex'
          : code === 'openrouter_disconnected'
            ? 'openrouter'
            : 'anthropic',
      message: 'blocked',
    },
  };
}

describe('evaluateProviderReadinessRule', () => {
  it('blocks codex disconnected with a cause-coded reason', () => {
    const credentialState: ProviderCredentialState = { kind: 'codex', status: 'disconnected' };

    const result = evaluateProviderReadinessRule({ credentialState });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'codex_disconnected',
        errorKind: 'connection-not-configured',
        headlineClass: 'auth',
        provider: 'codex',
        message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      },
    });
  });

  it('blocks anthropic missing key with admission-compatible copy', () => {
    const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'missing' };

    const result = evaluateProviderReadinessRule({ credentialState });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'anthropic_missing_api_key',
        errorKind: 'connection-not-configured',
        headlineClass: 'auth',
        provider: 'anthropic',
        message: 'Authentication is missing. Please add an API key in Settings.',
      },
    });
  });

  it('returns ready for valid local provider state', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'local',
      status: 'valid',
      profile: {
        id: 'local-profile',
        name: 'Local',
        provider: 'mindstone-local',
        model: 'gpt-4.1-mini',
      } as any,
    };

    expect(evaluateProviderReadinessRule({ credentialState })).toEqual({ status: 'ready' });
  });
});

describe('summarizeProviderReadinessBlocks', () => {
  it('returns ready summary when readiness is ready', () => {
    const summary = summarizeProviderReadinessBlocks({
      readiness: { status: 'ready' },
      runs: [],
      definitions: [],
    });

    expect(summary).toEqual({
      readiness: 'ready',
      affectedAutomationCount: 0,
      affectedAutomationIds: [],
      blockedRunCount: 0,
      sinceMs: null,
      cause: null,
    });
  });

  it('reports affected automations even before any blocked run exists', () => {
    const blockedReason = makeBlockedReason('anthropic_missing_api_key');

    const summary = summarizeProviderReadinessBlocks({
      readiness: blockedReason,
      definitions: [
        { id: 'scheduled-llm', enabled: true, schedule: { type: 'daily' }, executor: 'llm' },
        { id: 'event-llm', enabled: true, schedule: { type: 'event' }, executor: 'llm' },
        { id: 'scheduled-script', enabled: true, schedule: { type: 'daily' }, executor: 'script' },
        { id: 'disabled-llm', enabled: false, schedule: { type: 'daily' }, executor: 'llm' },
      ],
      runs: [],
    });

    expect(summary.readiness).toBe('blocked');
    expect(summary.affectedAutomationCount).toBe(1);
    expect(summary.affectedAutomationIds).toEqual(['scheduled-llm']);
    expect(summary.blockedRunCount).toBe(0);
    expect(summary.sinceMs).toBeNull();
    expect(summary.cause?.code).toBe('anthropic_missing_api_key');
  });

  it('separates affected automation count from historical blocked-run footprint', () => {
    const blockedReason = makeBlockedReason('anthropic_missing_api_key');

    const summary = summarizeProviderReadinessBlocks({
      readiness: blockedReason,
      definitions: [
        { id: 'a', enabled: true, schedule: { type: 'daily' }, executor: 'llm' },
        { id: 'b', enabled: true, schedule: { type: 'daily' }, executor: undefined },
        { id: 'c', enabled: false, schedule: { type: 'daily' }, executor: 'llm' },
      ],
      runs: [
        {
          automationId: 'a',
          startedAt: 1_000,
          completedAt: 1_050,
          admissionBlock: blockedReason.reason,
        },
        {
          automationId: 'a',
          startedAt: 2_000,
          completedAt: 2_050,
        },
        {
          automationId: 'b',
          startedAt: 3_000,
          completedAt: 3_050,
          admissionBlock: blockedReason.reason,
        },
        {
          automationId: 'c',
          startedAt: 4_000,
          completedAt: 4_050,
          admissionBlock: blockedReason.reason,
        },
      ],
    });

    expect(summary.readiness).toBe('blocked');
    expect(summary.affectedAutomationCount).toBe(2);
    expect(summary.affectedAutomationIds).toEqual(['a', 'b']);
    expect(summary.blockedRunCount).toBe(2);
    expect(summary.sinceMs).toBe(1_050);
    expect(summary.cause?.code).toBe('anthropic_missing_api_key');
  });
});

// ---------------------------------------------------------------------------
// evaluateProviderReadinessRule — rejection gate (new behaviour, F2)
//
// Post-F2: the rejection gate fires ONLY when activeCredentialSource is
// provided AND it belongs to the current provider kind AND it appears in
// rejectedCredentials. If activeCredentialSource is absent, the gate does
// NOT fire (safe default — Stage 3 will supply it from credential resolution).
// ---------------------------------------------------------------------------

describe('evaluateProviderReadinessRule — credential rejection', () => {
  it('blocks anthropic with anthropic_auth_rejected when the active api key is rejected', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-anth-key',
    };
    const rejectedCredentials = new Set(['anthropic-api-key'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-api-key',
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'anthropic_auth_rejected',
        errorKind: 'auth',
        headlineClass: 'auth',
        provider: 'anthropic',
        message: 'Your Anthropic API key is being rejected. Check your key in Settings.',
      },
    });
  });

  it('blocks anthropic with anthropic_auth_rejected when the active oauth token is rejected', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'oauth-derived',
    };
    const rejectedCredentials = new Set(['anthropic-oauth-token'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-oauth-token',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason.code).toBe('anthropic_auth_rejected');
      expect(result.reason.errorKind).toBe('auth');
    }
  });

  it('blocks openrouter with openrouter_auth_rejected when the active oauth token is rejected', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'openrouter',
      status: 'valid',
      oauthToken: 'or-token',
    };
    const rejectedCredentials = new Set(['openrouter-oauth-token'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'openrouter-oauth-token',
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'openrouter_auth_rejected',
        errorKind: 'auth',
        headlineClass: 'auth',
        provider: 'openrouter',
        message: 'Your OpenRouter connection is being rejected. Reconnect it in Settings.',
      },
    });
  });

  it('blocks codex with codex_auth_rejected when the active subscription is rejected', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'codex',
      status: 'connected',
      profile: null,
    };
    const rejectedCredentials = new Set(['codex-subscription'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'codex-subscription',
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'codex_auth_rejected',
        errorKind: 'auth',
        headlineClass: 'auth',
        provider: 'codex',
        message: 'Your ChatGPT Pro connection is being rejected. Reconnect it in Settings.',
      },
    });
  });

  // ------------------------------------------------------------------
  // F2: activeCredentialSource absent → gate does NOT fire (safe default)
  // ------------------------------------------------------------------

  it('returns ready when activeCredentialSource is absent, even if rejectedCredentials is populated', () => {
    // Stage 3 will supply activeCredentialSource; until then the gate stays open.
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-anth-key',
    };
    const rejectedCredentials = new Set(['anthropic-api-key'] as const);

    // No activeCredentialSource → gate must not fire.
    const result = evaluateProviderReadinessRule({ credentialState, rejectedCredentials });
    expect(result.status).toBe('ready');
  });

  it('returns ready when rejectedCredentials is absent (backwards-compatible no-arg call)', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-anth-key',
    };

    const result = evaluateProviderReadinessRule({ credentialState });
    expect(result.status).toBe('ready');
  });

  it('returns ready when rejectedCredentials is an empty set', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'openrouter',
      status: 'valid',
      oauthToken: 'tok',
    };

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials: new Set(),
      activeCredentialSource: 'openrouter-oauth-token',
    });
    expect(result.status).toBe('ready');
  });

  // ------------------------------------------------------------------
  // F2: cross-source isolation — a rejected credential source for the
  // SAME provider kind must NOT block a DIFFERENT active source
  // ------------------------------------------------------------------

  it('does NOT block anthropic when only the OAuth token is rejected but API key is active', () => {
    // Critical Anthropic case: two credential sources exist for the same
    // provider kind. A stale rejected OAuth token must not block an active
    // API-key credential.
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-live-key',
    };
    // OAuth token is rejected — but the active source is the API key.
    const rejectedCredentials = new Set(['anthropic-oauth-token'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-api-key', // active = API key, not OAuth
    });

    expect(result.status).toBe('ready');
  });

  it('does NOT block anthropic when only the API key is rejected but OAuth token is active', () => {
    // Inverse case: a rejected API key must not block an active OAuth token.
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'oauth-derived',
    };
    const rejectedCredentials = new Set(['anthropic-api-key'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-oauth-token', // active = OAuth
    });

    expect(result.status).toBe('ready');
  });

  it('does NOT block anthropic when a different provider kind credential is rejected', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-anth-key',
    };
    // openrouter is rejected — but active provider is anthropic (different kind)
    const rejectedCredentials = new Set(['openrouter-oauth-token'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-api-key',
    });
    expect(result.status).toBe('ready');
  });

  it('DOES block on exact-source match: active API key, API key rejected', () => {
    // Confirms the gate fires when active source and rejected source are identical.
    const credentialState: ProviderCredentialState = {
      kind: 'anthropic',
      status: 'valid',
      apiKey: 'fake-bad-key',
    };
    const rejectedCredentials = new Set(['anthropic-api-key'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-api-key', // exact match
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason.code).toBe('anthropic_auth_rejected');
    }
  });

  // ------------------------------------------------------------------
  // Precedence: missing/disconnected MUST take priority over rejected
  // ------------------------------------------------------------------

  it('returns missing block (not rejected block) when credential is missing AND in rejected set', () => {
    // A missing key cannot be "rejected" by the API — the missing state is
    // more actionable. Ensure the precedence rule holds.
    const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'missing' };
    const rejectedCredentials = new Set(['anthropic-api-key'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'anthropic-api-key',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason.code).toBe('anthropic_missing_api_key');
      expect(result.reason.errorKind).toBe('connection-not-configured');
    }
  });

  it('returns disconnected block (not rejected block) for codex disconnected + rejected', () => {
    const credentialState: ProviderCredentialState = { kind: 'codex', status: 'disconnected' };
    const rejectedCredentials = new Set(['codex-subscription'] as const);

    const result = evaluateProviderReadinessRule({
      credentialState,
      rejectedCredentials,
      activeCredentialSource: 'codex-subscription',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason.code).toBe('codex_disconnected');
      expect(result.reason.errorKind).toBe('connection-not-configured');
    }
  });

  it('rejected ≠ missing: rejection only fires when credential IS configured AND activeCredentialSource matches', () => {
    // Sanity: confirmed by the precedence tests above, but state it explicitly.
    const missingResult = evaluateProviderReadinessRule({
      credentialState: { kind: 'anthropic', status: 'missing' },
      rejectedCredentials: new Set(['anthropic-api-key'] as const),
      activeCredentialSource: 'anthropic-api-key',
    });
    const rejectedResult = evaluateProviderReadinessRule({
      credentialState: { kind: 'anthropic', status: 'valid', apiKey: 'fake-anth-key' },
      rejectedCredentials: new Set(['anthropic-api-key'] as const),
      activeCredentialSource: 'anthropic-api-key',
    });

    expect(missingResult.status).toBe('blocked');
    expect(rejectedResult.status).toBe('blocked');
    if (missingResult.status === 'blocked' && rejectedResult.status === 'blocked') {
      expect(missingResult.reason.code).not.toBe(rejectedResult.reason.code);
      expect(missingResult.reason.code).toBe('anthropic_missing_api_key');
      expect(rejectedResult.reason.code).toBe('anthropic_auth_rejected');
    }
  });
});

describe('isProviderReadinessEligibleAutomation', () => {
  it('includes enabled scheduled llm definitions', () => {
    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'daily' },
        executor: 'llm',
      }),
    ).toBe(true);
  });

  it('excludes script and event definitions', () => {
    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'daily' },
        executor: 'script',
      }),
    ).toBe(false);

    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'event' },
        executor: 'llm',
      }),
    ).toBe(false);
  });
});
