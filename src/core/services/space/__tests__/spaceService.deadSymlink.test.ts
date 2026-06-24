/**
 * Dead-symlink surfacing — `260624_dead-space-surface-remove` Stage 1.
 *
 * A Space whose backing folder/Drive was permanently deleted is a DEAD SYMLINK (the
 * link file exists; its target is gone). Before this fix the scan followed it, threw a
 * deterministic ENOENT, and the per-candidate catch DROPPED it (logging a recurring
 * warn) → invisible in the UI (so un-removable) + log noise every scan.
 *
 * These tests pin the fix: a dead symlink is RETAINED as a degraded
 * `status:'needs_attention'` / `syncStatus:'not_found'` SpaceInfo so the already-shipped
 * "folder no longer exists" card (badge + Reconnect/Remove) can render it. The negative
 * test pins that an OFFLINE/reconnecting cloud mount is NEVER misclassified as
 * `not_found` (it stays `reconnecting`) — the `cloud_symlink_fuse_hang` family's inverse
 * risk. The flag-OFF test pins that surfacing is independent of `cloudSymlinkIndexing`.
 *
 * Driven with REAL temp-dir fixtures (the LOCAL fs lane uses real `node:fs/promises`, so
 * a real dead symlink threads a genuine ENOENT through the boundary) + the wired cloud
 * executor doubles for the reconnecting case — mirrors spaceService.scanReadLaneBounded.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import {
  realFsExecutor,
  deadMountExecutor,
} from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';
import {
  setCloudSymlinkIndexingEnabled,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';

// electron-store is pulled in transitively by some space-service siblings on certain
// build configs; mock it defensively so the dynamic import never touches a real store.
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => {
      this.store[key] = value;
    });
    delete = vi.fn((key: string) => {
      delete this.store[key];
    });
    has = vi.fn((key: string) => key in this.store);
  },
}));

const spaceService = await import('../spaceService');
const { scanSpacesReadOnly, reconcileSpacesWithSettings, _resetScanSpacesCountersForTesting } =
  spaceService;

// Disable the coalesced cache so each test sees a fresh scan (deterministic).
process.env.REBEL_DISABLE_SPACES_COALESCE = '1';

let tmpRoot: string;
let workspace: string;

/** Write a valid space README so the candidate is unambiguously a space. */
async function writeSpaceReadme(dir: string, description: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'README.md'),
    `---\nrebel_space_description: ${description}\n---\n\n# Space\n`,
  );
}

/**
 * Create the live-repro shape: `work/<company>/<space>` where `<space>` is a DEAD
 * symlink (target does not exist). The company dir is a plain container so the dead
 * symlink is enumerated as a child candidate that the final scan loop materialises.
 */
async function makeDeadSymlinkSpace(company: string, spaceName: string): Promise<string> {
  const companyDir = path.join(workspace, 'work', company);
  await fs.mkdir(companyDir, { recursive: true });
  const deadTarget = path.join(tmpRoot, 'gone', `${spaceName}-target`);
  const link = path.join(companyDir, spaceName);
  // Symlink to a NON-EXISTENT target → dead symlink (lstat OK, stat/readlink-follow ENOENT).
  await fs.symlink(deadTarget, link);
  return link;
}

