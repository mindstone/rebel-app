/**
 * cloudSymlinkIndexing — the core-readable admission flag for the
 * `260619_cloud-symlink-indexing` feature (Stage 6b).
 *
 * The three descent decision points (`safeWalkDirectory` background indexing,
 * `fileTreeService` Library tree, `workspaceWatcherService` chokidar matcher) and
 * the absence-proof producer live in `src/core` / `src/main` — pure/sync code that
 * does NOT have an `AppSettings` object in hand. So the `experimental.cloudSymlinkIndexing`
 * flag is mirrored into a module-singleton boolean here, set once at bootstrap and
 * on every settings change (exactly like `cloudSpaceContainment` is reconfigured),
 * and read synchronously via {@link isCloudSymlinkIndexingEnabled}.
 *
 * THE CRITICAL INVARIANT (Stage 6b mandate): the default is `false`, and while it
 * is `false` every consult site behaves byte-identically to today — cloud symlink
 * targets stay EXCLUDED from walk/watch/index everywhere (the RC-1 / libuv-pool
 * hang-safe behaviour). Admission (descending into a healthy cloud space) is
 * gated on this flag being `true` AND the off-thread liveness verdict being
 * `healthy`. Flipping the DEFAULT on is a separate, later decision; this module
 * only carries the flag, it does not decide the default.
 *
 * Pure module-level state, no `electron` import → safe in `src/core/`. Cloud/mobile
 * never set it (no FUSE mounts there), so it stays `false` and nothing is admitted.
 *
 * This module is deliberately LOGGER-FREE (no `createScopedLogger` import) because
 * `resolveCloudSymlinkAdmission` below is imported by `safeWalkDirectory` (a
 * widely-used core util whose many test files mock `@core/logger` minimally) —
 * keeping the import lean avoids dragging the logger into every walker consumer.
 */
import { getCloudLivenessProbe } from '@core/services/cloudLivenessProbe';
import {
  mintCloudHopTargetCloudRootSafe,
  mintCloudHopTargetFromKnownCloudPath,
  mintFirstCloudHopTargetSync,
} from '@core/services/cloudLivenessProbe.types';
import { walkToFirstCloudHopViaReadlink } from '@core/utils/readlinkChain';

/**
 * Module-singleton mirror of `settings.experimental.cloudSymlinkIndexing`. The
 * UN-mirrored module default is `false` (inert exclude-all-cloud) so a host that
 * never wires the value — including cloud/mobile, which have no `utilityProcess` /
 * fs executor — stays safe. The DESKTOP host (`src/main/index.ts`) now mirrors with
 * a default-ON resolution (`?? true`, S5): undefined ⇒ ON, explicit `false` ⇒ the
 * kill-switch. So on desktop the effective default is ON; the `false` here is only
 * the pre-mirror / non-desktop floor.
 */
let _enabled = false;

/**
 * Mirror the current `experimental.cloudSymlinkIndexing` flag into this module.
 * Called at bootstrap and from the settings-change hook (`onDidAnyChange`). The
 * argument is `enabled === true`, so the DEFAULT-ON resolution lives at the desktop
 * call site (`... ?? true`) — passing `undefined` here coerces to `false` (the
 * non-desktop / pre-mirror floor), NOT the desktop default.
 */
export function setCloudSymlinkIndexingEnabled(enabled: boolean | undefined): void {
  _enabled = enabled === true;
}

/**
 * Synchronous, total read of the admission flag — hot-path safe (no I/O, never
 * throws). `false` ⇒ exclude all cloud symlink targets (default / today's
 * behaviour); `true` ⇒ a HEALTHY cloud space is admitted at the descent decision
 * points (the verdict gate is applied separately by each caller).
 */
export function isCloudSymlinkIndexingEnabled(): boolean {
  return _enabled;
}

/**
 * Whether a cloud symlink reached during descent / watch should be ADMITTED
 * (walked into, watched, indexed) or SKIPPED.
 *
 *  - `'skip'`  — the default and today's behaviour: exclude the cloud symlink
 *    target (admission flag off, OR the space's verdict is `degraded`/`unknown`).
 *  - `'admit'` — the admission flag is ON **and** the off-thread cloud-liveness
 *    verdict for the space is `healthy`. The caller descends/watches/indexes as
 *    if it were a local space (its own bounded budget is the defence-in-depth).
 */
