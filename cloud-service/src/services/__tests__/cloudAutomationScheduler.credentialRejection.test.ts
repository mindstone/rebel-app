/**
 * Stage 3b — cloud credential-rejection circuit-breaker tests.
 *
 * Mirrors src/main/services/__tests__/automationScheduler.credentialRejection.test.ts
 * for the cloud surface (CloudAutomationScheduler). Covers:
 *
 * - After REJECTED_CONSECUTIVE_THRESHOLD scheduled auth failures, the next scheduled
 *   spawn is BLOCKED with *_auth_rejected (provider_not_ready), no executeAgentTurn call.
 * - A successful turn (via recordSuccess on the core tracker) clears the circuit breaker.
 * - Manual runs are not blocked (cloud has no manual trigger but model-override fail-open
 *   is tested as a proxy for the F2 bypass path).
 * - Model-override automations fail OPEN (rejection check skipped).
 * - Exact-source isolation: a rejected OAuth token does not block an active API key.
 *
 * The cloud scheduler always uses trigger 'schedule' internally (no catch-up or manual).
 * recordSuccess is exercised via the shared credentialRejectionTracker singleton.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, AutomationDefinition, AutomationRun } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  REJECTED_CONSECUTIVE_THRESHOLD,
} from '@core/services/credentialRejectionTracker';

// ---------------------------------------------------------------------------
// credentialRejectionTracker: control via the real singleton but reset it
// between tests by calling clear() on all known sources + direct manipulation.
// We import the real tracker and spy on it — no proxy needed since both the
// test and the scheduler module share the SAME singleton instance.
// ---------------------------------------------------------------------------

// Import and expose the tracker for per-test state inspection.
import { credentialRejectionTracker } from '@core/services/credentialRejectionTracker';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../cloudAutomationPrompt', () => ({
  readAutomationPrompt: vi.fn().mockResolvedValue('Test automation prompt'),
}));

vi.mock('@shared/utils/automationScheduling', () => ({
  calculateNextRunAt: vi.fn().mockReturnValue(null), // Prevent automatic scheduling
}));

// Import CloudAutomationScheduler at module level so it's resolved before fake
// timers are enabled, avoiding dynamic-import timing issues under vi.useFakeTimers().
import { CloudAutomationScheduler, type CloudAutomationSchedulerDeps } from '../cloudAutomationScheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicApiKeySettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    models: { apiKey: 'test-api-key-1234' },
  } as unknown as AppSettings;
}

function makeAnthropicOAuthSettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    models: { authMethod: 'oauth-token', oauthToken: 'test-oauth-token', apiKey: '' },
  } as unknown as AppSettings;
}

function createOnceDefinition(
  id: string,
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id,
    name: `Cloud Automation ${id}`,
    filePath: `/tmp/${id}.md`,
    schedule: AutomationSchedule.once({ dateTime: new Date(Date.now() - 60_000).toISOString() }),
    enabled: true,
    executeIn: 'cloud',
    timezone: 'UTC',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface SchedulerContext {
  scheduler: CloudAutomationScheduler;
  executeAgentTurn: ReturnType<typeof vi.fn>;
  recordRun: ReturnType<typeof vi.fn>;
  triggerExecution: (definition: AutomationDefinition) => Promise<void>;
}

/**
 * Creates a CloudAutomationScheduler wired to emit an auth error event from
 * executeAgentTurn, simulating a failed turn with a specific credentialSource.
 */
