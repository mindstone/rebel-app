#!/usr/bin/env npx tsx
/**
 * CI Validation: every tracked TypeScript source file is a TYPE-CHECK ROOT of some
 * ratchet project — or is on an explicit, frozen baseline of known-unrooted files.
 *
 * This is the FILE-LEVEL analogue of check-tsconfig-ratchet-coverage.ts. That guard
 * proves every in-repo *tsconfig* is ratcheted-or-exempt; this one proves every
 * tracked *.ts/.tsx/.mts/.cts source file is picked up by some ratchet project's
 * `include`/`files`. They sit at different altitudes: a tsconfig can be a ratchet
 * PROJECT yet still leave individual files unrooted (its `include` globs don't reach
 * them, or an `exclude` drops them, or — most commonly — a whole tree like
 * scripts/sentry-autopilot is omitted from an allowlist-style tsconfig). Nothing
 * failed when that happened, so ~11% of source had silently drifted out of the
 * type-check root set. This gate freezes that set and FAILS when a NEW unrooted file
 * appears — without forcing anyone to fix the existing backlog first.
 *
 * "ROOT", precisely: the file is matched by some ratchet project's `include`/`files`
 * (after `extends`/`exclude`), i.e. it would be a root of that project's `tsc -p`
 * program. A file that is NOT a root but is reached transitively via an `import`
 * from a rooted file is *also* type-checked by tsc — but that coverage is incidental
 * and FRAGILE (it vanishes the moment the import is removed). This gate deliberately
 * requires the stronger, robust property (root inclusion), so such import-only files
 * are treated as unrooted and belong on the baseline or in an `include`. (Measured
 * 2026-06-24: only 12 repo files are import-only-covered; building full Programs to
 * detect them costs ~12.4s vs ~0.6s for the root-set enumeration below — not worth it.)
 *
 * Mechanism (NO type-check, NO second `tsc` pass): for each ratchet PROJECT we ask
 * the TypeScript compiler API for its resolved ROOT file set
 * (`ts.getParsedCommandLineOfConfigFile().fileNames`) — this resolves
 * include/exclude/files/extends precisely as tsc does, but only enumerates roots (no
 * Program, no diagnostics), so it costs milliseconds per project. The union is the
 * "rooted" set; the difference from `git ls-files` is the unrooted set.
 *
 * Baseline is an EXACT PATH SET (scripts/file-typecheck-coverage-baseline.json),
 * not a count — a count would have the replacement hole (an old uncovered file
 * disappears while a new one appears, count unchanged). Shrink-only: a baseline
 * entry that is now covered or deleted FAILS, so the backlog can only drain.
 *
 * To satisfy this gate when it fires on a NEW unrooted file:
 *   - Preferred: add the file's tree to a ratchet project's `include` so it is a
 *     robust type-check root, fixing any errors that surface.
 *   - Stopgap: regenerate the baseline (`--write-baseline`) to freeze it as known
 *     debt — but that is a deliberate choice a reviewer should see, not a default.
 *
 * Run:                 npx tsx scripts/check-file-typecheck-coverage.ts
 * Regenerate baseline: npx tsx scripts/check-file-typecheck-coverage.ts --write-baseline
 * Wired into: validate:fast (scripts/run-validate-fast.ts → validate:file-typecheck-coverage)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { PROJECTS } from './check-typescript-errors';
import { gitCapture } from './lib/git-exec';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = 'scripts/file-typecheck-coverage-baseline.json';

const SUBMODULES = ['rebel-system', 'super-mcp', 'coding-agent-instructions', 'mcp-servers'];

/** Absolute path → repo-relative POSIX, or null if outside the repo / in node_modules. */
function toRepoRel(absPath: string): string | null {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the repo (lib.d.ts, etc.)
  if (rel.includes('node_modules/')) return null;
  return rel;
}

/**
 * A ratchet project's resolved ROOT file set (from `include`/`files` after
 * `extends`/`exclude`), via the TS compiler API. Resolves exactly as tsc does, but
 * enumerates only — no Program is created, so there is no type-check cost. Fails
 * CLOSED on any config diagnostic (a malformed tsconfig must not silently yield an
 * empty/partial root set that hides unrooted files). Exported for testing.
 */
