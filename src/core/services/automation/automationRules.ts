import type { Scheduler, SchedulerTimerHandle } from '@core/scheduler';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import type { AutomationAdmissionBlock, AutomationProviderReadinessSummary, AppSettings } from '@shared/types';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';
import { classifyAnthropicSettingsCredential } from '@shared/utils/credentialResolution';

export const MAX_TIMEOUT_MS = 2147483647;

// ---------------------------------------------------------------------------
// Credential-source → provider-kind mapping for the rejection gate
// ---------------------------------------------------------------------------

/**
 * Maps each provider kind (matching ProviderCredentialState.kind) to the set of
 * ProviderCredentialSource values that represent an active credential for that
 * provider.
 *
 * Used by evaluateProviderReadinessRule to check whether the active provider's
 * credentials have been persistently rejected by the API (live 401). Only covers
 * the three providers that have admission-block codes; 'local' and 'mindstone'
 * are not gated on rejection.
 */
const PROVIDER_KIND_CREDENTIAL_SOURCES: Record<
  'anthropic' | 'openrouter' | 'codex',
  ReadonlyArray<ProviderCredentialSource>
> = {
  anthropic: ['anthropic-api-key', 'anthropic-oauth-token'],
  openrouter: ['openrouter-oauth-token'],
  codex: ['codex-subscription'],
};

// ---------------------------------------------------------------------------
// Shared credential-source derivation (desktop + cloud schedulers)
// ---------------------------------------------------------------------------

/**
 * Derives the ProviderCredentialSource that is currently active for a
 * credential state snapshot. Shared between the desktop AutomationScheduler
 * and the CloudAutomationScheduler so both surfaces use the SAME router-
 * authoritative classifier with no drift.
 *
 * For the `anthropic` case, uses `classifyAnthropicSettingsCredential` —
 * the SAME authority the router uses (`providerModeFor` → `providerRouting.ts:232`)
 * — so the derived source exactly matches what the turn would actually route through.
 * Precedence: API key wins over OAuth (api-key first, then oauth-token only when
 * authMethod === 'oauth-token').
 *
 * @param credentialState - the current provider credential state snapshot
 * @param getSettings - optional accessor for AppSettings; required for the
 *   anthropic credential sub-classification (api-key vs oauth-token). When
 *   absent (or when settings cannot be read), falls back to 'anthropic-api-key'
 *   so the rejection check still fires for the common single-key case; the
 *   fallback is acceptable because 'anthropic-api-key' is the modal path and
 *   a wrong-source mismatch simply fails OPEN (no false-positive block).
 */
export function deriveActiveCredentialSource(
  credentialState: ProviderCredentialState,
  getSettings?: (() => AppSettings | null | undefined) | null,
): ProviderCredentialSource | undefined {
  switch (credentialState.kind) {
    case 'anthropic': {
      const settings = getSettings?.();
      if (!settings) return 'anthropic-api-key';
      // classifyAnthropicSettingsCredential mirrors the router's credential precedence
      // exactly: api-key wins first; oauth-token only when authMethod === 'oauth-token';
      // otherwise missing. 'missing-anthropic' here means the rejection check won't
      // match any tracked source (benign — no credential to reject).
      const classification = classifyAnthropicSettingsCredential(settings);
      return classification === 'missing-anthropic' ? undefined : classification;
    }
    case 'openrouter':
      return 'openrouter-oauth-token';
    case 'codex':
      return 'codex-subscription';
    // mindstone, local: not rejection-gated — evaluateProviderReadinessRule
    // always returns 'ready' for these, so activeCredentialSource doesn't matter.
    case 'mindstone':
    case 'local':
      return undefined;
  }
}

export const INTERACTIVE_DEFERRAL_DEFAULTS = {
  MAX_DEFERRAL_MS: 5 * 60 * 1000,
  POLL_INTERVAL_MS: 2000,
  GRACE_MS: 5000,
} as const;

export interface RateLimitCooldownDecision {
  shouldDefer: boolean;
  deferMs: number;
  reason: string | null;
}

export type ProviderReadinessDecision =
  | { status: 'ready' }
  | {
      status: 'blocked';
      reason: AutomationAdmissionBlock;
    };

