// ---------------------------------------------------------------------------
// providerStatusService — live provider-status fetch (DIAGNOSTICS/TRIAGE ONLY)
// ---------------------------------------------------------------------------
// Fetches a provider's public Atlassian Statuspage v2 `summary.json` and
// distils it into a `ProviderStatusResult`. This is a CORROBORATING TRIAGE
// SIGNAL ONLY and NON-ESSENTIAL:
//   - it NEVER affects the reachability verdict (detectAllProvidersUnreachable);
//   - the status batch IS awaited within the reachability refresh (so it lands
//     in the exported diagnostics bundle), but the caller wraps it in its own
//     budget (STATUS_BATCH_BUDGET_MS, kept under the collector ceiling) and
//     treats it as non-essential — on timeout/failure it is simply omitted and
//     can NEVER make the reachability snapshot unavailable;
//   - it NEVER blocks a turn — the reachability refresh is a diagnostics/
//     fire-and-forget operation, not on a turn's hot path;
//   - it NEVER drives user-facing error copy (that is the static Stage 2 link).
//
// Fail-soft is total: ANY fetch error, non-2xx, timeout, JSON error, or schema
// mismatch resolves to `{ indicator: 'unknown', ... }` — NEVER `'none'`, NEVER
// a throw. A false "operational" during a real overload is the origin bug.
//
// Cross-surface safe: uses only `globalThis.fetch` + the pure `@rebel/shared`
// registry. No `electron`, no node-only APIs. The renderer never imports this
// module — it reads results via the diagnostics snapshot.
//
// Origin: Sentry REBEL-6D2 / FOX-3535. See
// docs/plans/260623_provider-status-probe/PLAN.md (Stage 3).
// ---------------------------------------------------------------------------

import { STATUSPAGE_REGISTRY, type StatusProviderId } from '@rebel/shared';
import {
  StatuspageSummarySchema,
  type ProviderStatusIndicator,
  type ProviderStatusIncident,
  type ProviderStatusResult,
} from '@shared/diagnostics/providerStatus';
import { runWithTimeout } from '@core/utils/withTimeout';
import { CoalescedCache } from '@core/utils/coalescedCache';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

// ~3s per-fetch ceiling. Comfortably under the diagnostics collector ceiling
// (12s) and well under the status batch budget the reachability collector wraps
// around all status fetches (~4s).
const FETCH_TIMEOUT_MS = 3_000;

// 90s TTL: status pages lag and are coarse; short-TTL coalesced caching avoids
// hammering the public endpoints while keeping the diagnostics view fresh-ish.
// In-memory only (dies with the process); URLs are static so no
// settings-change invalidation is needed.
const CACHE_TTL_MS = 90_000;

const statusCache = new CoalescedCache<ProviderStatusResult>({ ttlMs: CACHE_TTL_MS });

/**
 * Best-effort warn logger. We avoid a static `@core/logger` import here so the
 * module stays cross-surface safe (the desktop logger drags in node:fs / pino /
 * import.meta). Console-only is acceptable for a best-effort triage signal; it
 * matches the sibling reachability probe's posture.
 */
function warn(message: string, detail?: unknown): void {
  try {
    console.warn(`[providerStatusService] ${message}`, detail ?? '');
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'providerStatus.warn',
      reason: 'a logging failure must never break the fail-soft contract',
    });
  }
}

const KNOWN_INDICATORS: ReadonlySet<string> = new Set(['none', 'minor', 'major', 'critical']);

/** Map an upstream indicator string to ours; absent/unrecognised → 'unknown' (NEVER 'none'). */
function normalizeIndicator(raw: string | undefined): ProviderStatusIndicator {
  if (raw && KNOWN_INDICATORS.has(raw)) {
    return raw as ProviderStatusIndicator;
  }
  return 'unknown';
}

/** Build the fail-soft / no-fetch result for a provider (indicator 'unknown'). */
function unknownResult(humanUrl: string, stale = false): ProviderStatusResult {
  return {
    indicator: 'unknown',
    incidents: [],
    humanUrl,
    checkedAt: new Date().toISOString(),
    stale,
  };
}

async function fetchAndParse(
  id: StatusProviderId,
  summaryJsonUrl: string,
  humanUrl: string,
): Promise<ProviderStatusResult> {
  const { value } = await runWithTimeout<ProviderStatusResult>({
    timeoutMs: FETCH_TIMEOUT_MS,
    onTimeout: () => {
      warn(`status fetch timed out for ${id} after ${FETCH_TIMEOUT_MS}ms`);
      return unknownResult(humanUrl);
    },
    work: async (signal) => {
      let response: Response;
      try {
        response = await fetch(summaryJsonUrl, { redirect: 'follow', signal });
      } catch (err) {
        warn(`status fetch failed for ${id}`, err);
        return unknownResult(humanUrl);
      }

      if (!response.ok) {
        warn(`status fetch non-2xx for ${id}: ${response.status}`);
        return unknownResult(humanUrl);
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        warn(`status JSON parse failed for ${id}`, err);
        return unknownResult(humanUrl);
      }

      const parsed = StatuspageSummarySchema.safeParse(json);
      if (!parsed.success) {
        warn(`status schema mismatch for ${id}`, parsed.error);
        return unknownResult(humanUrl);
      }

      const summary = parsed.data;
      const indicator = normalizeIndicator(summary.status?.indicator);
      const incidents: ProviderStatusIncident[] = (summary.incidents ?? []).map((incident) => ({
        name: incident.name ?? '',
        impact: incident.impact ?? '',
        shortlink: incident.shortlink ?? '',
        updatedAt: incident.updated_at ?? '',
      }));

      return {
        indicator,
        description: summary.status?.description,
        incidents,
        humanUrl,
        checkedAt: new Date().toISOString(),
        stale: false,
      };
    },
  });

  return value;
}

/**
 * Fetch (or read from the 90s coalesced cache) a provider's public status.
 *
 * - `openrouter` (no public JSON API, `summaryJsonUrl === null`) → returns
 *   `{ indicator: 'unknown', humanUrl }` WITHOUT fetching.
 * - Any fetch/parse/timeout failure → `{ indicator: 'unknown', humanUrl }`,
 *   logged at warn, NEVER thrown, NEVER `'none'`.
 *
 * Never throws. Concurrent calls for the same id coalesce to a single fetch.
 */
export async function getProviderStatus(id: StatusProviderId): Promise<ProviderStatusResult> {
  const entry = STATUSPAGE_REGISTRY[id];
  const humanUrl = entry.humanUrl;

  // No JSON API (OpenRouter) → unknown + human link, no fetch.
  if (entry.summaryJsonUrl === null) {
    return unknownResult(humanUrl);
  }

  const summaryJsonUrl = entry.summaryJsonUrl;

  try {
    return await statusCache.get(id, () => fetchAndParse(id, summaryJsonUrl, humanUrl));
  } catch (err) {
    // fetchAndParse is itself fail-soft, but guard the cache layer defensively
    // so getProviderStatus can NEVER reject.
    warn(`unexpected status error for ${id}`, err);
    return unknownResult(humanUrl);
  }
}

/** Test-only: clear the in-memory status cache between cases. */
export function __resetProviderStatusCacheForTests(): void {
  statusCache.clear();
}