export function projectFileNames(tsconfigRelPath: string): string[] {
  const configPath = path.resolve(ROOT, tsconfigRelPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, /*optionsToExtend*/ {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`${tsconfigRelPath}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    },
  });
  if (!parsed) throw new Error(`${tsconfigRelPath}: could not parse tsconfig`);
  const realErrors = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (realErrors.length > 0) {
    throw new Error(
      `${tsconfigRelPath}: tsconfig parse errors — ${realErrors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('; ')}`,
    );
  }
  return parsed.fileNames;
}

/** Tracked + untracked-not-ignored TS source (.ts/.tsx/.mts/.cts, excluding
 * submodules + ambient .d.ts/.d.mts/.d.cts), repo-relative POSIX.
 * `--others --exclude-standard` (same enumeration as check-tsconfig-ratchet-coverage.ts)
 * so a NEW unrooted file is caught at authoring time, not only after it's committed;
 * .gitignore'd scratch (generated/, tmp/) is excluded, and submodule files aren't
 * listed by the superproject. */
export function trackedSourceFiles(): string[] {
  const raw = gitCapture(
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.cts'],
    { cwd: ROOT },
  );
  return raw
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.d\.(ts|mts|cts)$/.test(f))
    .filter((f) => !SUBMODULES.some((s) => f.startsWith(`${s}/`)))
    .sort();
}

/**
 * Pure classifier: given tracked source, the covered set, and the frozen baseline,
 * return human-readable violations (empty == pass). Exported for unit testing.
 */
export function computeFileCoverageViolations(
  tracked: readonly string[],
  covered: ReadonlySet<string>,
  baseline: readonly string[],
): string[] {
  const violations: string[] = [];
  const baselineSet = new Set(baseline);
  const trackedSet = new Set(tracked);

  const unrooted = tracked.filter((f) => !covered.has(f));
  const unrootedSet = new Set(unrooted);

  // NEW unrooted files (not previously baselined) — the regression this gate exists to catch.
  const fresh = unrooted.filter((f) => !baselineSet.has(f));
  for (const f of fresh) {
    violations.push(
      `NOT TYPE-CHECK-ROOTED (in no ratchet project's include): ${f}\n` +
        `  → Add its tree to a ratchet project's \`include\` in scripts/check-typescript-errors.ts\n` +
        `    (preferred — make it a robust type-check root), or, if intentionally excluded, regenerate\n` +
        `    the baseline with \`npx tsx scripts/check-file-typecheck-coverage.ts --write-baseline\`.`,
    );
  }

  // STALE baseline entries — now rooted or deleted. Shrink-only: keep the backlog honest.
  for (const f of baseline) {
    if (!trackedSet.has(f)) {
      violations.push(`STALE baseline entry "${f}" — file no longer tracked; regenerate the baseline (shrink-only).`);
    } else if (!unrootedSet.has(f)) {
      violations.push(
        `STALE baseline entry "${f}" — file is now type-check-rooted; regenerate the baseline (shrink-only).`,
      );
    }
  }

  return violations;
}

function computeCovered(): Set<string> {
  const covered = new Set<string>();
  for (const proj of PROJECTS) {
    for (const abs of projectFileNames(proj.tsconfig)) {
      const rel = toRepoRel(abs);
      if (rel) covered.add(rel);
    }
  }
  return covered;
}

function readBaseline(): string[] {
  const p = path.join(ROOT, BASELINE_FILE);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')) as string[];
}

function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline');
  const tracked = trackedSourceFiles();
  const covered = computeCovered();

  if (writeBaseline) {
    const unrooted = tracked.filter((f) => !covered.has(f)).sort();
    fs.writeFileSync(path.join(ROOT, BASELINE_FILE), `${JSON.stringify(unrooted, null, 2)}\n`);
    console.log(`[check-file-typecheck-coverage] wrote ${unrooted.length} unrooted paths to ${BASELINE_FILE}`);
    return;
  }

  const baseline = readBaseline();
  const violations = computeFileCoverageViolations(tracked, covered, baseline);

  if (violations.length > 0) {
    console.error('✘ file-level TypeScript root-coverage check FAILED:\n');
    for (const v of violations) console.error('  ' + v.replace(/\n/g, '\n  ') + '\n');
    console.error(
      `${tracked.length} tracked TS source · ${tracked.length - tracked.filter((f) => !covered.has(f)).length} type-check-rooted · ${baseline.length} baselined-unrooted.`,
    );
    process.exit(1);
  }

  const unrootedCount = tracked.filter((f) => !covered.has(f)).length;
  console.log(
    `✔ file-level TypeScript root-coverage: ${tracked.length - unrootedCount}/${tracked.length} tracked source files ` +
      `are a type-check root of some ratchet project; ${unrootedCount} on the frozen baseline (no new unrooted files).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