export type CloudSymlinkAdmission = 'admit' | 'skip';

/**
 * Stage 6b — the single admission decision the three descent decision points
 * consult for a cloud symlink (the `safeWalkDirectory` readlink-first skip, the
 * `fileTreeService` `cloudSkip` node, the `workspaceWatcherService` matcher).
 *
 * `symlinkPath` is the symlink's OWN path. The verdict cache KEY is minted via the
 * SINGLE cloud-root-safe key source {@link mintCloudHopTargetCloudRootSafe} — the
 * SAME helper prewarm + containment + sync-status use — so the prewarm-populated
 * verdict is read back under a byte-identical key by construction.
 *
 * CLOUD-ROOT-SAFE OVERLOAD (260624 — the fix for GDrive Spaces under a Dropbox
 * workspace root rendering empty): when `options.rootIsCloud`, the symlink inode
 * lives UNDER a cloud-classified root, so even a `readlinkSync` on it could block a
 * dead FUSE mount on the main thread (the libuv-pool hang this subsystem exists to
 * kill — the same hazard the 260623 prewarm fix closed for prewarm/containment/
 * sync-status; admission was the lone holdout). In that mode the key is minted
 * ZERO-I/O from the cached `sourcePath`. ALL key-minting is delegated to
 * {@link mintCloudHopTargetCloudRootSafe} (no hand-rolled `readlinkSync` branch
 * here), so a sync readlink under a cloud root is UNREPRESENTABLE by construction:
 *  - `rootIsCloud:true`  → ZERO-I/O `sourcePath` key (missing/relative/non-cloud
 *    `sourcePath` → `null` → `'skip'`, fail closed, NEVER a readlink under the root);
 *  - `rootIsCloud:false`/omitted → byte-identical to today: the full-fidelity
 *    `mintFirstCloudHopTargetSync` live-readlink walk (covers chained-local-alias).
 *
 * VERDICT FRESHNESS: the verdict read uses a longer ADMISSION-scoped TTL
 * ({@link ADMISSION_VERDICT_TTL_MS}, 360s) so a healthy verdict survives the gap
 * between the 5-min periodic re-walk re-probes — `buildFileTree` runs on-demand and
 * uncached, so with the raw 45s TTL most renders read an expired `unknown` and skip
 * (the empty-cards trigger). The raw `getCachedVerdict` (self-healing, un-debounced)
 * is still the source of truth — NOT the sticky `getDisplayVerdict` — we just widen
 * its trusted window for THIS reader. Other readers (containment, coverage) keep the
 * raw 45s. See docs/plans/260624_cloud-space-descent-skip-despite-healthy/PLAN.md.
 *
 * SYNC + total (never blocks, never throws): the flag read is a module-boolean, the
 * key mint is `readlinkSync`-only on a local root (zero-I/O under a cloud root), the
 * verdict read is the total `getCachedVerdict`. Returns `'skip'` unless BOTH the flag
 * is on AND the cached verdict is `healthy` — so with the flag OFF this is
 * byte-identical to "always skip cloud", with NO key mint / verdict read on the fast
 * path. Returns `'skip'` when the chain is unclassifiable (key mint returns null —
 * a dangling link / dead first hop / hop-cap, or an unkeyable `sourcePath` under a
 * cloud root) — fail closed.
 */
