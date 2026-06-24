/**
 * Stage 3a — credential-rejection circuit-breaker tests.
 *
 * Covers:
 * - After 2 scheduled auth failures for a credentialSource, the next scheduled
 *   spawn is BLOCKED with a *_auth_rejected provider_not_ready run (no session spawned).
 * - A successful turn (recordSuccess) clears the circuit breaker and unblocks the
 *   next scheduled spawn.
 * - clear() on credential change resets; manual 'Run now' is neither counted nor blocked.
 * - Exact-source isolation: a rejected OAuth token does not block an active API key.
 * - event-triggered runs are not counted and not blocked.
 *
 * Implementation under test:
 * - src/main/services/automationScheduler.ts (persistRun, executeAutomation gate)
 * - src/core/services/credentialRejectionTracker.ts (singleton, cleared via import)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AppSettings } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import {
  CredentialRejectionTracker,
  REJECTED_CONSECUTIVE_THRESHOLD,
} from '@core/services/credentialRejectionTracker';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUpdateSession = vi.fn();

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getSecurityDenials: vi.fn().mockReturnValue([]),
    clearSecurityDenials: vi.fn(),
    hasInteractiveTurn: vi.fn().mockReturnValue(false),
    getRendererSession: vi.fn().mockReturnValue(null),
    getTurnCategory: vi.fn().mockReturnValue('automation'),
    setTurnCategory: vi.fn(),
    getEventListener: vi.fn().mockReturnValue(null),
    deleteEventListener: vi.fn(),
    getOrCreateAccumulator: vi.fn().mockImplementation(() => ({
      appendEvent: vi.fn((event: unknown) => event),
      stampSeq: vi.fn((event: unknown) => event),
      getConversationShape: vi.fn().mockReturnValue({ messages: [], eventsByTurn: {} }),
    })),
    clearToolCalls: vi.fn(),
  },
}));

vi.mock('../shutdownState', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
  dispatchAgentErrorEvent: vi.fn(),
  sanitizeEventForMainAccumulation: (event: unknown) => event,
  showAutomationOutcomeNotification: vi.fn(),
  broadcastSequencedAgentEvent: vi.fn(),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({ updateSession: mockUpdateSession }),
}));

// ---------------------------------------------------------------------------
// credentialRejectionTracker: inject a fresh instance per test so the
// module-level singleton doesn't bleed between tests. We swap the singleton
// reference via a shared mutable tracker kept in the mock module.
// ---------------------------------------------------------------------------

let _testTracker: CredentialRejectionTracker = new CredentialRejectionTracker();

vi.mock('@core/services/credentialRejectionTracker', async () => {
  const actual = await vi.importActual<typeof import('@core/services/credentialRejectionTracker')>(
    '@core/services/credentialRejectionTracker',
  );
  return {
    ...actual,
    // Delegate to the test-local tracker so tests can control state.
    credentialRejectionTracker: new Proxy(
      {} as InstanceType<typeof actual.CredentialRejectionTracker>,
      {
        get(_target, prop) {
          return (...args: unknown[]) =>
            (_testTracker as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string]?.(...args);
        },
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// getOAuthToken mock — controls anthropic-oauth-token detection
// ---------------------------------------------------------------------------

let _mockOAuthToken: string | null = null;

vi.mock('@core/rebelCore/settingsAccessors', async () => {
  const actual = await vi.importActual<typeof import('@core/rebelCore/settingsAccessors')>(
    '@core/rebelCore/settingsAccessors',
  );
  return {
    ...actual,
    getOAuthToken: (_settings: unknown) => _mockOAuthToken,
  };
});

// ---------------------------------------------------------------------------
// Loader helpers
// ---------------------------------------------------------------------------

async function loadScheduler() {
  vi.resetModules();
  await initTestPlatformConfig();
  const { setSchedulerFactory } = await import('@core/scheduler');
  setSchedulerFactory(() => ({
    registerTimeout: (callback: () => void, delayMs: number) =>
      setTimeout(callback, Math.max(0, delayMs)),
    registerInterval: (callback: () => void, intervalMs: number) =>
      setInterval(callback, Math.max(0, intervalMs)),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    now: () => Date.now(),
    sleep: async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
    isVisible: () => true,
    deferUntilVisible: async () => 'visible' as const,
  }));
  const module = await import('../automationScheduler');
  return module.AutomationScheduler;
}

type SchedulerCtor = Awaited<ReturnType<typeof loadScheduler>>;
type SchedulerInstance = InstanceType<SchedulerCtor>;

/**
 * Create a scheduler whose executeAgentTurn fires a synthetic `error` event
 * with the given errorKind + credentialSource, then resolves (simulating a
 * failed automation run pipeline).
 */
