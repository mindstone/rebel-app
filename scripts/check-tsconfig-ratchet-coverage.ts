#!/usr/bin/env npx tsx
/**
 * CI Validation: every in-repo tsconfig is either ratcheted or explicitly exempt.
 *
 * Kills the "a whole TypeScript project ships type-checked NOWHERE" class by
 * construction. The TS ratchet (scripts/check-typescript-errors.ts) covers an
 * explicit PROJECTS list; a new sub-project that adds its own tsconfig but is
 * never added to PROJECTS is invisible to the ratchet — exactly how
 * cloud-service-test, mobile-test, packages-shared, and most recently
 * meeting-bot-worker each sat unchecked until someone noticed. This gate makes
 * that impossible: it enumerates every in-repo tsconfig and asserts each one is
 * EITHER a ratchet PROJECTS entry OR carries an explicit EXEMPT entry (with a
 * category + human reason). A new, unaccounted-for tsconfig fails the build.
 *
 * Scope: the superproject only. Submodules (rebel-system, super-mcp,
 * coding-agent-instructions, mcp-servers — read from .gitmodules) have their own
 * CI and are excluded, as are node_modules and build outputs.
 *
 * To satisfy this gate when it fires on a NEW tsconfig:
 *   - Preferred: add it to PROJECTS in scripts/check-typescript-errors.ts so it
 *     is actually type-checked (baseline 0 for greenfield; see that file).
 *   - Otherwise: add an EXEMPT entry below with an honest category + reason.
 *     'deferred' means "real debt we intend to ratchet later" — keep it short.
 *
 * Run:        npx tsx scripts/check-tsconfig-ratchet-coverage.ts
 * Wired into: validate:fast (scripts/run-validate-fast.ts → validate:tsconfig-ratchet-coverage)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECTS } from './check-typescript-errors';
import { gitCapture } from './lib/git-exec';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type ExemptCategory = 'base' | 'tooling' | 'fixture' | 'deferred';

export interface ExemptEntry {
  /** Why this tsconfig is not (yet) a ratchet project. */
  category: ExemptCategory;
  /** Human-readable justification, shown nowhere by default but kept honest by review. */
  reason: string;
}

/**
 * tsconfig files that are intentionally NOT ratchet projects, keyed by
 * repo-relative POSIX path. Every entry needs a category + reason. Categories:
 *   - 'base'     — an extended-only base / IDE aggregator that type-checks no files itself.
 *   - 'tooling'  — consumed by another tool (ESLint), whose files are ratcheted elsewhere.
 *   - 'fixture'  — a test fixture that intentionally is not product code.
 *   - 'deferred' — real type debt we mean to ratchet later (tracked in the PLAN).
 */
export const EXEMPT: Record<string, ExemptEntry> = {
  'tsconfig.json': {
    category: 'base',
    reason:
      'Root IDE / path-alias aggregator with "files": [] — it type-checks nothing; the real surfaces are split across tsconfig.node/renderer/evals/scripts, all of which are ratcheted.',
  },
  'tsconfig.base.json': {
    category: 'base',
    reason: 'Shared compiler-options base extended by the per-surface configs; not a standalone type-check target.',
  },
  'resources/mcp/tsconfig.base.json': {
    category: 'base',
    reason: 'Shared base for the bundled MCP servers; extended-only, checks no files itself.',
  },
  'tsconfig.eslint-strict.json': {
    category: 'tooling',
    reason:
      'ESLint strict-subset config (extends tsconfig.renderer.json); the files it lists are already type-checked by the renderer ratchet project.',
  },
  'eslint-rules/__tests__/fixtures/no-unused-result/tsconfig.json': {
    category: 'fixture',
    reason: 'ESLint-rule test fixture — exists to exercise rule behaviour, not product code.',
  },
  'scripts/__tests__/fixtures/fake-mcp-a/tsconfig.json': {
    category: 'fixture',
    reason: 'check-script test fixture (a fake MCP package); not product code.',
  },
  'scripts/__tests__/fixtures/fake-mcp-b/tsconfig.json': {
    category: 'fixture',
    reason: 'check-script test fixture (a fake MCP package); not product code.',
  },
  'evals/gui/tsconfig.json': {
    category: 'deferred',
    reason:
      'Dev-only eval-analyzer UI; carries real type debt and needs its own deps installed. Tracked for future ratcheting in docs/plans/260624_ts-ratchet-extend/PLAN.md.',
  },
  'evals/gui/tsconfig.server.json': {
    category: 'deferred',
    reason: 'Dev-only eval-analyzer server (extends evals/gui/tsconfig.json); same deferral as the UI config.',
  },
  'resources/mcp/ibkr/tsconfig.json': {
    category: 'deferred',
    reason:
      'Bundled MCP server whose `@stoqey/ib` dependency is NOT in the root install (tsc reports TS2307), so it cannot type-check from root like profitsage/discourse do — ratcheting it needs `@stoqey/ib` added to root devDeps or a per-project npm ci. Tracked in docs/plans/260624_ts-ratchet-extend/PLAN.md.',
  },
  // NOTE: resources/mcp/{profitsage,discourse} were promoted OUT of this exempt
  // list into ratchet PROJECTS (260624 follow-up) — their deps resolve from root.
};

