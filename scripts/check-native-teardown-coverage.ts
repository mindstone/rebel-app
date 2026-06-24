#!/usr/bin/env npx tsx
/**
 * Native-teardown coverage guard (Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md).
 *
 * WHY THIS EXISTS: a native-resource owner (an in-MAIN-process holder of a
 * native worker/TSFN/handle — an ORT InferenceSession, a LanceDB connection, a
 * BLE central) can be added to the codebase and be COMPLETELY INVISIBLE to
 * shutdown. Nothing structurally forces a new owner to be classified against
 * the teardown contract. That is the exact structural miss that hid moonshine
 * ONNX (no disposer at all) and the file-index LanceDB connection (closeIndex
 * exists, never called on desktop quit) — both now prime quit-deadlock suspects
 * (Sentry REBEL-6AM). See docs/plans/260622_teardown-lifecycle-contract/PLAN.md
 * and subagent_reports/260622_researcher.md.
 *
 * This guard makes "an invisible native owner" UNREPRESENTABLE: it scans the
 * source tree for a PINNED, NARROW set of native-owner signatures and FAILS
 * when a matched file is NOT mapped to an entry in the
 * `nativeTeardownRegistry.ts` manifest AND not on the explicit EXEMPT list.
 *
 * MANIFEST-DRIVEN, NOT regex-as-source-of-truth (GPT design F3): the regex
 * SIGNATURES only FIND candidate owners; the source of truth for "is this owner
 * covered" is the registry manifest. The signatures are deliberately narrow —
 * they match the call that ESTABLISHES a long-lived native handle
 * (`lancedb.connect(`, `InferenceSession.create(`, a BLE central's
 * `startScanning(`), NOT every reference to a native package (which would
 * over-match the loader util, type-only imports, JSDoc, etc.). A pasted current
 * match list (CURRENT_MATCH_BASELINE) keeps this deterministic and
 * review-visible; a NEW unrecognised match FAILS loud, forcing a human to
 * classify it (register it, or EXEMPT it with a reason).
 *
 * Wired into scripts/run-validate-fast.ts with a step-identity baseline.
 *
 * Usage: npx tsx scripts/check-native-teardown-coverage.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getDetachedChildManifestNames,
  getDetachedChildNamesWithEmptyBackstop,
  getDetachedChildTrackedGapNames,
  getNativeTeardownManifestNames,
} from '../src/main/services/nativeTeardownManifest';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Source roots scanned for native-owner signatures (no tests / built output). */
const SCAN_ROOTS = ['src/main', 'src/core'] as const;

const EXCLUDE_PARTS = new Set(['__tests__', '__mocks__', 'node_modules', 'build', 'dist', '.vite']);

// --- Native-owner signatures (narrow, pinned) -------------------------------------------

/**
 * A signature that identifies a file as a native-resource OWNER. Each matches
 * the call that ESTABLISHES a long-lived in-process native handle — not a mere
 * reference to a native package. Deliberately narrow to avoid the over-match
 * the broad-regex approach risks (GPT design F3).
 */
export interface NativeOwnerSignature {
  /** Human label for diagnostics. */
  readonly label: string;
  /** Matches the handle-establishing call. */
  readonly pattern: RegExp;
}

