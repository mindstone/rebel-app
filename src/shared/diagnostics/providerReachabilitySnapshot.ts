import { z } from 'zod';
import { ProviderStatusResultSchema } from '@shared/diagnostics/providerStatus';

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'codex', 'rebel-cloud']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProbeErrorCodeSchema = z.enum(['dns', 'tls', 'http_4xx', 'http_5xx', 'timeout', 'unknown']);
export type ProbeErrorCode = z.infer<typeof ProbeErrorCodeSchema>;

export const ProbeResultSchema = z.object({
  status: z.enum(['reachable', 'unreachable', 'unknown']),
  latencyMs: z.number().optional(),
  errorCode: ProbeErrorCodeSchema.optional(),
  checkedAt: z.number(),
  cachedAt: z.number(),
  expiresAt: z.number(),
  stale: z.boolean(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProviderReachabilitySnapshotSchema = z.object({
  snapshotPresent: z.boolean(),
  lastRefreshAt: z.number().nullable(),
  providers: z.partialRecord(ProviderIdSchema, ProbeResultSchema).optional(),
  /**
   * OPTIONAL corroborating provider-status results, keyed by `StatusProviderId`
   * ('anthropic' | 'openai' | 'openrouter'). DIAGNOSTICS/TRIAGE ONLY — this
   * sibling is NOT read by `detectAllProvidersUnreachable` (which iterates only
   * `.providers`), so it can never corrupt the reachability verdict. Populated
   * best-effort by the reachability refresh; omitted/partial when the status
   * fetch fails or times out (a status failure must never make the
   * `provider_reachability` diagnostic section unavailable).
   */
  statusPages: z.record(z.string(), ProviderStatusResultSchema).optional(),
});
export type ProviderReachabilitySnapshot = z.infer<typeof ProviderReachabilitySnapshotSchema>;