/** A repo path is a tsconfig iff its basename CONTAINS `tsconfig` and ends `.json`.
 * Deliberately fail-OPEN and aligned with the git pathspec `*tsconfig*.json` below:
 * it matches not just `tsconfig.json` / `tsconfig.test.json` / `tsconfig.base.json`
 * but also configs whose basename merely contains `tsconfig`
 * (`build.tsconfig.json`, `app.tsconfig.json`). A start-anchored `^tsconfig` filter
 * would silently DROP those even though git lists them — exactly the silent-skip this
 * guard exists to prevent (false positives can always be EXEMPT'd; silent false
 * negatives can't). It still excludes non-tsconfig files git surfaces under a
 * tsconfig-named directory (e.g. `tsconfig-stuff/foo.json`) and non-`.json` siblings
 * (`tsconfig.json.bak`). */
const TSCONFIG_BASENAME = /tsconfig.*\.json$/;

/**
 * Filter a list of repo-relative paths down to the tsconfig files, sorted.
 * Pure (the git call that feeds it is the only impure part) — exported for testing.
 */
export function filterTsconfigPaths(repoPaths: readonly string[]): string[] {
  return repoPaths
    .filter((p) => TSCONFIG_BASENAME.test(p.slice(p.lastIndexOf('/') + 1)))
    .sort();
}

/**
 * Enumerate every in-repo tsconfig via git's view of the working tree, NOT a
 * name-based filesystem glob. `git ls-files --cached --others --exclude-standard`
 * gives committed + not-yet-tracked files while honouring .gitignore, which buys
 * three correctness properties a glob can't, all of which matter for a guard whose
 * whole job is to never SILENTLY skip a project:
 *   - Submodules are excluded natively (their files are tracked in their own repos,
 *     so the superproject's `ls-files` never lists them) — no .gitmodules parsing.
 *   - .gitignore'd build outputs (dist/, build/, out/, .vite/, …) are excluded
 *     because they're ignored — and a *tracked* tsconfig is by definition source,
 *     so we never need brittle name-based ignore globs that could also swallow a
 *     real `src/.../build/tsconfig.json`.
 *   - Dot-directories (.config/, .github/, …) are included — git tracks them.
 * A pathspec narrows the output at the git layer; filterTsconfigPaths enforces the
 * exact basename shape.
 */
function listRepoTsconfigs(root: string): string[] {
  // Route through the repo-wide git capture helper (256 MiB buffer, stderr captured)
  // — required by the check-git-exec-maxbuffer gate; raw child_process git capture is banned.
  const raw = gitCapture(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*tsconfig*.json'], {
    cwd: root,
  });
  return filterTsconfigPaths(raw.split('\0').filter(Boolean));
}

/**
 * Pure classifier: given the enumerated tsconfig set, the ratcheted set, the
 * exempt map, and an existence probe, return a list of human-readable violations
 * (empty == pass). Exported for unit testing.
 */
export function computeViolations(
  found: readonly string[],
  ratcheted: ReadonlySet<string>,
  exempt: Readonly<Record<string, ExemptEntry>>,
  existsOnDisk: (rel: string) => boolean,
): string[] {
  const violations: string[] = [];

  for (const rel of found) {
    if (ratcheted.has(rel)) continue; // type-checked by the ratchet
    if (exempt[rel]) continue; // explicitly accounted for
    violations.push(
      `UNRATCHETED tsconfig: ${rel}\n` +
        `  → Add it to PROJECTS in scripts/check-typescript-errors.ts (preferred — actually type-check it),\n` +
        `    or add an EXEMPT entry in scripts/check-tsconfig-ratchet-coverage.ts with a category + reason.`,
    );
  }

  // Keep the EXEMPT list honest: no stale entries, no contradictions with PROJECTS.
  for (const rel of Object.keys(exempt)) {
    if (!existsOnDisk(rel)) {
      violations.push(`STALE EXEMPT entry "${rel}" — file no longer exists; remove it from EXEMPT.`);
    } else if (ratcheted.has(rel)) {
      violations.push(`REDUNDANT EXEMPT entry "${rel}" — it is now also a ratchet PROJECT; remove it from EXEMPT.`);
    }
  }

  return violations;
}

function main(): void {
  const found = listRepoTsconfigs(ROOT);

  const ratcheted = new Set(PROJECTS.map((p) => p.tsconfig.split(path.sep).join('/')));

  const violations = computeViolations(found, ratcheted, EXEMPT, (rel) =>
    fs.existsSync(path.join(ROOT, rel)),
  );

  if (violations.length > 0) {
    console.error('✘ tsconfig ratchet-coverage check FAILED:\n');
    for (const v of violations) console.error('  ' + v.replace(/\n/g, '\n  ') + '\n');
    console.error(
      `${found.length} tsconfig files scanned · ${ratcheted.size} ratcheted · ${Object.keys(EXEMPT).length} exempt.`,
    );
    process.exit(1);
  }

  const exemptCount = found.filter((rel) => !ratcheted.has(rel)).length;
  console.log(
    `✔ tsconfig ratchet-coverage: all ${found.length} in-repo tsconfig files are accounted for ` +
      `(${found.length - exemptCount} ratcheted · ${exemptCount} explicitly exempt).`,
  );
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
