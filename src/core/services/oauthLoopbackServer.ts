import http from 'node:http';
import { getAvailablePort as getAvailablePortImpl } from '@core/utils/systemUtils';
import { googleOAuthHtml } from './oauthHtmlTemplates';

export type OAuthLoopbackCallbackHost = '127.0.0.1' | 'localhost';
export type OAuthLoopbackCancellationReason = 'cancelled' | 'superseded';
export type OAuthLoopbackAuthUrl = URL | string;

export interface OAuthLoopbackAuthorizationCode {
  code: string;
  state: string;
}

export type OAuthLoopbackResult<TValue = OAuthLoopbackAuthorizationCode> =
  | { outcome: 'success'; value: TValue }
  | { outcome: 'cancelled'; reason: OAuthLoopbackCancellationReason }
  | { outcome: 'error'; error: Error };

export class OAuthLoopbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OAuth authorization timed out after ${timeoutMs}ms`);
    this.name = 'OAuthLoopbackTimeoutError';
  }
}

export class OAuthLoopbackStateMismatchError extends Error {
  constructor() {
    super('OAuth state mismatch - possible CSRF attack');
    this.name = 'OAuthLoopbackStateMismatchError';
  }
}

export class OAuthLoopbackProviderError extends Error {
  readonly oauthError: string;

  constructor(oauthError: string) {
    super('OAuth authorization server returned an error');
    this.name = 'OAuthLoopbackProviderError';
    this.oauthError = sanitizeOAuthProviderError(oauthError);
  }
}

export class OAuthLoopbackMissingCodeError extends Error {
  constructor() {
    super('No authorization code in callback');
    this.name = 'OAuthLoopbackMissingCodeError';
  }
}

export interface OAuthLoopbackLogFields {
  [key: string]: unknown;
}

export interface OAuthLoopbackLogger {
  info: (fields: OAuthLoopbackLogFields, message: string) => void;
  warn: (fields: OAuthLoopbackLogFields, message: string) => void;
  error: (fields: OAuthLoopbackLogFields, message: string) => void;
}

export type OAuthLoopbackGetAvailablePort = (
  preferredPort?: number,
  host?: OAuthLoopbackCallbackHost,
) => Promise<number>;

export interface OAuthLoopbackRequestContext {
  providerName: string;
  generation: number;
  callbackHost: OAuthLoopbackCallbackHost;
  callbackPath: string;
  port: number;
  callbackUrl: URL;
}

export interface OAuthLoopbackBrowserContext extends OAuthLoopbackRequestContext {
  authUrl: OAuthLoopbackAuthUrl;
}

export interface OAuthLoopbackHtmlRenderers {
  success: (context: OAuthLoopbackRequestContext) => string;
  error: (message: string, context: OAuthLoopbackRequestContext) => string;
  expired: (context: OAuthLoopbackRequestContext) => string;
}

export interface CreateOAuthLoopbackControllerOptions {
  providerName: string;
  callbackHost: OAuthLoopbackCallbackHost;
  callbackPath?: string;
  getAvailablePort?: OAuthLoopbackGetAvailablePort;
  logger?: Partial<OAuthLoopbackLogger>;
}

export interface OAuthLoopbackStartOptions<TValue = OAuthLoopbackAuthorizationCode> {
  state: string;
  timeoutMs: number;
  preferredPort?: number;
  includeStateInCallbackUrl?: boolean;
  /**
   * When true, skip the controller's built-in plaintext `state` query-param CSRF
   * check. The provider's `extractCallbackResult` MUST then perform its own CSRF
   * validation (e.g. Discourse validates an RSA-encrypted `nonce` inside the
   * payload). Default false — existing OAuth consumers (OpenRouter, Microsoft)
   * keep the built-in `state` check unchanged.
   */
  skipBuiltInStateValidation?: boolean;
  buildAuthUrl: (
    callbackUrl: URL,
    context: OAuthLoopbackRequestContext,
  ) => OAuthLoopbackAuthUrl | Promise<OAuthLoopbackAuthUrl>;
  openAuthUrl: (
    authUrl: OAuthLoopbackAuthUrl,
    context: OAuthLoopbackBrowserContext,
  ) => void | Promise<void>;
  onBrowserOpened?: (context: OAuthLoopbackBrowserContext) => void;
  onSuccess?: (value: TValue, context: OAuthLoopbackRequestContext) => void | Promise<void>;
  extractCallbackResult?: (
    params: URLSearchParams,
    context: OAuthLoopbackRequestContext,
  ) => TValue | Promise<TValue>;
  html?: Partial<OAuthLoopbackHtmlRenderers>;
}

export interface OAuthLoopbackController {
  start: <TValue = OAuthLoopbackAuthorizationCode>(
    options: OAuthLoopbackStartOptions<TValue>,
  ) => Promise<OAuthLoopbackResult<TValue>>;
  cancel: (reason?: OAuthLoopbackCancellationReason) => void;
}

interface ActiveLoopbackFlow {
  generation: number;
  cancel: (reason: OAuthLoopbackCancellationReason) => void;
}

const noopLogger: OAuthLoopbackLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function normalizeCallbackPath(callbackPath: string | undefined): string {
  if (!callbackPath) return '/callback';
  if (!callbackPath.startsWith('/')) {
    throw new Error('OAuth loopback callbackPath must start with "/"');
  }
  return callbackPath;
}

function describeErrorForLog(error: unknown): OAuthLoopbackLogFields {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    const code = typeof errorWithCode.code === 'string' ? errorWithCode.code : undefined;
    return { name: error.name, code };
  }
  return { type: typeof error };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SAFE_OAUTH_PROVIDER_ERROR_CODES = new Set([
  'access_denied',
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'invalid_request',
  'invalid_scope',
  'login_required',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);

function sanitizeOAuthProviderError(oauthError: string): string {
  const normalized = oauthError.trim().toLowerCase();
  return SAFE_OAUTH_PROVIDER_ERROR_CODES.has(normalized) ? normalized : 'redacted';
}

function defaultSuccessHtml(context: OAuthLoopbackRequestContext): string {
  const providerName = escapeHtml(context.providerName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${providerName} Connected - Rebel</title>
</head>
<body>
  <h1>${providerName} connected</h1>
  <p>You can return to Rebel.</p>
</body>
</html>`;
}

