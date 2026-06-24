#!/usr/bin/env npx tsx
/**
 * CI Validation (260624_cloud-space-descent-skip-despite-healthy, Stage 2 / Fork 4):
 * the cloud-symlink ADMISSION healthy-verdict tolerance MUST stay strictly greater
 * than the periodic re-walk interval —
 *
 *     ADMISSION_VERDICT_TTL_MS  >  CLOUD_PERIODIC_REWALK_INTERVAL_MS
 *
 * WHY this is a gate (and not a unit test): the two constants live in DIFFERENT
 * modules (a core constant vs a main-service constant) and are coupled only by
 * intent, so a runtime unit test co-located with one of them under-protects — and
 * the gate's Tier-1 vitest skips untracked test files (a known recurring gotcha).
 * If the invariant is ever violated (someone lowers the admission TTL below the
 * re-walk interval, or raises the interval past the TTL), a healthy admission
 * verdict could EXPIRE in the gap between re-walk re-probes and re-open the
 * GDrive-Spaces-render-empty bug this whole plan fixes. This gate makes that
 * regression a build failure by construction.
 *
 * It reads the LITERAL numeric value of each constant from its source file (a tiny
 * regex over the canonical `export const NAME = <number>;` definition) rather than
 * importing them — importing `cloudPeriodicRewalkService.ts` would drag the main
 * service graph into a scripts/ tsx run, and the literals are the source of truth.
 *
 * Run:    npx tsx scripts/check-cloud-verdict-ttl-invariant.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see docs/plans/260624_cloud-space-descent-skip-despite-healthy/PLAN.md (Stage 2)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ConstantSource {
  /** Repo-relative POSIX path of the file the constant is defined in. */
  readonly file: string;
  /** The exported constant name. */
  readonly name: string;
}

export const ADMISSION_TTL_SOURCE: ConstantSource = {
  file: 'src/core/constants.ts',
  name: 'ADMISSION_VERDICT_TTL_MS',
};

export const REWALK_INTERVAL_SOURCE: ConstantSource = {
  file: 'src/main/services/cloudPeriodicRewalkService.ts',
  name: 'CLOUD_PERIODIC_REWALK_INTERVAL_MS',
};

/**
 * Extract the numeric value of `export const <name> = <number>;` from a source
 * string. Tolerates `_` digit separators (e.g. `360_000`) and trailing comments.
 * Returns `null` when the constant is absent or its RHS is not a plain numeric
 * literal (e.g. it was changed to an expression) — the caller fails closed.
 */
export function extractNumericConstant(source: string, name: string): number | null {
  // Escape regex metacharacters in the identifier (defensive; identifiers won't
  // contain them, but keep the matcher robust).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`export\\s+const\\s+${escaped}\\s*(?::\\s*number\\s*)?=\\s*([0-9][0-9_]*)\\s*;`);
  const m = re.exec(source);
  if (!m) return null;
  const digits = m[1].replace(/_/g, '');
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

const REPO_ROOT = path.join(__dirname, '..');

function readConstant(src: ConstantSource): number {
  const abs = path.join(REPO_ROOT, src.file);
  if (!fs.existsSync(abs)) {
    console.error(`\n✗ Source file not found: ${src.file}`);
    console.error('  Update scripts/check-cloud-verdict-ttl-invariant.ts if it was renamed/moved.');
    process.exit(1);
  }
  const value = extractNumericConstant(fs.readFileSync(abs, 'utf8'), src.name);
  if (value === null) {
    console.error(`\n✗ Could not read a plain numeric \`${src.name}\` from ${src.file}.`);
    console.error('  The TTL-vs-re-walk invariant gate requires both constants to be plain numeric literals.');
    console.error('  If you changed the definition shape, update extractNumericConstant() accordingly.');
    process.exit(1);
  }
  return value;
}

if (!process.env.VITEST) {
  console.log('Checking the cloud admission-verdict TTL vs periodic re-walk interval invariant...\n');

  const admissionTtl = readConstant(ADMISSION_TTL_SOURCE);
  const rewalkInterval = readConstant(REWALK_INTERVAL_SOURCE);

  if (admissionTtl <= rewalkInterval) {
    console.error(
      `\n✗ Invariant violated: ${ADMISSION_TTL_SOURCE.name} (${admissionTtl}) must be STRICTLY GREATER than ${REWALK_INTERVAL_SOURCE.name} (${rewalkInterval}).\n`,
    );
    console.error(
      'A healthy cloud-Space admission verdict is refreshed only by the periodic re-walk\n' +
        're-probe. If the admission TTL is not larger than the re-walk interval, the verdict\n' +
        'expires in the gap between re-probes and the Library file-tree skips a HEALTHY cloud\n' +
        'Space → empty cards (the 260624 bug). Either raise ADMISSION_VERDICT_TTL_MS\n' +
        '(src/core/constants.ts) or lower CLOUD_PERIODIC_REWALK_INTERVAL_MS\n' +
        '(src/main/services/cloudPeriodicRewalkService.ts) so the margin is restored.\n' +
        'See: docs/plans/260624_cloud-space-descent-skip-despite-healthy/PLAN.md (Stage 2)',
    );
    process.exit(1);
  }

  console.log(
    `✓ ${ADMISSION_TTL_SOURCE.name}=${admissionTtl} > ${REWALK_INTERVAL_SOURCE.name}=${rewalkInterval} (margin ${admissionTtl - rewalkInterval}ms)`,
  );
}
