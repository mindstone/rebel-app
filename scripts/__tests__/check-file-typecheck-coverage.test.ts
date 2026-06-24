/**
 * Pure-logic tests for the file-level TS coverage guard
 * (scripts/check-file-typecheck-coverage.ts), Stage 1 of the 260624 coverage
 * follow-up (docs/plans/260624_ts-ratchet-extend/PLAN.md).
 *
 * Exercises the classifier in isolation: a covered file passes, a baselined
 * uncovered file passes, a NEW uncovered file fails (the regression this gate
 * catches), and stale baseline entries (now-covered or deleted) fail so the
 * backlog can only shrink. Plus a live smoke that the real PROJECTS enumerate
 * a non-trivial covered set via the TS compiler API.
 */

import { describe, expect, it } from 'vitest';

import { PROJECTS } from '../check-typescript-errors';
import { computeFileCoverageViolations, projectFileNames } from '../check-file-typecheck-coverage';

const COVERED = new Set(['src/core/a.ts', 'src/main/b.ts']);

describe('computeFileCoverageViolations', () => {
  it('passes when every tracked file is covered', () => {
    expect(computeFileCoverageViolations(['src/core/a.ts', 'src/main/b.ts'], COVERED, [])).toEqual([]);
  });

  it('passes an uncovered file that is on the baseline', () => {
    expect(
      computeFileCoverageViolations(['src/core/a.ts', 'scripts/legacy.ts'], COVERED, ['scripts/legacy.ts']),
    ).toEqual([]);
  });

  it('FAILS a NEW uncovered file not on the baseline (the regression this catches)', () => {
    const v = computeFileCoverageViolations(['src/core/a.ts', 'scripts/new-tooling.ts'], COVERED, []);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('NOT TYPE-CHECK-ROOTED (in no ratchet project\'s include): scripts/new-tooling.ts');
  });

  it('FAILS a stale baseline entry that is now rooted (shrink-only)', () => {
    // src/core/a.ts is rooted but still listed in the baseline → must be removed.
    const v = computeFileCoverageViolations(['src/core/a.ts'], COVERED, ['src/core/a.ts']);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('is now type-check-rooted');
  });

  it('FAILS a stale baseline entry whose file was deleted (shrink-only)', () => {
    const v = computeFileCoverageViolations(['src/core/a.ts'], COVERED, ['scripts/deleted.ts']);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('no longer tracked');
  });

  it('a covered file takes precedence — only the genuinely-uncovered new file fails', () => {
    const v = computeFileCoverageViolations(['src/core/a.ts', 'scripts/x.ts'], COVERED, []);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('scripts/x.ts');
  });
});

describe('projectFileNames (live, TS compiler API)', () => {
  it('enumerates a non-trivial file set for the node project without type-checking', () => {
    const nodeProj = PROJECTS.find((p) => p.name === 'node');
    expect(nodeProj).toBeDefined();
    const files = projectFileNames(nodeProj!.tsconfig);
    // The node project compiles thousands of files; assert it resolved a real set.
    // (fileNames can include .json via resolveJsonModule, so don't require all .ts.)
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.includes('check-file-typecheck-coverage.ts'))).toBe(true);
  });
});