export function evaluateProviderReadinessRule(args: {
  credentialState: ProviderCredentialState;
  /**
   * Optional runtime health input: the set of credential sources that have
   * been persistently rejected by the API (real HTTP 401, not a missing/
   * unconfigured credential). Consumed from `credentialRejectionTracker`
   * in Stage 3; absent in unit-test contexts that only care about the
   * static missing/disconnected checks.
   *
   * **Precedence rule**: missing/disconnected takes priority over rejected.
   * Rationale: if the credential is not configured at all, the rejection
   * signal is meaningless (there is nothing to be rejected). We return the
   * more actionable "configure first" block so the user fixes the root cause.
   * Rejection is only surfaced when the credential IS configured but the API
   * actively refuses it.
   */
  rejectedCredentials?: ReadonlySet<ProviderCredentialSource>;
  /**
   * Optional: the specific credential source that is currently active (i.e.
   * the resolved source used for the current turn). When provided, the
   * rejection gate fires ONLY when this exact source is in rejectedCredentials
   * AND it belongs to the current provider kind.
   *
   * Without this argument the rejection gate does NOT fire — Stage 3 will
   * supply the resolved active source from credential resolution. This is the
   * safe default: it's better to allow a potentially-broken spawn than to
   * block a valid credential because a different source for the same provider
   * happens to be in the rejected set (e.g., a stale OAuth token rejection
   * must not block an active API-key credential).
   *
   * Providers with only one credential source (openrouter, codex) are
   * unambiguous; the source-specific gate is most important for anthropic,
   * which maps to both `anthropic-api-key` and `anthropic-oauth-token`.
   */
  activeCredentialSource?: ProviderCredentialSource;
}): ProviderReadinessDecision {
  const block = (
    reason: Omit<AutomationAdmissionBlock, 'source'>,
  ): ProviderReadinessDecision => ({
    status: 'blocked',
    reason: {
      source: 'provider-readiness',
      ...reason,
    },
  });

  /**
   * Returns true when the active credential source for the given provider kind
   * has been persistently rejected by the API.
   *
   * The gate requires ALL of:
   *   1. activeCredentialSource is provided (safe default: absent → don't fire)
   *   2. activeCredentialSource belongs to this provider kind
   *   3. activeCredentialSource appears in rejectedCredentials
   *
   * This prevents cross-source false positives: e.g. a rejected OAuth token
   * must not block an active API-key credential for the same provider kind.
   */
  const isRejected = (kind: 'anthropic' | 'openrouter' | 'codex'): boolean => {
    if (!args.activeCredentialSource) return false;
    if (!args.rejectedCredentials || args.rejectedCredentials.size === 0) return false;
    // Verify the active source belongs to this provider kind (guards against
    // cross-provider contamination in the rejectedCredentials set).
    if (!PROVIDER_KIND_CREDENTIAL_SOURCES[kind].includes(args.activeCredentialSource)) {
      return false;
    }
    return args.rejectedCredentials.has(args.activeCredentialSource);
  };

  switch (args.credentialState.kind) {
    case 'anthropic':
      // Missing takes precedence — surface the configuration gap first.
      if (args.credentialState.status === 'missing') {
        return block({
          code: 'anthropic_missing_api_key',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'anthropic',
          message: 'Authentication is missing. Please add an API key in Settings.',
        });
      }
      if (isRejected('anthropic')) {
        return block({
          code: 'anthropic_auth_rejected',
          errorKind: 'auth',
          headlineClass: 'auth',
          provider: 'anthropic',
          message: 'Your Anthropic API key is being rejected. Check your key in Settings.',
        });
      }
      return { status: 'ready' };
    case 'openrouter':
      if (args.credentialState.status === 'missing') {
        return block({
          code: 'openrouter_disconnected',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'openrouter',
          message: 'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.',
        });
      }
      if (isRejected('openrouter')) {
        return block({
          code: 'openrouter_auth_rejected',
          errorKind: 'auth',
          headlineClass: 'auth',
          provider: 'openrouter',
          message: 'Your OpenRouter connection is being rejected. Reconnect it in Settings.',
        });
      }
      return { status: 'ready' };
    case 'codex':
      if (args.credentialState.status === 'disconnected') {
        return block({
          code: 'codex_disconnected',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'codex',
          message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
        });
      }
      if (isRejected('codex')) {
        return block({
          code: 'codex_auth_rejected',
          errorKind: 'auth',
          headlineClass: 'auth',
          provider: 'codex',
          message: 'Your ChatGPT Pro connection is being rejected. Reconnect it in Settings.',
        });
      }
      return { status: 'ready' };
    case 'local':
    case 'mindstone':
      return { status: 'ready' };
    default: {
      const _exhaustive: never = args.credentialState;
      void _exhaustive;
      return { status: 'ready' };
    }
  }
}

export interface ProviderReadinessSummaryInput {
  readiness: ProviderReadinessDecision;
  runs: ReadonlyArray<{
    automationId: string;
    startedAt: number;
    completedAt?: number | null;
    admissionBlock?: AutomationAdmissionBlock;
  }>;
  definitions: ReadonlyArray<{
    id: string;
    enabled: boolean;
    schedule: { type: string };
    executor?: 'llm' | 'script';
  }>;
}