export const NATIVE_OWNER_SIGNATURES: readonly NativeOwnerSignature[] = [
  {
    label: 'LanceDB connection (native Rust addon + async runtime)',
    // `lancedb.connect(` — the call that opens a LanceDB connection handle.
    pattern: /\blancedb\.connect\s*\(/,
  },
  {
    label: 'ONNX Runtime InferenceSession (native runtime threads)',
    // `InferenceSession.create(` — creates an ORT session holding native threads.
    pattern: /\bInferenceSession\.create\s*\(/,
  },
  {
    label: 'BLE central scan (native @stoprocent/noble handle)',
    // `.startScanning(` on a noble central — opens an OS BLE handle.
    pattern: /\bstartScanning\s*\(/,
  },
  {
    label: 'sherpa-onnx ONNX Runtime recognizer (native runtime threads)',
    // `loadNativeModule<...>('sherpa-onnx-node')` — loads the native ORT-backed
    // sherpa module that the Windows local-STT path uses to build an
    // OfflineRecognizer (native threads) in the MAIN process. Matches the LOAD
    // call (not a bare mention of the package name), so the manifest's own note
    // string and the loadNativeModule JSDoc example do not false-match.
    pattern: /\bloadNativeModule\b[^)]*\bsherpa-onnx-node\b/,
  },
] as const;

// --- Detached-child signature (orphan-survival dimension) -------------------------------

/**
 * Matches a spawn option that makes a child DETACHED with a non-`false` value —
 * i.e. a child that can be reparented to launchd/init and OUTLIVE the parent
 * (the orphan failure mode, distinct from the native hang-parent signatures
 * above).
 *
 * The negative lookahead skips ONLY an EXACT `false` / `undefined` literal value
 * (followed by a delimiter or end-of-line) — `detached: false`, `detached: undefined`.
 * It deliberately still MATCHES compound expressions that merely START with those
 * tokens (`detached: false || shouldDetach`, `detached: undefined ?? shouldDetach`)
 * because their runtime value can be truthy (reviewer F2). It also matches the
 * literal `detached: true`, computed forms (`detached: !isWindows && !isTestMode`,
 * `detached: !isWindows`), and passthrough forms (`detached: options.detached`) —
 * so a conservatively-flagged passthrough must be explicitly exempted.
 *
 * Applied to COMMENT-STRIPPED source (via stripComments), so the many
 * `// ... detached: true ...` doc comments and JSDoc examples do not false-match;
 * only a real options-object property survives.
 */
export const DETACHED_CHILD_SIGNATURE: RegExp =
  /\bdetached\s*:\s*(?!(?:false|undefined)\b\s*(?:[,}\n;)]|$))\S/;

/** Whether this (comment-stripped) source spawns a non-`false` detached child. */
export function matchesDetachedSignature(source: string): boolean {
  return DETACHED_CHILD_SIGNATURE.test(stripComments(source));
}

/**
 * Maps a file that spawns a non-`false` detached child to its registered NAME
 * in `DETACHED_CHILD_MANIFEST` (nativeTeardownManifest.ts). Every file matching
 * the detached signature MUST appear here (covered) or in
 * DETACHED_CHILD_EXEMPT (justified) — neither is a hard FAIL. Pasted CURRENT
 * baseline; a new unrecognised match fails loud, forcing classification.
 */
export const DETACHED_CHILD_OWNER_FILES: ReadonlyMap<string, string> = new Map([
  ['src/core/services/superMcpHttpManager.ts', 'super-mcp'],
  ['src/main/services/autoUpdateService.ts', 'relaunch-watchdog'],
  ['src/core/rebelCore/builtinTools.ts', 'bash-tool'],
]);

/**
 * Files that match the detached signature but are deliberately NOT a manifest
 * owner, each with a one-line reason: a dev-only spawn that never runs in a
 * packaged build, or a generic passthrough primitive whose `detached` is decided
 * by its caller (the caller is the real owner and must itself be covered).
 */
export const DETACHED_CHILD_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'src/main/services/nativeTeardownManifest.ts',
    "the teardown manifest's own data file: `detached:` appears only inside DETACHED_CHILD_MANIFEST note STRINGS describing real spawn sites — this file has zero imports and spawns nothing. Listed so the guard does not flag its own source.",
  ],
  [
    'src/main/services/demoModeService.ts',
    'dev-only: spawns a terminal to restart `npm run dev` (spawnDevModeRestart) — never reached in a packaged/production build, so it cannot orphan a shipped app.',
  ],
  [
    'src/main/services/mcp/mcpSubprocessAdapter.ts',
    'passthrough primitive: MainProcessSpawner forwards the caller-supplied options.detached; the CALLER owns the detached decision (sole caller is superMcpHttpManager, which is covered).',
  ],
]);