export function resolveCloudSymlinkAdmission(
  symlinkPath: string,
  options?: {
    readonly rootIsCloud?: boolean;
    readonly sourcePath?: string | null;
    /**
     * 260624: the Library file-tree descent (`buildFileTree`) passes
     * {@link ADMISSION_VERDICT_TTL_MS} (360s) so a healthy verdict survives the gap
     * between 5-min re-walk re-probes (the empty-cards fix). OMITTED ⇒ the raw 45s
     * `HEALTHY_VERDICT_TTL_MS` — byte-identical to today for the EXEMPT single-arg
     * callers (the embedding indexer's `safeWalkDirectory`, the subprocess-exclusion
     * walk), which run under a LOCAL parent dir and must keep the unwidened tolerance.
     */
    readonly maxHealthyAgeMs?: number;
  },
): CloudSymlinkAdmission {
  // Flag-off fast path: byte-identical to today (no key mint, no verdict read).
  if (!_enabled) return 'skip';
  const verdictKey = mintCloudHopTargetCloudRootSafe({
    linkPath: symlinkPath,
    sourcePath: options?.sourcePath,
    rootIsCloud: options?.rootIsCloud === true,
  });
  if (verdictKey === null) return 'skip'; // unclassifiable / unkeyable → fail closed (exclude)
  // `maxHealthyAgeMs` omitted ⇒ `getCachedVerdict` uses the raw 45s TTL (exempt callers
  // unchanged). Only the Library admission path passes the longer ADMISSION tolerance.
  return getCloudLivenessProbe().getCachedVerdict(verdictKey, options?.maxHealthyAgeMs) === 'healthy'
    ? 'admit'
    : 'skip';
}

/**
 * Stage-4 (260624) R6 gate — the pure decision behind the `onConfirmedHealthyTransition`
 * callback wired in `index.ts`. Builds a broadcaster that emits a debounced Library
 * tree-refresh ONLY when the cloud-symlink-indexing flag is ON, so a flag-OFF build
 * never leaks a `library:changed` on a cold-launch `unknown → healthy` transition.
 *
 * The transition DETECTION (first-warm + degraded→healthy recovery, NOT steady-state
 * healthy→healthy) lives in the prober (`recordObservedVerdict`); this is solely the
 * flag gate + the broadcast side-effect, extracted so the R6 invariant is unit-tested
 * (rather than asserted only by reading the inline `index.ts` ctor callback).
 *
 * @param isEnabled  reads the live admission flag (`isCloudSymlinkIndexingEnabled`).
 * @param broadcast  the side-effect (the `libraryBroadcaster.broadcast` emit).
 */
export function makeConfirmedHealthyBroadcaster(
  isEnabled: () => boolean,
  broadcast: () => void,
): () => void {
  return () => {
    if (!isEnabled()) return; // R6: flag-OFF must never leak a broadcast.
    broadcast();
  };
}

// ---------------------------------------------------------------------------
// Stage 8 — per-space degraded-state UI signal (producer).
// ---------------------------------------------------------------------------

/**
 * The flap-debounced per-space SYNC-health signal surfaced in the UI (the Stage-8
 * "Reconnecting" badge/banner on `SpaceCard` + the search-results notice). DISTINCT
 * from `SpaceInfo.status` (`'ok' | 'needs_attention'` = frontmatter/CONFIG health) —
 * this is the cloud MOUNT's reachability, an orthogonal axis (Chief-Designer F1).
 *
 *  - `'healthy'`      — the cloud mount answered a bounded probe at local-disk
 *    latency (or the space isn't a cloud space / the feature is off) ⇒ NO signal.
 *    The default, so a space with no cloud signal renders exactly as today.
 *  - `'reconnecting'` — the mount is timing out / flapping / not-yet-probed; the
 *    last-known index is retained and the mount auto-recovers. UI states A (prior
 *    index) and B (no prior index) both map here; the renderer picks the copy.
 *  - `'not_found'`    — the linked folder is STRUCTURALLY gone (a dangling symlink,
 *    e.g. a deleted shared drive) — NOT a transient outage, so we never promise
 *    recovery. UI state C (warning tone + Reconnect/Remove).
 */
export type SpaceSyncStatus = 'healthy' | 'reconnecting' | 'not_found';

