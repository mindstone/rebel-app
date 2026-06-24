/**
 * Stage 6b — `resolveCloudSymlinkAdmission` + the `isCloudSymlinkIndexingEnabled`
 * flag accessor.
 *
 * The shared admission decision the three descent decision points consult:
 *  - flag OFF (default) ⇒ always `'skip'` (byte-identical to today), with NO key
 *    mint / verdict read (the fast path);
 *  - flag ON + verdict `healthy` ⇒ `'admit'`;
 *  - flag ON + `degraded`/`unknown` ⇒ `'skip'`;
 *  - an unclassifiable chain (readlink can't prove cloud) ⇒ `'skip'` (fail closed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CLOUD_SYMLINK = '/Users/test/ws/Company Memories';
const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/Company Memories';
const LOCAL_SYMLINK = '/Users/test/ws/Notes';
const LOCAL_TARGET = '/Users/test/Projects/notes';
const DANGLING_SYMLINK = '/Users/test/ws/Dead';

function einval(): NodeJS.ErrnoException {
  return Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
}
function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

const readlinkSyncSpy = vi.fn((p: string) => {
  if (p === CLOUD_SYMLINK) return CLOUD_TARGET;
  if (p === LOCAL_SYMLINK) return LOCAL_TARGET;
  if (p === DANGLING_SYMLINK) throw enoent(); // dead first hop → unclassifiable
  throw einval(); // a real (non-symlink) path → terminus
});
vi.mock('node:fs', () => ({ readlinkSync: (p: string) => readlinkSyncSpy(p) }));

import {
  setCloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  type CloudHealthVerdict,
} from '@core/services/cloudLivenessProbe';
import { ADMISSION_VERDICT_TTL_MS } from '@core/constants';
import {
  setCloudSymlinkIndexingEnabled,
  isCloudSymlinkIndexingEnabled,
  resolveCloudSymlinkAdmission,
  resolveSpaceSyncStatus,
  makeConfirmedHealthyBroadcaster,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';

const getCachedVerdictSpy = vi.fn<(t: string, maxHealthyAgeMs?: number) => CloudHealthVerdict>(
  () => 'healthy',
);
const getDisplayVerdictSpy = vi.fn<(t: string) => CloudHealthVerdict>(() => 'healthy');
function installProbe(): void {
  setCloudLivenessProbe({
    probeHealth: async () => 'healthy',
    getCachedVerdict: (target, maxHealthyAgeMs) => getCachedVerdictSpy(target, maxHealthyAgeMs),
    getDisplayVerdict: (target) => getDisplayVerdictSpy(target),
  });
}

describe('cloudSymlinkIndexing flag accessor', () => {
  beforeEach(() => __resetCloudSymlinkIndexingForTests());
  afterEach(() => __resetCloudSymlinkIndexingForTests());

  it('defaults to false', () => {
    expect(isCloudSymlinkIndexingEnabled()).toBe(false);
  });
  it('mirrors the set value; undefined coerces to false', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(isCloudSymlinkIndexingEnabled()).toBe(true);
    setCloudSymlinkIndexingEnabled(undefined);
    expect(isCloudSymlinkIndexingEnabled()).toBe(false);
  });
});

describe('resolveCloudSymlinkAdmission', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getCachedVerdictSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('flag OFF ⇒ skip, with NO key mint or verdict read (fast path)', () => {
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + healthy verdict ⇒ admit (verdict keyed by the first cloud hop, RAW 45s TTL on the exempt single-arg path)', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('admit');
    // Admission reads the RAW getCachedVerdict (NOT getDisplayVerdict). The single-arg
    // (exempt) callers forward NO maxHealthyAgeMs → raw 45s tolerance (MUST-FIX #2); only
    // the Library buildFileTree descent passes the longer admission TTL explicitly.
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET, undefined);
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + degraded ⇒ skip', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('degraded');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
  });

  it('flag ON + unknown ⇒ skip', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('unknown');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
  });

  it('flag ON + a LOCAL symlink ⇒ skip (not cloud → null key → no admission)', () => {
    setCloudSymlinkIndexingEnabled(true);
    // A local-terminus chain mints a null key → skip; never reads a verdict.
    expect(resolveCloudSymlinkAdmission(LOCAL_SYMLINK)).toBe('skip');
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + an UNCLASSIFIABLE chain (dead first hop) ⇒ skip (fail closed)', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(resolveCloudSymlinkAdmission(DANGLING_SYMLINK)).toBe('skip');
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });
});

describe('resolveCloudSymlinkAdmission — cloud-root-safe overload (260624 GDrive-empty fix)', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getCachedVerdictSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
    setCloudSymlinkIndexingEnabled(true);
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('rootIsCloud + cloud sourcePath + healthy ⇒ admit, ZERO readlink (key from sourcePath)', () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('admit');
    // The load-bearing RC-1 property: never touched the link inode under a cloud root.
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    // Keyed ZERO-I/O from sourcePath, NOT the live readlink. With NO maxHealthyAgeMs
    // option, the raw 45s TTL applies (undefined forwarded) — the longer admission TTL
    // is the Library caller's responsibility to pass (MUST-FIX #2: not widened here).
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET, undefined);
    // Admission reads the RAW verdict, never the sticky display verdict.
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + cloud sourcePath + EXPLICIT maxHealthyAgeMs ⇒ forwards the longer TTL (the Library path)', () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, {
        rootIsCloud: true,
        sourcePath: CLOUD_TARGET,
        maxHealthyAgeMs: ADMISSION_VERDICT_TTL_MS,
      }),
    ).toBe('admit');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    // Only when the caller (buildFileTree's Library descent) passes it does the longer
    // tolerance reach getCachedVerdict.
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET, ADMISSION_VERDICT_TTL_MS);
  });

  it('rootIsCloud + cloud sourcePath + degraded ⇒ skip, ZERO readlink', () => {
    getCachedVerdictSpy.mockReturnValue('degraded');
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + MISSING sourcePath ⇒ skip, fail closed, NO readlink, NO verdict read', () => {
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK, { rootIsCloud: true })).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + NON-CLOUD sourcePath ⇒ skip, fail closed, NO readlink, NO verdict read', () => {
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: LOCAL_TARGET }),
    ).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + RELATIVE sourcePath ⇒ skip, fail closed, NO readlink (only absolute keys are equivalent)', () => {
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, {
        rootIsCloud: true,
        sourcePath: 'Shared drives/Company Memories',
      }),
    ).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud:false / omitted ⇒ byte-identical live-readlink path with the RAW 45s TTL (no admission widening — MUST-FIX #2)', () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    // Explicit false: live readlink, sourcePath ignored.
    expect(
      resolveCloudSymlinkAdmission(CLOUD_SYMLINK, { rootIsCloud: false, sourcePath: CLOUD_TARGET }),
    ).toBe('admit');
    expect(readlinkSyncSpy).toHaveBeenCalledWith(CLOUD_SYMLINK);
    // The exempt single-arg callers (safeWalkDirectory / subprocess-exclusion) and any
    // omitted-options call must keep the raw 45s tolerance — NO maxHealthyAgeMs forwarded.
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET, undefined);
  });

  it('single-arg call (the EXEMPT callers) ⇒ live-readlink path, raw 45s TTL (undefined forwarded)', () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('admit');
    expect(readlinkSyncSpy).toHaveBeenCalledWith(CLOUD_SYMLINK);
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET, undefined);
  });
});

describe('resolveSpaceSyncStatus (Stage 8 — per-space UI signal producer)', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getCachedVerdictSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('flag OFF ⇒ healthy (inert), with NO readlink or verdict read (fast path)', () => {
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag OFF ⇒ healthy even for a dangling symlink (fully inert)', () => {
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('flag ON + a healthy cloud mount ⇒ healthy (no signal), keyed by the first cloud hop', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('healthy');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('healthy');
    // Reads the DEBOUNCED display verdict (NOT the raw getCachedVerdict).
    expect(getDisplayVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET);
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + degraded display verdict ⇒ reconnecting', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('degraded');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('reconnecting');
  });

  it('flag ON + unknown display verdict (not yet probed) ⇒ reconnecting', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('unknown');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('reconnecting');
  });

  it('flag ON + a dangling cloud symlink (ENOENT) ⇒ not_found (structurally gone)', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('not_found');
    // Never reads a verdict for a structurally-gone link.
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + a genuinely LOCAL symlink ⇒ healthy (no cloud mount, no signal)', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(resolveSpaceSyncStatus(LOCAL_SYMLINK)).toBe('healthy');
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });
});

describe('resolveSpaceSyncStatus — cloud-root-safe path (readlink hardening)', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getCachedVerdictSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
    setCloudSymlinkIndexingEnabled(true);
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('rootIsCloud + cloud sourcePath + healthy ⇒ healthy, ZERO readlink (key from sourcePath)', () => {
    getDisplayVerdictSpy.mockReturnValue('healthy');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled(); // never touched the link inode
    expect(getDisplayVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET);
  });

  it('rootIsCloud + cloud sourcePath + degraded ⇒ reconnecting, ZERO readlink', () => {
    getDisplayVerdictSpy.mockReturnValue('degraded');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('reconnecting');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + missing / non-cloud sourcePath ⇒ healthy (no spurious badge), no readlink/verdict', () => {
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true })).toBe('healthy');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: LOCAL_TARGET }),
    ).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud NEVER returns not_found, even for a (would-be dangling) link — we cannot prove "gone" without touching it', () => {
    // The trade-off: under a cloud root we forgo the ENOENT not_found discrimination.
    // A degraded/unknown verdict surfaces the calmer reconnecting, never not_found.
    getDisplayVerdictSpy.mockReturnValue('unknown');
    const status = resolveSpaceSyncStatus(DANGLING_SYMLINK, {
      rootIsCloud: true,
      sourcePath: CLOUD_TARGET,
    });
    expect(status).toBe('reconnecting');
    expect(status).not.toBe('not_found');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('LOCAL root (rootIsCloud false / omitted) keeps full-fidelity readlink walk incl. not_found', () => {
    // Regression guard: the default path is unchanged — it still readlinks and still
    // distinguishes the structurally-gone not_found state.
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK, { rootIsCloud: false })).toBe('not_found');
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('not_found');
    expect(readlinkSyncSpy).toHaveBeenCalledWith(DANGLING_SYMLINK);
  });
});

// 260624 (refinement SHOULD-FIX / Testing GAP-1): the Stage-4 R6 flag-gate that the
// index.ts `onConfirmedHealthyTransition` callback applies before broadcasting a Library
// tree-refresh. The transition DETECTION is covered in cloudLivenessProbeService.test.ts;
// here we cover the flag gate + broadcast side-effect, extracted into a testable helper so
// a future edit that drops the gate (→ a flag-OFF broadcast leak on every cold launch)
// cannot ship silently.
describe('makeConfirmedHealthyBroadcaster (Stage-4 R6 gate)', () => {
  it('flag-ON ⇒ broadcasts on a confirmed healthy transition', () => {
    const broadcast = vi.fn();
    const fire = makeConfirmedHealthyBroadcaster(() => true, broadcast);
    fire();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('flag-ON ⇒ still broadcasts on a repeat transition (debounce is downstream, not the gate)', () => {
    const broadcast = vi.fn();
    const fire = makeConfirmedHealthyBroadcaster(() => true, broadcast);
    fire();
    fire();
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('flag-OFF ⇒ does NOT broadcast (R6: no leak)', () => {
    const broadcast = vi.fn();
    const fire = makeConfirmedHealthyBroadcaster(() => false, broadcast);
    fire();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reads the flag LIVE on each fire (not captured at construction)', () => {
    const broadcast = vi.fn();
    let enabled = false;
    const fire = makeConfirmedHealthyBroadcaster(() => enabled, broadcast);
    fire();
    expect(broadcast).not.toHaveBeenCalled();
    enabled = true;
    fire();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