/**
 * The ONLY detached children allowed to declare `tracked-gap` as their backstop
 * (a KNOWN orphan gap with no real non-graceful backstop yet). Reviewer F1: if
 * `tracked-gap` simply counted as a valid backstop, CI could stay green while a
 * new detached child admits "no backstop" — gutting the class-kill. So this is a
 * pinned baseline: a manifest entry whose only backstop is `tracked-gap` and
 * whose name is NOT here is a hard FAIL (add a real backstop, or make a loud,
 * review-visible edit to this baseline). A baseline name that is NOT actually a
 * tracked-gap (closed/renamed) is a stale-baseline FAIL.
 *
 * `bash-tool` is the sole accepted gap (the agent Bash tool's detached command
 * shell can orphan on a force-quit mid-command; a real backstop is a separate
 * scoped task — see docs/plans/260623_detached-child-backstop-guard/PLAN.md).
 */
export const TRACKED_GAP_BASELINE: ReadonlySet<string> = new Set(['bash-tool']);

// --- Coverage manifest (the source of truth) --------------------------------------------

/**
 * Maps a matched source file (repo-relative posix path) to its registered
 * owner NAME in `src/main/services/nativeTeardownRegistry.ts`. Every file the
 * signatures match MUST appear here (covered) or in EXEMPT (justified) — a
 * file matching a signature and present in NEITHER is a hard FAIL.
 *
 * This is the pasted CURRENT match baseline (PLAN.md / design F3): it is
 * deterministic and review-visible, and a NEW unrecognised match fails loud.
 */
export const COVERED_OWNER_FILES: ReadonlyMap<string, string> = new Map([
  // LanceDB main-process connection owners.
  ['src/main/services/conversationIndexService.ts', 'conversation-lancedb'],
  ['src/core/services/toolIndex/toolIndexService.ts', 'tool-lancedb'],
  ['src/main/services/fileIndexService/index.ts', 'file-lancedb'],
  // ONNX Runtime main-process session owners.
  ['src/main/services/moonshineTranscriber.ts', 'moonshine-onnx'],
  ['src/main/services/localSttService.ts', 'local-stt-sherpa'],
  // BLE central (device feature) — classified `tracked-gap` (in-MAIN OS BLE
  // handle, not yet on the shutdown roster); manifest-only, no liveness accessor.
  ['src/main/services/physicalRecording/physicalRecordingService.ts', 'noble-ble'],
]);

/**
 * Files that match a native-owner signature but are deliberately NOT a
 * registry main-owner, each with a one-line reason. These are owners whose
 * heavy native resource lives in a SEPARATE OS process (a utilityProcess
 * worker / offscreen window), so it dies with that process and cannot block
 * the main process's env teardown — OR a transient connect→use→close in a
 * single bounded call with no persistent in-main holder.
 */
export const EXEMPT_OWNER_FILES: ReadonlyMap<string, string> = new Map([
  [
    'src/main/workers/preTurnWorker.ts',
    'out-of-process-child: runs in a utilityProcess (its own OS process); LanceDB connections die with the worker, cannot hang main env teardown.',
  ],
  [
    'src/main/workers/indexHealthWorker.ts',
    'out-of-process-child: runs in a utilityProcess (force-killable on timeout); LanceDB connection dies with the worker.',
  ],
  [
    'src/core/services/indexHealthService.ts',
    'stateless-transient: opens a LanceDB connection for one bounded validate call and closes it before returning (no persistent in-main holder).',
  ],
]);

// --- Pure core (unit-tested) ------------------------------------------------------------

function toRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

/** Strip block + line comments so JSDoc examples / commented code don't false-match. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Which signature labels (if any) match this (comment-stripped) source. */
export function matchingSignatures(
  source: string,
  signatures: readonly NativeOwnerSignature[] = NATIVE_OWNER_SIGNATURES,
): string[] {
  const code = stripComments(source);
  return signatures.filter((s) => s.pattern.test(code)).map((s) => s.label);
}