export interface ProviderReadinessEligibleAutomation {
  enabled: boolean;
  schedule: { type: string };
  executor?: 'llm' | 'script';
}

export function isProviderReadinessEligibleAutomation(
  definition: ProviderReadinessEligibleAutomation,
): boolean {
  return (
    definition.enabled
    && definition.schedule.type !== 'event'
    && (definition.executor ?? 'llm') === 'llm'
  );
}

export function summarizeProviderReadinessBlocks(
  input: ProviderReadinessSummaryInput,
): AutomationProviderReadinessSummary {
  if (input.readiness.status === 'ready') {
    return {
      readiness: 'ready',
      affectedAutomationCount: 0,
      affectedAutomationIds: [],
      blockedRunCount: 0,
      sinceMs: null,
      cause: null,
    };
  }
  const blockedReason = input.readiness.reason;

  const affectedAutomationIds = input.definitions
    .filter((definition) => isProviderReadinessEligibleAutomation(definition))
    .map((definition) => definition.id)
    .sort();
  const affectedIds = new Set(affectedAutomationIds);

  const matchingBlockedRuns = input.runs.filter((run) =>
    affectedIds.has(run.automationId)
      && run.admissionBlock?.source === 'provider-readiness'
      && run.admissionBlock.code === blockedReason.code,
  );

  const sinceMs =
    matchingBlockedRuns.length > 0
      ? Math.min(...matchingBlockedRuns.map((run) => run.completedAt ?? run.startedAt))
      : null;

  return {
    readiness: 'blocked',
    affectedAutomationCount: affectedAutomationIds.length,
    affectedAutomationIds,
    blockedRunCount: matchingBlockedRuns.length,
    sinceMs,
    cause: blockedReason,
  };
}

export function evaluateRateLimitCooldownRule(args: {
  isAvailable: boolean;
  remainingMs: number;
  reason?: string;
}): RateLimitCooldownDecision {
  if (args.isAvailable) {
    return { shouldDefer: false, deferMs: 0, reason: null };
  }

  return {
    shouldDefer: true,
    deferMs: Math.max(0, args.remainingMs),
    reason: args.reason ?? 'API rate-limit cooldown active',
  };
}

export function shouldSkipDueToActiveRun(isRunning: boolean): boolean {
  return isRunning;
}

export interface AutomationRunDeduper {
  isRunning(automationId: string): boolean;
  tryStart(automationId: string): boolean;
  finish(automationId: string): void;
}

export function createAutomationRunDeduper(
  backingSet: Set<string> = new Set<string>(),
): AutomationRunDeduper {
  return {
    isRunning(automationId: string): boolean {
      return backingSet.has(automationId);
    },
    tryStart(automationId: string): boolean {
      if (backingSet.has(automationId)) {
        return false;
      }
      backingSet.add(automationId);
      return true;
    },
    finish(automationId: string): void {
      backingSet.delete(automationId);
    },
  };
}

export interface InteractiveTurnDeferralResult {
  deferred: boolean;
  deferredMs: number;
  timedOut: boolean;
  shuttingDown: boolean;
}

export interface InteractiveTurnDeferralOptions {
  hasInteractiveTurn: () => boolean;
  isShuttingDown: () => boolean;
  scheduler: Pick<Scheduler, 'sleep' | 'now' | 'deferUntilVisible'>;
  waitForVisible?: boolean;
  maxDeferralMs?: number;
  pollIntervalMs?: number;
  graceMs?: number;
}

export async function waitForInteractiveTurnToSettle(
  options: InteractiveTurnDeferralOptions,
): Promise<InteractiveTurnDeferralResult> {
  const {
    hasInteractiveTurn,
    isShuttingDown,
    scheduler,
    waitForVisible = false,
    maxDeferralMs = INTERACTIVE_DEFERRAL_DEFAULTS.MAX_DEFERRAL_MS,
    pollIntervalMs = INTERACTIVE_DEFERRAL_DEFAULTS.POLL_INTERVAL_MS,
    graceMs = INTERACTIVE_DEFERRAL_DEFAULTS.GRACE_MS,
  } = options;

  const start = scheduler.now();
  const deadline = start + maxDeferralMs;

  const waitForVisibilityIfNeeded = async (): Promise<'visible' | 'timeout' | 'aborted'> => {
    if (!waitForVisible) return 'visible';
    const remainingMs = Math.max(0, deadline - scheduler.now());
    return scheduler.deferUntilVisible({ timeoutMs: remainingMs });
  };

  const initialVisibility = await waitForVisibilityIfNeeded();
  if (initialVisibility === 'timeout') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }
  if (initialVisibility === 'aborted') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  while (hasInteractiveTurn() && scheduler.now() < deadline && !isShuttingDown()) {
    await scheduler.sleep(pollIntervalMs);
  }

  if (isShuttingDown()) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  if (scheduler.now() >= deadline) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }

  await scheduler.sleep(graceMs);

  while (hasInteractiveTurn() && scheduler.now() < deadline && !isShuttingDown()) {
    await scheduler.sleep(pollIntervalMs);

    if (isShuttingDown()) {
      return {
        deferred: true,
        deferredMs: scheduler.now() - start,
        timedOut: false,
        shuttingDown: true,
      };
    }

    if (!hasInteractiveTurn()) {
      await scheduler.sleep(graceMs);
    }
  }

  if (isShuttingDown()) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  const finalVisibility = await waitForVisibilityIfNeeded();
  if (finalVisibility === 'timeout') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }
  if (finalVisibility === 'aborted') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  return {
    deferred: true,
    deferredMs: scheduler.now() - start,
    timedOut: scheduler.now() >= deadline,
    shuttingDown: false,
  };
}

