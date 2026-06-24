/**
 * Microsoft 365 Auth Service
 *
 * Handles OAuth2 authentication for Microsoft 365 (Outlook, Calendar, OneDrive, Teams).
 * Uses system browser + deep link callback pattern (like Slack).
 *
 * Flow:
 * 1. Generate Microsoft OAuth URL with Cloudflare redirect
 * 2. Open system browser for OAuth consent
 * 3. Cloudflare redirects to mindstone://microsoft/callback with code
 * 4. App handles deep link, exchanges code for tokens via PKCE
 * 5. Save tokens in shared config directory
 *
 * Cold-start resilience:
 * On Windows, if the app restarts during the OAuth flow (user quit, crash, auto-update),
 * the deep link callback arrives at a fresh process with no in-memory pendingAuth.
 * Without the PKCE codeVerifier, the auth code is unrecoverable.
 * To handle this, we persist minimal auth state to disk before opening the browser.
 * The fresh instance can then load the persisted state and complete the token exchange.
 */

import { URL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  OAuthLoopbackTimeoutError,
  createOAuthLoopbackController,
  type OAuthLoopbackAuthUrl,
  type OAuthLoopbackLogger,
} from '@core/services/oauthLoopbackServer';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import {
  DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE,
  selectOAuthTransport,
} from '@core/services/oauthTransport';
import { atomicCredentialWrite, sweepStaleTemps } from '@core/utils/atomicCredentialWrite';
import { getAvailablePort } from '../utils/systemUtils';
import { isDeepLinkDeliverySupported } from './oauthDeepLinkSupport';
import { trackOAuthBrowserOpened, trackOAuthStartBlocked } from './oauthTelemetry';
import { generateCsrfState, bringAppToForeground } from './oauthPrimitives';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { assertNever } from '@shared/utils/assertNever';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'microsoft-auth' });

const PENDING_AUTH_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches the in-memory timeout
const RECENT_COMPLETED_AUTH_WINDOW_MS = 30 * 1000;

// Microsoft OAuth URLs (common tenant for multi-tenant apps)
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';
const MICROSOFT_LOOPBACK_CALLBACK_HOST = 'localhost';
// Enabled once the Entra localhost redirect URI was registered (260623).
// See docs/plans/260623_oauth-deeplink-loopback-class/ENTRA_LOOPBACK_HANDOFF.md.
const MICROSOFT_LOOPBACK_CAPABLE = true;

// Microsoft Graph base scopes for Mail, Calendar, Files, Teams
export const MICROSOFT_BASE_SCOPES = [
  'offline_access', // Required for refresh tokens
  'User.Read', // Get user profile/email
  'Mail.Read',
  'Mail.Send',
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
  'Files.ReadWrite',
  'Chat.Read',
  'Chat.ReadWrite',
  'Presence.Read',
];

// Additional scopes for SharePoint access (requested via incremental consent)
export const MICROSOFT_SHAREPOINT_SCOPES = ['Sites.Read.All'];

// Internal alias for backward compatibility within this module
const MICROSOFT_SCOPES = MICROSOFT_BASE_SCOPES;

export interface MicrosoftAccount {
  email: string;
  displayName?: string;
}

interface AccountsConfig {
  accounts: MicrosoftAccount[];
}

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  token_type: string;
  scope: string;
}

// Redirect URI - Cloudflare redirects this to mindstone://microsoft/callback
const getRedirectUri = () => getOAuthRedirectUri('microsoft');

