/* eslint-disable no-console -- bootstrap: runs before the structured logger (pino) is initialised */
/**
 * Source-build `.env` / `.env.local` loader.
 *
 * In a SOURCE / dev build (`!app.isPackaged`), reads `<repoRoot>/.env` then
 * `<repoRoot>/.env.local` and copies each `KEY=VALUE` into `process.env`.
 *
 * Precedence (dotenv ecosystem norm): **real env > `.env.local` > `.env`**. A
 * real shell export / CI env that is already present at entry ALWAYS wins and is
 * never overridden by either file. Between the two files, `.env.local` (the
 * user-specific override) wins over `.env` (committed defaults). Absent keys get
 * filled. (This deliberately differs from the once-only first-writer rule in
 * `scripts/generate-runtime-config.mjs` — that quirk is not the contract we want
 * for this runtime loader.)
 *
 * WHY this exists: the in-app ConnectorSetupDialog, docs/connectors/CONNECTOR_SETUP.md,
 * .env.example, and scripts/oss-setup.mjs all tell source-build users to put their
 * BYO OAuth client credentials (e.g. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) in a
 * `.env.local` at the repo root and restart — but nothing actually loaded that file
 * into the main process `process.env`. `resolveOAuthCredentials` reads
 * `process.env[name]`, so without this loader the documented setup path silently
 * fails (the connector stays unconnectable). See
 * docs/plans/260623_google-oss-connector-verify/PLAN.md (Stage 1).
 *
 * PACKAGED builds are a NO-OP: they inherit a real launch environment (the
 * documented path), and we must never read repo files that don't ship.
 *
 * Parser is forgiving for hand-editing OSS users: strips a leading UTF-8 BOM and
 * accepts a pasted `export KEY=...` shell line.
 *
 * OBSERVABILITY: a missing file is the expected, silent case; a file that EXISTS
 * but can't be read (e.g. permissions) is surfaced as a names/path-only warning
 * (basename + error code) — boot still continues.
 *
 * SECURITY: never logs secret VALUES or file contents — at most the KEY NAMES
 * that were loaded (and, on a read error, the file basename + error code).
 *
 * Cross-platform: uses node:path / node:fs only; no OS-specific separators.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const ENV_FILES = ['.env', '.env.local'] as const;

/**
 * Parse a single dotenv-style file's contents into key/value pairs. Behaviour:
 *   - Strips a leading UTF-8 BOM from the file (so a BOM-prefixed first key —
 *     common when an editor saves UTF-8-with-BOM on Windows — parses correctly).
 *   - Skips blank lines and `#` comments.
 *   - Accepts an optional leading `export ` before the key (e.g. a pasted shell
 *     `export GOOGLE_CLIENT_ID=...` line parses the key as `GOOGLE_CLIENT_ID`).
 *   - Splits on the FIRST `=`, trims key and value.
 *   - Strips a single pair of surrounding single or double quotes from the value.
 *   - Skips lines without `=` or with an empty key.
 * Pure — no I/O, no env mutation.
 */
