import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProviderStatus,
  __resetProviderStatusCacheForTests,
} from '../providerStatusService';
import operationalFixture from './__fixtures__/statuspage-summary-operational.json';
import majorIncidentFixture from './__fixtures__/statuspage-summary-major-incident.json';

function mockFetchJson(payload: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as typeof fetch;
}

describe('providerStatusService', () => {
  beforeEach(() => {
    __resetProviderStatusCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) parses a valid operational fixture → indicator + no incidents', async () => {
    globalThis.fetch = mockFetchJson(operationalFixture);
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('none');
    expect(result.description).toBe('All Systems Operational');
    expect(result.incidents).toEqual([]);
    expect(result.humanUrl).toBe('https://status.claude.com/');
    expect(result.stale).toBe(false);
  });

  it('(a2) parses a major-incident fixture → indicator major + mapped incident', async () => {
    globalThis.fetch = mockFetchJson(majorIncidentFixture);
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('major');
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toEqual({
      name: 'Elevated errors on the Messages API',
      impact: 'major',
      shortlink: 'https://stspg.io/abc',
      updatedAt: '2026-06-23T15:20:00.000Z',
    });
  });

  it('(b) malformed JSON (json() rejects) → unknown, never throws', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    }) as unknown as typeof fetch;
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('unknown');
    expect(result.humanUrl).toBe('https://status.claude.com/');
  });

  it('(b2) schema mismatch (wrong shape) → unknown, never throws', async () => {
    globalThis.fetch = mockFetchJson({ status: 'not-an-object', incidents: 'nope' });
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('unknown');
  });

  it('(b3) non-2xx response → unknown, never throws', async () => {
    globalThis.fetch = mockFetchJson({}, false, 503);
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('unknown');
  });

  it('(c) fetch rejects (network) → unknown, never throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch;
    const result = await getProviderStatus('openai');
    expect(result.indicator).toBe('unknown');
    expect(result.humanUrl).toBe('https://status.openai.com/');
  });

  it('(d) slow fetch exceeding the timeout → unknown within budget, never throws', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise(() => {}), // never resolves
    ) as unknown as typeof fetch;

    const promise = getProviderStatus('anthropic');
    // Advance past the ~3s internal fetch timeout.
    await vi.advanceTimersByTimeAsync(3_500);
    const result = await promise;
    expect(result.indicator).toBe('unknown');
    vi.useRealTimers();
  });

  it('(e) openrouter (summaryJsonUrl null) → unknown + humanUrl, fetch NOT called', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await getProviderStatus('openrouter');
    expect(result.indicator).toBe('unknown');
    expect(result.humanUrl).toBe('https://status.openrouter.ai/');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(f) coalescing → one fetch for concurrent calls of the same id', async () => {
    const fetchSpy = mockFetchJson(operationalFixture);
    globalThis.fetch = fetchSpy;
    const [a, b] = await Promise.all([
      getProviderStatus('anthropic'),
      getProviderStatus('anthropic'),
    ]);
    expect(a.indicator).toBe('none');
    expect(b.indicator).toBe('none');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('(g) indicator NEVER defaults to none on failure (unknown, not none)', async () => {
    // A failure must never read as "operational" — the origin bug.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).not.toBe('none');
    expect(result.indicator).toBe('unknown');
  });

  it('(g2) absent/unrecognised upstream indicator → unknown, not none', async () => {
    globalThis.fetch = mockFetchJson({ status: { indicator: 'banana' }, incidents: [] });
    const result = await getProviderStatus('anthropic');
    expect(result.indicator).toBe('unknown');
  });

  it('uses follow-redirect on the fetch (Anthropic host migration defence)', async () => {
    const fetchSpy = mockFetchJson(operationalFixture);
    globalThis.fetch = fetchSpy;
    await getProviderStatus('anthropic');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://status.claude.com/api/v2/summary.json',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });
});
