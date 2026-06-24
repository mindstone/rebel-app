import { z } from 'zod';

// ---------------------------------------------------------------------------
// providerStatus — parsed Atlassian Statuspage v2 result (DIAGNOSTICS/TRIAGE)
// ---------------------------------------------------------------------------
// The shape produced by the core `providerStatusService` after fetching and
// tolerantly parsing a provider's public Statuspage v2 `summary.json`. This is
// a CORROBORATING TRIAGE SIGNAL ONLY — it is non-essential: it never gates the
// reachability verdict, never makes the reachability snapshot unavailable, and
// never drives user-facing error copy. The status batch IS awaited within the
// reachability refresh (so it lands in the exported diagnostics bundle), bounded
// by STATUS_BATCH_BUDGET_MS under the collector ceiling; on timeout/failure it is
// simply omitted. It never blocks a turn — the reachability refresh is a
// diagnostics/fire-and-forget operation, not on a turn's hot path.
//
// Origin: Sentry REBEL-6D2 / FOX-3535. See
// docs/plans/260623_provider-status-probe/PLAN.md (Stage 3).
// ---------------------------------------------------------------------------

/**
 * The normalised provider-status indicator we surface in diagnostics.
 *
 * IMPORTANT: on ANY failure (fetch error, non-2xx, timeout, JSON error, schema
 * mismatch, absent/unrecognised upstream indicator) the service defaults to
 * `'unknown'` — NEVER `'none'`. A false "operational" during a real overload is
 * the exact origin bug; we must never assert "no outage" without evidence.
 */
export const ProviderStatusIndicatorSchema = z.enum([
  'none',
  'minor',
  'major',
  'critical',
  'unknown',
]);
export type ProviderStatusIndicator = z.infer<typeof ProviderStatusIndicatorSchema>;

/** A single active incident, distilled from the Statuspage payload. */
export const ProviderStatusIncidentSchema = z.object({
  name: z.string(),
  impact: z.string(),
  shortlink: z.string(),
  updatedAt: z.string(),
});
export type ProviderStatusIncident = z.infer<typeof ProviderStatusIncidentSchema>;

/**
 * Parsed provider-status result attached to the reachability snapshot's
 * optional `statusPages` sibling. Always carries a `humanUrl` so the UI can
 * offer a "View status page" link even when the live fetch failed.
 */
export const ProviderStatusResultSchema = z.object({
  indicator: ProviderStatusIndicatorSchema,
  description: z.string().optional(),
  incidents: z.array(ProviderStatusIncidentSchema),
  humanUrl: z.string(),
  /** ISO timestamp of when we computed this result. */
  checkedAt: z.string(),
  /** True when this result is served from a stale/degraded read. */
  stale: z.boolean(),
});
export type ProviderStatusResult = z.infer<typeof ProviderStatusResultSchema>;

// ---------------------------------------------------------------------------
// Tolerant Statuspage v2 `summary.json` payload schema
// ---------------------------------------------------------------------------
// Atlassian Statuspage v2 returns a large object; we only care about
// `status.{indicator,description}` and the active `incidents[]`. Everything is
// optional + `.passthrough()` so a schema drift (extra/missing fields) degrades
// to `unknown` rather than throwing. The service maps an absent/unrecognised
// `indicator` to `'unknown'` (never `'none'`).

export const StatuspageSummarySchema = z
  .object({
    status: z
      .object({
        indicator: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough()
      .optional(),
    incidents: z
      .array(
        z
          .object({
            name: z.string().optional(),
            impact: z.string().optional(),
            shortlink: z.string().optional(),
            updated_at: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type StatuspageSummary = z.infer<typeof StatuspageSummarySchema>;
