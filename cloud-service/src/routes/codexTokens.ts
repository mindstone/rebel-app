/**
 * Codex OAuth token sync route.
 *
 * POST /api/codex/tokens
 *   Body: { tokens: CodexTokens | null }
 *   - tokens object → persist via `saveCodexTokens()` (core storage)
 *   - tokens: null → `clearCodexTokens()` (cloud logout)
 *
 * Desktop calls this whenever its token state changes (after login, refresh,
 * or logout) so the user's cloud instance can use ChatGPT Pro for mobile /
 * web sessions. Without this bridge, `activeProvider: 'codex'` syncs to
 * cloud but the tokens don't, producing the retry loop fixed in commit
 * 8a3ced505.
 */

import http from 'node:http';
import { readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
import {
  saveCodexTokens,
  clearCodexTokens,
  hasCodexTokens,
  CodexTokensSchema,
} from '@core/services/codexTokenStorage';
import { getSettings, updateSettings, applyCodexProviderHeal } from '@core/services/settingsStore/index';
import { getManagedKeyAvailability } from '@core/rebelCore/managedKeyAvailability';
import { credentialRejectionTracker } from '@core/services/credentialRejectionTracker';

interface SyncTokensBody {
  tokens: unknown;
}

export async function handleCodexTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  const body = await readBody(req) as SyncTokensBody | null;
  if (!body || typeof body !== 'object') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
  }
  if (body.tokens === null) {
    clearCodexTokens({
      cause: 'sync_null',
      source: 'codex_sync_route',
    });
    // Stage 3a (cloud): a codex token clear (logout) must clear the rejection
    // tracker so a future re-login starts with a clean circuit-breaker. Mirrors
    // the desktop codexHandlers.ts clear on logout.
    credentialRejectionTracker.clear('codex-subscription');
    return sendJson(res, 200, { ok: true });
  }
  const parsed = CodexTokensSchema.safeParse(body.tokens);
  if (!parsed.success) {
    return sendRouteError(res, undefined, new RouteError('INVALID_TOKENS', { status: 400, message: 'tokens must be a valid CodexTokens object or null' }));
  }
  const { accountEmail, ...tokenFields } = parsed.data;
  saveCodexTokens(
    accountEmail == null
      ? tokenFields
      : { ...tokenFields, accountEmail },
    {
      cause: 'sync_update',
      source: 'codex_sync_route',
    },
  );
  // FOX-3494 (MA-3 cross-surface parity): same heal as desktop `codex:login`, so
  // a mobile/web user whose `activeProvider` drifted off 'codex' is restored to a
  // usable session after their tokens sync. Uses the shared core helper; the
  // cloud managed-key seam is `getManagedKeyAvailability()` (fail-closed false).
  const current = getSettings();
  const { migrated, healed } = applyCodexProviderHeal(current, {
    codexConnected: hasCodexTokens(),
    hasManagedKey: getManagedKeyAvailability(),
  });
  if (healed) {
    updateSettings({ activeProvider: migrated.activeProvider });
  }
  // Stage 3a (cloud): a codex token save/update deserves a clean circuit-breaker
  // so the next automation spawn isn't pre-blocked by a prior rejection.
  credentialRejectionTracker.clear('codex-subscription');
  return sendJson(res, 200, { ok: true });
}