function defaultErrorHtml(message: string): string {
  return googleOAuthHtml.error(message);
}

function defaultExpiredHtml(_context: OAuthLoopbackRequestContext): string {
  return defaultErrorHtml(
    'This authorization request expired. Please return to Rebel and try again.',
  );
}

function writeHtmlResponse(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function closeHttpServer(
  server: http.Server,
  logger: OAuthLoopbackLogger,
  providerName: string,
): void {
  server.close((err?: Error & { code?: string }) => {
    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
      logger.warn(
        { providerName, err: describeErrorForLog(err) },
        'OAuth loopback callback server close failed',
      );
    }
  });
}

function callbackUrlFor(
  callbackHost: OAuthLoopbackCallbackHost,
  port: number,
  callbackPath: string,
  state: string,
  includeStateInCallbackUrl: boolean,
): URL {
  const callbackUrl = new URL(`http://${callbackHost}:${port}${callbackPath}`);
  if (includeStateInCallbackUrl) {
    callbackUrl.searchParams.set('state', state);
  }
  return callbackUrl;
}

function defaultExtractAuthorizationCode(
  params: URLSearchParams,
  expectedState: string,
): OAuthLoopbackAuthorizationCode {
  const code = params.get('code');
  if (!code) {
    throw new OAuthLoopbackMissingCodeError();
  }
  return { code, state: expectedState };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown }).then === 'function';
}