function createSchedulerWithAuthError(
  Scheduler: SchedulerCtor,
  opts: {
    activeProvider?: AppSettings['activeProvider'];
    credentialSource?: string;
    errorKind?: string;
    /** If undefined, executeAgentTurn resolves cleanly (success run). */
    failure?: boolean;
  } = {},
): { scheduler: SchedulerInstance; executeAgentTurn: ReturnType<typeof vi.fn> } {
  const {
    activeProvider = 'anthropic',
    credentialSource = 'anthropic-api-key',
    errorKind = 'auth',
    failure = true,
  } = opts;

  const executeAgentTurn = vi.fn().mockImplementation(
    async (
      _turnId: string,
      _prompt: string,
      options: { onEvent: (event: unknown) => void },
    ) => {
      if (failure) {
        // Fire an auth error event so the pipeline classifies the run as failure/auth.
        options.onEvent({
          type: 'error',
          error: 'Invalid API key',
          errorKind,
          credentialSource,
          headlineClass: 'auth',
          timestamp: Date.now(),
          seq: 1,
        });
      } else {
        // Emit a success result event so the pipeline classifies the run as successful.
        options.onEvent({
          type: 'result',
          result: 'done',
          timestamp: Date.now(),
          seq: 1,
          sessionId: null,
          toolMetrics: { totalToolCalls: 0, failedToolCalls: 0 },
        });
      }
    },
  );

  const scheduler = new Scheduler({
    getCoreDirectory: () => '/tmp/test',
    executeAgentTurn,
    notifyRenderer: vi.fn(),
    getSettings: () =>
      ({
        onboardingCompleted: true,
        activeProvider,
        // getApiKey() reads settings.models.apiKey, not the top-level field.
        models: activeProvider === 'anthropic' ? { apiKey: 'fake-anth-key' } : {},
        openRouterApiKey: '',
        codexApiKey: '',
        openRouter:
          activeProvider === 'openrouter'
            ? { models: [], activeAlias: '', enabled: true, oauthToken: 'or-test-token' }
            : { models: [], activeAlias: '' },
      } as unknown as AppSettings),
  });

  return { scheduler, executeAgentTurn };
}

function mockResolvedAutomationFile(scheduler: SchedulerInstance): void {
  const internals = scheduler as unknown as {
    resolveAutomationFile: () => Promise<{ resolved: string; root: string; fileContent: string }>;
  };
  vi.spyOn(internals, 'resolveAutomationFile').mockResolvedValue({
    resolved: '/tmp/test/automation.md',
    root: '/tmp/test',
    fileContent: '# Test\n\nRun something.',
  });
}

