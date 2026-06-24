/**
 * Pure-logic tests for the native-teardown coverage guard
 * (scripts/check-native-teardown-coverage.ts), Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md.
 *
 * Exercises the manifest-driven coverage computation in isolation: a registered
 * owner passes, an unregistered matched owner fails, an exempt entry passes, a
 * comment-only match does not match, and a stale baseline entry fails. Also a
 * tiny live check that the real signature set + baselines pass on the repo (via
 * the script's own main()).
 */

import { describe, expect, it } from 'vitest';

import {
  computeCoverage,
  computeDetachedCoverage,
  matchesDetachedSignature,
  matchingSignatures,
  stripComments,
  type NativeOwnerSignature,
} from '../check-native-teardown-coverage';

const SIGS: readonly NativeOwnerSignature[] = [
  { label: 'LanceDB connection', pattern: /\blancedb\.connect\s*\(/ },
  { label: 'ORT InferenceSession', pattern: /\bInferenceSession\.create\s*\(/ },
];

describe('matchingSignatures', () => {
  it('matches the handle-establishing call', () => {
    expect(matchingSignatures('const c = await lancedb.connect(dir);', SIGS)).toEqual(['LanceDB connection']);
  });

  it('does not match a mere type-only / reference mention', () => {
    // No `.connect(` call — just a type import reference.
    const src = "type Conn = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;";
    expect(matchingSignatures(src, SIGS)).toEqual([]);
  });

  it('ignores matches inside comments (stripped first)', () => {
    const src = '// example: await lancedb.connect(dbPath)\nconst x = 1;';
    expect(matchingSignatures(src, SIGS)).toEqual([]);
  });

  it('strips block comments before matching', () => {
    expect(stripComments('/* lancedb.connect( */ const x = 1;')).not.toContain('connect');
  });

  it('matches the sherpa-onnx loadNativeModule call but not a bare package mention', () => {
    const sherpaSig: readonly NativeOwnerSignature[] = [
      { label: 'sherpa', pattern: /\bloadNativeModule\b[^)]*\bsherpa-onnx-node\b/ },
    ];
    // The actual handle-establishing load call → matches.
    const call = "const s = loadNativeModule<SherpaOnnxModule>('sherpa-onnx-node');";
    expect(matchingSignatures(call, sherpaSig)).toEqual(['sherpa']);
    // A bare mention of the package name (e.g. in a manifest note string) → no match.
    const mention = "const note = 'TRACKED GAP: sherpa-onnx-node OfflineRecognizer';";
    expect(matchingSignatures(mention, sherpaSig)).toEqual([]);
  });
});

describe('computeCoverage', () => {
  const covered = new Map([['src/main/services/owner.ts', 'owner-registry-name']]);
  const exempt = new Map([['src/main/workers/worker.ts', 'out-of-process-child: dies with worker.']]);
  // The owner names covered above, so the manifest-name check passes by default.
  const manifestNames = ['owner-registry-name'];

  it('passes a registered (covered) owner', () => {
    const files = new Map([['src/main/services/owner.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
    expect(result.unknownOwners).toEqual([]);
    expect(result.matchedFileCount).toBe(1);
  });

  it('passes an exempt owner', () => {
    const files = new Map([['src/main/workers/worker.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
  });

  it('FAILS a covered file whose owner name is absent from the manifest (typo/deleted entry)', () => {
    const files = new Map([['src/main/services/owner.ts', 'await lancedb.connect(d);']]);
    // Manifest does NOT contain 'owner-registry-name' — a typo'd/deleted owner.
    const result = computeCoverage(files, covered, exempt, SIGS, ['some-other-owner']);
    expect(result.unknownOwners).toEqual([
      { repoPath: 'src/main/services/owner.ts', ownerName: 'owner-registry-name' },
    ]);
    // The file is still "covered" by path, so it is NOT an unclassified violation.
    expect(result.violations).toEqual([]);
  });

  it('FAILS an unregistered matched owner', () => {
    const files = new Map([['src/main/services/new-owner.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      repoPath: 'src/main/services/new-owner.ts',
      kind: 'unclassified',
    });
    expect(result.violations[0].matchedSignatures).toContain('LanceDB connection');
  });

  it('ignores a file that matches no signature', () => {
    const files = new Map([['src/main/services/plain.ts', 'const x = 1;']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
    expect(result.matchedFileCount).toBe(0);
  });

  it('FAILS a stale covered baseline entry (file no longer matches any signature)', () => {
    // The covered file is present but its source no longer contains the signature.
    const files = new Map([['src/main/services/owner.ts', 'const x = 1; // refactored away']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.staleCovered).toEqual(['src/main/services/owner.ts']);
  });

  it('FAILS a stale exempt baseline entry', () => {
    const files = new Map([['src/main/workers/worker.ts', 'const x = 1;']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.staleExempt).toEqual(['src/main/workers/worker.ts']);
  });
});

// --- Detached-child orphan-survival dimension -------------------------------------------

describe('matchesDetachedSignature', () => {
  it('matches a literal detached: true spawn option', () => {
    expect(matchesDetachedSignature('spawn(cmd, args, { detached: true, stdio: "ignore" });')).toBe(true);
  });

  it('matches the COMPUTED form (the real super-mcp spawn a literal-only regex would miss)', () => {
    expect(matchesDetachedSignature('  detached: !isWindows && !isTestMode, // Stay attached in test mode')).toBe(true);
  });

  it('matches the bash-tool computed form', () => {
    expect(matchesDetachedSignature('      detached: !isWindows,')).toBe(true);
  });

  it('matches a passthrough form (conservatively flagged → must be exempted)', () => {
    expect(matchesDetachedSignature('      detached: options.detached,')).toBe(true);
  });

  it('does NOT match detached: false (attached child, dies with parent)', () => {
    expect(matchesDetachedSignature('      detached: false,')).toBe(false);
  });

  it('does NOT match detached:false without a space', () => {
    expect(matchesDetachedSignature('detached:false')).toBe(false);
  });

  it('does NOT match detached: undefined', () => {
    expect(matchesDetachedSignature('      detached: undefined,')).toBe(false);
  });

  it('does NOT match an exact false at end of line (no trailing comma)', () => {
    expect(matchesDetachedSignature('detached: false')).toBe(false);
  });

  it('MATCHES a compound expression starting with false (runtime value can be truthy) — reviewer F2', () => {
    expect(matchesDetachedSignature('      detached: false || shouldDetach,')).toBe(true);
  });

  it('MATCHES a compound expression starting with undefined — reviewer F2', () => {
    expect(matchesDetachedSignature('      detached: undefined ?? shouldDetach,')).toBe(true);
  });

  it('MATCHES a variable whose name merely starts with false (e.g. falsey)', () => {
    expect(matchesDetachedSignature('      detached: falsey,')).toBe(true);
  });

  it('does NOT match a comment-only mention (stripped first)', () => {
    expect(matchesDetachedSignature('// On Unix, use detached: true so the child gets its own group')).toBe(false);
  });

  it('keeps the code on a line that has a trailing // comment (strips only the comment)', () => {
    // The trailing comment is removed, but `detached: true` survives → still matches.
    expect(matchesDetachedSignature('  detached: true, // becomes a session leader')).toBe(true);
  });

  it('matches a note STRING that reproduces the pattern (documents why the manifest file is self-exempt)', () => {
    expect(matchesDetachedSignature("const note = 'spawned detached (detached: !isWindows && !isTestMode)';")).toBe(true);
  });
});

describe('computeDetachedCoverage', () => {
  const covered = new Map([['src/core/services/superMcpHttpManager.ts', 'super-mcp']]);
  const exempt = new Map([['src/main/services/demoModeService.ts', 'dev-only: npm run dev restart.']]);
  const manifestNames = ['super-mcp'];
  const noEmptyBackstops: readonly string[] = [];

  it('passes a registered detached child with a non-empty backstop', () => {
    const files = new Map([['src/core/services/superMcpHttpManager.ts', 'detached: !isWindows && !isTestMode,']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.violations).toEqual([]);
    expect(result.unknownOwners).toEqual([]);
    expect(result.emptyBackstop).toEqual([]);
    expect(result.matchedFileCount).toBe(1);
  });

  it('passes an exempt detached spawn (dev-only / passthrough)', () => {
    const files = new Map([['src/main/services/demoModeService.ts', 'detached: true,']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.violations).toEqual([]);
  });

  it('FAILS an unclassified detached spawn (neither covered nor exempt)', () => {
    const files = new Map([['src/main/services/newDaemon.ts', 'spawn(c, a, { detached: true });']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.violations).toEqual([{ repoPath: 'src/main/services/newDaemon.ts', kind: 'unclassified' }]);
  });

  it('does NOT flag a detached: false spawn', () => {
    const files = new Map([['src/main/services/attached.ts', 'spawn(c, a, { detached: false });']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.violations).toEqual([]);
    expect(result.matchedFileCount).toBe(0);
  });

  it('FAILS a covered file whose owner name is absent from the manifest', () => {
    const files = new Map([['src/core/services/superMcpHttpManager.ts', 'detached: !isWindows,']]);
    const result = computeDetachedCoverage(files, covered, exempt, ['some-other-name'], noEmptyBackstops);
    expect(result.unknownOwners).toEqual([
      { repoPath: 'src/core/services/superMcpHttpManager.ts', ownerName: 'super-mcp' },
    ]);
    expect(result.violations).toEqual([]);
  });

  it('FAILS a manifest owner with an EMPTY backstop array (the orphan bug)', () => {
    const files = new Map([['src/core/services/superMcpHttpManager.ts', 'detached: true,']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, ['super-mcp']);
    expect(result.emptyBackstop).toEqual(['super-mcp']);
  });

  it('FAILS a stale covered baseline entry (no longer a detached spawn)', () => {
    const files = new Map([['src/core/services/superMcpHttpManager.ts', 'detached: false, // now attached']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.staleCovered).toEqual(['src/core/services/superMcpHttpManager.ts']);
  });

  it('FAILS a stale exempt baseline entry', () => {
    const files = new Map([['src/main/services/demoModeService.ts', 'const x = 1;']]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.staleExempt).toEqual(['src/main/services/demoModeService.ts']);
  });

  it('counts a file with multiple detached spawns only once', () => {
    const files = new Map([
      ['src/core/services/superMcpHttpManager.ts', 'detached: true,\n  detached: !isWindows,'],
    ]);
    const result = computeDetachedCoverage(files, covered, exempt, manifestNames, noEmptyBackstops);
    expect(result.matchedFileCount).toBe(1);
  });

  // --- tracked-gap baseline (reviewer F1: tracked-gap must not silently pass) ---

  it('passes a tracked-gap owner that IS in the baseline', () => {
    const files = new Map([['src/core/rebelCore/builtinTools.ts', 'detached: !isWindows,']]);
    const result = computeDetachedCoverage(
      files,
      new Map([['src/core/rebelCore/builtinTools.ts', 'bash-tool']]),
      exempt,
      ['bash-tool'],
      noEmptyBackstops,
      ['bash-tool'], // trackedGapNames
      new Set(['bash-tool']), // baseline
    );
    expect(result.newTrackedGaps).toEqual([]);
    expect(result.staleTrackedGapBaseline).toEqual([]);
  });

  it('FAILS a NEW tracked-gap owner that is NOT in the baseline', () => {
    const files = new Map([['src/main/services/newDaemon.ts', 'detached: true,']]);
    const result = computeDetachedCoverage(
      files,
      new Map([['src/main/services/newDaemon.ts', 'new-daemon']]),
      exempt,
      ['new-daemon'],
      noEmptyBackstops,
      ['new-daemon'], // declared tracked-gap
      new Set(['bash-tool']), // but only bash-tool is baselined
    );
    expect(result.newTrackedGaps).toEqual(['new-daemon']);
  });

  it('FAILS a stale TRACKED_GAP_BASELINE entry (baselined name no longer a tracked gap)', () => {
    const files = new Map([['src/core/services/superMcpHttpManager.ts', 'detached: !isWindows,']]);
    const result = computeDetachedCoverage(
      files,
      covered,
      exempt,
      manifestNames,
      noEmptyBackstops,
      [], // no tracked gaps anymore (bash-tool got a real backstop)
      new Set(['bash-tool']), // but baseline still pins it
    );
    expect(result.staleTrackedGapBaseline).toEqual(['bash-tool']);
  });
});
