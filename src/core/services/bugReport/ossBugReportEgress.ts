/**
 * Best-effort bug-report egress for the OSS build.
 *
 * This module is intentionally the client-side contract spec for Mindstone's
 * unauthenticated `POST /api/oss/bug-report` endpoint. The endpoint is live;
 * the single production gate below remains the shipped switch for this egress.
 *
 * ## Request contract
 *
 * The caller POSTs JSON to `${apiUrl}/api/oss/bug-report`.
 *
 * - `eventId`: required idempotency key reused for every retry of the same
 *   report. The backend must treat duplicate `eventId` values idempotently.
 * - `email` / `firstName`: optional user-provided OSS onboarding identity. A
 *   bug report must still send when either field is absent.
 * - `description`: required user bug description.
 * - `stepsToReproduce` / `expectedBehavior`: optional user-written details.
 * - `urgency`: one of `low`, `medium`, `high`, or `critical`.
 * - `appVersion` / `platform`: supplied by the caller from PlatformConfig.
 * - `diagnosticsSummary`: optional redacted diagnostic summary text.
 * - `filteredLogsNdjson`: optional deny-by-default filtered newline-delimited
 *   JSON logs, matching the commercial `filtered-logs.ndjson` attachment.
 * - `updateForensics`: optional structured update-forensics payload. Attachment
 *   bytes are JSON-safe: text remains a string, binary data is base64-encoded.
 *   The backend should accept any JSON object/array/scalar here because desktop
 *   update evidence may evolve independently of the endpoint deployment.
 * - `screenshot`: optional `{ base64, mimeType }`. `base64` is the raw binary
 *   screenshot bytes encoded as standard base64 with no data-URL prefix;
 *   `mimeType` must describe those bytes (for example `image/png`).
 * - `diagnosticSectionStates`: optional per-section state map documenting what
 *   diagnostic sections were included, omitted, unavailable, or empty.
 * - `tags`: optional flat string tags for server-side routing/search.
 * - `extras`: optional JSON object for additional redacted metadata.
 *
 * Payload size expectation: callers should keep the full JSON body under 10 MiB
 * (including screenshot base64 expansion). The backend should reject larger
 * payloads with a non-2xx response; this helper will then return `retry`.
 *
 * LOAD-BEARING INVARIANT: this helper NEVER throws to its caller. Any network
 * failure, timeout, abort, or non-2xx response is caught and converted into a
 * small {@link OssBugReportResult}. Logs are structured and must never include
 * raw email, name, description, screenshots, diagnostics, logs, or forensics.
 *
 * Platform-agnostic (electron-free): `appVersion`/`platform` are passed in by
 * the caller. This module does not read Electron, renderer, or process state.
 */

/** Minimal structured-logger shape (compatible with the pino-based core logger). */
export interface OssBugReportEgressLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export type OssBugReportUrgency = 'low' | 'medium' | 'high' | 'critical';

export type OssBugReportDiagnosticSectionState =
  | 'included'
  | 'omitted_by_user_toggle'
  | 'omitted_by_option'
  | 'unavailable'
  | 'reader_unavailable'
  | 'empty';

export interface OssBugReportScreenshot {
  /**
   * Raw screenshot bytes encoded as standard base64 with no `data:` URL prefix.
   * `mimeType` describes the encoded bytes.
   */
  base64: string;
  /** Screenshot MIME type, for example `image/png`. */
  mimeType: string;
}

export interface OssBugReportRequest {
  /** Idempotency key reused across retries of the same report. */
  eventId: string;
  /** Optional user-provided OSS onboarding email; absence must not block send. */
  email?: string;
  /** Optional user-provided OSS onboarding first name. */
  firstName?: string;
  /** Required user-written bug description. */
  description: string;
  /** Optional user-written reproduction steps. */
  stepsToReproduce?: string;
  /** Optional user-written expected behavior. */
  expectedBehavior?: string;
  /** User-selected severity/urgency. */
  urgency: OssBugReportUrgency;
  /** App version sourced by the caller from PlatformConfig. */
  appVersion: string;
  /** OS/platform sourced by the caller from PlatformConfig. */
  platform: string;
  /** Optional redacted diagnostic summary text. */
  diagnosticsSummary?: string;
  /** Optional deny-by-default filtered newline-delimited JSON logs. */
  filteredLogsNdjson?: string;
  /** Optional structured, JSON-safe update-forensics payload. */
  updateForensics?: unknown;
  /** Optional screenshot attachment encoded as base64 bytes plus MIME type. */
  screenshot?: OssBugReportScreenshot;
  /** Optional per-diagnostic-section inclusion/omission state. */
  diagnosticSectionStates?: Record<string, OssBugReportDiagnosticSectionState>;
  /** Optional flat string tags for backend routing/search. */
  tags?: Record<string, string>;
  /** Optional additional redacted JSON metadata. */
  extras?: Record<string, unknown>;
}