function addDailyAutomation(scheduler: SchedulerInstance) {
  return scheduler.upsertDefinition({
    name: 'Daily Triage',
    filePath: '/test/automation.md',
    schedule: AutomationSchedule.daily({ time: '09:00' }),
    enabled: true,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _testTracker = new CredentialRejectionTracker();
  _mockOAuthToken = null;
  mockUpdateSession.mockImplementation(async (
    _sessionId: string,
    mutator: (existing: unknown) => unknown,
  ) => {
    mutator(null);
    return true;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutomationScheduler — credential-rejection circuit-breaker (Stage 3a)', () => {
  // -------------------------------------------------------------------------
  // Core: auth failure recording → spawn blocking
  // -------------------------------------------------------------------------
  describe('scheduled auth failures trip the circuit breaker', () => {
    it(`blocks the next scheduled spawn after ${REJECTED_CONSECUTIVE_THRESHOLD} scheduled auth failures`, async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Run THRESHOLD times as scheduled — trips the circuit breaker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        const run = await scheduler.runNow(def.id, 'schedule');
        expect(run?.status).toBe('failure');
        expect(run?.errorKind).toBe('auth');
      }

      // Confirm the circuit breaker tripped.
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // Next scheduled spawn must be BLOCKED — no session spawned.
      executeAgentTurn.mockClear();
      const blockedRun = await scheduler.runNow(def.id, 'schedule');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(blockedRun?.admissionBlock?.code).toBe('anthropic_auth_rejected');
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });

    it('blocks catch-up triggers as well as schedule triggers', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip via catch-up runs.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(def.id, 'catch-up');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      executeAgentTurn.mockClear();
      const blockedRun = await scheduler.runNow(def.id, 'catch-up');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Manual 'Run now' must NOT count or block
  // -------------------------------------------------------------------------
  describe('manual runs are not counted and not blocked', () => {
    it('does not record manual run failures in the rejection tracker', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Many manual failures — must NOT trip the circuit breaker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD + 2; i++) {
        await scheduler.runNow(def.id, 'manual');
      }

      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);
    });

    it('does not block a manual run even when the tracker is tripped', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip via scheduled runs.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(def.id, 'schedule');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // Manual run must still proceed.
      executeAgentTurn.mockClear();
      const manualRun = await scheduler.runNow(def.id, 'manual');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(manualRun?.status).toBe('failure'); // still fails, but not blocked
    });
  });

  // -------------------------------------------------------------------------
  // event-triggered runs are not counted and not blocked
  // -------------------------------------------------------------------------
  describe('event-triggered runs are not counted and not blocked', () => {
    it('does not record event-triggered failures in the rejection tracker', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = scheduler.upsertDefinition({
        name: 'Event Automation',
        filePath: '/test/automation.md',
        schedule: AutomationSchedule.event({ eventType: 'transcript-ready' }),
        enabled: true,
      });

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD + 2; i++) {
        await scheduler.runNow(def.id, 'event');
      }

      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Success clears the circuit breaker
  // -------------------------------------------------------------------------
  describe('success clears the circuit breaker', () => {
    it('recordSuccess clears the rejection and unblocks the next scheduled spawn', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(def.id, 'schedule');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // Simulate a successful turn clearing the tracker (as agentTurnExecute does).
      _testTracker.recordSuccess('anthropic-api-key');
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);

      // Next scheduled spawn proceeds.
      executeAgentTurn.mockClear();
      const unlockedRun = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      // The run itself still fails (the mock still returns auth error), but it
      // was NOT blocked by the gate — it proceeded to the pipeline.
      expect(unlockedRun?.status).toBe('failure');
      expect(unlockedRun?.admissionBlock).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // clear() on credential change resets
  // -------------------------------------------------------------------------
  describe('clear() on credential change gives a clean slate', () => {
    it('clear(credentialSource) resets rejection state and allows next spawn', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(def.id, 'schedule');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // Simulate credential change clearing the tracker.
      _testTracker.clear('anthropic-api-key');
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);

      // Spawn should proceed.
      executeAgentTurn.mockClear();
      const run = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.admissionBlock).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Exact-source isolation: rejected OAuth token must NOT block active API key
  // -------------------------------------------------------------------------
  describe('exact-source isolation', () => {
    it('a rejected anthropic-oauth-token does not block an active anthropic-api-key', async () => {
      const Scheduler = await loadScheduler();
      // Scheduler uses API key (no OAuth token in settings).
      _mockOAuthToken = null;
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: false, // will run successfully
        credentialSource: 'anthropic-api-key',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Manually trip the tracker for the OAuth token (not the API key).
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('anthropic-oauth-token');
      }
      expect(_testTracker.isRejected('anthropic-oauth-token')).toBe(true);
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);

      // Scheduler's active source is 'anthropic-api-key' — gate must pass.
      const run = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      // Run should succeed (not blocked).
      expect(run?.status).not.toBe('provider_not_ready');
      expect(run?.admissionBlock).toBeUndefined();
    });

    it('a rejected codex-subscription does not block an active anthropic-api-key', async () => {
      const Scheduler = await loadScheduler();
      _mockOAuthToken = null;
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: false,
        credentialSource: 'anthropic-api-key',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip tracker for codex.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('codex-subscription');
      }
      expect(_testTracker.isRejected('codex-subscription')).toBe(true);

      const run = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.admissionBlock).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Non-auth failures must not trip the circuit breaker
  // -------------------------------------------------------------------------
  describe('non-auth failure kinds are not recorded', () => {
    it('rate_limit errors from scheduled runs do not trip the rejection tracker', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler } = createSchedulerWithAuthError(Scheduler, {
        failure: true,
        errorKind: 'rate_limit',
        credentialSource: 'anthropic-api-key',
        activeProvider: 'anthropic',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD + 2; i++) {
        await scheduler.runNow(def.id, 'schedule');
      }

      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // F4(a): Dual-credential — API key and OAuth token BOTH present, router
  // precedence is API key wins; a rejected OAuth token must NOT block the
  // active API key credential (and vice versa).
  // -------------------------------------------------------------------------
  describe('F4(a): dual-credential — API-key wins over OAuth when both are present', () => {
    it('a rejected oauth-token does not block an active api-key when both are in settings', async () => {
      const Scheduler = await loadScheduler();
      // Settings have both an API key AND an OAuth token — router gives api-key priority.
      // classifyAnthropicSettingsCredential sees models.apiKey and returns 'anthropic-api-key'.
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: false, // run succeeds
        credentialSource: 'anthropic-api-key',
      });
      // Patch scheduler's getSettings to include BOTH credentials.
      // resolveModelSettings reads settings.models.*, so we override both.
      const internals = scheduler as unknown as {
        deps: { getSettings?: () => AppSettings };
      };
      const baseSettings = internals.deps.getSettings?.() ?? {} as AppSettings;
      internals.deps.getSettings = () => ({
        ...baseSettings,
        models: {
          apiKey: 'fake-anth-key',    // api-key is present → wins over oauth
          authMethod: 'oauth-token',
          oauthToken: 'oauth-tok',  // also present, but api-key takes precedence
        },
      } as unknown as AppSettings);

      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip the tracker for the OAuth token only.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('anthropic-oauth-token');
      }
      expect(_testTracker.isRejected('anthropic-oauth-token')).toBe(true);
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);

      // Spawn must proceed — the active source is api-key, not oauth-token.
      const run = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.admissionBlock).toBeUndefined();
      expect(run?.status).not.toBe('provider_not_ready');
    });

    it('deriveActiveCredentialSource returns api-key when api-key is present, even if oauth-token is also set', async () => {
      // F1 correctness: classifyAnthropicSettingsCredential (the router authority) returns
      // 'anthropic-api-key' when models.apiKey is set, regardless of authMethod/oauthToken.
      // This test verifies the dual-credential precedence via the scheduler's gate:
      // with BOTH credentials in settings, only the api-key rejection source matters.
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
      });

      // Patch settings to include both api-key AND oauth-token.
      const internals = scheduler as unknown as {
        deps: { getSettings?: () => AppSettings };
      };
      const baseSettings = internals.deps.getSettings?.() ?? {} as AppSettings;
      internals.deps.getSettings = () => ({
        ...baseSettings,
        models: {
          apiKey: 'fake-anth-key',    // api-key present → wins over oauth
          authMethod: 'oauth-token',
          oauthToken: 'oauth-tok',  // also present, but api-key takes precedence
        },
      } as unknown as AppSettings);

      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Trip via scheduled auth failures — credentialSource = 'anthropic-api-key' (from the error event).
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(def.id, 'schedule');
      }
      // api-key IS rejected; oauth-token is NOT.
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);
      expect(_testTracker.isRejected('anthropic-oauth-token')).toBe(false);

      // Next scheduled spawn: the active source is 'api-key' (router precedence),
      // which IS rejected → must be BLOCKED.
      executeAgentTurn.mockClear();
      const blockedRun = await scheduler.runNow(def.id, 'schedule');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(blockedRun?.admissionBlock?.code).toBe('anthropic_auth_rejected');
      expect(executeAgentTurn).not.toHaveBeenCalled();

      // Manually trip ONLY the oauth-token rejection and clear the api-key.
      _testTracker.clear('anthropic-api-key');
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('anthropic-oauth-token');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(false);
      expect(_testTracker.isRejected('anthropic-oauth-token')).toBe(true);

      // With api-key active (router precedence) and api-key NOT rejected,
      // the spawn must PROCEED even though oauth-token IS rejected.
      executeAgentTurn.mockClear();
      const run = await scheduler.runNow(def.id, 'schedule');
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.admissionBlock).toBeUndefined();
      expect(run?.status).not.toBe('provider_not_ready');
    });
  });

  // -------------------------------------------------------------------------
  // F4(b): A route-overriding automation (automation.model set) is NOT paused
  // by a globally-rejected default credential. The rejection check fails open
  // when a model override is present.
  // -------------------------------------------------------------------------
  describe('F4(b): route-overriding automation is not paused by a rejected global credential', () => {
    it('an automation with a model override runs even when the global active source is rejected', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: false, // succeeds for the override run
        credentialSource: 'anthropic-api-key',
      });
      mockResolvedAutomationFile(scheduler);

      // Add an automation WITH a model override (simulating a different provider's model).
      const defWithOverride = scheduler.upsertDefinition({
        name: 'Overridden Automation',
        filePath: '/test/automation.md',
        schedule: AutomationSchedule.daily({ time: '09:00' }),
        enabled: true,
        model: 'gpt-5.5', // per-automation model override
      });

      // Trip the rejection tracker for the global anthropic-api-key source.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // The overridden automation must NOT be paused — its route may differ.
      executeAgentTurn.mockClear();
      const run = await scheduler.runNow(defWithOverride.id, 'schedule');
      // Gate must have passed (executeAgentTurn was called, not blocked).
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      expect(run?.status).not.toBe('provider_not_ready');
      expect(run?.admissionBlock).toBeUndefined();
    });

    it('an automation WITHOUT a model override IS paused when the global source is rejected', async () => {
      const Scheduler = await loadScheduler();
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: true,
        errorKind: 'auth',
        credentialSource: 'anthropic-api-key',
      });
      mockResolvedAutomationFile(scheduler);
      const defNoOverride = addDailyAutomation(scheduler); // no model field

      // Trip the tracker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        await scheduler.runNow(defNoOverride.id, 'schedule');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // Next spawn for the no-override automation must be BLOCKED.
      executeAgentTurn.mockClear();
      const blockedRun = await scheduler.runNow(defNoOverride.id, 'schedule');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // F4(c): Success-reset via the executeAgentTurn event seam.
  //
  // NOTE: credentialRejectionTracker.recordSuccess() is called by the REAL
  // agentTurnExecute.ts turn executor, which is mocked here. Testing the full
  // round-trip would require wiring the real executor — infeasible in this
  // mock-based scheduler test harness. Instead we verify that a successful run
  // (result event, not direct recordSuccess) flows through the scheduler's
  // persistRun path correctly: the circuit breaker state is unchanged by success
  // (the scheduler itself does not call recordSuccess — that's the turn executor's
  // responsibility). This confirms the scheduler does NOT incorrectly clear the
  // tracker itself on success.
  // -------------------------------------------------------------------------
  describe('F4(c): success-run via event seam does not incorrectly mutate tracker', () => {
    it('a successful run via result event does not trip or unexpectedly clear the tracker', async () => {
      const Scheduler = await loadScheduler();
      // Scheduler that emits success result events.
      const { scheduler, executeAgentTurn } = createSchedulerWithAuthError(Scheduler, {
        activeProvider: 'anthropic',
        failure: false, // will succeed
        credentialSource: 'anthropic-api-key',
      });
      mockResolvedAutomationFile(scheduler);
      const def = addDailyAutomation(scheduler);

      // Manually trip the tracker (simulating prior auth failures via another path).
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        _testTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // A run through the turn-seam (not direct recordSuccess call) — the scheduler
      // should NOT clear the tracker (that's the real turn executor's job, not the scheduler's).
      // We use a manual run so the rejection gate is bypassed.
      executeAgentTurn.mockClear();
      const manualRun = await scheduler.runNow(def.id, 'manual');
      // executeAgentTurn was called (gate passed for manual run).
      expect(executeAgentTurn).toHaveBeenCalledTimes(1);
      // The pipeline ran (may return any status in the mock context —
      // the important assertion is that the tracker was NOT cleared by the scheduler).
      expect(manualRun).not.toBeNull();

      // Tracker remains tripped — scheduler did NOT accidentally clear it via persistRun.
      expect(_testTracker.isRejected('anthropic-api-key')).toBe(true);

      // A scheduled spawn is still blocked (tracker unchanged by the prior manual run).
      executeAgentTurn.mockClear();
      const blockedRun = await scheduler.runNow(def.id, 'schedule');
      expect(blockedRun?.status).toBe('provider_not_ready');
      expect(executeAgentTurn).not.toHaveBeenCalled();
    });
  });
});
