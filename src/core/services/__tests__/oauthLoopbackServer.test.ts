import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthLoopbackCallbackHost, OAuthLoopbackLogger } from '../oauthLoopbackServer';

type MockLoopbackRequest = { method?: string; url?: string };
type MockLoopbackResponse = {
  status: number;
  headers: Record<string, unknown> | undefined;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
type MockLoopbackHandler = (
  req: MockLoopbackRequest,
  res: MockLoopbackResponse,
) => void;
type MockLoopbackServer = {
  handler: MockLoopbackHandler;
  eventHandlers: Map<string, (...args: unknown[]) => void>;
  listen: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  emitError: (error: unknown) => void;
};

const mockGetAvailablePort = vi.hoisted(() =>
  vi.fn(async (_preferredPort?: unknown, _host?: unknown) => 31_337),
);
const mockHttp = vi.hoisted(() => {
  const state = {
    servers: [] as MockLoopbackServer[],
  };

  const createServer = vi.fn((handler?: MockLoopbackHandler) => {
    const eventHandlers = new Map<string, (...args: unknown[]) => void>();
    let lastPort = 0;
    let lastHost = '127.0.0.1';
    const server: MockLoopbackServer = {
      handler: handler ?? (() => undefined),
      eventHandlers,
      listen: vi.fn((port: number, host: string, callback?: () => void) => {
        lastPort = port;
        lastHost = host;
        callback?.();
        return server;
      }),
      on: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
        eventHandlers.set(eventName, callback);
        return server;
      }),
      close: vi.fn((callback?: (err?: Error & { code?: string }) => void) => {
        callback?.();
        return server;
      }),
      address: vi.fn(() => ({
        address: lastHost,
        family: lastHost === 'localhost' ? 'IPv6' : 'IPv4',
        port: lastPort,
      })),
      emitError: (error: unknown) => {
        eventHandlers.get('error')?.(error);
      },
    };
    state.servers.push(server);
    return server;
  });

  return { createServer, state };
});

vi.mock('node:http', () => ({
  default: { createServer: mockHttp.createServer },
  createServer: mockHttp.createServer,
}));

vi.mock('@core/utils/systemUtils', () => ({
  getAvailablePort: (preferredPort?: unknown, host?: unknown) =>
    mockGetAvailablePort(preferredPort, host),
}));

import {
  OAuthLoopbackProviderError,
  OAuthLoopbackStateMismatchError,
  OAuthLoopbackTimeoutError,
  createOAuthLoopbackController,
} from '../oauthLoopbackServer';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function createMockResponse(): MockLoopbackResponse {
  const response = {
    status: 0,
    headers: undefined,
    body: '',
  } as MockLoopbackResponse;

  response.writeHead = vi.fn((status: number, headers?: Record<string, unknown>) => {
    response.status = status;
    response.headers = headers;
    return response;
  });
  response.end = vi.fn((body?: unknown) => {
    response.body += body === undefined ? '' : String(body);
    return response;
  });

  return response;
}

function invokeCallback(
  server: MockLoopbackServer,
  request: MockLoopbackRequest,
): MockLoopbackResponse {
  const response = createMockResponse();
  server.handler(request, response);
  return response;
}

function createLogger(): OAuthLoopbackLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createAuthUrlBuilder() {
  return vi.fn((callbackUrl: URL) => {
    const authUrl = new URL('https://auth.example.test/oauth');
    authUrl.searchParams.set('redirect_uri', callbackUrl.toString());
    return authUrl;
  });
}