export interface CoverageViolation {
  readonly repoPath: string;
  readonly matchedSignatures: readonly string[];
  readonly kind: 'unclassified';
}

/** A covered-file → owner-name mapping whose owner name is absent from the manifest (FAIL). */
export interface UnknownOwnerViolation {
  readonly repoPath: string;
  readonly ownerName: string;
}

export interface CoverageResult {
  /** Files matching a signature that are neither covered nor exempt (FAIL). */
  readonly violations: readonly CoverageViolation[];
  /** Covered entries naming an owner that is not in the manifest (FAIL — guard is manifest-driven). */
  readonly unknownOwners: readonly UnknownOwnerViolation[];
  /** Covered-map entries whose file no longer matches any signature (stale baseline → FAIL). */
  readonly staleCovered: readonly string[];
  /** Exempt-map entries whose file no longer matches any signature (stale baseline → FAIL). */
  readonly staleExempt: readonly string[];
  readonly matchedFileCount: number;
}

/**
 * Pure coverage computation over a set of (repoPath → comment-stripped-source)
 * inputs. A file that matches a signature must be covered OR exempt; every
 * covered file's named owner MUST exist in the manifest (the guard is actually
 * manifest-driven — a typo'd/deleted owner name fails, GPT F1); and every
 * covered/exempt baseline entry must still match a signature (no stale
 * allowlisting — same anti-rot posture as check-packaged-native-modules).
 */
export function computeCoverage(
  files: ReadonlyMap<string, string>,
  covered: ReadonlyMap<string, string> = COVERED_OWNER_FILES,
  exempt: ReadonlyMap<string, string> = EXEMPT_OWNER_FILES,
  signatures: readonly NativeOwnerSignature[] = NATIVE_OWNER_SIGNATURES,
  manifestOwnerNames: readonly string[] = getNativeTeardownManifestNames(),
): CoverageResult {
  const violations: CoverageViolation[] = [];
  const matchedRepoPaths = new Set<string>();

  for (const [repoPath, source] of files) {
    const matched = matchingSignatures(source, signatures);
    if (matched.length === 0) {
      continue;
    }
    matchedRepoPaths.add(repoPath);
    if (covered.has(repoPath) || exempt.has(repoPath)) {
      continue;
    }
    violations.push({ repoPath, matchedSignatures: matched, kind: 'unclassified' });
  }

  // GPT F1: the guard is only manifest-driven if a covered file's named owner
  // actually exists in the manifest. A typo or a deleted manifest entry must FAIL.
  const manifestNameSet = new Set(manifestOwnerNames);
  const unknownOwners: UnknownOwnerViolation[] = [];
  for (const [repoPath, ownerName] of covered) {
    if (!manifestNameSet.has(ownerName)) {
      unknownOwners.push({ repoPath, ownerName });
    }
  }

  const staleCovered = [...covered.keys()].filter((p) => !matchedRepoPaths.has(p));
  const staleExempt = [...exempt.keys()].filter((p) => !matchedRepoPaths.has(p));

  return {
    violations,
    unknownOwners,
    staleCovered,
    staleExempt,
    matchedFileCount: matchedRepoPaths.size,
  };
}

// --- Detached-child coverage (pure) -----------------------------------------------------

export interface DetachedCoverageViolation {
  readonly repoPath: string;
  readonly kind: 'unclassified';
}

export interface DetachedCoverageResult {
  /** Files matching the detached signature that are neither covered nor exempt (FAIL). */
  readonly violations: readonly DetachedCoverageViolation[];
  /** Covered entries naming a manifest owner that does not exist (FAIL — manifest-driven). */
  readonly unknownOwners: readonly UnknownOwnerViolation[];
  /** Manifest owners whose declared backstop array is empty (FAIL — a detached child with no backstop is the orphan bug). */
  readonly emptyBackstop: readonly string[];
  /** Manifest owners whose only backstop is `tracked-gap` but are NOT in TRACKED_GAP_BASELINE (FAIL — a new unauthorised gap). */
  readonly newTrackedGaps: readonly string[];
  /** TRACKED_GAP_BASELINE names that are no longer an actual tracked-gap owner (stale baseline → FAIL). */
  readonly staleTrackedGapBaseline: readonly string[];
  /** Covered-map entries whose file no longer matches the signature (stale → FAIL). */
  readonly staleCovered: readonly string[];
  /** Exempt-map entries whose file no longer matches the signature (stale → FAIL). */
  readonly staleExempt: readonly string[];
  readonly matchedFileCount: number;
}