function createSchedulerWithAuthError(opts: {
  credentialState: ProviderCredentialState | null;
  credentialSource?: string;
  errorKind?: string;
  failure?: boolean;
  settings?: AppSettings | null;
  modelOverride?: string;
  definition?: AutomationDefinition;
}): SchedulerContext {
  const {
    credentialState,
    credentialSource = 'anthropic-api-key',
    errorKind = 'auth',
    failure = true,
    settings = makeAnthropicApiKeySettings(),
    modelOverride,
  } = opts;

  const executeAgentTurn = vi.fn().mockImplementation(
    async (
      _turnId: string,
      _prompt: string,
      options: { onEvent: (event: AgentEvent) => void },
    ) => {
      if (failure) {
        options.onEvent({
          type: 'error',
          error: 'Invalid API key',
          errorKind,
          credentialSource,
          headlineClass: 'auth',
          timestamp: Date.now(),
          seq: 1,
        } as AgentEvent);
        // Throw after emitting the error event — mirrors the real turn pipeline
        // which dispatches the error event then re-throws, causing the catch block
        // to set status = 'failure'. The scheduler also sets status = 'failure' when
        // it receives an error event (defensive, handles non-throw paths too).
        throw new Error('Invalid API key');
      } else {
        options.onEvent({
          type: 'result',
          result: 'done',
          timestamp: Date.now(),
          seq: 1,
          sessionId: null,
          toolMetrics: { totalToolCalls: 0, failedToolCalls: 0 },
        } as unknown as AgentEvent);
      }
    },
  );

  const recordRun = vi.fn();
  const updateDefinitionNextRunAt = vi.fn();

  // Mutable definitions list so we can provide the active definition to the scheduler's
  // internal re-read check (executeDefinition re-reads getDefinitions() to confirm the
  // automation is still cloud-selected and enabled before proceeding).
  let activeDefinitions: AutomationDefinition[] = opts.definition ? [opts.definition] : [];

  const scheduler = new CloudAutomationScheduler({
    getDefinitions: () => activeDefinitions,
    getProviderCredentialState: credentialState ? () => credentialState : undefined,
    getSettings: settings ? () => settings : undefined,
    executeAgentTurn,
    store: {
      recordRun,
      updateDefinitionNextRunAt,
    } as unknown as CloudAutomationSchedulerDeps['store'],
  });

  // Access private executeDefinition via cast for direct invocation in tests.
  const triggerExecution = async (definition: AutomationDefinition): Promise<void> => {
    // Ensure the definition appears in the scheduler's lookup on each call.
    const effectiveDef = { ...definition, ...(modelOverride ? { model: modelOverride } : {}) };
    activeDefinitions = [effectiveDef];
    return (scheduler as unknown as {
      executeDefinition: (def: AutomationDefinition) => Promise<void>
    }).executeDefinition(effectiveDef);
  };

  return { scheduler, executeAgentTurn, recordRun, triggerExecution };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// All known credential sources — cleared between tests to prevent state bleed.
const ALL_TEST_SOURCES = [
  'anthropic-api-key',
  'anthropic-oauth-token',
  'openrouter-oauth-token',
  'codex-subscription',
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-15T08:00:00.000Z'));
  vi.clearAllMocks();

  // Reset the real singleton tracker by clearing all known sources.
  for (const source of ALL_TEST_SOURCES) {
    credentialRejectionTracker.clear(source);
  }

  vi.spyOn(apiRateLimitCooldown, 'isAvailable').mockReturnValue(true);
  vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(0);
  vi.spyOn(agentTurnRegistry, 'hasInteractiveTurn').mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudAutomationScheduler — credential-rejection circuit-breaker (Stage 3b)', () => {
  // -------------------------------------------------------------------------
  // Core: auth failure recording → spawn blocking
  // -------------------------------------------------------------------------
  describe('scheduled auth failures trip the circuit breaker', () => {
    it(`blocks the next scheduled spawn after ${REJECTED_CONSECUTIVE_THRESHOLD} auth failures`, async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-auth-reject-test');
      const { executeAgentTurn, recordRun, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        settings: makeAnthropicApiKeySettings(),
      });

      // Run THRESHOLD times — trips the circuit breaker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await triggerExecution(definition);
      }

      // Confirm the circuit breaker tripped.
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(true);

      // Next spawn must be BLOCKED — no executeAgentTurn call.
      executeAgentTurn.mockClear();
      recordRun.mockClear();
      await triggerExecution(definition);

      expect(executeAgentTurn).not.toHaveBeenCalled();
      const blockedRun = recordRun.mock.calls[0]?.[0] as AutomationRun | undefined;
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(blockedRun?.errorKind).toBe('auth');
      expect(blockedRun?.admissionBlock?.code).toBe('anthropic_auth_rejected');
    });

    it('does not block when only one auth failure has been recorded (below threshold)', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-one-failure');
      const { executeAgentTurn, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        settings: makeAnthropicApiKeySettings(),
      });

      // Only one failure — below threshold.
      await triggerExecution(definition);
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(false);

      // Next spawn must proceed.
      executeAgentTurn.mockClear();
      await triggerExecution(definition);
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Success clears the circuit breaker
  // -------------------------------------------------------------------------
  describe('success clears the circuit breaker', () => {
    it('a successful turn clears the rejection and unblocks the next spawn', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-success-reset');

      // Trip the tracker directly (bypassing the scheduler's auth-failure recording).
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(true);

      // Now create a success scheduler and run — should clear via recordSuccess in
      // agentTurnExecute (which fires the tracker's recordSuccess). We simulate this
      // directly via the tracker since we don't have the full pipeline here.
      credentialRejectionTracker.recordSuccess('anthropic-api-key');
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(false);

      const { executeAgentTurn, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: false,
        settings: makeAnthropicApiKeySettings(),
      });

      // Spawn must proceed.
      await triggerExecution(definition);
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Model-override automations fail OPEN (F2 safety)
  // -------------------------------------------------------------------------
  describe('model-override automations fail OPEN', () => {
    it('does not block a model-override automation even when the active credential is rejected', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-model-override');

      // Trip the tracker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(true);

      // Automation with a model override — should NOT be blocked by rejection gate.
      const { executeAgentTurn, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        settings: makeAnthropicApiKeySettings(),
        modelOverride: 'gpt-4o-mini',
      });

      await triggerExecution(definition);
      // executeAgentTurn is called (not blocked) — the run still fails with auth, but the
      // pre-spawn gate did not suppress it.
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Exact-source isolation: rejected OAuth does not block API key
  // -------------------------------------------------------------------------
  describe('exact-source isolation', () => {
    it('a rejected OAuth token does not block when the active credential is an API key', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-exact-source');

      // Trip the tracker for OAuth.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-oauth-token');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-oauth-token')).toBe(true);

      // Active credential is API key (settings has apiKey, not oauth).
      const { executeAgentTurn, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: false,
        settings: makeAnthropicApiKeySettings(),
      });

      // The API-key spawn must proceed — rejected OAuth must not block it.
      await triggerExecution(definition);
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    });

    it('(rule-level unit test) exact-source gate: rejected API key does not block when deriveActiveCredentialSource resolves OAuth', async () => {
      // NOTE: This is a RULE-LEVEL unit test, not an end-to-end OAuth-only scenario.
      //
      // The credentialState is constructed directly ({kind:'anthropic', status:'valid', apiKey:...})
      // rather than derived from makeAnthropicOAuthSettings() via validateProviderCredentials.
      // This is intentional: validateProviderCredentials has a PRE-EXISTING limitation where
      // it does NOT recognize Anthropic OAuth-only credentials — it only checks `models.apiKey`
      // and returns status:'missing' when no API key is present, even when authMethod='oauth-token'.
      //
      // PRE-EXISTING FOLLOW-UP (tracked): validateProviderCredentials should be updated to
      // recognize Anthropic OAuth-only credentials (return status:'valid' when authMethod==='oauth-token'
      // and a token is present, even without an apiKey). Until then, OAuth-only Anthropic users
      // would be blocked by the 'missing API key' gate before the rejection check fires.
      //
      // What THIS test validates: the rejection gate's exact-source matching logic in
      // evaluateProviderReadinessRule — given a valid credentialState where the settings
      // resolve to 'anthropic-oauth-token' as the active source, a rejected 'anthropic-api-key'
      // does NOT block the spawn. This exercises the PROVIDER_KIND_CREDENTIAL_SOURCES guard
      // and deriveActiveCredentialSource independently of validateProviderCredentials.
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-exact-source-oauth');

      // Trip the tracker for API key.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(true);

      // Settings declare OAuth as the auth method: deriveActiveCredentialSource will
      // resolve to 'anthropic-oauth-token', which does NOT match the rejected 'anthropic-api-key'.
      const { executeAgentTurn, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: false,
        settings: makeAnthropicOAuthSettings(),
      });

      // The spawn must proceed — rejected API key must not block when OAuth is the active source.
      await triggerExecution(definition);
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Non-auth errors do not trip the circuit breaker
  // -------------------------------------------------------------------------
  describe('non-auth errors do not trip the circuit breaker', () => {
    it('rate-limit errors do not increment the rejection counter', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'valid', apiKey: 'test-api-key-1234' };
      const definition = createOnceDefinition('cloud-rate-limit');
      const { triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: true,
        errorKind: 'rate-limit',
        credentialSource: 'anthropic-api-key',
        settings: makeAnthropicApiKeySettings(),
      });

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD + 2; i++) {
        await triggerExecution(definition);
      }

      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Missing/disconnected gate is unchanged
  // -------------------------------------------------------------------------
  describe('missing/disconnected credential still blocks (pre-existing behaviour)', () => {
    it('blocks when Anthropic API key is missing regardless of rejection state', async () => {
      const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'missing' };
      const definition = createOnceDefinition('cloud-missing-key');
      const { executeAgentTurn, recordRun, triggerExecution } = createSchedulerWithAuthError({
        credentialState,
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        settings: makeAnthropicApiKeySettings(),
      });

      await triggerExecution(definition);

      expect(executeAgentTurn).not.toHaveBeenCalled();
      const blocked = recordRun.mock.calls[0]?.[0] as AutomationRun | undefined;
      expect(blocked?.status).toBe('provider_not_ready');
      expect(blocked?.admissionBlock?.code).toBe('anthropic_missing_api_key');
    });
  });
});
