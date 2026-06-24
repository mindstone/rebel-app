import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeProviderReachability,
  getProviderReachabilitySnapshot,
  refreshProviderReachabilityCache,
  detectAllProvidersUnreachable,
} from '../providerReachabilitySnapshot';
import type { AppSettings } from '@shared/types';
import type {
  ProbeResult,
  ProviderId,
  ProviderReachabilitySnapshot,
} from '@shared/diagnostics/providerReachabilitySnapshot';

// Mock settingsStore
vi.mock('../../settingsStore', () => {
  let settingsCallback: ((settings: AppSettings) => void) | null = null;
  return {
    getSettings: vi.fn(() => ({ cloudInstance: { cloudUrl: 'https://test.rebel.mindstone.com' } })),
    onSettingsChange: vi.fn((cb) => {
      settingsCallback = cb;
      return () => { settingsCallback = null; };
    }),
    __triggerSettingsChange: (settings: AppSettings) => {
      if (settingsCallback) settingsCallback(settings);
    }
  };
});

// Mock the status service so we can assert the reachability refresh treats
// status collection as a non-essential, deduped, corroborating signal — without
// hitting the network. Returns a fixed 'unknown' result by default.
vi.mock('../providerStatusService', () => {
  const getProviderStatus = vi.fn(async (id: string) => ({
    indicator: 'unknown' as const,
    incidents: [],
    humanUrl: `https://status.example/${id}`,
    checkedAt: new Date().toISOString(),
    stale: false,
  }));
  return { getProviderStatus };
});

import * as settingsStore from '../../settingsStore';
import { getProviderStatus } from '../providerStatusService';

const getProviderStatusMock = getProviderStatus as unknown as ReturnType<typeof vi.fn>;

const triggerSettingsChange = (settingsStore as unknown as {
  __triggerSettingsChange: (settings: AppSettings) => void;
}).__triggerSettingsChange;

describe('providerReachabilitySnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset module-level cache
    triggerSettingsChange({} as AppSettings);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('probeProviderReachability', () => {
    it('returns reachable status on 200 OK', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('reachable');
      expect(result.errorCode).toBeUndefined();
    });

    it('returns reachable status on 401 Unauthorized (expected for HEAD)', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('reachable');
    });

    it('returns unreachable status on 500 error', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('unreachable');
      expect(result.errorCode).toBe('http_5xx');
    });

    it('returns unreachable on fetch error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('unreachable');
      expect(result.errorCode).toBe('dns');
    });
  });

  describe('getProviderReachabilitySnapshot', () => {
    it('reads the cache without probing providers', () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const snap = getProviderReachabilitySnapshot();

      expect(snap.snapshotPresent).toBe(false);
      expect(snap.providers).toEqual({});
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns probe-populated cache entries without re-probing', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await probeProviderReachability('anthropic');
      const snap1 = getProviderReachabilitySnapshot();
      expect(snap1.snapshotPresent).toBe(true);
      expect(snap1.providers?.anthropic?.status).toBe('reachable');
      
      // Fast forward 10 seconds (cache still valid)
      vi.advanceTimersByTime(10000);
      
      const snap2 = getProviderReachabilitySnapshot();
      expect(snap2.providers?.anthropic?.checkedAt).toBe(snap1.providers?.anthropic?.checkedAt);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('refreshProviderReachabilityCache refreshes stale entries only', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await refreshProviderReachabilityCache(['anthropic']);
      await refreshProviderReachabilityCache(['anthropic']);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await refreshProviderReachabilityCache(['anthropic']);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    
    it('invalidates cache on settings change', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      await refreshProviderReachabilityCache(['anthropic']);
      
      // Simulate settings change using our mock helper
      triggerSettingsChange({} as AppSettings);
      
      const snap = getProviderReachabilitySnapshot();
      expect(snap.snapshotPresent).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('detectAllProvidersUnreachable', () => {
  const mk = (
    status: ProbeResult['status'],
    opts: { stale?: boolean; errorCode?: ProbeResult['errorCode'] } = {},
  ): ProbeResult => ({
    status,
    ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    checkedAt: 1_000,
    cachedAt: 1_000,
    expiresAt: 31_000,
    stale: opts.stale ?? false,
  });

  const snap = (
    providers: Partial<Record<ProviderId, ProbeResult>>,
    over: Partial<ProviderReachabilitySnapshot> = {},
  ): ProviderReachabilitySnapshot => ({
    snapshotPresent: Object.keys(providers).length > 0,
    lastRefreshAt: 1_000,
    providers,
    ...over,
  });

  it('all fresh providers unreachable → all_unreachable (with per-provider error codes)', () => {
    const r = detectAllProvidersUnreachable(
      snap({
        anthropic: mk('unreachable', { errorCode: 'timeout' }),
        openai: mk('unreachable', { errorCode: 'dns' }),
      }),
    );
    expect(r.verdict).toBe('all_unreachable');
    expect(r.unreachableProviders.sort()).toEqual(['anthropic', 'openai']);
    expect(r.errorCodes).toEqual({ anthropic: 'timeout', openai: 'dns' });
    expect(r.lastRefreshAt).toBe(1_000);
  });

  it('mixed fresh statuses → partially_unreachable', () => {
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('reachable'), openai: mk('unreachable', { errorCode: 'http_5xx' }) }),
    );
    expect(r.verdict).toBe('partially_unreachable');
    expect(r.unreachableProviders).toEqual(['openai']);
  });

  it('a fresh reachable provider and no unreachable → none_unreachable', () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('reachable') }));
    expect(r.verdict).toBe('none_unreachable');
    expect(r.unreachableProviders).toEqual([]);
  });

  it('empty / absent snapshot → inconclusive (never a confident "all down")', () => {
    expect(detectAllProvidersUnreachable(snap({})).verdict).toBe('inconclusive');
    expect(
      detectAllProvidersUnreachable({ snapshotPresent: false, lastRefreshAt: null, providers: {} })
        .verdict,
    ).toBe('inconclusive');
  });

  it('F7: stale data is NOT counted as unreachable → inconclusive', () => {
    // All entries stale → no fresh evidence → must not read as "all down".
    const r = detectAllProvidersUnreachable(
      snap({
        anthropic: mk('unreachable', { stale: true, errorCode: 'timeout' }),
        openai: mk('unreachable', { stale: true }),
      }),
    );
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
  });

  it('F7: a fresh stale-unreachable is ignored; a fresh reachable wins → none_unreachable', () => {
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('reachable'), openai: mk('unreachable', { stale: true }) }),
    );
    expect(r.verdict).toBe('none_unreachable');
  });

  it("F7: 'unknown'-status probes are not evidence → inconclusive", () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('unknown') }));
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
  });

  it('a single fresh-unreachable provider → all_unreachable (consideredProviders is the coverage guardrail)', () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('unreachable', { errorCode: 'timeout' }) }));
    expect(r.verdict).toBe('all_unreachable');
    expect(r.consideredProviders).toEqual(['anthropic']);
    expect(r.unreachableProviders).toEqual(['anthropic']);
  });

  it('providers map undefined → inconclusive (no throw)', () => {
    const r = detectAllProvidersUnreachable({
      snapshotPresent: false,
      lastRefreshAt: null,
      providers: undefined,
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
    expect(r.unreachableProviders).toEqual([]);
  });

  it('snapshotPresent:false short-circuits to inconclusive even with non-empty providers', () => {
    // A malformed/transitional snapshot (present flag false but rows linger) must
    // not be read as a confident verdict.
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('unreachable'), openai: mk('unreachable') }, { snapshotPresent: false }),
    );
    expect(r.verdict).toBe('inconclusive');
  });
});