/**
 * Pure detached-child coverage over (repoPath → comment-stripped-source) inputs,
 * mirroring `computeCoverage` for the orphan-survival dimension: a file spawning
 * a non-`false` detached child must be covered OR exempt; every covered file's
 * named owner must exist in `DETACHED_CHILD_MANIFEST`; every covered owner must
 * declare a non-empty backstop; and no covered/exempt baseline entry may be
 * stale (no longer match the signature).
 */
export function computeDetachedCoverage(
  files: ReadonlyMap<string, string>,
  covered: ReadonlyMap<string, string> = DETACHED_CHILD_OWNER_FILES,
  exempt: ReadonlyMap<string, string> = DETACHED_CHILD_EXEMPT,
  manifestOwnerNames: readonly string[] = getDetachedChildManifestNames(),
  emptyBackstopNames: readonly string[] = getDetachedChildNamesWithEmptyBackstop(),
  trackedGapNames: readonly string[] = getDetachedChildTrackedGapNames(),
  trackedGapBaseline: ReadonlySet<string> = TRACKED_GAP_BASELINE,
): DetachedCoverageResult {
  const violations: DetachedCoverageViolation[] = [];
  const matchedRepoPaths = new Set<string>();

  for (const [repoPath, source] of files) {
    if (!matchesDetachedSignature(source)) {
      continue;
    }
    matchedRepoPaths.add(repoPath);
    if (covered.has(repoPath) || exempt.has(repoPath)) {
      continue;
    }
    violations.push({ repoPath, kind: 'unclassified' });
  }

  const manifestNameSet = new Set(manifestOwnerNames);
  const unknownOwners: UnknownOwnerViolation[] = [];
  for (const [repoPath, ownerName] of covered) {
    if (!manifestNameSet.has(ownerName)) {
      unknownOwners.push({ repoPath, ownerName });
    }
  }

  // Reviewer F1: `tracked-gap` must not silently pass as a real backstop. A
  // tracked-gap owner is allowed ONLY if pinned in the baseline; a baseline name
  // that is no longer a tracked gap is stale (anti-rot, same posture as the maps).
  const trackedGapSet = new Set(trackedGapNames);
  const newTrackedGaps = trackedGapNames.filter((n) => !trackedGapBaseline.has(n));
  const staleTrackedGapBaseline = [...trackedGapBaseline].filter((n) => !trackedGapSet.has(n));

  const staleCovered = [...covered.keys()].filter((p) => !matchedRepoPaths.has(p));
  const staleExempt = [...exempt.keys()].filter((p) => !matchedRepoPaths.has(p));

  return {
    violations,
    unknownOwners,
    emptyBackstop: [...emptyBackstopNames],
    newTrackedGaps,
    staleTrackedGapBaseline,
    staleCovered,
    staleExempt,
    matchedFileCount: matchedRepoPaths.size,
  };
}

// --- Filesystem scan --------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_PARTS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    out.push(fullPath);
  }
  return out;
}

function collectScannedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const filePath of walk(path.join(REPO_ROOT, root))) {
      files.set(toRepoPath(filePath), fs.readFileSync(filePath, 'utf8'));
    }
  }
  return files;
}

// --- CLI --------------------------------------------------------------------------------