async function startController(options: {
  host?: OAuthLoopbackCallbackHost;
  state?: string;
  timeoutMs?: number;
  logger?: OAuthLoopbackLogger;
} = {}) {
  const logger = options.logger ?? createLogger();
  const controller = createOAuthLoopbackController({
    providerName: 'Example Provider',
    callbackHost: options.host ?? '127.0.0.1',
    logger,
  });
  const buildAuthUrl = createAuthUrlBuilder();
  const openAuthUrl = vi.fn(async () => undefined);
  const promise = controller.start({
    state: options.state ?? 'state-fixture',
    timeoutMs: options.timeoutMs ?? 10_000,
    buildAuthUrl,
    openAuthUrl,
  });

  await vi.waitFor(() => {
    expect(openAuthUrl).toHaveBeenCalledTimes(1);
  });

  const server = mockHttp.state.servers.at(-1);
  if (!server) {
    throw new Error('Expected fake loopback server');
  }

  return { controller, promise, server, buildAuthUrl, openAuthUrl, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockHttp.state.servers.length = 0;
  mockGetAvailablePort.mockResolvedValue(31_337);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createOAuthLoopbackController', () => {
  it('real getAvailablePort probes the requested host', async () => {
    const actualSystemUtils = await vi.importActual<typeof import('@core/utils/systemUtils')>(
      '@core/utils/systemUtils',
    );

    await expect(actualSystemUtils.getAvailablePort(45_001, 'localhost')).resolves.toBe(45_001);

    const probeServer = mockHttp.state.servers.at(-1);
    expect(probeServer?.listen).toHaveBeenCalledWith(
      45_001,
      'localhost',
      expect.any(Function),
    );
  });

  it('binds the callback server and port probe to the configured host', async () => {
    const { controller, promise, server, buildAuthUrl } = await startController({
      host: 'localhost',
    });

    expect(mockGetAvailablePort).toHaveBeenCalledWith(undefined, 'localhost');
    expect(server.listen).toHaveBeenCalledWith(31_337, 'localhost', expect.any(Function));

    const callbackUrl = buildAuthUrl.mock.calls[0]?.[0] as URL;
    expect(callbackUrl.hostname).toBe('localhost');
    expect(callbackUrl.pathname).toBe('/callback');
    expect(callbackUrl.searchParams.get('state')).toBe('state-fixture');

    controller.cancel();
    await expect(promise).resolves.toEqual({ outcome: 'cancelled', reason: 'cancelled' });
  });

  it('rejects non-GET requests and non-callback paths without resolving the flow', async () => {
    const { controller, promise, server } = await startController();
    let settled = false;
    const observedPromise = promise.then((result) => {
      settled = true;
      return result;
    });

    const postResponse = invokeCallback(server, {
      method: 'POST',
      url: '/callback?code=code-fixture&state=state-fixture',
    });
    expect(postResponse.status).toBe(404);
    expect(postResponse.body).toBe('Not found');

    const wrongPathResponse = invokeCallback(server, {
      method: 'GET',
      url: '/elsewhere?code=code-fixture&state=state-fixture',
    });
    expect(wrongPathResponse.status).toBe(404);
    expect(wrongPathResponse.body).toBe('Not found');

    await Promise.resolve();
    expect(settled).toBe(false);

    controller.cancel();
    await expect(observedPromise).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'cancelled',
    });
  });

  it('rejects CSRF state mismatches and tears down without a success result', async () => {
    const { promise, server } = await startController();

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=raw-code-secret&state=wrong-state-secret',
    });

    expect(response.status).toBe(400);
    expect(response.body).not.toContain('raw-code-secret');
    expect(response.body).not.toContain('wrong-state-secret');

    const result = await promise;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBeInstanceOf(OAuthLoopbackStateMismatchError);
    }
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('rejects missing CSRF state by default', async () => {
    const { promise, server } = await startController();

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=raw-code-secret',
    });

    expect(response.status).toBe(400);

    const result = await promise;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBeInstanceOf(OAuthLoopbackStateMismatchError);
    }
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('lets providers handle CSRF when built-in state validation is skipped', async () => {
    const extractCallbackResult = vi.fn((params: URLSearchParams) => ({
      payload: params.get('payload'),
    }));
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger: createLogger(),
    });
    const openAuthUrl = vi.fn(async () => undefined);
    const promise = controller.start({
      state: 'opaque-state-fixture',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl,
      skipBuiltInStateValidation: true,
      extractCallbackResult,
    });

    await vi.waitFor(() => {
      expect(openAuthUrl).toHaveBeenCalledTimes(1);
    });

    const server = mockHttp.state.servers.at(-1);
    if (!server) {
      throw new Error('Expected fake loopback server');
    }

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?payload=provider-owned-csrf',
    });

    await expect(promise).resolves.toEqual({
      outcome: 'success',
      value: { payload: 'provider-owned-csrf' },
    });
    expect(extractCallbackResult).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('settles as an error when provider-side validation throws after skipping built-in state validation', async () => {
    const providerError = new Error('provider-side CSRF failed');
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger: createLogger(),
    });
    const openAuthUrl = vi.fn(async () => undefined);
    const promise = controller.start({
      state: 'opaque-state-fixture',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl,
      skipBuiltInStateValidation: true,
      extractCallbackResult: vi.fn(() => {
        throw providerError;
      }),
    });

    await vi.waitFor(() => {
      expect(openAuthUrl).toHaveBeenCalledTimes(1);
    });

    const server = mockHttp.state.servers.at(-1);
    if (!server) {
      throw new Error('Expected fake loopback server');
    }

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?payload=provider-owned-csrf',
    });

    const result = await promise;
    expect(result).toEqual({ outcome: 'error', error: providerError });
    expect(response.status).toBe(400);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('resolves authorization codes and closes the server on success', async () => {
    const { promise, server } = await startController();

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=code-fixture&state=state-fixture',
    });

    const result = await promise;
    expect(result).toEqual({
      outcome: 'success',
      value: { code: 'code-fixture', state: 'state-fixture' },
    });
    expect(response.status).toBe(200);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('closes the server when cancelled', async () => {
    const { controller, promise, server } = await startController();

    controller.cancel();

    await expect(promise).resolves.toEqual({ outcome: 'cancelled', reason: 'cancelled' });
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('cancels during the port probe without creating a server', async () => {
    const portProbe = deferred<number>();
    mockGetAvailablePort.mockReturnValueOnce(portProbe.promise);
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger: createLogger(),
    });
    const openAuthUrl = vi.fn(async () => undefined);

    const promise = controller.start({
      state: 'state-fixture',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl,
    });
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(1);
    });

    controller.cancel();
    portProbe.resolve(31_337);

    await expect(promise).resolves.toEqual({ outcome: 'cancelled', reason: 'cancelled' });
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(openAuthUrl).not.toHaveBeenCalled();
  });

  it('closes the server when authorization times out', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger,
    });
    const promise = controller.start({
      state: 'state-fixture',
      timeoutMs: 1_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl: vi.fn(async () => undefined),
    });

    await Promise.resolve();
    await Promise.resolve();

    const server = mockHttp.state.servers.at(-1);
    expect(server).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_000);

    const result = await promise;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBeInstanceOf(OAuthLoopbackTimeoutError);
    }
    expect(server?.close).toHaveBeenCalledTimes(1);
  });

  it('closes the server when the server emits an error', async () => {
    const { promise, server } = await startController();

    server.emitError(new Error('listen failed'));

    const result = await promise;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error.message).toBe('listen failed');
    }
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('does not log or echo raw callback secrets', async () => {
    const logger = createLogger();
    const { promise, server, buildAuthUrl } = await startController({
      state: 'raw-state-secret',
      logger,
    });
    const callbackUrl = buildAuthUrl.mock.calls[0]?.[0] as URL;

    const successResponse = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=raw-code-secret&state=raw-state-secret',
    });

    await expect(promise).resolves.toMatchObject({ outcome: 'success' });

    const loggedPayload = JSON.stringify([
      (logger.info as ReturnType<typeof vi.fn>).mock.calls,
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      (logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    const echoedPayload = successResponse.body;

    for (const secret of [
      'raw-code-secret',
      'raw-state-secret',
      'raw-token-secret',
      callbackUrl.toString(),
    ]) {
      expect(loggedPayload).not.toContain(secret);
      expect(echoedPayload).not.toContain(secret);
    }
  });

  it('does not echo provider error descriptions that may contain secrets', async () => {
    const logger = createLogger();
    const { promise, server } = await startController({
      state: 'raw-state-secret',
      logger,
    });

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?error=raw-token-secret&error_description=raw-token-secret&state=raw-state-secret',
    });

    const result = await promise;
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBeInstanceOf(OAuthLoopbackProviderError);
      expect((result.error as OAuthLoopbackProviderError).oauthError).toBe('redacted');
      expect(JSON.stringify(result.error)).not.toContain('raw-token-secret');
    }

    const loggedPayload = JSON.stringify([
      (logger.info as ReturnType<typeof vi.fn>).mock.calls,
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      (logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(response.body).not.toContain('raw-token-secret');
    expect(response.body).not.toContain('raw-state-secret');
    expect(loggedPayload).not.toContain('raw-token-secret');
    expect(loggedPayload).not.toContain('raw-state-secret');
  });

  it('does not run success side effects when cancelled during async callback extraction', async () => {
    const extraction = deferred<{ code: string; state: string }>();
    const logger = createLogger();
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger,
    });
    const onSuccess = vi.fn(async () => undefined);
    const openAuthUrl = vi.fn(async () => undefined);
    const promise = controller.start({
      state: 'state-fixture',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl,
      extractCallbackResult: vi.fn(() => extraction.promise),
      onSuccess,
      html: {
        success: () => '<h1>success-page-marker</h1>',
      },
    });

    await vi.waitFor(() => {
      expect(openAuthUrl).toHaveBeenCalledTimes(1);
    });

    const server = mockHttp.state.servers.at(-1);
    if (!server) {
      throw new Error('Expected fake loopback server');
    }

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=code-fixture&state=state-fixture',
    });
    await Promise.resolve();
    expect(response.end).not.toHaveBeenCalled();

    controller.cancel();
    await expect(promise).resolves.toEqual({ outcome: 'cancelled', reason: 'cancelled' });

    extraction.resolve({ code: 'code-fixture', state: 'state-fixture' });
    await vi.waitFor(() => {
      expect(response.end).toHaveBeenCalledTimes(1);
    });

    const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, message]) => message,
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(infoMessages).not.toContain(
      'OAuth authorization code received via loopback callback',
    );
    expect(response.status).toBe(410);
    expect(response.body).not.toContain('success-page-marker');
  });

  it('does not write success response/log or settle as success after cancelled async onSuccess', async () => {
    const successSideEffect = deferred<void>();
    const logger = createLogger();
    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger,
    });
    const onSuccess = vi.fn(() => successSideEffect.promise);
    const openAuthUrl = vi.fn(async () => undefined);
    const promise = controller.start({
      state: 'state-fixture',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl,
      extractCallbackResult: vi.fn(() => ({ code: 'code-fixture', state: 'state-fixture' })),
      onSuccess,
      html: {
        success: () => '<h1>success-page-marker</h1>',
      },
    });

    await vi.waitFor(() => {
      expect(openAuthUrl).toHaveBeenCalledTimes(1);
    });

    const server = mockHttp.state.servers.at(-1);
    if (!server) {
      throw new Error('Expected fake loopback server');
    }

    const response = invokeCallback(server, {
      method: 'GET',
      url: '/callback?code=code-fixture&state=state-fixture',
    });
    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    // onSuccess can already be running; the stale-flow guard covers controller output/settle.
    expect(response.end).not.toHaveBeenCalled();

    controller.cancel();
    const staleFlowResult = await promise;
    expect(staleFlowResult).toEqual({ outcome: 'cancelled', reason: 'cancelled' });

    successSideEffect.resolve();
    await vi.waitFor(() => {
      expect(response.end).toHaveBeenCalledTimes(1);
    });

    const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, message]) => message,
    );
    expect(infoMessages).not.toContain(
      'OAuth authorization code received via loopback callback',
    );
    expect(response.status).toBe(410);
    expect(response.status).not.toBe(200);
    expect(response.body).not.toContain('success-page-marker');
  });

  it('lets only the newest same-provider setup continue when superseded during port probing', async () => {
    const firstPortProbe = deferred<number>();
    const secondPortProbe = deferred<number>();
    mockGetAvailablePort
      .mockReturnValueOnce(firstPortProbe.promise)
      .mockReturnValueOnce(secondPortProbe.promise);

    const controller = createOAuthLoopbackController({
      providerName: 'Example Provider',
      callbackHost: '127.0.0.1',
      logger: createLogger(),
    });
    const firstOpenAuthUrl = vi.fn(async () => undefined);
    const secondOpenAuthUrl = vi.fn(async () => undefined);

    const firstPromise = controller.start({
      state: 'first-state',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl: firstOpenAuthUrl,
    });
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(1);
    });

    const secondPromise = controller.start({
      state: 'second-state',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl: secondOpenAuthUrl,
    });
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(2);
    });

    firstPortProbe.resolve(31_337);
    await expect(firstPromise).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'superseded',
    });
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(firstOpenAuthUrl).not.toHaveBeenCalled();

    secondPortProbe.resolve(31_338);
    await vi.waitFor(() => {
      expect(secondOpenAuthUrl).toHaveBeenCalledTimes(1);
    });
    expect(mockHttp.state.servers).toHaveLength(1);
    expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
      31_338,
      '127.0.0.1',
      expect.any(Function),
    );

    const response = invokeCallback(mockHttp.state.servers[0], {
      method: 'GET',
      url: '/callback?code=second-code&state=second-state',
    });

    await expect(secondPromise).resolves.toEqual({
      outcome: 'success',
      value: { code: 'second-code', state: 'second-state' },
    });
    expect(response.status).toBe(200);
  });

  it('keeps separate provider controller instances from interfering with each other', async () => {
    mockGetAvailablePort
      .mockResolvedValueOnce(31_337)
      .mockResolvedValueOnce(31_338);
    const firstController = createOAuthLoopbackController({
      providerName: 'First Provider',
      callbackHost: '127.0.0.1',
      logger: createLogger(),
    });
    const secondController = createOAuthLoopbackController({
      providerName: 'Second Provider',
      callbackHost: 'localhost',
      logger: createLogger(),
    });
    const firstOpenAuthUrl = vi.fn(async () => undefined);
    const secondOpenAuthUrl = vi.fn(async () => undefined);

    const firstPromise = firstController.start({
      state: 'first-state',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl: firstOpenAuthUrl,
    });
    const secondPromise = secondController.start({
      state: 'second-state',
      timeoutMs: 10_000,
      buildAuthUrl: createAuthUrlBuilder(),
      openAuthUrl: secondOpenAuthUrl,
    });

    await vi.waitFor(() => {
      expect(firstOpenAuthUrl).toHaveBeenCalledTimes(1);
      expect(secondOpenAuthUrl).toHaveBeenCalledTimes(1);
    });

    expect(mockHttp.state.servers).toHaveLength(2);
    expect(mockHttp.state.servers[0]?.listen).toHaveBeenCalledWith(
      31_337,
      '127.0.0.1',
      expect.any(Function),
    );
    expect(mockHttp.state.servers[1]?.listen).toHaveBeenCalledWith(
      31_338,
      'localhost',
      expect.any(Function),
    );

    invokeCallback(mockHttp.state.servers[1], {
      method: 'GET',
      url: '/callback?code=second-code&state=second-state',
    });
    invokeCallback(mockHttp.state.servers[0], {
      method: 'GET',
      url: '/callback?code=first-code&state=first-state',
    });

    await expect(firstPromise).resolves.toEqual({
      outcome: 'success',
      value: { code: 'first-code', state: 'first-state' },
    });
    await expect(secondPromise).resolves.toEqual({
      outcome: 'success',
      value: { code: 'second-code', state: 'second-state' },
    });
  });
});