describe('scanSpaces — dead-symlink surfacing (260624)', () => {
  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-dead-symlink-')));
    workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace);
    _resetScanSpacesCountersForTesting();
    setWorkspaceFsExecutor(realFsExecutor);
    __resetCloudSpaceContainmentForTests();
    __resetCloudSymlinkIndexingForTests();
  });

  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    __resetCloudSymlinkIndexingForTests();
    _resetScanSpacesCountersForTesting();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('REGRESSION: a dead symlink (folder gone) is RETAINED as needs_attention / not_found, not dropped', async () => {
    await makeDeadSymlinkSpace('Acme', 'DeletedDrive-240616');

    const spaces = await scanSpacesReadOnly(workspace);

    const dead = spaces.find((s) => s.name === 'DeletedDrive-240616');
    expect(dead, 'dead-symlink space must be RETAINED in SpaceInfo[] (was dropped before the fix)').toBeDefined();
    expect(dead?.status).toBe('needs_attention');
    expect(dead?.syncStatus).toBe('not_found');
    // A degraded space is a symlink BY CONSTRUCTION. `isSymlink:true` is load-bearing:
    // the Settings Remove handler branches on it (`SpacesManager.handleRemoveButtonClick`)
    // — `false` would misroute the dead space to the "Move out of Library" confirm instead
    // of "Remove link", and `reconcileSpacesWithSettings` would clobber the persisted
    // `isSymlink:true` to false. (Reviewer F1.)
    expect(dead?.isSymlink).toBe(true);
    // Path identity preserved so the Remove affordance can target it.
    expect(dead?.path).toBe('work/Acme/DeletedDrive-240616');
    expect(dead?.absolutePath).toBe(path.join(workspace, 'work', 'Acme', 'DeletedDrive-240616'));
  });

  it('NEGATIVE: a reconnecting (offline-mount) cloud space stays reconnecting, NEVER not_found', async () => {
    // A real cloud-pattern target (Dropbox segment) symlinked into the workspace.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Company Memories');
    await fs.mkdir(cloudTarget, { recursive: true });
    await writeSpaceReadme(cloudTarget, 'Cloud-backed company space');
    const link = path.join(workspace, 'Company Memories');
    await fs.symlink(cloudTarget, link);
    configureCloudSpaceContainment(workspace, [
      { name: 'Company Memories', path: 'Company Memories', type: 'other', isSymlink: true, createdAt: 0 } as never,
    ]);

    // Mount goes dark: every cloud op times out → boundary maps to reconnecting (returned,
    // never thrown), so it must NOT take the dead-symlink ENOENT classification.
    setWorkspaceFsExecutor(deadMountExecutor);

    const spaces = await scanSpacesReadOnly(workspace);

    const space = spaces.find((s) => s.name === 'Company Memories');
    expect(space, 'reconnecting cloud space must be retained').toBeDefined();
    expect(space?.syncStatus).toBe('reconnecting');
    expect(space?.syncStatus).not.toBe('not_found');
    expect(space?.status).toBe('needs_attention');
  });

  it('FLAG-OFF: a dead symlink still surfaces not_found regardless of the cloud-symlink-indexing flag', async () => {
    // EXPLICITLY disable the flag (don't rely on the default) to pin the contract: the
    // dead-symlink producer is flag-INDEPENDENT. The cloud-symlink-indexing producer
    // (resolveSpaceSyncStatus) is inert with no containment + flag off; the dead-symlink
    // producer fires anyway because "the folder is gone" has nothing to do with cloud indexing.
    setCloudSymlinkIndexingEnabled(false);
    __resetCloudSpaceContainmentForTests();
    await makeDeadSymlinkSpace('Acme', 'DeletedDrive-240616');

    setWorkspaceFsExecutor(realFsExecutor);
    const spaces = await scanSpacesReadOnly(workspace);

    const dead = spaces.find((s) => s.name === 'DeletedDrive-240616');
    expect(dead, 'dead symlink must surface even with no cloud indexing').toBeDefined();
    expect(dead?.syncStatus).toBe('not_found');
    expect(dead?.status).toBe('needs_attention');
    expect(dead?.isSymlink).toBe(true);
  });

  it('HEALTHY: a live symlinked space is unaffected (status ok, no not_found)', async () => {
    // Sanity guard: the dead-symlink classification must not bleed onto healthy spaces.
    const companyDir = path.join(workspace, 'work', 'Acme');
    await fs.mkdir(companyDir, { recursive: true });
    const liveTarget = path.join(tmpRoot, 'live', 'ActiveDrive-260416');
    await fs.mkdir(liveTarget, { recursive: true });
    await writeSpaceReadme(liveTarget, 'Live Drive space');
    await fs.symlink(liveTarget, path.join(companyDir, 'ActiveDrive-260416'));

    const spaces = await scanSpacesReadOnly(workspace);

    const live = spaces.find((s) => s.name === 'ActiveDrive-260416');
    expect(live, 'live symlinked space must appear').toBeDefined();
    expect(live?.status).toBe('ok');
    expect(live?.syncStatus).toBeUndefined();
  });

  it('DEPTH (work/<company> direct): a dead symlink AT work/<Company> surfaces not_found', async () => {
    // Distinct code path from the work/<company>/<space> repro above: here the dead symlink
    // sits DIRECTLY at work/<Company>, so the work-loop `workspaceFs.stat(companyPath)` follows
    // it, throws a deterministic ENOENT, and the work/<company> catch surfaces it (reachable
    // via `throw statRead.error`). Reviewer F2 — pin that this reachable catch works.
    const workDir = path.join(workspace, 'work');
    await fs.mkdir(workDir, { recursive: true });
    const deadTarget = path.join(tmpRoot, 'gone', 'DeletedCompany-target');
    await fs.symlink(deadTarget, path.join(workDir, 'DeletedCompany'));

    const spaces = await scanSpacesReadOnly(workspace);

    const dead = spaces.find((s) => s.name === 'DeletedCompany');
    expect(dead, 'dead symlink directly at work/<Company> must be RETAINED').toBeDefined();
    expect(dead?.status).toBe('needs_attention');
    expect(dead?.syncStatus).toBe('not_found');
    expect(dead?.isSymlink).toBe(true);
    expect(dead?.path).toBe('work/DeletedCompany');
  });

  it('DEPTH (root-level): a dead symlink directly at the workspace ROOT surfaces not_found', async () => {
    // Stage 4 (sibling parity): the root candidate loop now LEADS with a bounded
    // `workspaceFs.stat(candidatePath)` (mirroring the work/<company> loop), so a dead symlink
    // sitting directly at the workspace root follows the link, throws a deterministic ENOENT,
    // and the root catch surfaces it (reachable via `throw statRead.error`) — closing the
    // previously-documented out-of-scope limitation. No new disk I/O beyond the bounded stat the
    // work/<company> sibling already uses.
    const deadTarget = path.join(tmpRoot, 'gone', 'RootOrphan-target');
    await fs.symlink(deadTarget, path.join(workspace, 'RootOrphan'));

    const spaces = await scanSpacesReadOnly(workspace);

    const dead = spaces.find((s) => s.name === 'RootOrphan');
    expect(dead, 'root-level dead symlink must now be RETAINED (was dropped before Stage 4)').toBeDefined();
    expect(dead?.status).toBe('needs_attention');
    expect(dead?.syncStatus).toBe('not_found');
    expect(dead?.isSymlink).toBe(true);
    // root-level: the path IS the entry name.
    expect(dead?.path).toBe('RootOrphan');
  });

  it('NEGATIVE (root-level): a reconnecting (offline-mount) symlink at the ROOT stays reconnecting, NEVER not_found', async () => {
    // The Stage-4 inverse risk: the new leading bounded stat must NOT misclassify an offline
    // cloud mount at the root as a dead symlink. A reconnecting mount is RETURNED (kind:
    // 'reconnecting') by the boundary, never thrown — so the root loop retains it as a candidate
    // and the final loop materialises it as `reconnecting`, not `not_found`.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'Root Cloud Space');
    await fs.mkdir(cloudTarget, { recursive: true });
    await writeSpaceReadme(cloudTarget, 'Root-level cloud-backed space');
    const link = path.join(workspace, 'Root Cloud Space');
    await fs.symlink(cloudTarget, link);
    configureCloudSpaceContainment(workspace, [
      { name: 'Root Cloud Space', path: 'Root Cloud Space', type: 'other', isSymlink: true, createdAt: 0 } as never,
    ]);

    // Mount goes dark: every cloud op times out → boundary maps to reconnecting (returned, never
    // thrown), so the leading bounded stat must take the reconnecting branch, not the ENOENT catch.
    setWorkspaceFsExecutor(deadMountExecutor);

    const spaces = await scanSpacesReadOnly(workspace);

    const space = spaces.find((s) => s.name === 'Root Cloud Space');
    expect(space, 'reconnecting root-level cloud space must be retained').toBeDefined();
    expect(space?.syncStatus).toBe('reconnecting');
    expect(space?.syncStatus).not.toBe('not_found');
    expect(space?.status).toBe('needs_attention');
  });

  it('RECONCILE: a degraded not_found scan does NOT clobber a persisted isSymlink:true to false', async () => {
    // Reviewer F1 / reconcile half: `reconcileSpacesWithSettings` writes `scanned.isSymlink`
    // over the persisted entry (spaceService.ts merge block). With the fix the degraded scan
    // carries isSymlink:true, so the persisted symlink-ness survives reconciliation — which is
    // what keeps the Settings Remove handler routing to "Remove link", not "Move out".
    const persisted = [
      {
        name: 'DeletedDrive-240616',
        path: 'work/Acme/DeletedDrive-240616',
        type: 'other',
        isSymlink: true,
        sourcePath: '/some/cloud/target/DeletedDrive-240616',
        createdAt: 0,
      } as never,
    ];
    // The scan now returns a degraded not_found SpaceInfo for the same path.
    const degradedScan = [
      {
        name: 'DeletedDrive-240616',
        path: 'work/Acme/DeletedDrive-240616',
        absolutePath: path.join(workspace, 'work', 'Acme', 'DeletedDrive-240616'),
        type: 'other',
        isSymlink: true,
        hasReadme: false,
        status: 'needs_attention',
        syncStatus: 'not_found',
      } as never,
    ];

    const reconciled = await reconcileSpacesWithSettings(workspace, degradedScan, persisted);

    const entry = reconciled.find((s) => s.path === 'work/Acme/DeletedDrive-240616');
    expect(entry, 'persisted entry must be retained').toBeDefined();
    expect(entry?.isSymlink, 'persisted isSymlink:true must NOT be clobbered to false').toBe(true);
    // sourcePath also survives (degraded scan can't read the dead target → falls back to persisted).
    expect(entry?.sourcePath).toBe('/some/cloud/target/DeletedDrive-240616');
  });
});