describe('status-page collection (corroborating triage signal, non-essential)', () => {
  beforeEach(() => {
    // Real timers: the status batch budget uses runWithTimeout setTimeout, and
    // we want the actual async settling rather than fake-timer plumbing.
    vi.useRealTimers();
    vi.clearAllMocks();
    triggerSettingsChange({} as AppSettings);
    // Default: HEAD probes succeed.
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    getProviderStatusMock.mockImplementation(async (id: string) => ({
      indicator: 'unknown' as const,
      incidents: [],
      humanUrl: `https://status.example/${id}`,
      checkedAt: new Date().toISOString(),
      stale: false,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(i) cloneSnapshot/resetSnapshot carry statusPages', async () => {
    getProviderStatusMock.mockResolvedValue({
      indicator: 'major',
      incidents: [{ name: 'Outage', impact: 'major', shortlink: 'x', updatedAt: 't' }],
      humanUrl: 'https://status.claude.com/',
      checkedAt: new Date().toISOString(),
      stale: false,
    });

    await refreshProviderReachabilityCache(['anthropic'], { force: true });
    const snap1 = getProviderReachabilitySnapshot();
    expect(snap1.statusPages?.anthropic?.indicator).toBe('major');

    // resetSnapshot via a settings change clears statusPages too.
    triggerSettingsChange({} as AppSettings);
    const snap2 = getProviderReachabilitySnapshot();
    expect(snap2.statusPages).toBeUndefined();
  });

  it('(j) dedupes codex + openai → one openai status fetch', async () => {
    await refreshProviderReachabilityCache(['openai', 'codex'], { force: true });
    const statusCalls = getProviderStatusMock.mock.calls.map((c) => c[0]);
    const openaiCalls = statusCalls.filter((id) => id === 'openai');
    expect(openaiCalls).toHaveLength(1);
  });

  it('skips status fetch for providers with no status page (google/rebel-cloud)', async () => {
    await refreshProviderReachabilityCache(['google', 'rebel-cloud'], { force: true });
    expect(getProviderStatusMock).not.toHaveBeenCalled();
  });

  it('(h) a status-fetch failure leaves the verdict UNCHANGED and still returns the snapshot', async () => {
    // Make HEAD probes deterministic: anthropic reachable, openai unreachable.
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('openai')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    // Status collection blows up — must be swallowed (non-essential).
    getProviderStatusMock.mockRejectedValue(new Error('status service exploded'));

    const snapshot = await refreshProviderReachabilityCache(['anthropic', 'openai'], { force: true });

    // Snapshot still returned and populated.
    expect(snapshot.snapshotPresent).toBe(true);
    expect(snapshot.providers?.anthropic?.status).toBe('reachable');
    expect(snapshot.providers?.openai?.status).toBe('unreachable');

    // Verdict computed only from .providers, unaffected by the status failure.
    const verdict = detectAllProvidersUnreachable(snapshot);
    expect(verdict.verdict).toBe('partially_unreachable');
    expect(verdict.unreachableProviders).toEqual(['openai']);

    // statusPages omitted (none succeeded), never corrupting the verdict.
    expect(snapshot.statusPages).toBeUndefined();
  });

  it('attaches partial statusPages when one status fetch fails and another succeeds', async () => {
    getProviderStatusMock.mockImplementation(async (id: string) => {
      if (id === 'openai') throw new Error('openai status down');
      return {
        indicator: 'critical' as const,
        incidents: [],
        humanUrl: 'https://status.claude.com/',
        checkedAt: new Date().toISOString(),
        stale: false,
      };
    });

    const snapshot = await refreshProviderReachabilityCache(['anthropic', 'openai'], { force: true });
    expect(snapshot.statusPages?.anthropic?.indicator).toBe('critical');
    expect(snapshot.statusPages?.openai).toBeUndefined();
  });
});