export interface OssBugReportDeps {
  /** Base Mindstone API URL, normally MINDSTONE_API_URL. */
  apiUrl: string;
  /** Structured logger for observable failures. */
  log: OssBugReportEgressLogger;
  /** Injectable fetch (defaults to global fetch) to keep tests/staging pure. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms before the request is aborted. Defaults to 5000. */
  timeoutMs?: number;
}

export type OssBugReportResult =
  | { kind: 'delivered' }
  | { kind: 'retry'; error?: string }
  | { kind: 'circuit-open'; error?: string; retryAfterMs?: number };

export type OssBugReportEgressEnabled = () => boolean;

const DEFAULT_TIMEOUT_MS = 5000;
const SOURCE = 'oss-bug-report';
const OSS_BUG_REPORT_EGRESS_ENABLED = true;

/**
 * Production default for OSS bug-report egress.
 *
 * EGRESS IS ON. This is the single switch that ships egress of user email,
 * first name, description, reproduction notes, expected behavior, screenshot
 * bytes, diagnostics summary, filtered logs, update forensics, tags, and extras
 * to Mindstone.
 *
 * Gate-flip checklist satisfied in the same change:
 * 1. The rebel-platform `POST /api/oss/bug-report` endpoint is live, verified,
 *    and accepts the contract documented in this file.
 * 2. The external privacy policy is owner-handled with the release; the bundled
 *    open-build help doc discloses this egress.
 * 3. The in-modal at-submit disclosure explains what is sent.
 * 4. Queued-toast copy automatically reverts from the gated "saved on your
 *    device" wording to the live-send receipt because suppression is keyed on
 *    this same switch.
 *
 * Do not read process.env here. Tests and staging must vary behavior by
 * injecting an {@link OssBugReportEgressEnabled} predicate into the consumer,
 * never by relying on an ambient environment variable that could change a
 * shipped PII POST independently of the disclosures above.
 */
export function isOssBugReportEgressEnabled(): boolean {
  return OSS_BUG_REPORT_EGRESS_ENABLED;
}

/**
 * POST a bug report to Mindstone. Best-effort: resolves to an outbox-compatible
 * result regardless of outcome; failures are logged, never thrown.
 */
export async function postOssBugReport(
  input: OssBugReportRequest,
  deps: OssBugReportDeps,
): Promise<OssBugReportResult> {
  const { apiUrl, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${apiUrl}/api/oss/bug-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (response.ok) {
      return { kind: 'delivered' };
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      log.warn(
        { status: response.status, retryAfterMs, source: SOURCE },
        'OSS bug-report POST rate-limited',
      );
      return {
        kind: 'circuit-open',
        error: 'http-429',
        ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
      };
    }

    log.warn(
      { status: response.status, source: SOURCE },
      'OSS bug-report POST returned a non-2xx status',
    );
    return { kind: 'retry', error: `http-${response.status}` };
  } catch (error) {
    const err = sanitizeErrorName(error);
    log.warn(
      { err, source: SOURCE },
      'OSS bug-report POST failed',
    );
    return { kind: 'retry', error: `fetch-${err}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const numericSeconds = Number(value.trim());
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.floor(numericSeconds * 1000);
  }

  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) {
    return undefined;
  }

  const remainingMs = retryAtMs - Date.now();
  return remainingMs > 0 ? remainingMs : undefined;
}

function sanitizeErrorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : 'unknown';
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return sanitized || 'unknown';
}
