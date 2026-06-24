/**
 * Stage 3a cloud — credential-rejection recovery via REST route handlers.
 *
 * Verifies that calling the cloud settings or codex-token routes CLEARS the
 * credentialRejectionTracker so that a previously-blocked CloudAutomationScheduler
 * can proceed on its next tick. This is the cloud equivalent of the desktop
 * IPC clear hooks in settingsHandlers.ts / codexHandlers.ts.
 *
 * Safety properties tested:
 *   1. After the tracker trips (blocking automations), a settings PUT to the cloud
 *      route clears the non-codex sources so the next spawn is unblocked.
 *   2. After the tracker trips on codex-subscription, a codex-token POST clears it.
 *   3. A codex-token clear (tokens: null) also clears the codex-subscription source.
 *
 * Tests hit the real route handler seam directly (handleSettings, handleCodexTokens)
 * and use the real credentialRejectionTracker singleton — the same instance the
 * CloudAutomationScheduler imports — confirming same-process tenancy.
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real singleton — same module the CloudAutomationScheduler imports.
import { credentialRejectionTracker, REJECTED_CONSECUTIVE_THRESHOLD } from '@core/services/credentialRejectionTracker';

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the route handlers can be imported in isolation
// ---------------------------------------------------------------------------

vi.mock('@core/services/diagnostics/settingsDriftDetector', () => ({
  createSettingsDriftEmissionCache: vi.fn(() => ({})),
  detectSettingsDrift: vi.fn(() => []),
  consumeSettingsDriftEmissionDecision: vi.fn(() => ({ shouldEmit: false, observations: [], eventState: 'stable' })),
}));

vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent: vi.fn(),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: vi.fn(),
  })),
  setErrorReporter: vi.fn(),
}));

vi.mock('@shared/cloudSettingsPolicy', () => ({
  stripLocalSettings: vi.fn((body: unknown) => body),
  stripSensitiveSettingsForClient: vi.fn((s: unknown) => s),
}));

vi.mock('@shared/utils/learnedLimitsMergeGuard', () => ({
  mergeIncomingProfilesPreservingLearned: vi.fn((_local: unknown, incoming: unknown) => incoming),
}));

// codexTokens.ts dependencies
vi.mock('@core/services/codexTokenStorage', () => ({
  saveCodexTokens: vi.fn(),
  clearCodexTokens: vi.fn(),
  hasCodexTokens: vi.fn(() => true),
  CodexTokensSchema: {
    safeParse: vi.fn((data: unknown) => ({
      success: true,
      data: {
        accountEmail: undefined,
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600_000,
        ...(typeof data === 'object' && data !== null ? data : {}),
      },
    })),
  },
}));

vi.mock('@core/services/settingsStore/index', () => ({
  getSettings: vi.fn(() => ({ activeProvider: 'codex' })),
  updateSettings: vi.fn(),
  applyCodexProviderHeal: vi.fn(() => ({ migrated: { activeProvider: 'codex' }, healed: false })),
}));

vi.mock('@core/rebelCore/managedKeyAvailability', () => ({
  getManagedKeyAvailability: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// HTTP mock helpers
// ---------------------------------------------------------------------------

interface MockRes {
  _status: number;
  _body: string;
  statusCode: number;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function createMockRes(): http.ServerResponse & MockRes {
  const res: MockRes = {
    _status: 0,
    _body: '',
    statusCode: 0,
    setHeader() {},
    getHeader() { return undefined; },
    writeHead(status: number) { this._status = status; this.statusCode = status; },
    end(body?: string) { if (body) this._body = body; },
  };
  return res as unknown as http.ServerResponse & MockRes;
}

function createPutReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.headers = { host: 'cloud.local', 'content-type': 'application/json' };
  req.url = '/api/settings';
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
    req.emit('end');
  });
  return req;
}

function createPostReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'POST';
  req.headers = { host: 'cloud.local', 'content-type': 'application/json' };
  req.url = '/api/codex/tokens';
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
    req.emit('end');
  });
  return req;
}

// ---------------------------------------------------------------------------
// Shared fake CloudServiceDeps for handleSettings
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<{
  getSettings: () => Record<string, unknown>;
  updateSettings: (p: unknown) => void;
  refreshAnalyticsIdentity: () => void;
}> = {}) {
  return {
    getSettings: vi.fn(() => ({ activeProvider: 'anthropic', models: { apiKey: 'fake-test-key' } })),
    updateSettings: vi.fn(),
    refreshAnalyticsIdentity: vi.fn(),
    ...overrides,
  };
}

// All known credential sources — cleared between tests to prevent state bleed.
const ALL_TEST_SOURCES = [
  'anthropic-api-key',
  'anthropic-oauth-token',
  'openrouter-oauth-token',
  'codex-subscription',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const source of ALL_TEST_SOURCES) {
    credentialRejectionTracker.clear(source);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud credential-rejection recovery via REST routes (Stage 3a)', () => {

  describe('handleSettings PUT — clears non-codex rejection sources', () => {
    it('clears anthropic-api-key rejection after settings update', async () => {
      const { handleSettings } = await import('../settings');
      const deps = makeDeps();

      // Trip the tracker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-api-key');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(true);

      const req = createPutReq({ models: { apiKey: 'fake-new-valid-key' } });
      const res = createMockRes();
      await handleSettings(req, res, deps as never);

      expect(res._status).toBe(200);
      // Tracker must be cleared so the next scheduled spawn is unblocked.
      expect(credentialRejectionTracker.isRejected('anthropic-api-key')).toBe(false);
    });

    it('clears anthropic-oauth-token rejection after settings update', async () => {
      const { handleSettings } = await import('../settings');
      const deps = makeDeps();

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('anthropic-oauth-token');
      }
      expect(credentialRejectionTracker.isRejected('anthropic-oauth-token')).toBe(true);

      const req = createPutReq({ models: { oauthToken: 'new-oauth-token', authMethod: 'oauth-token' } });
      const res = createMockRes();
      await handleSettings(req, res, deps as never);

      expect(res._status).toBe(200);
      expect(credentialRejectionTracker.isRejected('anthropic-oauth-token')).toBe(false);
    });

    it('clears openrouter-oauth-token rejection after settings update', async () => {
      const { handleSettings } = await import('../settings');
      const deps = makeDeps();

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('openrouter-oauth-token');
      }
      expect(credentialRejectionTracker.isRejected('openrouter-oauth-token')).toBe(true);

      const req = createPutReq({ openRouter: { oauthToken: 'new-or-token', enabled: true } });
      const res = createMockRes();
      await handleSettings(req, res, deps as never);

      expect(res._status).toBe(200);
      expect(credentialRejectionTracker.isRejected('openrouter-oauth-token')).toBe(false);
    });

    it('does not clear codex-subscription (codex is handled by codexTokens route)', async () => {
      const { handleSettings } = await import('../settings');
      const deps = makeDeps();

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('codex-subscription');
      }
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(true);

      const req = createPutReq({ models: { apiKey: 'fake-new-key' } });
      const res = createMockRes();
      await handleSettings(req, res, deps as never);

      expect(res._status).toBe(200);
      // codex-subscription must NOT be cleared by the settings route.
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(true);
    });
  });

  describe('handleCodexTokens POST — clears codex-subscription rejection', () => {
    it('clears codex-subscription after a token save', async () => {
      const { handleCodexTokens } = await import('../codexTokens');

      // Trip the tracker.
      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('codex-subscription');
      }
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(true);

      const req = createPostReq({
        tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600_000 },
      });
      const res = createMockRes();
      await handleCodexTokens(req, res);

      expect(res._status).toBe(200);
      // Tracker must be cleared so the next scheduled spawn is unblocked.
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(false);
    });

    it('clears codex-subscription after tokens: null (logout)', async () => {
      const { handleCodexTokens } = await import('../codexTokens');

      for (let i = 0; i < REJECTED_CONSECUTIVE_THRESHOLD; i++) {
        credentialRejectionTracker.recordAuthFailure('codex-subscription');
      }
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(true);

      const req = createPostReq({ tokens: null });
      const res = createMockRes();
      await handleCodexTokens(req, res);

      expect(res._status).toBe(200);
      expect(credentialRejectionTracker.isRejected('codex-subscription')).toBe(false);
    });
  });
});
