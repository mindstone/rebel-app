import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOssBugReportEgressEnabled,
  postOssBugReport,
  type OssBugReportEgressLogger,
  type OssBugReportRequest,
} from '../ossBugReportEgress';

type MockLog = {
  warn: ReturnType<typeof vi.fn<(obj: Record<string, unknown>, msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(obj: Record<string, unknown>, msg: string) => void>>;
};

function makeLog(): MockLog {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Adapt the typed mock to the logger interface the helper expects. */
const asLog = (m: MockLog): OssBugReportEgressLogger => m;

const BASE_INPUT: OssBugReportRequest = {
  eventId: '0123456789abcdef0123456789abcdef',
  email: 'alex@example.com',
  firstName: 'Alex',
  description: 'The export flow includes the customer name in a broken filename.',
  stepsToReproduce: 'Open export, pick CSV, click Save.',
  expectedBehavior: 'The export should complete.',
  urgency: 'high',
  appVersion: '1.2.3',
  platform: 'darwin',
  diagnosticsSummary: 'Redacted diagnostics summary',
  filteredLogsNdjson: '{"level":"warn","msg":"redacted"}\n',
  updateForensics: { channel: 'beta', lastInstaller: 'redacted' },
  screenshot: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
  diagnosticSectionStates: {
    recent_logs: 'included',
    settings_drift: 'omitted_by_user_toggle',
  },
  tags: { build: 'oss', area: 'export' },
  extras: { reportSource: 'feedback-modal' },
};

describe('postOssBugReport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('POSTs to /api/oss/bug-report with the documented unauthenticated body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const log = makeLog();

    const result = await postOssBugReport(BASE_INPUT, {
      apiUrl: 'https://api.test',
      log: asLog(log),
      fetchImpl,
    });

    expect(result).toEqual({ kind: 'delivered' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/api/oss/bug-report');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    // No Authorization header — unauthenticated by design.
    expect(JSON.stringify(init.headers)).not.toContain('Authorization');
    expect(JSON.parse(init.body)).toEqual(BASE_INPUT);
    expect(JSON.parse(init.body).eventId).toBe('0123456789abcdef0123456789abcdef');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('sends without an email', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const log = makeLog();
    const input = { ...BASE_INPUT };
    delete input.email;
    delete input.firstName;

    await expect(
      postOssBugReport(input, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toEqual({ kind: 'delivered' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.email).toBeUndefined();
    expect(body.firstName).toBeUndefined();
    expect(body.description).toBe(BASE_INPUT.description);
  });

  it('sends with an email', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const log = makeLog();

    await expect(
      postOssBugReport(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toEqual({ kind: 'delivered' });

    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.email).toBe('alex@example.com');
    expect(body.firstName).toBe('Alex');
  });

  it('maps 429 with Retry-After to circuit-open with retryAfterMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '7' } }),
    );
    const log = makeLog();

    const result = await postOssBugReport(BASE_INPUT, {
      apiUrl: 'https://api.test',
      log: asLog(log),
      fetchImpl,
    });

    expect(result).toEqual({ kind: 'circuit-open', error: 'http-429', retryAfterMs: 7000 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toMatchObject({ status: 429, retryAfterMs: 7000, source: 'oss-bug-report' });
  });

  it('maps 500 to retry and never throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const log = makeLog();

    await expect(
      postOssBugReport(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toEqual({ kind: 'retry', error: 'http-500' });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toMatchObject({ status: 500, source: 'oss-bug-report' });
  });

  it('maps a network rejection to retry and never throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network down'));
    const log = makeLog();

    await expect(
      postOssBugReport(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toEqual({ kind: 'retry', error: 'fetch-TypeError' });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toEqual({ err: 'TypeError', source: 'oss-bug-report' });
  });

  it('aborts via timeout and resolves to retry when the request hangs', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    // A fetch that rejects when its signal aborts (mimics real fetch abort).
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    const promise = postOssBugReport(BASE_INPUT, {
      apiUrl: 'https://api.test',
      log: asLog(log),
      fetchImpl,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({ kind: 'retry', error: 'fetch-AbortError' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toEqual({ err: 'AbortError', source: 'oss-bug-report' });
  });

  it('never throws on an already-aborted fetch path', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const log = makeLog();

    await expect(
      postOssBugReport(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toEqual({ kind: 'retry', error: 'fetch-AbortError' });
  });

  it('does not log PII on non-2xx, network error, or timeout', async () => {
    vi.useFakeTimers();
    const warningInputs: Array<[string, typeof fetch]> = [
      ['non-2xx', vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch],
      ['network', vi.fn().mockRejectedValue(new Error('server unavailable')) as unknown as typeof fetch],
      [
        'timeout',
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            }),
        ) as unknown as typeof fetch,
      ],
    ];

    for (const [label, fetchImpl] of warningInputs) {
      const log = makeLog();
      const promise = postOssBugReport(BASE_INPUT, {
        apiUrl: 'https://api.test',
        log: asLog(log),
        fetchImpl,
        timeoutMs: 10,
      });
      if (label === 'timeout') {
        await vi.advanceTimersByTimeAsync(10);
      }
      await promise;

      const logged = JSON.stringify(log.warn.mock.calls);
      expect(logged).not.toContain(BASE_INPUT.email);
      expect(logged).not.toContain(BASE_INPUT.firstName);
      expect(logged).not.toContain(BASE_INPUT.description);
      expect(logged).not.toContain(BASE_INPUT.stepsToReproduce);
      expect(logged).not.toContain(BASE_INPUT.expectedBehavior);
      expect(logged).not.toContain(BASE_INPUT.diagnosticsSummary);
      expect(logged).not.toContain(BASE_INPUT.filteredLogsNdjson);
      expect(logged).not.toContain(BASE_INPUT.screenshot?.base64);
    }
  });
});

describe('isOssBugReportEgressEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true in production now that OSS bug-report egress is live', () => {
    expect(isOssBugReportEgressEnabled()).toBe(true);
  });

  it('is a fixed production const and ignores ambient process.env', () => {
    vi.stubEnv('REBEL_OSS_BUG_REPORT_EGRESS', '0');
    vi.stubEnv('OSS_BUG_REPORT_EGRESS_ENABLED', 'false');
    vi.stubEnv('MINDSTONE_OSS_BUG_REPORT_EGRESS', 'disabled');

    expect(isOssBugReportEgressEnabled()).toBe(true);

    vi.stubEnv('REBEL_OSS_BUG_REPORT_EGRESS', '1');
    vi.stubEnv('OSS_BUG_REPORT_EGRESS_ENABLED', 'true');
    vi.stubEnv('MINDSTONE_OSS_BUG_REPORT_EGRESS', 'enabled');

    expect(isOssBugReportEgressEnabled()).toBe(true);
  });
});
