/**
 * fileTreeService — CLOUD-ROOT descent regression (260624
 * cloud-space-descent-skip-despite-healthy).
 *
 * THE GAP THAT LET THE BUG SHIP: the existing fileTreeService cloud suite
 * (`fileTreeService.cloudBound.test.ts`) MOCKS `resolveCloudSymlinkAdmission` and
 * never exercises a CLOUD workspace root, so it could not see that a healthy
 * Google-Drive Space under a cloud-classified (Dropbox) root rendered EMPTY. These
 * tests drive the REAL admission decision (via the real `resolveCloudSymlinkAdmission`
 * + a stubbed liveness probe) through `buildFileTree` with `rootIsCloud:true`, and
 * assert:
 *   (1) a healthy cloud Space under a cloud root DESCENDS (node WITH children) — keyed
 *       ZERO-I/O from `sourcePath`, with ZERO `readlinkSync` on the link inode (the
 *       load-bearing RC-1 property — a dead cloud root must never be readlinked);
 *   (2) a cloud Space whose `sourcePath` is missing/relative/non-cloud under a cloud
 *       root SKIPS (visible-but-childless `cloudSkip`), fail closed, no readlink;
 *   (3) the cross-notion invariant: any Space the UI badge (`resolveSpaceSyncStatus`)
 *       reports healthy, admission must NOT skip (the durable class-killer);
 *   (4) a LOCAL-root regression: a healthy cloud symlink under a local root still
 *       descends via the live-readlink path (byte-identical to today).
 *
 * We mock `node:fs` readlinkSync as a SPY so "zero readlink under a cloud root" is
 * directly assertable, and stub the WorkspaceFileSystem so the real
 * `shouldSkipCloudSymlinkTarget` (pattern match on the resolved target) flags the
 * symlink as cloud and the admitted subtree returns real children.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A real workspace topology mirroring Greg's machine: a cloud (Dropbox) root holding
// a Google-Drive Shared-drive symlink Space.
const CLOUD_ROOT = '/Users/test/Dropbox/dev/Rebel-chief-of-staff';
const SPACE_NAME = 'General';
const SPACE_LINK = path.join(CLOUD_ROOT, SPACE_NAME);
const SPACE_SOURCE =
  '/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/General';
const LOCAL_ROOT = '/Users/test/ws';

// ── readlinkSync SPY (the RC-1 assertion lever) ─────────────────────────────
// Under a cloud root the admission path must NEVER call this. Under a local root it
// maps the link to its cloud target (the live-readlink fidelity path).
const readlinkSyncSpy = vi.fn((p: string) => {
  if (p === path.join(LOCAL_ROOT, SPACE_NAME)) return SPACE_SOURCE;
  const err = Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
  throw err; // a non-symlink terminus
});
vi.mock('node:fs', () => ({ readlinkSync: (p: string) => readlinkSyncSpy(p) }));

const { setCloudLivenessProbe, __resetCloudLivenessProbeForTesting } = await import(
  '@core/services/cloudLivenessProbe'
);
type CloudHealthVerdict = import('@core/services/cloudLivenessProbe').CloudHealthVerdict;
const {
  setCloudSymlinkIndexingEnabled,
  __resetCloudSymlinkIndexingForTests,
  resolveSpaceSyncStatus,
} = await import('@core/services/cloudSymlinkIndexing');
const { setWorkspaceFileSystemFactory } = await import('@core/workspaceFileSystem');
const { buildFileTree, buildSpaceSourcePathResolver } = await import('../fileTreeService');

type WorkspaceDirectoryEntry = import('@core/workspaceFileSystem').WorkspaceDirectoryEntry;
type WorkspaceFileSystem = import('@core/workspaceFileSystem').WorkspaceFileSystem;
type WorkspacePathStat = import('@core/workspaceFileSystem').WorkspacePathStat;

// Verdict stub: by default healthy; tests override per case. We capture the keys it
// is read with so we can assert the cloud-root key is the sourcePath, not a readlink.
const getCachedVerdictSpy = vi.fn<(t: string, maxHealthyAgeMs?: number) => CloudHealthVerdict>(
  () => 'healthy',
);
const getDisplayVerdictSpy = vi.fn<(t: string) => CloudHealthVerdict>(() => 'healthy');
function installProbe(): void {
  setCloudLivenessProbe({
    probeHealth: async () => 'healthy',
    getCachedVerdict: (t, maxHealthyAgeMs) => getCachedVerdictSpy(t, maxHealthyAgeMs),
    getDisplayVerdict: (t) => getDisplayVerdictSpy(t),
  });
}

class MockWorkspaceFileSystem implements WorkspaceFileSystem {
  constructor(private readonly root: string) {}
  listDirectory(_r: string, target: string): Promise<WorkspaceDirectoryEntry[]> {
    if (target === '.') {
      return Promise.resolve([
        { name: SPACE_NAME, isDirectory: false, isSymbolicLink: true },
        { name: 'local.md', isDirectory: false, isSymbolicLink: false },
      ]);
    }
    if (target === SPACE_NAME) {
      // The admitted cloud subtree's real children.
      return Promise.resolve([
        { name: 'memo.md', isDirectory: false, isSymbolicLink: false },
        { name: 'notes.md', isDirectory: false, isSymbolicLink: false },
      ]);
    }
    return Promise.resolve([]);
  }
  realPath(_r: string, target: string): Promise<string> {
    if (target === '.') return Promise.resolve(this.root);
    if (target === SPACE_NAME) return Promise.resolve(SPACE_SOURCE); // resolves to a cloud mount
    return Promise.resolve(path.join(this.root, target));
  }
  stat(_r: string, target: string): Promise<WorkspacePathStat> {
    if (target === SPACE_NAME) return Promise.resolve({ isDirectory: true, mtimeMs: 1 });
    return Promise.resolve({ isDirectory: false, mtimeMs: 1 });
  }
  async readFile(): Promise<string> {
    throw new Error('unused');
  }
  async writeFile(): Promise<void> {
    throw new Error('unused');
  }
  async deleteFile(): Promise<void> {
    throw new Error('unused');
  }
  async exists(): Promise<boolean> {
    throw new Error('unused');
  }
}

describe('buildFileTree — cloud-root descent (260624 GDrive-empty regression)', () => {
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
    vi.restoreAllMocks();
  });

  it('healthy cloud Space under a CLOUD root DESCENDS (node WITH children) — keyed from sourcePath, ZERO readlink', async () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    setWorkspaceFileSystemFactory(() => new MockWorkspaceFileSystem(CLOUD_ROOT));

    const resolveSourcePath = buildSpaceSourcePathResolver(CLOUD_ROOT, [
      { name: SPACE_NAME, path: SPACE_NAME, type: 'other', isSymlink: true, sourcePath: SPACE_SOURCE, createdAt: 0 },
    ]);
    const { nodes } = await buildFileTree(CLOUD_ROOT, CLOUD_ROOT, 0, true, new Set<string>(), {
      rootIsCloud: true,
      resolveSourcePath,
    });

    const spaceNode = nodes.find((n) => n.name === SPACE_NAME);
    expect(spaceNode).toBeDefined();
    expect(spaceNode?.kind).toBe('directory');
    // The fix: the Space DESCENDS (children present) instead of the childless cloudSkip node.
    expect(spaceNode?.children?.map((c) => c.name).sort()).toEqual(['memo.md', 'notes.md']);
    // RC-1: never touched the link inode under the (possibly-dead) cloud root.
    expect(readlinkSyncSpy).not.toHaveBeenCalledWith(SPACE_LINK);
    // Verdict was keyed ZERO-I/O from the cached sourcePath, not a live readlink target.
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(SPACE_SOURCE, expect.any(Number));
  });

  it('cloud Space under a CLOUD root with NO usable sourcePath SKIPS (visible-but-childless), no readlink', async () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    setWorkspaceFileSystemFactory(() => new MockWorkspaceFileSystem(CLOUD_ROOT));

    // Empty resolver → admission fails closed under a cloud root.
    const { nodes } = await buildFileTree(CLOUD_ROOT, CLOUD_ROOT, 0, true, new Set<string>(), {
      rootIsCloud: true,
      resolveSourcePath: () => null,
    });

    const spaceNode = nodes.find((n) => n.name === SPACE_NAME);
    expect(spaceNode).toBeDefined();
    expect(spaceNode?.children).toHaveLength(0); // childless cloudSkip — degraded, not crashed
    expect(readlinkSyncSpy).not.toHaveBeenCalledWith(SPACE_LINK);
    // Never read a verdict (null key → fail closed before the verdict read).
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('cross-notion invariant: a Space the UI badge reports healthy is NOT skipped by admission', async () => {
    // The durable class-killer: the two "healthy" notions must not drift such that the
    // badge says healthy while admission skips (empty cards under a green badge).
    getCachedVerdictSpy.mockReturnValue('healthy');
    getDisplayVerdictSpy.mockReturnValue('healthy');
    setWorkspaceFileSystemFactory(() => new MockWorkspaceFileSystem(CLOUD_ROOT));

    // The badge (resolveSpaceSyncStatus) under a cloud root reads the DISPLAY verdict.
    const badge = resolveSpaceSyncStatus(SPACE_LINK, {
      rootIsCloud: true,
      sourcePath: SPACE_SOURCE,
    });
    expect(badge).toBe('healthy');

    const resolveSourcePath = buildSpaceSourcePathResolver(CLOUD_ROOT, [
      { name: SPACE_NAME, path: SPACE_NAME, type: 'other', isSymlink: true, sourcePath: SPACE_SOURCE, createdAt: 0 },
    ]);
    const { nodes } = await buildFileTree(CLOUD_ROOT, CLOUD_ROOT, 0, true, new Set<string>(), {
      rootIsCloud: true,
      resolveSourcePath,
    });
    const spaceNode = nodes.find((n) => n.name === SPACE_NAME);
    // Badge healthy ⊇ admission: the Space is admitted (has children), not skipped.
    expect(spaceNode?.children?.length).toBeGreaterThan(0);
  });

  it('LOCAL-root regression: a healthy cloud symlink under a local root still descends via the live-readlink path', async () => {
    getCachedVerdictSpy.mockReturnValue('healthy');
    setWorkspaceFileSystemFactory(() => new MockWorkspaceFileSystem(LOCAL_ROOT));

    // rootIsCloud:false (the default) — the live-readlink path; sourcePath resolver
    // is inert because admission ignores it under a local root.
    const { nodes } = await buildFileTree(LOCAL_ROOT, LOCAL_ROOT, 0, true);

    const spaceNode = nodes.find((n) => n.name === SPACE_NAME);
    expect(spaceNode?.children?.map((c) => c.name).sort()).toEqual(['memo.md', 'notes.md']);
    // The live-readlink path DID read the link inode (safe under a local root).
    expect(readlinkSyncSpy).toHaveBeenCalledWith(path.join(LOCAL_ROOT, SPACE_NAME));
  });
});
