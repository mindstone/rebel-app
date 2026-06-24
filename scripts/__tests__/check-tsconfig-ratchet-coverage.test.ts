/**
 * Pure-logic tests for the tsconfig ratchet-coverage meta-guard
 * (scripts/check-tsconfig-ratchet-coverage.ts), deferred follow-up of
 * docs/plans/260624_ts-ratchet-extend/PLAN.md.
 *
 * Exercises the classifier in isolation: a ratcheted tsconfig passes, an exempt
 * one passes, an unaccounted-for one fails (the class this guard exists to
 * catch), a stale exempt entry fails, and an exempt entry that has become a
 * ratchet project fails. Plus the basename filter (which shapes git's output)
 * and a live check that the real repo passes via the exported EXEMPT map + the
 * actual PROJECTS set.
 */

import { describe, expect, it } from 'vitest';

import { PROJECTS } from '../check-typescript-errors';
import {
  computeViolations,
  filterTsconfigPaths,
  EXEMPT,
  type ExemptEntry,
} from '../check-tsconfig-ratchet-coverage';

const RATCHETED = new Set(['tsconfig.node.json', 'cloud-service/tsconfig.json']);
const EX: Record<string, ExemptEntry> = {
  'tsconfig.base.json': { category: 'base', reason: 'extended-only' },
};
const existsAll = () => true;

describe('computeViolations', () => {
  it('passes a tsconfig covered by the ratchet', () => {
    expect(computeViolations(['tsconfig.node.json'], RATCHETED, EX, existsAll)).toEqual([]);
  });

  it('passes an explicitly exempt tsconfig', () => {
    expect(computeViolations(['tsconfig.base.json'], RATCHETED, EX, existsAll)).toEqual([]);
  });

  it('FAILS an unaccounted-for tsconfig (the class this guard catches)', () => {
    const v = computeViolations(['some/new/tsconfig.json'], RATCHETED, EX, existsAll);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('UNRATCHETED tsconfig: some/new/tsconfig.json');
  });

  it('FAILS a stale exempt entry whose file no longer exists', () => {
    const existsNone = (rel: string) => rel !== 'tsconfig.base.json';
    const v = computeViolations([], RATCHETED, EX, existsNone);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('STALE EXEMPT entry "tsconfig.base.json"');
  });

  it('FAILS an exempt entry that has become a ratchet project (redundant)', () => {
    const ratchetedNow = new Set(['tsconfig.base.json']);
    const v = computeViolations(['tsconfig.base.json'], ratchetedNow, EX, existsAll);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('REDUNDANT EXEMPT entry "tsconfig.base.json"');
  });

  it('a ratcheted path takes precedence over an unaccounted classification', () => {
    // tsconfig.node.json is ratcheted; even alongside an unknown one, only the unknown fails.
    const v = computeViolations(['tsconfig.node.json', 'mystery/tsconfig.json'], RATCHETED, EX, existsAll);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('mystery/tsconfig.json');
  });
});

describe('filterTsconfigPaths', () => {
  it('keeps tsconfig-shaped basenames at any depth, sorted', () => {
    const input = [
      'cloud-service/tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.json',
      'meeting-bot-worker/tsconfig.test.json',
      'tsconfig.eslint-strict.json',
    ];
    expect(filterTsconfigPaths(input)).toEqual([
      'cloud-service/tsconfig.json',
      'meeting-bot-worker/tsconfig.test.json',
      'tsconfig.base.json',
      'tsconfig.eslint-strict.json',
      'tsconfig.json',
    ]);
  });

  it('fail-OPEN: keeps configs whose basename CONTAINS tsconfig, not just starts with it (F1)', () => {
    // A start-anchored filter would silently drop these even though git lists them
    // (git pathspec *tsconfig*.json matches them) — the exact silent-skip this guard prevents.
    expect(filterTsconfigPaths(['src/build.tsconfig.json', 'app.tsconfig.json'])).toEqual([
      'app.tsconfig.json',
      'src/build.tsconfig.json',
    ]);
  });

  it('drops non-.json siblings and non-tsconfig basenames git can surface', () => {
    // tsconfig.json.bak ends .bak not .json; package.json under a tsconfig-named dir has no
    // "tsconfig" in its basename. Both are correctly excluded.
    expect(filterTsconfigPaths(['b/tsconfig.json.bak', 'tsconfig-stuff/package.json', 'c/readme.md'])).toEqual([]);
  });
});

describe('live repo invariants', () => {
  it('no EXEMPT entry is also a ratchet PROJECT (would be redundant)', () => {
    const ratcheted = new Set(PROJECTS.map((p) => p.tsconfig.split(/[\\/]/).join('/')));
    const redundant = Object.keys(EXEMPT).filter((rel) => ratcheted.has(rel));
    expect(redundant).toEqual([]);
  });

  it('every EXEMPT entry has a non-empty reason', () => {
    for (const [rel, entry] of Object.entries(EXEMPT)) {
      expect(entry.reason.length, `${rel} needs a reason`).toBeGreaterThan(0);
    }
  });
});