export function main(): number {
  const files = collectScannedFiles();
  const result = computeCoverage(files);
  const detached = computeDetachedCoverage(files);

  let failed = false;

  if (result.violations.length > 0) {
    failed = true;
    process.stderr.write(
      '[check-native-teardown-coverage] FAIL: native-resource owner(s) not classified against the teardown contract.\n\n',
    );
    for (const v of result.violations) {
      process.stderr.write(`  ${v.repoPath}\n    matched: ${v.matchedSignatures.join('; ')}\n`);
    }
    process.stderr.write(
      '\nWhy this is RED: a file that establishes a long-lived native handle (LanceDB connection, ORT\n' +
        'InferenceSession, BLE central) in the MAIN process can hang the quit in FreeEnvironment →\n' +
        'Worker::JoinThread if it is still live at env teardown — the REBEL-6AM quit-deadlock class. A new\n' +
        'such owner that is invisible to shutdown is exactly how moonshine + file-index slipped through.\n' +
        'CLASSIFY it, in the SAME commit:\n' +
        '  - If it is an in-MAIN owner that should be torn down: add it to NATIVE_TEARDOWN_OWNERS in\n' +
        '    src/main/services/nativeTeardownRegistry.ts (main-owner, or tracked-gap if no disposer yet)\n' +
        '    AND add it to COVERED_OWNER_FILES in this script, pointing at the registry name. Wire its\n' +
        '    bounded disposal onto the shutdownInternal roster in gracefulShutdown.ts (a later stage).\n' +
        '  - If the heavy native resource lives OUT of the main process (utilityProcess / offscreen window\n' +
        '    / detached child) or is a transient connect→use→close: add it to EXEMPT_OWNER_FILES here with\n' +
        '    a one-line reason.\n' +
        'See docs/plans/260622_teardown-lifecycle-contract/PLAN.md.\n',
    );
  }

  if (result.unknownOwners.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: covered file(s) name an owner that is NOT in the\n' +
        'native-teardown manifest (src/main/services/nativeTeardownManifest.ts). The guard is\n' +
        'manifest-driven — a typo or a deleted manifest entry must not pass green. Fix the owner name\n' +
        'in COVERED_OWNER_FILES, or add the missing entry to the manifest:\n',
    );
    for (const u of result.unknownOwners) {
      process.stderr.write(`  ${u.repoPath} -> "${u.ownerName}" (not in manifest)\n`);
    }
  }

  if (result.staleCovered.length > 0 || result.staleExempt.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: stale coverage baseline entr(y/ies) — listed file(s) no longer\n' +
        'match any native-owner signature. Remove the stale entry so the baseline stays honest:\n',
    );
    for (const p of result.staleCovered) {
      process.stderr.write(`  COVERED_OWNER_FILES: ${p}\n`);
    }
    for (const p of result.staleExempt) {
      process.stderr.write(`  EXEMPT_OWNER_FILES: ${p}\n`);
    }
  }

  // --- Detached-child orphan-survival dimension -----------------------------------------

  if (detached.violations.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: detached child spawn(s) not classified for orphan survival.\n\n',
    );
    for (const v of detached.violations) {
      process.stderr.write(`  ${v.repoPath}\n    matched: non-false \`detached:\` spawn option\n`);
    }
    process.stderr.write(
      '\nWhy this is RED: a child spawned with a non-`false` `detached:` (+ unref()) is reparented to\n' +
        'launchd/init and SURVIVES the parent — so on a non-graceful quit (crash / force-quit / OS-restart /\n' +
        'update-quit, which bypasses before-quit) it becomes a PPID=1 orphan. That is the super-mcp quit-orphan\n' +
        'class (260623). Every detached child MUST declare how it avoids accumulating. CLASSIFY it, in the\n' +
        'SAME commit:\n' +
        '  - If it should be torn down/contained: add an entry to DETACHED_CHILD_MANIFEST in\n' +
        '    src/main/services/nativeTeardownManifest.ts with a non-empty `backstop` (self-watchdog /\n' +
        '    boot-reaper / self-terminating / dev-only / tracked-gap) AND add it to\n' +
        '    DETACHED_CHILD_OWNER_FILES in this script, pointing at the manifest name.\n' +
        '  - If it cannot orphan a shipped app (dev-only) or is a passthrough primitive whose `detached` is\n' +
        '    decided by its caller: add it to DETACHED_CHILD_EXEMPT here with a one-line reason.\n' +
        '  - If the child is attached (no new process group / not unref()ed), use `detached: false` —\n' +
        '    this guard is scoped to the detached/unref orphan risk and skips false/undefined.\n' +
        'See docs/plans/260623_detached-child-backstop-guard/PLAN.md.\n',
    );
  }

  if (detached.unknownOwners.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: detached-covered file(s) name an owner NOT in\n' +
        'DETACHED_CHILD_MANIFEST (src/main/services/nativeTeardownManifest.ts). Fix the name in\n' +
        'DETACHED_CHILD_OWNER_FILES, or add the missing manifest entry:\n',
    );
    for (const u of detached.unknownOwners) {
      process.stderr.write(`  ${u.repoPath} -> "${u.ownerName}" (not in detached manifest)\n`);
    }
  }

  if (detached.emptyBackstop.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: detached-child manifest entr(y/ies) declare an EMPTY\n' +
        'backstop array — a detached child with no declared non-graceful backstop is exactly the orphan\n' +
        'bug. Give each at least one NonGracefulBackstop (tracked-gap is allowed but must be a deliberate,\n' +
        'note-justified choice):\n',
    );
    for (const name of detached.emptyBackstop) {
      process.stderr.write(`  "${name}" (empty backstop[])\n`);
    }
  }

  if (detached.newTrackedGaps.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: detached child(ren) declare ONLY `tracked-gap` as their\n' +
        'backstop but are NOT in TRACKED_GAP_BASELINE — `tracked-gap` means "no real non-graceful backstop\n' +
        'yet", so it must not silently pass CI. Give the child a real backstop (self-watchdog / boot-reaper /\n' +
        'self-terminating), or — if the gap is genuinely accepted for now — add its name to\n' +
        'TRACKED_GAP_BASELINE in this script (a deliberate, review-visible act) and explain why in the\n' +
        'manifest note:\n',
    );
    for (const name of detached.newTrackedGaps) {
      process.stderr.write(`  "${name}" (tracked-gap, not in baseline)\n`);
    }
  }

  if (detached.staleTrackedGapBaseline.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: stale TRACKED_GAP_BASELINE entr(y/ies) — listed name(s) are\n' +
        'no longer a tracked-gap owner (closed, renamed, or given a real backstop). Remove them from\n' +
        'TRACKED_GAP_BASELINE so the baseline stays honest:\n',
    );
    for (const name of detached.staleTrackedGapBaseline) {
      process.stderr.write(`  TRACKED_GAP_BASELINE: ${name}\n`);
    }
  }

  if (detached.staleCovered.length > 0 || detached.staleExempt.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: stale detached baseline entr(y/ies) — listed file(s) no\n' +
        'longer match the `detached:` signature. Remove the stale entry so the baseline stays honest:\n',
    );
    for (const p of detached.staleCovered) {
      process.stderr.write(`  DETACHED_CHILD_OWNER_FILES: ${p}\n`);
    }
    for (const p of detached.staleExempt) {
      process.stderr.write(`  DETACHED_CHILD_EXEMPT: ${p}\n`);
    }
  }

  if (failed) {
    return 1;
  }

  const trackedGapNote =
    TRACKED_GAP_BASELINE.size > 0
      ? ` [${TRACKED_GAP_BASELINE.size} accepted tracked-gap: ${[...TRACKED_GAP_BASELINE].join(', ')}]`
      : '';
  process.stdout.write(
    `[check-native-teardown-coverage] OK: ${result.matchedFileCount} native-owner file(s) matched ` +
      `(${COVERED_OWNER_FILES.size} registered, ${EXEMPT_OWNER_FILES.size} exempt); ` +
      `${detached.matchedFileCount} detached-child spawn file(s) matched ` +
      `(${DETACHED_CHILD_OWNER_FILES.size} registered, ${DETACHED_CHILD_EXEMPT.size} exempt); ` +
      `all classified.${trackedGapNote}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exit(main());
}
