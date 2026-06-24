// ---------------------------------------------------------------------------
// providerStatusRegistry
// ---------------------------------------------------------------------------
// Pure, fetch-free source of truth mapping Rebel's LLM providers to their
// public status pages (Atlassian Statuspage v2 where available). Consumed by
// BOTH the error path (a static "Check <Provider> status" link in the error
// notice) and the core live-status fetch service (diagnostics/triage).
//
// This module is intentionally self-contained — no network, no electron, no
// node-only APIs — so it can be imported from the desktop renderer, the cloud
// service, and the mobile app under `@rebel/shared`'s zero-platform-dependency
// layering. It deliberately does NOT import `ActiveProvider` from
// `src/shared/types/settings.ts` (that would cross the package boundary);
// instead it accepts string-keyed provider identifiers and maps them.
//
// Origin: Sentry REBEL-6D2 / FOX-3535 — confirm "upstream provider outage vs.
// Rebel bug" and link the user to the relevant status page as evidence. See
// docs/plans/260623_provider-status-probe/PLAN.md.
// ---------------------------------------------------------------------------

/**
 * The set of providers we have a status page for. Distinct from the app's
 * `ActiveProvider` ('anthropic' | 'openrouter' | 'codex' | 'mindstone', see
 * src/shared/types/settings.ts): Codex rides OpenAI's API so it maps to the
 * OpenAI status page, and Mindstone-managed routes via OpenRouter.
 */
export type StatusProviderId = 'anthropic' | 'openai' | 'openrouter';

export interface ProviderStatusPageEntry {
  /** Human-readable provider name for UI copy (e.g. "Check Anthropic status"). */
  label: string;
  /** Public, human-facing status page URL (always present). */
  humanUrl: string;
  /**
   * Atlassian Statuspage v2 summary JSON endpoint, or `null` when the provider
   * has no public JSON API (OpenRouter). Callers must treat `null` as "human
   * link only, no live fetch".
   */
  summaryJsonUrl: string | null;
}

/**
 * Provider → status page registry.
 *
 * Anthropic gotcha: `status.anthropic.com` 302-redirects to
 * `status.claude.com`, so we register the canonical `status.claude.com` host
 * directly (avoids a wasted redirect hop and a stale/empty parse).
 *
 * OpenRouter has no public Statuspage JSON API (`status.openrouter.ai/api/v2/
 * summary.json` → 404), so `summaryJsonUrl` is `null` — we only offer the
 * human-facing status page link and degrade live status to "unknown".
 */
export const STATUSPAGE_REGISTRY: Record<StatusProviderId, ProviderStatusPageEntry> = {
  anthropic: {
    label: 'Anthropic',
    humanUrl: 'https://status.claude.com/',
    summaryJsonUrl: 'https://status.claude.com/api/v2/summary.json',
  },
  openai: {
    label: 'OpenAI',
    humanUrl: 'https://status.openai.com/',
    summaryJsonUrl: 'https://status.openai.com/api/v2/summary.json',
  },
  openrouter: {
    label: 'OpenRouter',
    humanUrl: 'https://status.openrouter.ai/',
    // No public Statuspage JSON API — human link only.
    summaryJsonUrl: null,
  },
};

/**
 * Maps an app provider identifier to its status page id, or `null` if we have
 * no status page for it.
 *
 * Mapping (case-insensitive, whitespace-tolerant):
 *   - 'anthropic'  → 'anthropic'
 *   - 'openai'     → 'openai'
 *   - 'codex'      → 'openai'      (Codex/ChatGPT Pro rides OpenAI's API)
 *   - 'openrouter' → 'openrouter'
 *   - 'mindstone'  → 'openrouter'  (Mindstone-managed pool routes via OpenRouter)
 *   - anything else / null / undefined → null
 *
 * Aligned with `ActiveProvider` ('anthropic' | 'openrouter' | 'codex' |
 * 'mindstone') in src/shared/types/settings.ts, plus 'openai' which appears as
 * a distinct error/reachability provider id. Kept string-keyed to avoid a
 * cross-package import that would violate `@rebel/shared`'s layering.
 */
export function statusProviderIdForProvider(
  provider: string | null | undefined,
): StatusProviderId | null {
  const normalized = provider?.trim().toLowerCase() ?? '';

  switch (normalized) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'codex':
      return 'openai';
    case 'openrouter':
    case 'mindstone':
      return 'openrouter';
    default:
      return null;
  }
}

/**
 * Convenience wrapper: returns the full registry entry for a given app
 * provider string, or `null` if the provider has no status page.
 */
export function statusPageEntryForProvider(
  provider: string | null | undefined,
): ProviderStatusPageEntry | null {
  const statusId = statusProviderIdForProvider(provider);
  return statusId ? STATUSPAGE_REGISTRY[statusId] : null;
}