/**
 * Stage 8 producer — resolve the per-space {@link SpaceSyncStatus} for a space's
 * symlink path, READLINK-ONLY and SYNC (never blocks, never throws, never touches
 * the mount). Consumed by `scanSpaces` to populate `SpaceInfo.syncStatus`.
 *
 * GATING (the inert-when-off invariant): a non-`'healthy'` status is produced ONLY
 * for an ADMITTED cloud space — i.e. the `cloudSymlinkIndexing` flag is ON. With the
 * flag OFF this returns `'healthy'` immediately (no readlink, no verdict read), so
 * the UI shows no signal at all — byte-identical to today. (A non-cloud / local
 * space also returns `'healthy'` regardless of the flag: there's no mount to be
 * reconnecting to.)
 *
 * `symlinkPath` is the space's OWN symlink path (under a LOCAL parent dir). The
 * chain is walked with `readlinkSync` ONLY, STOPPING at the first cloud hop (never
 * readlinking into a possibly-dead mount — the load-bearing F2 safety property),
 * and the verdict comes from the prober's flap-DEBOUNCED `getDisplayVerdict` (the
 * Chief-Designer-spec'd 8s-settle / clear-on-healthy / cooldown), NOT the raw
 * `getCachedVerdict` admission/purge read.
 *
 * Distinguishing `'not_found'` from `'reconnecting'` without dereferencing:
 *  - a `readlinkSync` ENOENT on the chain = the link target genuinely doesn't exist
 *    = structurally gone → `'not_found'` (state C);
 *  - any other unclassifiable code (EACCES/ELOOP/timeout/dead-mount-first-hop) is
 *    treated as the calmer `'reconnecting'` (we can't prove the folder is GONE, only
 *    that it's unreachable right now).
 */
export function resolveSpaceSyncStatus(
  symlinkPath: string,
  options?: { readonly rootIsCloud?: boolean; readonly sourcePath?: string | null },
): SpaceSyncStatus {
  // Flag-off fast path: byte-identical to today (no readlink, no verdict read).
  if (!_enabled) return 'healthy';

  // CLOUD-ROOT-SAFE PATH (cloud-inside-cloud, e.g. a Dropbox workspace root holding
  // Google-Drive symlinks): the symlink inode lives UNDER a cloud-classified root, so
  // the `walkToFirstCloudHopViaReadlink` readlink below could block on a dead FUSE
  // mount on the main thread (the same hazard the prewarm fix closed). Derive the
  // verdict key ZERO-I/O from the cached `sourcePath` instead. The trade-off: we give
  // up the ENOENT `'not_found'` discrimination (we cannot prove the linked folder is
  // structurally GONE without touching the link), so we fail toward the CALMER states.
  //  - usable cloud `sourcePath` → flap-debounced display verdict: healthy ⇒ no
  //    signal, degraded/unknown ⇒ `'reconnecting'` (recovers; never the alarming
  //    `'not_found'`);
  //  - non-cloud / missing / relative `sourcePath` → `'healthy'` (no mount we can
  //    speak to → no spurious "Reconnecting" badge).
  // The key is minted byte-identically to admission/prewarm, so the verdict reads
  // back under the same key. Local-root callers (the default) keep the full-fidelity
  // readlink walk below, including `'not_found'`.
  if (options?.rootIsCloud) {
    const verdictKey =
      typeof options.sourcePath === 'string'
        ? mintCloudHopTargetFromKnownCloudPath(options.sourcePath)
        : null;
    if (verdictKey === null) return 'healthy';
    return getCloudLivenessProbe().getDisplayVerdict(verdictKey) === 'healthy'
      ? 'healthy'
      : 'reconnecting';
  }

  const hop = walkToFirstCloudHopViaReadlink(symlinkPath);
  if (hop.kind === 'local-terminus') {
    // A genuinely local space (e.g. `rebel-system → /Applications/…`) — no mount.
    return 'healthy';
  }
  if (hop.kind === 'unclassifiable') {
    // ENOENT = the link itself dangles (target structurally gone) → state C. Any
    // other code (EACCES/ELOOP/timeout/dead first hop) is unreachable-but-not-
    // provably-gone → the calmer "reconnecting".
    return hop.code === 'ENOENT' ? 'not_found' : 'reconnecting';
  }
  // hop.kind === 'cloud' — a live cloud chain. Mint the verdict-cache key
  // readlink-only (byte-identical to prewarm/containment/admission) and read the
  // FLAP-DEBOUNCED display verdict. `healthy` ⇒ no signal; degraded/unknown ⇒
  // reconnecting.
  const verdictKey = mintFirstCloudHopTargetSync(symlinkPath);
  if (verdictKey === null) return 'reconnecting'; // unclassifiable on the mint path → fail toward the calmer state
  return getCloudLivenessProbe().getDisplayVerdict(verdictKey) === 'healthy'
    ? 'healthy'
    : 'reconnecting';
}

/** Test-only: restore the default `false`. */
export function __resetCloudSymlinkIndexingForTests(): void {
  _enabled = false;
}