export function createOAuthLoopbackController(
  options: CreateOAuthLoopbackControllerOptions,
): OAuthLoopbackController {
  const {
    providerName,
    callbackHost,
    getAvailablePort = getAvailablePortImpl,
  } = options;
  const callbackPath = normalizeCallbackPath(options.callbackPath);
  const logger: OAuthLoopbackLogger = {
    ...noopLogger,
    ...options.logger,
  };

  let activeGeneration = 0;
  let activeFlow: ActiveLoopbackFlow | null = null;
  const inactiveGenerationReasons = new Map<number, OAuthLoopbackCancellationReason>();

  const isCurrent = (generation: number): boolean => generation === activeGeneration;

  const markInactiveGeneration = (
    generation: number,
    reason: OAuthLoopbackCancellationReason,
  ): void => {
    if (generation > 0) {
      inactiveGenerationReasons.set(generation, reason);
    }
  };

  const consumeInactiveGenerationReason = (
    generation: number,
  ): OAuthLoopbackCancellationReason => {
    const reason = inactiveGenerationReasons.get(generation) ?? 'superseded';
    inactiveGenerationReasons.delete(generation);
    return reason;
  };

  const cancelActiveFlow = (reason: OAuthLoopbackCancellationReason): void => {
    const flow = activeFlow;
    if (!flow) return;
    flow.cancel(reason);
  };

  const nextGeneration = (): number => {
    markInactiveGeneration(activeGeneration, 'superseded');
    activeGeneration += 1;
    cancelActiveFlow('superseded');
    return activeGeneration;
  };

  const cancel = (reason: OAuthLoopbackCancellationReason = 'cancelled'): void => {
    markInactiveGeneration(activeGeneration, reason);
    activeGeneration += 1;
    cancelActiveFlow(reason);
  };

  const start = async <TValue = OAuthLoopbackAuthorizationCode>(
    startOptions: OAuthLoopbackStartOptions<TValue>,
  ): Promise<OAuthLoopbackResult<TValue>> => {
    const generation = nextGeneration();
    const includeStateInCallbackUrl = startOptions.includeStateInCallbackUrl ?? true;
    const html: OAuthLoopbackHtmlRenderers = {
      success: defaultSuccessHtml,
      error: (message) => defaultErrorHtml(message),
      expired: defaultExpiredHtml,
      ...startOptions.html,
    };

    let port: number;
    try {
      port = await getAvailablePort(startOptions.preferredPort, callbackHost);
    } catch (error) {
      if (!isCurrent(generation)) {
        return {
          outcome: 'cancelled',
          reason: consumeInactiveGenerationReason(generation),
        };
      }
      logger.error(
        { providerName, err: describeErrorForLog(error) },
        'OAuth loopback callback port probe failed',
      );
      return {
        outcome: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    if (!isCurrent(generation)) {
      return {
        outcome: 'cancelled',
        reason: consumeInactiveGenerationReason(generation),
      };
    }

    const callbackUrl = callbackUrlFor(
      callbackHost,
      port,
      callbackPath,
      startOptions.state,
      includeStateInCallbackUrl,
    );
    const context: OAuthLoopbackRequestContext = {
      providerName,
      generation,
      callbackHost,
      callbackPath,
      port,
      callbackUrl,
    };

    let authUrl: OAuthLoopbackAuthUrl;
    try {
      authUrl = await startOptions.buildAuthUrl(callbackUrl, context);
    } catch (error) {
      if (!isCurrent(generation)) {
        return {
          outcome: 'cancelled',
          reason: consumeInactiveGenerationReason(generation),
        };
      }
      logger.error(
        { providerName, err: describeErrorForLog(error) },
        'OAuth loopback auth URL construction failed',
      );
      return {
        outcome: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    if (!isCurrent(generation)) {
      return {
        outcome: 'cancelled',
        reason: consumeInactiveGenerationReason(generation),
      };
    }

    return new Promise<OAuthLoopbackResult<TValue>>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const browserContext: OAuthLoopbackBrowserContext = { ...context, authUrl };
      const server = http.createServer((req, res) => {
        void handleRequest(req, res).catch((error: unknown) => {
          logger.error(
            { providerName, err: describeErrorForLog(error) },
            'OAuth loopback callback request failed',
          );
          if (!res.headersSent) {
            writeHtmlResponse(
              res,
              400,
              html.error('Authorization failed. Please return to Rebel and try again.', context),
            );
          }
          settleError(error instanceof Error ? error : new Error(String(error)));
        });
      });

      const settle = (result: OAuthLoopbackResult<TValue>): void => {
        if (settled) return;
        settled = true;
        inactiveGenerationReasons.delete(generation);
        if (activeFlow?.generation === generation) {
          activeFlow = null;
        }
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        closeHttpServer(server, logger, providerName);
        resolve(result);
      };

      function settleError(error: Error): void {
        settle({ outcome: 'error', error });
      }

      async function handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ): Promise<void> {
        const requestUrl = new URL(req.url ?? '/', `http://${callbackHost}:${port}`);

        if (req.method !== 'GET' || requestUrl.pathname !== callbackPath) {
          writeNotFound(res);
          return;
        }

        if (!isCurrent(generation)) {
          writeHtmlResponse(res, 410, html.expired(context));
          settle({
            outcome: 'cancelled',
            reason: consumeInactiveGenerationReason(generation),
          });
          return;
        }

        const params = requestUrl.searchParams;
        if (!startOptions.skipBuiltInStateValidation) {
          const returnedState = params.get('state');
          if (!returnedState || returnedState !== startOptions.state) {
            logger.error(
              {
                providerName,
                returnedStatePresent: Boolean(returnedState),
                expectedStatePresent: true,
              },
              '[SECURITY] OAuth state mismatch - possible CSRF attack',
            );
            writeHtmlResponse(
              res,
              400,
              html.error('Security validation failed. Please return to Rebel and try again.', context),
            );
            settleError(new OAuthLoopbackStateMismatchError());
            return;
          }
        }

        const oauthError = params.get('error');
        if (oauthError) {
          logger.error(
            { providerName, oauthErrorPresent: true },
            'OAuth loopback callback returned authorization error',
          );
          writeHtmlResponse(
            res,
            400,
            html.error(
              'The authorization server returned an error. Please return to Rebel and try again.',
              context,
            ),
          );
          settleError(new OAuthLoopbackProviderError(oauthError));
          return;
        }

        try {
          const extractCallbackResult = startOptions.extractCallbackResult
            ?? ((paramsToExtract: URLSearchParams) =>
              defaultExtractAuthorizationCode(paramsToExtract, startOptions.state) as TValue);
          const completeSuccessfulCallback = (value: TValue): void | Promise<void> => {
            if (!isCurrent(generation)) {
              writeHtmlResponse(res, 410, html.expired(context));
              return;
            }

            const writeSuccess = (): void => {
              if (!isCurrent(generation)) {
                writeHtmlResponse(res, 410, html.expired(context));
                return;
              }

              logger.info(
                { providerName, callbackHost, port },
                'OAuth authorization code received via loopback callback',
              );
              writeHtmlResponse(res, 200, html.success(context));
              settle({ outcome: 'success', value });
            };

            if (!startOptions.onSuccess) {
              writeSuccess();
              return;
            }

            return Promise.resolve(startOptions.onSuccess(value, context)).then(writeSuccess);
          };

          const extractedValue = extractCallbackResult(params, context);
          if (isPromiseLike(extractedValue)) {
            const value = await extractedValue;
            await completeSuccessfulCallback(value);
            return;
          }

          const completion = completeSuccessfulCallback(extractedValue);
          if (completion && isPromiseLike(completion)) {
            await completion;
          }
        } catch (error) {
          if (!isCurrent(generation)) {
            writeHtmlResponse(res, 410, html.expired(context));
            return;
          }

          logger.error(
            { providerName, err: describeErrorForLog(error) },
            'OAuth loopback callback handling failed',
          );
          writeHtmlResponse(
            res,
            400,
            html.error('Authorization failed. Please return to Rebel and try again.', context),
          );
          settleError(error instanceof Error ? error : new Error(String(error)));
        }
      }

      timeout = setTimeout(() => {
        if (!isCurrent(generation)) {
          settle({
            outcome: 'cancelled',
            reason: consumeInactiveGenerationReason(generation),
          });
          return;
        }

        logger.warn(
          { providerName, timeoutMs: startOptions.timeoutMs },
          'OAuth loopback authorization timed out',
        );
        settleError(new OAuthLoopbackTimeoutError(startOptions.timeoutMs));
      }, startOptions.timeoutMs);

      activeFlow = {
        generation,
        cancel: (reason) => {
          settle({ outcome: 'cancelled', reason });
        },
      };

      server.listen(port, callbackHost, () => {
        if (!isCurrent(generation)) {
          settle({
            outcome: 'cancelled',
            reason: consumeInactiveGenerationReason(generation),
          });
          return;
        }

        logger.info(
          { providerName, callbackHost, port },
          'OAuth loopback callback server started',
        );

        void Promise.resolve(startOptions.openAuthUrl(authUrl, browserContext))
          .then(() => {
            if (!isCurrent(generation)) return;
            try {
              startOptions.onBrowserOpened?.(browserContext);
            } catch (error) {
              logger.warn(
                { providerName, err: describeErrorForLog(error) },
                'OAuth loopback browser-opened callback failed',
              );
            }
          })
          .catch((error: unknown) => {
            if (!isCurrent(generation)) {
              settle({
                outcome: 'cancelled',
                reason: consumeInactiveGenerationReason(generation),
              });
              return;
            }

            logger.error(
              { providerName, err: describeErrorForLog(error) },
              'Failed to open browser for OAuth loopback authorization',
            );
            settleError(new Error('Failed to open browser for authentication'));
          });
      });

      server.on('error', (error) => {
        if (!isCurrent(generation)) {
          settle({
            outcome: 'cancelled',
            reason: consumeInactiveGenerationReason(generation),
          });
          return;
        }

        logger.error(
          { providerName, err: describeErrorForLog(error) },
          'OAuth loopback callback server error',
        );
        settleError(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  return { start, cancel };
}