interface PendingMicrosoftAuth {
  clientId: string;
  codeVerifier: string;
  state: string; // CSRF protection token
  redirectUri: string; // snapshotted at auth start; reused at token exchange to prevent env mutation drift
  resolve: (email: string) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

// Module state for pending OAuth
let pendingAuth: PendingMicrosoftAuth | null = null;
let recentlyCompletedAuthStates: Array<{ state: string; completedAt: number }> = [];
let microsoftLoopbackCapableOverrideForTests: boolean | null = null;

type MicrosoftCallbackMethod = 'deep_link' | 'loopback';

const loopbackLogger: OAuthLoopbackLogger = {
  info: (fields, message) => log.info(fields, message),
  warn: (fields, message) => log.warn(fields, message),
  error: (fields, message) => log.error(fields, message),
};

const microsoftLoopbackController = createOAuthLoopbackController({
  providerName: 'Microsoft',
  callbackHost: MICROSOFT_LOOPBACK_CALLBACK_HOST,
  getAvailablePort,
  logger: loopbackLogger,
});

export function __setMicrosoftLoopbackCapableForTests(value: boolean | null): void {
  microsoftLoopbackCapableOverrideForTests = value;
}

export function __resetMicrosoftAuthMemoryForTests(): void {
  microsoftLoopbackController.cancel();
  if (pendingAuth) {
    clearPendingAuthTimeout(pendingAuth);
    pendingAuth = null;
  }
  recentlyCompletedAuthStates = [];
  microsoftLoopbackCapableOverrideForTests = null;
}

function isMicrosoftLoopbackCapable(): boolean {
  return microsoftLoopbackCapableOverrideForTests ?? MICROSOFT_LOOPBACK_CAPABLE;
}

function pruneRecentlyCompletedAuthStates(now = Date.now()): void {
  recentlyCompletedAuthStates = recentlyCompletedAuthStates.filter(
    (entry) => now - entry.completedAt <= RECENT_COMPLETED_AUTH_WINDOW_MS,
  );
}

function markAuthStateCompleted(state: string): void {
  const now = Date.now();
  pruneRecentlyCompletedAuthStates(now);
  recentlyCompletedAuthStates.push({ state, completedAt: now });
}

function isRecentlyCompletedAuthState(state: string | null): boolean {
  if (!state) return false;
  const now = Date.now();
  pruneRecentlyCompletedAuthStates(now);
  return recentlyCompletedAuthStates.some((entry) => entry.state === state);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Get the Microsoft config directory (shared by all 4 MCPs)
 */
export function getMicrosoftConfigDir(): string {
  return path.join(app.getPath('userData'), 'microsoft-mcp');
}

/**
 * Get accounts.json path
 */
function getAccountsPath(): string {
  return path.join(getMicrosoftConfigDir(), 'accounts.json');
}

/**
 * Get credentials directory for per-account token files
 */
function getCredentialsDir(): string {
  return path.join(getMicrosoftConfigDir(), 'credentials');
}

/**
 * Sanitize email for use in filename (matches Google/HubSpot pattern)
 */
function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Get token file path for a specific account
 */
function getTokenPath(email: string): string {
  return path.join(getCredentialsDir(), `${sanitizeEmail(email)}.token.json`);
}

/**
 * Get legacy tokens.json path (for migration)
 */
function getLegacyTokensPath(): string {
  return path.join(getMicrosoftConfigDir(), 'tokens.json');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildMicrosoftAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string;
  additionalScopes?: string[];
  loginHint?: string;
}): URL {
  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', input.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', input.redirectUri);
  authUrl.searchParams.set('scope', input.scopes.join(' '));
  authUrl.searchParams.set('code_challenge', input.codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // For incremental consent: use 'consent' prompt + login_hint to target the correct account
  if (input.additionalScopes && input.loginHint) {
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('login_hint', input.loginHint);
  } else {
    authUrl.searchParams.set('prompt', 'select_account');
  }

  authUrl.searchParams.set('state', input.state);
  return authUrl;
}

// --- Persisted pending auth (cold-start resilience) ---

interface PersistedPendingAuth {
  clientId: string;
  codeVerifier: string;
  state: string;
  expiresAt: number;
}

function getPendingAuthPath(): string {
  return path.join(getMicrosoftConfigDir(), '.pending-auth.json');
}

async function persistPendingAuth(data: PersistedPendingAuth): Promise<void> {
  try {
    const configDir = getMicrosoftConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(getPendingAuthPath(), JSON.stringify(data), { mode: 0o600 });
  } catch (err) {
    log.warn({ err }, 'Failed to persist pending auth state (non-fatal)');
  }
}

async function loadPersistedPendingAuth(): Promise<PersistedPendingAuth | null> {
  try {
    const data = await fs.readFile(getPendingAuthPath(), 'utf-8');
    const parsed = JSON.parse(data) as PersistedPendingAuth;
    if (!parsed.clientId || !parsed.codeVerifier || !parsed.state || !parsed.expiresAt) {
      return null;
    }
    if (Date.now() > parsed.expiresAt) {
      log.info('Persisted pending auth expired, discarding');
      await clearPersistedPendingAuth();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clear persisted pending auth file.
 * If expectedState is provided, only clears if the on-disk state matches —
 * this prevents a stale clear from deleting a newer attempt's file.
 */
async function clearPersistedPendingAuth(expectedState?: string): Promise<void> {
  try {
    if (expectedState) {
      const data = await fs.readFile(getPendingAuthPath(), 'utf-8');
      const parsed = JSON.parse(data) as PersistedPendingAuth;
      if (parsed.state !== expectedState) return;
    }
    await fs.unlink(getPendingAuthPath());
  } catch {
    // Ignore if file doesn't exist or is unreadable
  }
}

/**
 * Load accounts from accounts.json
 */
async function loadAccounts(): Promise<AccountsConfig> {
  const accountsPath = getAccountsPath();
  try {
    const data = await fs.readFile(accountsPath, 'utf-8');
    return JSON.parse(data) as AccountsConfig;
  } catch {
    return { accounts: [] };
  }
}

/**
 * Save accounts to accounts.json using the 8-step atomic credential write
 * (temp + fsync + rename + chmod 0o600 + parent-dir fsync). The accounts file
 * is part of the OAuth trust surface across 5 Microsoft MCP processes; a
 * partial write would corrupt the shared identity index.
 */
async function saveAccounts(config: AccountsConfig): Promise<void> {
  const configDir = getMicrosoftConfigDir();
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(configDir, 0o700).catch(() => undefined);
  }
  await sweepStaleTemps(configDir);
  await atomicCredentialWrite(
    getAccountsPath(),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Save token for a specific account using atomic credential write. Five
 * sibling Microsoft MCP subprocesses read this file concurrently via
 * TokenProvider, so any non-atomic write is observable as a partial read.
 */
async function saveToken(email: string, tokenData: TokenData): Promise<void> {
  const credentialsDir = getCredentialsDir();
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(credentialsDir, 0o700).catch(() => undefined);
  }
  await sweepStaleTemps(credentialsDir);
  await atomicCredentialWrite(
    getTokenPath(email),
    JSON.stringify(tokenData, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Load token for a specific account
 */
async function loadToken(email: string): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(getTokenPath(email), 'utf-8');
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

/**
 * Delete token file for a specific account
 */
async function deleteToken(email: string): Promise<void> {
  try {
    await fs.unlink(getTokenPath(email));
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Migrate legacy single tokens.json to per-account storage.
 * Called on startup or when loading accounts.
 */
async function migrateLegacyTokens(): Promise<void> {
  const legacyPath = getLegacyTokensPath();
  try {
    const data = await fs.readFile(legacyPath, 'utf-8');
    const legacyToken = JSON.parse(data) as TokenData;
    
    // Find the first account to migrate the token to
    const config = await loadAccounts();
    if (config.accounts.length > 0) {
      const firstAccount = config.accounts[0];
      log.info({ email: firstAccount.email }, 'Migrating legacy tokens.json to per-account storage');
      await saveToken(firstAccount.email, legacyToken);
      
      // Remove the legacy file after successful migration
      await fs.unlink(legacyPath);
      log.info('Legacy tokens.json migrated and removed');
    }
  } catch {
    // No legacy file or migration not needed
  }
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<TokenData> {
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type ?? 'Bearer',
    scope: data.scope,
  };
}

/**
 * Get user info from Microsoft Graph
 */
async function getUserInfo(accessToken: string): Promise<{ email: string; displayName: string }> {
  const response = await fetch(MICROSOFT_GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  const data = await response.json();
  return {
    email: data.mail ?? data.userPrincipalName,
    displayName: data.displayName ?? '',
  };
}

/**
 * Get all connected Microsoft accounts with their status
 */
export async function getMicrosoftAccounts(): Promise<Array<{
  email: string;
  displayName?: string;
  status: 'active' | 'expired' | 'error';
}>> {
  // Migrate legacy tokens if needed
  await migrateLegacyTokens();
  
  const config = await loadAccounts();
  const results = [];

  for (const account of config.accounts) {
    // Load token for this specific account
    const token = await loadToken(account.email);
    let status: 'active' | 'expired' | 'error' = 'error';

    if (token) {
      // Use 5-minute buffer to match MCP auto-refresh logic
      const bufferMs = 5 * 60 * 1000;
      if (token.expires_at > Date.now() + bufferMs) {
        status = 'active';
      } else if (token.refresh_token) {
        status = 'active'; // Can be refreshed by MCP
      } else {
        status = 'expired';
      }
    }

    results.push({
      email: account.email,
      displayName: account.displayName,
      status,
    });
  }

  return results;
}

/**
 * Check if Microsoft is connected (has valid token)
 */
export async function isMicrosoftConnected(): Promise<boolean> {
  const accounts = await getMicrosoftAccounts();
  return accounts.some((a) => a.status === 'active');
}

/**
 * Remove a Microsoft account.
 *
 * **Microsoft OAuth Revocation Limitation:**
 * Unlike Google, Salesforce, HubSpot, and Slack, Microsoft does not provide a
 * programmatic OAuth token revocation endpoint accessible to desktop apps.
 *
 * Microsoft's `revokeSignInSessions` Graph API endpoint exists, but requires
 * `User.RevokeSessions.All` permission which is an admin-only scope. Desktop
 * OAuth apps using delegated permissions cannot obtain this scope.
 *
 * As a result, this function only deletes local tokens. Users who wish to
 * fully revoke Mindstone's access must do so manually:
 * - Azure Portal: https://portal.azure.com → Azure Active Directory → Enterprise Applications
 * - Microsoft Account: https://account.microsoft.com/privacy/app-access
 *
 * @see https://learn.microsoft.com/en-us/graph/api/user-revokesigninsessions
 */
export async function removeMicrosoftAccount(email: string): Promise<void> {
  log.info({ email }, 'Removing Microsoft account');

  // Delete the token file for this account
  await deleteToken(email);

  // Remove from accounts list
  const config = await loadAccounts();
  config.accounts = config.accounts.filter((a) => a.email !== email);
  await saveAccounts(config);

  log.info({ email }, 'Microsoft account removed');
}

// ── Scope Helpers ──────────────────────────────────────────────

/**
 * Parse a space-delimited OAuth scope string into a normalized (lowercase) set.
 */
export function parseScopes(scopeString: string): Set<string> {
  return new Set(
    scopeString
      .split(' ')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

/**
 * Validate that the new scope set is a superset of (or equal to) the existing scope set.
 * Returns `true` if the new scopes are valid (no shrinkage), `false` if shrinkage detected.
 */
export function validateScopeExpansion(existingScopes: string, newScopes: string): boolean {
  const existingSet = parseScopes(existingScopes);
  const newSet = parseScopes(newScopes);
  for (const scope of existingSet) {
    if (!newSet.has(scope)) {
      return false;
    }
  }
  return true;
}

/**
 * Return scopes from an existing token that are NOT in MICROSOFT_BASE_SCOPES.
 * Used during reconnection to preserve previously-granted permissions (e.g. Sites.Read.All).
 * Returns an empty array if no token exists or no extra scopes are found.
 */
export async function getExtraScopesForAccount(email: string): Promise<string[]> {
  const token = await loadToken(email);
  if (!token?.scope) return [];

  const baseSet = new Set(MICROSOFT_BASE_SCOPES.map((s) => s.toLowerCase()));
  const extras: string[] = [];
  for (const scope of token.scope.split(' ')) {
    const trimmed = scope.trim();
    if (trimmed && !baseSet.has(trimmed.toLowerCase())) {
      extras.push(trimmed);
    }
  }
  return extras;
}

async function completeMicrosoftAuthCode(input: {
  code: string;
  clientId: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
  coldStart: boolean;
}): Promise<string> {
  // Exchange code for tokens
  log.info({ coldStart: input.coldStart }, 'Exchanging code for tokens');
  const tokenData = await exchangeCodeForTokens(
    input.code,
    input.clientId,
    input.redirectUri,
    input.codeVerifier,
  );

  // Get user info
  const userInfo = await getUserInfo(tokenData.access_token);
  const email = userInfo.email;

  if (!email) {
    throw new Error('Could not determine email from token');
  }

  log.info({ email, coldStart: input.coldStart }, 'OAuth successful, saving tokens');

  // Scope shrinkage protection: if an existing token has MORE scopes than the new token,
  // reject the overwrite to prevent losing previously-granted permissions.
  const existingToken = await loadToken(email);
  if (existingToken?.scope && tokenData.scope) {
    if (!validateScopeExpansion(existingToken.scope, tokenData.scope)) {
      const msg = "Authorization didn't include required permissions. Your existing connection is unchanged.";
      log.warn({ email, existingScopes: existingToken.scope, newScopes: tokenData.scope }, msg);
      throw new Error(msg);
    }
  }

  // Save token for this specific account
  await saveToken(email, tokenData);

  // Update accounts list
  const config = await loadAccounts();
  const existingIndex = config.accounts.findIndex((a) => a.email === email);
  if (existingIndex >= 0) {
    config.accounts[existingIndex].displayName = userInfo.displayName;
  } else {
    config.accounts.push({
      email,
      displayName: userInfo.displayName,
    });
  }
  await saveAccounts(config);

  // Bring app to foreground
  bringAppToForeground();

  markAuthStateCompleted(input.state);
  log.info({ email, coldStart: input.coldStart }, 'Microsoft OAuth completed successfully');
  return email;
}

/**
 * Cancel any pending OAuth flow
 */
export function cancelMicrosoftAuth(): void {
  microsoftLoopbackController.cancel();
  if (pendingAuth) {
    log.info('Cancelling pending Microsoft auth');
    const { state } = pendingAuth;
    clearPendingAuthTimeout(pendingAuth);
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
    fireAndForget(clearPersistedPendingAuth(state), 'microsoftAuthService.line535');
  }
}

interface MicrosoftAuthInternalCallbacks {
  resolveEmail: (email: string) => void;
  rejectEmail: (err: Error) => void;
  onBrowserOpened?: (authUrl: string) => void;
  onBrowserOpenFailed?: (err: Error) => void;
}

function rejectMicrosoftAuthStartBlocked(
  reason: string,
  deepLinkDeliverySupported: boolean,
  callbacks: MicrosoftAuthInternalCallbacks,
): void {
  log.warn(
    {
      connectorName: 'Microsoft',
      connectorType: 'bundled',
      reason,
      isPackaged: app.isPackaged,
      deepLinkDeliverySupported,
      platform: process.platform,
      isDefaultApp: Boolean(process.defaultApp),
      microsoftLoopbackCapable: isMicrosoftLoopbackCapable(),
    },
    'Blocked Microsoft OAuth start because no callback transport is available',
  );
  trackOAuthStartBlocked({
    connectorName: 'Microsoft',
    connectorType: 'bundled',
    reason,
  });

  const err = new Error(DEEP_LINK_OAUTH_START_BLOCKED_MESSAGE);
  callbacks.rejectEmail(err);
  callbacks.onBrowserOpenFailed?.(err);
}

function clearPendingAuthForState(state: string): PendingMicrosoftAuth | null {
  if (!pendingAuth || pendingAuth.state !== state) return null;
  const auth = pendingAuth;
  clearPendingAuthTimeout(auth);
  pendingAuth = null;
  return auth;
}

function clearPendingAuthTimeout(auth: PendingMicrosoftAuth): void {
  if (auth.timeout) {
    clearTimeout(auth.timeout);
  }
}

function createPendingAuthTimeout(
  state: string,
  callbacks: MicrosoftAuthInternalCallbacks,
  onTimeout?: () => void,
): NodeJS.Timeout {
  return setTimeout(() => {
    if (pendingAuth && pendingAuth.state === state) {
      pendingAuth = null;
      onTimeout?.();
      fireAndForget(clearPersistedPendingAuth(state), 'microsoftAuthService.pendingAuthTimeout');
      callbacks.rejectEmail(new Error('Authorization timed out'));
    }
  }, PENDING_AUTH_TTL_MS);
}

function registerPendingMicrosoftAuth(input: {
  clientId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  callbacks: MicrosoftAuthInternalCallbacks;
  persistToDisk: boolean;
  armTimeout?: boolean;
  onTimeout?: () => void;
}): void {
  const timeout = input.armTimeout === false
    ? undefined
    : createPendingAuthTimeout(input.state, input.callbacks, input.onTimeout);

  const nextPendingAuth: PendingMicrosoftAuth = {
    clientId: input.clientId,
    codeVerifier: input.codeVerifier,
    state: input.state,
    redirectUri: input.redirectUri,
    resolve: input.callbacks.resolveEmail,
    reject: input.callbacks.rejectEmail,
  };
  if (timeout) {
    nextPendingAuth.timeout = timeout;
  }
  pendingAuth = nextPendingAuth;

  if (input.persistToDisk) {
    fireAndForget(persistPendingAuth({
      clientId: input.clientId,
      codeVerifier: input.codeVerifier,
      state: input.state,
      expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
    }), 'microsoftAuthService.registerPendingMicrosoftAuth');
  }
}

function mapLoopbackAuthError(error: Error): Error {
  if (error instanceof OAuthLoopbackTimeoutError) {
    return new Error('Authorization timed out');
  }
  return error;
}

function rejectLoopbackAuthFailure(
  state: string,
  error: Error,
  browserOpened: boolean,
  callbacks: MicrosoftAuthInternalCallbacks,
): void {
  const auth = clearPendingAuthForState(state);
  if (auth) {
    auth.reject(error);
  } else {
    callbacks.rejectEmail(error);
  }

  if (!browserOpened) {
    callbacks.onBrowserOpenFailed?.(error);
  }
}

async function openMicrosoftAuthInBrowser(
  authUrl: OAuthLoopbackAuthUrl,
  callbackMethod: MicrosoftCallbackMethod,
): Promise<string> {
  const authUrlString = authUrl.toString();
  await shell.openExternal(authUrlString);
  trackOAuthBrowserOpened({
    connectorName: 'Microsoft',
    connectorType: 'bundled',
    oauthUrl: authUrlString,
    callbackMethod,
  });
  log.info('Opened Microsoft OAuth in system browser');
  return authUrlString;
}

/**
 * Shared OAuth setup: PKCE + URL build + pendingAuth registration +
 * disk-persist + browser open. Used by both `startMicrosoftAuth()` (await-on-email)
 * and `beginMicrosoftAuthFlow()` (return-on-browser-opened). Keeping this in
 * one place ensures the two entry points cannot drift apart.
 *
 * Returns the constructed authUrl synchronously so non-blocking callers can
 * surface it before browser-open resolves.
 */
function setupAndOpenMicrosoftAuth(
  clientId: string,
  additionalScopes: string[] | undefined,
  loginHint: string | undefined,
  callbacks: MicrosoftAuthInternalCallbacks,
): { authUrl: string; state: string } {
  const deepLinkDeliverySupported = isDeepLinkDeliverySupported();
  const transport = selectOAuthTransport({
    isPackaged: app.isPackaged,
    deepLinkDeliverySupported,
    supportsDeepLink: true,
    supportsLoopback: isMicrosoftLoopbackCapable(),
  });

  const prepareAuthFlow = (): {
    verifier: string;
    challenge: string;
    state: string;
    allScopes: string[];
  } => {
    const { verifier, challenge } = generatePkce();
    const state = generateCsrfState();

    // Merge base scopes with any additional scopes (deduplicating)
    const allScopes = additionalScopes
      ? [...new Set([...MICROSOFT_SCOPES, ...additionalScopes])]
      : MICROSOFT_SCOPES;

    return { verifier, challenge, state, allScopes };
  };

  switch (transport.mode) {
    case 'loopback': {
      const { verifier, challenge, state, allScopes } = prepareAuthFlow();
      let browserOpened = false;

      void microsoftLoopbackController.start({
        state,
        timeoutMs: PENDING_AUTH_TTL_MS,
        includeStateInCallbackUrl: false,
        buildAuthUrl: (callbackUrl) => {
          const redirectUri = callbackUrl.toString();
          registerPendingMicrosoftAuth({
            clientId,
            codeVerifier: verifier,
            state,
            redirectUri,
            callbacks,
            persistToDisk: false,
            armTimeout: false,
          });

          return buildMicrosoftAuthUrl({
            clientId,
            redirectUri,
            scopes: allScopes,
            codeChallenge: challenge,
            state,
            additionalScopes,
            loginHint,
          });
        },
        openAuthUrl: async (authUrl) => {
          const authUrlString = await openMicrosoftAuthInBrowser(authUrl, 'loopback');
          browserOpened = true;
          callbacks.onBrowserOpened?.(authUrlString);
        },
        onSuccess: async ({ code, state: returnedState }) => {
          const auth = clearPendingAuthForState(returnedState);
          if (!auth) {
            throw new Error('Microsoft OAuth loopback auth is no longer pending');
          }

          fireAndForget(
            clearPersistedPendingAuth(returnedState),
            'microsoftAuthService.loopbackSuccess',
          );

          try {
            // The token exchange persists valid credentials before the loopback
            // controller re-checks whether this flow is still current. If a
            // cancel/superseding auth — or the controller timeout — lands
            // mid-exchange, the UI may report cancellation/timeout while the
            // valid token remains saved; re-auth will simply re-save it, so
            // preserve that benign behavior.
            const email = await completeMicrosoftAuthCode({
              code,
              clientId: auth.clientId,
              codeVerifier: auth.codeVerifier,
              redirectUri: auth.redirectUri,
              state: auth.state,
              coldStart: false,
            });
            auth.resolve(email);
          } catch (err) {
            const error = toError(err);
            auth.reject(error);
            throw error;
          }
        },
      }).then((result) => {
        if (result.outcome === 'success') return;

        const error = result.outcome === 'cancelled'
          ? new Error('Auth cancelled by user')
          : mapLoopbackAuthError(result.error);
        rejectLoopbackAuthFailure(state, error, browserOpened, callbacks);
      }).catch((err) => {
        const error = toError(err);
        rejectLoopbackAuthFailure(state, error, browserOpened, callbacks);
      });

      return { authUrl: '', state };
    }

    case 'deep_link': {
      const { verifier, challenge, state, allScopes } = prepareAuthFlow();

      // Snapshot the redirect URI once per auth flow so the token exchange uses the same value
      // as the authorization request (Microsoft rejects mismatched redirect_uri).
      const redirectUri = getRedirectUri();

      const authUrl = buildMicrosoftAuthUrl({
        clientId,
        redirectUri,
        scopes: allScopes,
        codeChallenge: challenge,
        state,
        additionalScopes,
        loginHint,
      });

      registerPendingMicrosoftAuth({
        clientId,
        codeVerifier: verifier,
        state,
        redirectUri,
        callbacks,
        persistToDisk: true,
      });

      const authUrlString = authUrl.toString();
      shell.openExternal(authUrlString).then(() => {
        trackOAuthBrowserOpened({
          connectorName: 'Microsoft',
          connectorType: 'bundled',
          oauthUrl: authUrlString,
          callbackMethod: 'deep_link',
        });
        callbacks.onBrowserOpened?.(authUrlString);
      }).catch((err) => {
        log.error({ err }, 'Failed to open browser for Microsoft OAuth');
        clearPendingAuthForState(state);
        fireAndForget(clearPersistedPendingAuth(state), 'microsoftAuthService.line631');
        const wrapped = new Error('Failed to open browser for authentication');
        callbacks.rejectEmail(wrapped);
        callbacks.onBrowserOpenFailed?.(wrapped);
      });
      log.info('Opened Microsoft OAuth in system browser');

      return { authUrl: authUrlString, state };
    }

    case 'fail_loud':
      rejectMicrosoftAuthStartBlocked(transport.reason, deepLinkDeliverySupported, callbacks);
      return { authUrl: '', state: '' };

    default:
      return assertNever(transport, 'Microsoft OAuth transport selection');
  }
}

/**
 * Start OAuth flow for a new Microsoft account.
 * The callback will be handled by handleMicrosoftOAuthCallback when the deep link arrives.
 *
 * @param clientId - Azure AD application client ID
 * @param additionalScopes - Optional extra scopes for incremental consent (merged with base scopes)
 * @param loginHint - Optional email hint for incremental consent (skips account picker)
 */
export async function startMicrosoftAuth(
  clientId: string,
  additionalScopes?: string[],
  loginHint?: string,
): Promise<string> {
  // Cancel any pending auth
  cancelMicrosoftAuth();

  return new Promise((resolve, reject) => {
    setupAndOpenMicrosoftAuth(clientId, additionalScopes, loginHint, {
      resolveEmail: resolve,
      rejectEmail: reject,
    });
  });
}

export interface BeginMicrosoftAuthFlowOptions {
  /** Extra scopes merged on top of MICROSOFT_BASE_SCOPES (e.g. Sites.Read.All). */
  scopes?: string[];
  /** Marks the flow as incremental consent — sets prompt=consent + login_hint when both this and loginHint/targetEmail are set. */
  incremental?: boolean;
  /** Existing account email used to skip the account picker on incremental consent. */
  loginHint?: string;
  /** Alias for loginHint (matches AuthOrchestratorContext.email). */
  targetEmail?: string;
}

export interface BeginMicrosoftAuthFlowResult {
  authUrl: string;
  state: string;
  /**
   * Resolves with the authenticated email once the deep-link callback completes,
   * or rejects on cancel / timeout / browser-open failure. Callers that don't
   * need the email (e.g. host orchestrators that just kick off the browser)
   * MUST still attach a catch handler to avoid unhandled rejection warnings;
   * the helper attaches a no-op catch internally as a safety net.
   */
  awaitedEmail: Promise<string>;
}

/**
 * Non-blocking entry point used by the `microsoftApi` host OAuth orchestrator.
 * Resolves with `{ authUrl, state, awaitedEmail }` as soon as the system
 * browser is opened, so the calling MCP can return the URL to the agent
 * without blocking on user consent.
 *
 * The existing `startMicrosoftAuth()` await-resolves-with-email contract is
 * preserved for all three production callers (microsoftHandlers.ts × 2 +
 * inboxBridgeStateMachine.ts).
 */
export async function beginMicrosoftAuthFlow(
  clientId: string,
  options: BeginMicrosoftAuthFlowOptions = {},
): Promise<BeginMicrosoftAuthFlowResult> {
  cancelMicrosoftAuth();

  const loginHint = options.loginHint ?? options.targetEmail;

  let resolveEmail!: (email: string) => void;
  let rejectEmail!: (err: Error) => void;
  const awaitedEmail = new Promise<string>((resolve, reject) => {
    resolveEmail = resolve;
    rejectEmail = reject;
  });
  // Attach a no-op catch so callers that only want the authUrl don't leak
  // an unhandled rejection if the user later cancels or the flow times out.
  awaitedEmail.catch(() => undefined);

  return new Promise<BeginMicrosoftAuthFlowResult>((resolve, reject) => {
    let settled = false;
    const settleSuccess = (result: BeginMicrosoftAuthFlowResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const settleFailure = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const { authUrl, state } = setupAndOpenMicrosoftAuth(clientId, options.scopes, loginHint, {
      resolveEmail,
      rejectEmail,
      onBrowserOpened: (openedUrl) => {
        settleSuccess({ authUrl: openedUrl, state, awaitedEmail });
      },
      onBrowserOpenFailed: (err) => {
        settleFailure(err);
      },
    });

    // Defensive: if the implementation ever returns synchronously without
    // hitting the onBrowserOpened callback (e.g. test mocks), surface the
    // URL we built so callers don't deadlock.
    void authUrl;
    void state;
  });
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://microsoft/callback is received.
 *
 * If no in-memory pendingAuth exists (e.g., app restarted during the OAuth flow),
 * falls back to persisted auth state from disk to complete the token exchange.
 */
export async function handleMicrosoftOAuthCallback(url: string): Promise<void> {
  let clientId: string;
  let codeVerifier: string;
  let state: string;
  let isColdStart = false;
  // Snapshotted at auth-start for the in-memory path so token exchange uses the same redirect URI
  // as the authorization request. Undefined in the cold-start path (process restarted during OAuth);
  // there we fall back to the current env value, which has the same drift risk pre-existing F1.
  let callbackRedirectUri: string | undefined;
  let resolve: ((email: string) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    if (!returnedState) {
      log.error('Received Microsoft OAuth callback without state parameter');
      getErrorReporter().captureMessage('Microsoft OAuth state mismatch - possible CSRF', {
        level: 'error',
        tags: { area: 'auth', component: 'microsoft-oauth', flow: 'callback', security: 'csrf' },
      });
      return;
    }

    if (pendingAuth) {
      // Validate before consuming the pending auth. A stale callback must not clear a newer attempt.
      if (returnedState !== pendingAuth.state) {
        if (isRecentlyCompletedAuthState(returnedState)) {
          log.warn(
            { hasPendingAuth: true },
            'Ignoring duplicate Microsoft OAuth callback for recently completed auth',
          );
          return;
        }

        log.error(
          { returnedState, expectedState: '[present]' },
          '[SECURITY] OAuth state mismatch - possible CSRF attack',
        );
        getErrorReporter().captureMessage('Microsoft OAuth state mismatch - possible CSRF', {
          level: 'error',
          tags: { area: 'auth', component: 'microsoft-oauth', flow: 'callback', security: 'csrf' },
        });
        return;
      }

      // Normal path: in-memory state from the same process that started auth.
      // redirectUri snapshot is reused here to keep token-exchange aligned with the auth URL.
      ({ clientId, codeVerifier, state, redirectUri: callbackRedirectUri } = pendingAuth);
      resolve = pendingAuth.resolve;
      reject = pendingAuth.reject;
      clearPendingAuthTimeout(pendingAuth);
      pendingAuth = null;
    } else {
      // Cold-start path: app restarted during OAuth, try persisted state
      const persisted = await loadPersistedPendingAuth();
      if (!persisted) {
        if (isRecentlyCompletedAuthState(returnedState)) {
          log.warn(
            { uptimeSeconds: Math.round(process.uptime()) },
            'Ignoring duplicate Microsoft OAuth callback for recently completed auth',
          );
          return;
        }

        log.warn({ uptimeSeconds: Math.round(process.uptime()) },
          'Received Microsoft OAuth callback but no auth is pending (in-memory or persisted)');
        // Ledger-only telemetry (registry sink policy) — was a raw info
        // captureMessage; see 260610 improve-sentry-noise Stage 5.
        captureKnownCondition(
          'microsoft_oauth_no_pending_callback',
          {
            tags: { area: 'auth', component: 'microsoft-oauth', flow: 'callback' },
            extra: {
              uptimeSeconds: Math.round(process.uptime()),
              coldStart: true,
              protocolLaunch: process.argv.some(a => a.startsWith('mindstone://')),
            },
          },
          new Error('Microsoft OAuth callback received with no pending auth'),
        );
        return;
      }

      if (returnedState !== persisted.state) {
        if (isRecentlyCompletedAuthState(returnedState)) {
          log.warn(
            { uptimeSeconds: Math.round(process.uptime()) },
            'Ignoring duplicate Microsoft OAuth callback for recently completed auth',
          );
          return;
        }

        log.error(
          { returnedState, expectedState: '[present]', coldStart: true },
          '[SECURITY] OAuth state mismatch - possible CSRF attack',
        );
        getErrorReporter().captureMessage('Microsoft OAuth state mismatch - possible CSRF', {
          level: 'error',
          tags: { area: 'auth', component: 'microsoft-oauth', flow: 'callback', security: 'csrf' },
          extra: { coldStart: true },
        });
        return;
      }

      isColdStart = true;
      log.info({ uptimeSeconds: Math.round(process.uptime()) },
        'Recovering Microsoft OAuth from persisted state (cold-start callback)');
      ({ clientId, codeVerifier, state } = persisted);
    }

    // Clear persisted state only after the returned state has been validated.
    fireAndForget(clearPersistedPendingAuth(state), 'microsoftAuthService.line867');

    if (error || !code) {
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    const email = await completeMicrosoftAuthCode({
      code,
      clientId,
      codeVerifier,
      redirectUri: callbackRedirectUri ?? getRedirectUri(),
      state,
      coldStart: isColdStart,
    });
    resolve?.(email);
  } catch (err) {
    log.error({ err, coldStart: isColdStart }, 'Microsoft OAuth callback failed');
    getErrorReporter().captureException(toError(err), {
      tags: { area: 'auth', component: 'microsoft-oauth', flow: 'callback' },
      extra: { coldStart: isColdStart },
    });
    reject?.(toError(err));
  }
}