export function parseDotEnv(contents: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  // Strip a leading UTF-8 BOM (U+FEFF) before splitting so the first key isn't
  // mangled into "﻿KEY".
  const normalized = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  for (const rawLine of normalized.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // Accept an optional leading `export ` (pasted shell export line).
    line = line.replace(/^export\s+/, '');
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!key) {
      continue;
    }
    let value = line.slice(equalsIndex + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * A file that exists but could not be read (NOT a missing file). Carries only
 * the basename and the error code/message — NEVER file contents or values — so
 * the caller can surface a safe, names-only diagnostic.
 */
export interface EnvFileReadError {
  /** Basename only (e.g. `.env.local`) — never the absolute path. */
  file: string;
  /** Error code (e.g. `EACCES`) or message; never file contents/values. */
  code: string;
}

/** Result of {@link loadSourceBuildEnvInto}. */
export interface LoadSourceBuildEnvResult {
  /**
   * Ordered KEY NAMES applied from files (a key set by `.env` then overridden
   * by `.env.local` appears once). Names only — safe to log; never values.
   */
  applied: string[];
  /**
   * Files that EXIST but could not be read (e.g. permissions). Missing files
   * (existsSync false) are NOT reported here — that's the expected case.
   */
  readErrors: EnvFileReadError[];
}

/**
 * Testable core: load `.env` then `.env.local` from `repoRoot` into the given
 * `env` map (defaults to `process.env`). No-op when `isPackaged`. Fail-soft: a
 * missing or unreadable file never throws.
 *
 * Precedence — **real env > `.env.local` > `.env`**:
 *   - Keys already present in `env` at entry (real shell / CI exports) are
 *     snapshotted and NEVER overridden by either file.
 *   - `.env` applies first, filling any non-pre-set key.
 *   - `.env.local` applies second and MAY override a value sourced from `.env`
 *     (so `.env.local` wins over `.env`), but still never a pre-set key.
 *
 * Returns `{ applied, readErrors }`: `applied` is the names-only list of keys
 * set from files; `readErrors` lists files that EXIST but couldn't be read
 * (basename + code only) so the caller can warn. Missing files are silent
 * (expected). No secret VALUE ever appears in either field.
 */
export function loadSourceBuildEnvInto(
  repoRoot: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): LoadSourceBuildEnvResult {
  if (isPackaged) {
    return { applied: [], readErrors: [] };
  }
  // Snapshot the real (pre-set) keys at entry — shell/CI exports. These always
  // win and must never be overridden by either file.
  const preSetKeys = new Set(Object.keys(env));
  // Track which keys we applied from files (dedup so .env→.env.local override
  // counts once); preserve first-applied order for stable logging.
  const appliedOrder: string[] = [];
  const appliedSet = new Set<string>();
  const readErrors: EnvFileReadError[] = [];
  for (const fileName of ENV_FILES) {
    const filePath = path.join(repoRoot, fileName);
    // Missing file is the expected, silent case — skip without reporting.
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let contents: string;
    try {
      contents = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // File exists but is unreadable (e.g. EACCES). Fail-soft (never break
      // boot) BUT make it observable: record basename + code/message only —
      // never file contents or values.
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
          ? err.code
          : err instanceof Error
            ? err.message
            : String(err);
      readErrors.push({ file: fileName, code });
      continue;
    }
    for (const { key, value } of parseDotEnv(contents)) {
      // Real env always wins — never override a pre-set key.
      if (preSetKeys.has(key)) {
        continue;
      }
      // Not pre-set: set it. .env fills absent keys; .env.local (read second)
      // is allowed to override a value that came from .env.
      env[key] = value;
      if (!appliedSet.has(key)) {
        appliedSet.add(key);
        appliedOrder.push(key);
      }
    }
  }
  return { applied: appliedOrder, readErrors };
}

/**
 * Real boot entry point. Resolves repoRoot = process.cwd() (npm run dev runs
 * from the repo root) and reads `app.isPackaged`. No-op for packaged builds.
 * Logs only the KEY NAMES that were loaded — never values.
 */
export function loadSourceBuildEnv(): void {
  try {
    const { applied, readErrors } = loadSourceBuildEnvInto(
      process.cwd(),
      app.isPackaged,
      process.env,
    );
    if (applied.length > 0) {
      // Names only — NEVER log values or file contents. Single line; runs
      // before pino is initialised (same constraint as sibling startup modules).
      console.log(
        `[bootstrap] loadSourceBuildEnv: loaded ${applied.length} var(s) from .env/.env.local: ${applied.join(', ')}`,
      );
    }
    if (readErrors.length > 0) {
      // A file exists but couldn't be read (e.g. permissions). Surface it —
      // basename + code only, never contents/values — so a misconfigured file
      // isn't silently ignored. Boot continues regardless.
      const detail = readErrors.map((e) => `${e.file} (${e.code})`).join(', ');
      console.warn(
        `[bootstrap] loadSourceBuildEnv: ${readErrors.length} env file(s) exist but could not be read: ${detail}`,
      );
    }
  } catch (err) {
    // Defensive belt: loadSourceBuildEnvInto is fail-soft per file, so this
    // only fires on something unexpected (e.g. process.cwd() throwing). We log
    // it (observable, not silent) and continue — a failed env load must never
    // break boot. The connector then shows its normal "needs OAuth creds" guidance.
    // eslint-disable-next-line rebel-silent-swallow/no-silent-swallow -- error IS surfaced via console.warn; degrading to "env not loaded" is the intended, non-fatal boot behaviour
    console.warn(
      `[bootstrap] loadSourceBuildEnv skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Side-effect on import: load source-build env BEFORE any OAuth credential
// resolution (which happens far later, at connect-time). Safe to run this early.
loadSourceBuildEnv();