export interface ScheduleDefinitionWithMaxTimeoutResult {
  nextRunAt: number;
  delayMs: number;
  chained: boolean;
}

export interface ScheduleDefinitionWithMaxTimeoutOptions<TDefinition> {
  definitionId: string;
  timers: Map<string, SchedulerTimerHandle>;
  scheduler: Pick<Scheduler, 'registerTimeout' | 'clear' | 'now'>;
  getDefinitionById: (definitionId: string) => TDefinition | undefined;
  calculateNextRunAt: (definition: TDefinition, fromMs: number) => number | null;
  onNextRunAt?: (definition: TDefinition, nextRunAt: number) => void;
  onFire: (definition: TDefinition) => void;
  onDropped?: (
    definitionId: string,
    reason: 'missing-definition' | 'no-next-run',
  ) => void;
  maxTimeoutMs?: number;
}

export function scheduleDefinitionWithMaxTimeout<TDefinition>(
  options: ScheduleDefinitionWithMaxTimeoutOptions<TDefinition>,
): ScheduleDefinitionWithMaxTimeoutResult | null {
  const {
    definitionId,
    timers,
    scheduler,
    getDefinitionById,
    calculateNextRunAt,
    onNextRunAt,
    onFire,
    onDropped,
    maxTimeoutMs = MAX_TIMEOUT_MS,
  } = options;

  const existingTimer = timers.get(definitionId);
  if (existingTimer) {
    scheduler.clear(existingTimer);
    timers.delete(definitionId);
  }

  const initialNow = scheduler.now();
  const initialDefinition = getDefinitionById(definitionId);
  if (!initialDefinition) {
    onDropped?.(definitionId, 'missing-definition');
    return null;
  }

  const initialNextRunAt = calculateNextRunAt(initialDefinition, initialNow);
  if (initialNextRunAt === null) {
    onDropped?.(definitionId, 'no-next-run');
    return null;
  }
  onNextRunAt?.(initialDefinition, initialNextRunAt);

  const scheduleAt = (targetRunAt: number): void => {
    const now = scheduler.now();
    const delayMs = Math.max(0, targetRunAt - now);
    const shouldChain = delayMs > maxTimeoutMs;
    const timeoutMs = shouldChain ? maxTimeoutMs : delayMs;

    const timer = scheduler.registerTimeout(() => {
      if (shouldChain) {
        const freshDefinition = getDefinitionById(definitionId);
        if (!freshDefinition) {
          timers.delete(definitionId);
          onDropped?.(definitionId, 'missing-definition');
          return;
        }

        const refreshedNextRunAt = calculateNextRunAt(freshDefinition, scheduler.now());
        if (refreshedNextRunAt === null) {
          timers.delete(definitionId);
          onDropped?.(definitionId, 'no-next-run');
          return;
        }

        onNextRunAt?.(freshDefinition, refreshedNextRunAt);
        scheduleAt(refreshedNextRunAt);
        return;
      }

      timers.delete(definitionId);
      const freshDefinition = getDefinitionById(definitionId);
      if (!freshDefinition) {
        onDropped?.(definitionId, 'missing-definition');
        return;
      }
      onFire(freshDefinition);
    }, timeoutMs);

    const previousTimer = timers.get(definitionId);
    if (previousTimer) {
      scheduler.clear(previousTimer);
    }
    timers.set(definitionId, timer);
  };

  scheduleAt(initialNextRunAt);

  const initialDelayMs = Math.max(0, initialNextRunAt - initialNow);
  return {
    nextRunAt: initialNextRunAt,
    delayMs: initialDelayMs,
    chained: initialDelayMs > maxTimeoutMs,
  };
}
