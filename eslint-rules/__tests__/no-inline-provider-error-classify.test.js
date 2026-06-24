import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-inline-provider-error-classify.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const clientFile = 'src/core/rebelCore/clients/openaiClient.ts';

ruleTester.run('no-inline-provider-error-classify', rule, {
  valid: [
    {
      // NON-VACUITY's mirror: the POST-FIX shape (the actual fix) must pass.
      // It reads type/code from the provider error frame AND delegates to the
      // shared classifyStatus — only using server_error as the unknown fallback.
      name: 'post-fix delegating in-stream classifier passes (calls classifyStatus)',
      filename: clientFile,
      code: `
        function handleChatChunkPayload(maybeError) {
          if (maybeError.error && !maybeError.choices) {
            const { code, type, message } = maybeError.error;
            const errorMessage = message ?? 'OpenAI-compatible streaming error';
            const statusHint = type === 'invalid_request_error' || code === 'invalid_prompt' ? 400 : undefined;
            const classified = classifyStatus(statusHint, errorMessage, { type, code });
            const classifiedKind = classified.kind;
            const kind = classifiedKind === 'unknown' ? 'server_error' : classifiedKind;
            throw new ModelError(kind, errorMessage, undefined, this.provider);
          }
        }
      `,
    },
    {
      name: 'legit transport mint: empty response body (no type/code read)',
      filename: clientFile,
      code: `
        function doCodexStream(response) {
          if (!response.body) {
            throw new ModelError('server_error', 'Codex streaming response body is empty', response.status, this.provider);
          }
        }
      `,
    },
    {
      name: 'legit transport mint: stream first-chunk timeout (constant message, no discriminator)',
      filename: clientFile,
      code: `
        function stream() {
          if (streamStartTimeout.didTimeout()) {
            throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
          }
        }
      `,
    },
    {
      name: 'legit transport mint: idle timeout returning a server_error',
      filename: clientFile,
      code: `
        function buildIdleTimeoutError() {
          return new ModelError('server_error', STREAM_IDLE_TIMEOUT_MESSAGE, undefined, this.provider);
        }
      `,
    },
    {
      name: 'unrelated stream-event .type reads do not trigger (no lossy ModelError mint)',
      filename: clientFile,
      code: `
        function consumeStream(events) {
          for (const event of events) {
            if (event.type === 'content_block_start') continue;
            if (event.type === 'text_delta') onEvent({ type: 'text_delta', text: event.delta.text });
          }
        }
      `,
    },
    {
      name: 'reads error.code but delegates to classifyHttpError (sanctioned)',
      filename: clientFile,
      code: `
        async function doCodex(response) {
          if (!response.ok) {
            const errorBody = await response.text();
            throw classifyHttpError(response.status, errorBody, this.provider);
          }
        }
      `,
    },
    {
      name: '401 handler reads status and mints auth (not server_error/unknown), no discriminator',
      filename: clientFile,
      code: `
        async function doCodex(response) {
          if (response.status === 401) {
            const refreshed = await codex.forceRefreshToken();
            if (!refreshed) {
              throw new ModelError('auth', CODEX_RECONNECT_MESSAGE, 401, this.provider);
            }
          }
        }
      `,
    },
  ],
  invalid: [
    {
      // NON-VACUITY: the exact PRE-FIX bug shape. Destructure { code, type,
      // message } off the provider error frame, inline if/else-if onto a `let
      // kind`, default to 'server_error', then throw — with NO shared classifier.
      name: 'pre-fix inline classifier defaulting to server_error is flagged',
      filename: clientFile,
      code: `
        function handleChatChunkPayload(maybeError) {
          if (maybeError.error && !maybeError.choices) {
            const { code, type, message } = maybeError.error;
            const errorMessage = message ?? 'OpenAI-compatible streaming error';
            let kind = 'server_error';
            if (code === 'rate_limit_exceeded' || type === 'rate_limit_exceeded') {
              kind = 'rate_limit';
            } else if (code === 'insufficient_quota' || type === 'insufficient_quota') {
              kind = 'billing';
            }
            throw new ModelError(kind, errorMessage, undefined, this.provider);
          }
        }
      `,
      errors: [{ messageId: 'noInlineProviderErrorClassify' }],
    },
    {
      name: 'direct literal server_error mint with member discriminator read is flagged',
      filename: clientFile,
      code: `
        function handle(parsed) {
          if (parsed.error.type === 'overloaded') {
            throw new ModelError('server_error', parsed.error.message, undefined, this.provider);
          }
          throw new ModelError('unknown', 'fallthrough', undefined, this.provider);
        }
      `,
      errors: [
        { messageId: 'noInlineProviderErrorClassify' },
        { messageId: 'noInlineProviderErrorClassify' },
      ],
    },
    {
      name: 'inline classifier defaulting to unknown is flagged',
      filename: clientFile,
      code: `
        function classifyFrame(errorBody) {
          const code = errorBody.code;
          let kind = 'unknown';
          if (code === 'server_error') kind = 'server_error';
          throw new ModelError(kind, 'frame error', undefined, this.provider);
        }
      `,
      errors: [{ messageId: 'noInlineProviderErrorClassify' }],
    },
  ],
});
