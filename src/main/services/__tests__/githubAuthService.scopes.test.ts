/**
 * Regression tests for the GitHub OAuth empty-scopes bug.
 *
 * Root cause: `GITHUB_SCOPES` was an empty array, so the `scope` param was
 * omitted from the authorize URL and GitHub returned a zero-scope token. The
 * hosted GitHub MCP server accepted `get_me` on that token but rejected
 * scope-gated tools like `search_repositories` with a misleading
 * "Authentication required" surface error.
 *
 * See docs-private/investigations/260423_github_mcp_partial_auth_empty_scopes.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

type MockLoopbackHandler = (
  req: { method?: string; url?: string },
  res: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> },
) => void;
type MockLoopbackServer = {
  handler: MockLoopbackHandler;
  listen: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let testTokensDir: string;
const openExternalMock = vi.fn().mockResolvedValue(undefined);
const mockElectronApp = vi.hoisted(() => ({ isPackaged: true }));
const mockTrackOAuthBrowserOpened = vi.hoisted(() => vi.fn());
const mockTrackOAuthStartBlocked = vi.hoisted(() => vi.fn());
const mockGetAvailablePort = vi.hoisted(() =>
  vi.fn(async (_preferredPort?: number, _host?: '127.0.0.1' | 'localhost') => 31_337),
);
const mockHttp = vi.hoisted(() => {
  const state = {
    servers: [] as MockLoopbackServer[],
  };

  const createServer = vi.fn((handler: MockLoopbackHandler) => {
    const server = {
      handler,
      listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
        callback?.();
        return server;
      }),
      on: vi.fn(() => server),
      close: vi.fn((callback?: (err?: Error & { code?: string }) => void) => {
        callback?.();
        return server;
      }),
    };
    state.servers.push(server);
    return server;
  });

  return { createServer, state };
});

vi.mock('electron', () => ({
  app: mockElectronApp,
  shell: { openExternal: (...args: unknown[]) => openExternalMock(...args) },
}));

vi.mock('node:http', () => ({
  default: { createServer: mockHttp.createServer },
  createServer: mockHttp.createServer,
}));

vi.mock('../../utils/systemUtils', () => ({
  getAvailablePort: (preferredPort?: number, host?: '127.0.0.1' | 'localhost') =>
    mockGetAvailablePort(preferredPort, host),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mockTrackOAuthBrowserOpened,
  trackOAuthStartBlocked: mockTrackOAuthStartBlocked,
}));

vi.mock('../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
  generateCsrfState: () => 'test-state',
}));

vi.mock('../../utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => testTokensDir,
}));

const originalPlatform = process.platform;
const originalDefaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');

function setDeepLinkRuntime(input: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  defaultApp?: boolean;
}): void {
  mockElectronApp.isPackaged = input.isPackaged;
  Object.defineProperty(process, 'platform', { value: input.platform, configurable: true });
  Object.defineProperty(process, 'defaultApp', {
    value: input.defaultApp ?? false,
    configurable: true,
  });
}

function restoreRuntime(): void {
  mockElectronApp.isPackaged = true;
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalDefaultAppDescriptor) {
    Object.defineProperty(process, 'defaultApp', originalDefaultAppDescriptor);
  } else {
    delete (process as unknown as { defaultApp?: boolean }).defaultApp;
  }
}

function setGitHubEnv(): void {
  vi.stubEnv('GITHUB_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'test-client-secret');
}

describe('githubAuthService – OAuth scopes (260423 fix)', () => {
  beforeEach(async () => {
    testTokensDir = path.join(os.tmpdir(), `rebel-test-github-scopes-${Date.now()}-${Math.random()}`);
    await fs.mkdir(testTokensDir, { recursive: true });
    restoreRuntime();
    openExternalMock.mockClear();
    openExternalMock.mockResolvedValue(undefined);
    mockTrackOAuthBrowserOpened.mockClear();
    mockTrackOAuthStartBlocked.mockClear();
    mockGetAvailablePort.mockClear();
    mockGetAvailablePort.mockResolvedValue(31_337);
    mockHttp.state.servers.length = 0;
  });

  afterEach(async () => {
    restoreRuntime();
    vi.unstubAllEnvs();
    await fs.rm(testTokensDir, { recursive: true, force: true });
  });

  describe('authorize URL', () => {
    it('uses loopback OAuth on unpackaged source builds that cannot receive deep links', async () => {
      vi.resetModules();
      setDeepLinkRuntime({ isPackaged: false, platform: 'darwin' });
      setGitHubEnv();
      const mod = await import('../githubAuthService');

      const pending = mod.startGitHubAuth();
      pending.catch(() => {});
      await vi.waitFor(() => {
        expect(openExternalMock).toHaveBeenCalledTimes(1);
      });

      const [urlArg] = openExternalMock.mock.calls[0];
      const url = new URL(String(urlArg));
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:31337/callback');
      expect(mockGetAvailablePort).toHaveBeenCalledWith(undefined, '127.0.0.1');
      expect(mockTrackOAuthStartBlocked).not.toHaveBeenCalled();
      mod.cancelGitHubAuth();
      await expect(pending).rejects.toThrow('Auth cancelled by user');
    });

    it('uses loopback on unpackaged Windows dev builds with deep-link delivery', async () => {
      vi.resetModules();
      setDeepLinkRuntime({ isPackaged: false, platform: 'win32', defaultApp: true });
      setGitHubEnv();
      const mod = await import('../githubAuthService');

      const pending = mod.startGitHubAuth();
      pending.catch(() => {});
      await vi.waitFor(() => {
        expect(openExternalMock).toHaveBeenCalledTimes(1);
      });

      const [urlArg] = openExternalMock.mock.calls[0];
      const url = new URL(String(urlArg));
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:31337/callback');
      expect(mockTrackOAuthStartBlocked).not.toHaveBeenCalled();
      mod.cancelGitHubAuth();
      await expect(pending).rejects.toThrow('Auth cancelled by user');
    });

    it('does not fail-loud in packaged builds', async () => {
      vi.resetModules();
      setDeepLinkRuntime({ isPackaged: true, platform: 'darwin' });
      setGitHubEnv();
      const mod = await import('../githubAuthService');

      const pending = mod.startGitHubAuth();
      pending.catch(() => {});
      await new Promise((r) => setImmediate(r));

      expect(openExternalMock).toHaveBeenCalledTimes(1);
      expect(mockTrackOAuthStartBlocked).not.toHaveBeenCalled();
      mod.cancelGitHubAuth();
      await expect(pending).rejects.toThrow('Auth cancelled by user');
    });

    it('includes `scope=repo read:org` when starting auth', async () => {
      vi.resetModules();
      // Since the OSS env-only OAuth rework (Stage 7), startGitHubAuth() resolves
      // credentials from GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET up front and
      // throws (never reaching shell.openExternal) if either is unset. Supply
      // throwaway values so the authorize URL is built; the test only inspects
      // the `scope` param, not the credentials. Save & restore any pre-existing
      // values so an env-populated CI/dev worker isn't polluted by this test.
      const prevClientId = process.env.GITHUB_CLIENT_ID;
      const prevClientSecret = process.env.GITHUB_CLIENT_SECRET;
      process.env.GITHUB_CLIENT_ID = 'test-client-id';
      process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
      let mod: typeof import('../githubAuthService') | undefined;
      try {
        mod = await import('../githubAuthService');

        // startGitHubAuth returns a pending promise that resolves only after the
        // OAuth callback fires. We only care about the URL it passes to
        // shell.openExternal, so we kick it off and inspect immediately, then
        // cancel to clean up the pending promise.
        const pending = mod.startGitHubAuth();

        // Swallow the rejection from cancelGitHubAuth below so the test doesn't
        // fail on an unhandled rejection.
        pending.catch(() => {});

        // Wait one microtask for the internal promise to attach .then() to the
        // openExternal mock call.
        await new Promise((r) => setImmediate(r));

        expect(openExternalMock).toHaveBeenCalledTimes(1);
        const [urlArg] = openExternalMock.mock.calls[0];
        expect(typeof urlArg).toBe('string');
        const url = new URL(urlArg as string);

        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        // URLSearchParams decodes the value for us; GitHub accepts either
        // space- or plus-separated scopes, URLSearchParams serializes as `+`.
        const scope = url.searchParams.get('scope');
        expect(scope).toBe('repo read:org');
      } finally {
        mod?.cancelGitHubAuth();
        if (prevClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
        else process.env.GITHUB_CLIENT_ID = prevClientId;
        if (prevClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
        else process.env.GITHUB_CLIENT_SECRET = prevClientSecret;
      }
    });

    it('exports `repo` and `read:org` as the requested scopes', async () => {
      vi.resetModules();
      const mod = await import('../githubAuthService');
      expect(mod.GITHUB_SCOPES).toEqual(['repo', 'read:org']);
    });
  });

  describe('getGitHubStatus – scope sufficiency', () => {
    async function writeToken(tokenJson: Record<string, unknown>): Promise<void> {
      const tokensPath = path.join(testTokensDir, 'GitHub_tokens.json');
      await fs.writeFile(tokensPath, JSON.stringify(tokenJson, null, 2));
    }

    it('returns connected:false when no token file exists', async () => {
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: false });
    });

    it('returns connected:false for a zero-scope token (pre-fix state)', async () => {
      // This is exactly the shape of the broken token persisted by the pre-fix
      // OAuth flow — see investigation doc for the real on-disk sample.
      await writeToken({ access_token: 'gho_fake_underscoped', token_type: 'bearer', scope: '' });
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: false });
    });

    it('returns connected:false when scope is missing read:org', async () => {
      await writeToken({ access_token: 'gho_fake_partial', token_type: 'bearer', scope: 'repo' });
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: false });
    });

    it('returns connected:true when scope covers repo and read:org (space-separated)', async () => {
      await writeToken({
        access_token: 'gho_fake_ok',
        token_type: 'bearer',
        scope: 'repo read:org',
      });
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: true });
    });

    it('returns connected:true when scope covers repo and read:org (comma-separated)', async () => {
      // GitHub's `/access_token` JSON endpoint uses commas; cover both forms.
      await writeToken({
        access_token: 'gho_fake_ok2',
        token_type: 'bearer',
        scope: 'repo,read:org',
      });
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: true });
    });

    it('returns connected:true when scope includes extra scopes beyond required', async () => {
      await writeToken({
        access_token: 'gho_fake_broad',
        token_type: 'bearer',
        scope: 'repo read:org workflow user:email',
      });
      vi.resetModules();
      const mod = await import('../githubAuthService');
      const status = await mod.getGitHubStatus();
      expect(status).toEqual({ connected: true });
    });
  });

  describe('migrateStaleGitHubTokens', () => {
    async function writeFiles(tokenJson: Record<string, unknown>): Promise<void> {
      const tokensPath = path.join(testTokensDir, 'GitHub_tokens.json');
      const clientPath = path.join(testTokensDir, 'GitHub_client.json');
      await fs.writeFile(tokensPath, JSON.stringify(tokenJson, null, 2));
      await fs.writeFile(clientPath, JSON.stringify({ client_id: 'x' }, null, 2));
    }

    async function exists(p: string): Promise<boolean> {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    }

    it('deletes token AND client files when scope is empty', async () => {
      await writeFiles({ access_token: 'gho_fake', token_type: 'bearer', scope: '' });
      vi.resetModules();
      const mod = await import('../githubAuthService');

      await mod.migrateStaleGitHubTokens();

      expect(await exists(path.join(testTokensDir, 'GitHub_tokens.json'))).toBe(false);
      expect(await exists(path.join(testTokensDir, 'GitHub_client.json'))).toBe(false);
    });

    it('preserves files when scope is sufficient', async () => {
      await writeFiles({
        access_token: 'gho_fake_ok',
        token_type: 'bearer',
        scope: 'repo read:org',
      });
      vi.resetModules();
      const mod = await import('../githubAuthService');

      await mod.migrateStaleGitHubTokens();

      expect(await exists(path.join(testTokensDir, 'GitHub_tokens.json'))).toBe(true);
      expect(await exists(path.join(testTokensDir, 'GitHub_client.json'))).toBe(true);
    });

    it('is a no-op when no token file exists', async () => {
      vi.resetModules();
      const mod = await import('../githubAuthService');
      // Should not throw.
      await expect(mod.migrateStaleGitHubTokens()).resolves.toBeUndefined();
    });
  });
});
