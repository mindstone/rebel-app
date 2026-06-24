/**
 * Unit tests for the source-build `.env` / `.env.local` loader.
 *
 * Covers the testable core (`loadSourceBuildEnvInto`, `parseDotEnv`) with
 * controlled inputs (a real tmp dir + a controlled env map + an explicit
 * isPackaged flag) — no dependency on the real `app`/cwd.
 *
 * Security invariant under test: the function exposes only KEY NAMES + read-error
 * basenames/codes (its return value), never secret VALUES or file contents, so
 * the caller can log names-only.
 *
 * See docs/plans/260623_google-oss-connector-verify/PLAN.md (Stage 1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The module body runs `loadSourceBuildEnv()` as an import side-effect, which
// touches `app.isPackaged` from 'electron'. Mock electron so importing is inert
// (packaged → no-op), keeping these tests independent of the real app.
vi.mock('electron', () => ({
  app: { get isPackaged() { return true; } },
}));

import { loadSourceBuildEnvInto, parseDotEnv } from '../loadSourceBuildEnv';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-source-build-env-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnvFile(name: string, contents: string): void {
  fs.writeFileSync(path.join(tmpDir, name), contents, 'utf8');
}

describe('parseDotEnv', () => {
  it('skips blank lines and # comments', () => {
    const pairs = parseDotEnv('\n# a comment\n   # indented comment\nKEY=value\n\n');
    expect(pairs).toEqual([{ key: 'KEY', value: 'value' }]);
  });

  it('splits on the first = and trims key', () => {
    const pairs = parseDotEnv('  FOO = a=b=c ');
    expect(pairs).toEqual([{ key: 'FOO', value: 'a=b=c' }]);
  });

  it('skips lines without = and lines with an empty key', () => {
    const pairs = parseDotEnv('NO_EQUALS\n=novalue\nGOOD=ok');
    expect(pairs).toEqual([{ key: 'GOOD', value: 'ok' }]);
  });

  it('strips a single pair of surrounding single or double quotes', () => {
    const pairs = parseDotEnv(`A="dq"\nB='sq'\nC="unbalanced\nD=plain`);
    expect(pairs).toEqual([
      { key: 'A', value: 'dq' },
      { key: 'B', value: 'sq' },
      { key: 'C', value: '"unbalanced' },
      { key: 'D', value: 'plain' },
    ]);
  });

  it('accepts an optional leading `export ` before the key (pasted shell line)', () => {
    const pairs = parseDotEnv('export GOOGLE_CLIENT_ID=abc\nexport   GOOGLE_CLIENT_SECRET="shh"\nPLAIN=ok');
    expect(pairs).toEqual([
      { key: 'GOOGLE_CLIENT_ID', value: 'abc' },
      { key: 'GOOGLE_CLIENT_SECRET', value: 'shh' },
      { key: 'PLAIN', value: 'ok' },
    ]);
  });

  it('strips a leading UTF-8 BOM so the first key parses correctly', () => {
    const pairs = parseDotEnv('﻿GOOGLE_CLIENT_ID=first\nSECOND=two');
    expect(pairs).toEqual([
      { key: 'GOOGLE_CLIENT_ID', value: 'first' },
      { key: 'SECOND', value: 'two' },
    ]);
  });
});

describe('loadSourceBuildEnvInto', () => {
  it('loads vars from .env.local into the env map', () => {
    writeEnvFile('.env.local', 'GOOGLE_CLIENT_ID=client-123\nGOOGLE_CLIENT_SECRET=shh-secret');
    const env: NodeJS.ProcessEnv = {};
    const { applied, readErrors } = loadSourceBuildEnvInto(tmpDir, false, env);

    expect(env.GOOGLE_CLIENT_ID).toBe('client-123');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('shh-secret');
    expect(applied).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(readErrors).toEqual([]);
  });

  it('does NOT override a key already present in the env (real env wins)', () => {
    writeEnvFile('.env.local', 'GOOGLE_CLIENT_ID=from-file');
    const env: NodeJS.ProcessEnv = { GOOGLE_CLIENT_ID: 'from-shell' };
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    expect(env.GOOGLE_CLIENT_ID).toBe('from-shell');
    expect(applied).toEqual([]);
  });

  it('lets .env.local override .env when both define the same previously-unset key', () => {
    writeEnvFile('.env', 'GOOGLE_CLIENT_ID=base\nONLY_IN_BASE=base-only');
    writeEnvFile('.env.local', 'GOOGLE_CLIENT_ID=override');
    const env: NodeJS.ProcessEnv = {};
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    // Precedence real > .env.local > .env: neither key is pre-set, so .env fills
    // both, then .env.local (read second) overrides the shared key. .env.local
    // wins for GOOGLE_CLIENT_ID; ONLY_IN_BASE keeps the .env value.
    expect(env.GOOGLE_CLIENT_ID).toBe('override');
    expect(env.ONLY_IN_BASE).toBe('base-only');
    // Applied key names dedup (GOOGLE_CLIENT_ID set by .env then overridden by
    // .env.local counts once), in first-applied order.
    expect(applied).toEqual(['GOOGLE_CLIENT_ID', 'ONLY_IN_BASE']);
  });

  it('never lets either file override a real pre-set key (real env wins over .env and .env.local)', () => {
    writeEnvFile('.env', 'GOOGLE_CLIENT_ID=from-base');
    writeEnvFile('.env.local', 'GOOGLE_CLIENT_ID=from-local');
    const env: NodeJS.ProcessEnv = { GOOGLE_CLIENT_ID: 'from-shell' };
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    expect(env.GOOGLE_CLIENT_ID).toBe('from-shell');
    expect(applied).toEqual([]);
  });

  it('treats missing files as a silent no-op (no throw, no readErrors)', () => {
    const env: NodeJS.ProcessEnv = {};
    const { applied, readErrors } = loadSourceBuildEnvInto(tmpDir, false, env);
    expect(applied).toEqual([]);
    expect(readErrors).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });

  it('strips quotes and skips comments/blank lines end-to-end', () => {
    writeEnvFile('.env.local', '# comment\n\nQUOTED="value with spaces"\nSINGLE=\'sq\'\n');
    const env: NodeJS.ProcessEnv = {};
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    expect(env.QUOTED).toBe('value with spaces');
    expect(env.SINGLE).toBe('sq');
    expect(applied).toEqual(['QUOTED', 'SINGLE']);
  });

  it('is a no-op when isPackaged is true (reads nothing)', () => {
    writeEnvFile('.env.local', 'GOOGLE_CLIENT_ID=should-not-load');
    const env: NodeJS.ProcessEnv = {};
    const { applied, readErrors } = loadSourceBuildEnvInto(tmpDir, true, env);

    expect(applied).toEqual([]);
    expect(readErrors).toEqual([]);
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('reports an unreadable (non-ENOENT) file in readErrors without throwing or leaking contents', () => {
    const secret = 'super-secret-value-do-not-log';
    writeEnvFile('.env.local', `GOOGLE_CLIENT_SECRET=${secret}`);

    // File exists (existsSync true) but readFileSync throws a non-ENOENT error.
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw eacces;
    });

    const env: NodeJS.ProcessEnv = {};
    let result: ReturnType<typeof loadSourceBuildEnvInto> | undefined;
    expect(() => {
      result = loadSourceBuildEnvInto(tmpDir, false, env);
    }).not.toThrow();

    expect(result?.applied).toEqual([]);
    expect(result?.readErrors).toEqual([{ file: '.env.local', code: 'EACCES' }]);
    // Diagnostics carry basename + code only — never contents or secret value.
    const surface = JSON.stringify(result?.readErrors);
    expect(surface).not.toContain(secret);
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('exposes loaded KEY NAMES but never secret VALUES in its return surface', () => {
    const secret = 'super-secret-value-do-not-log';
    writeEnvFile('.env.local', `GOOGLE_CLIENT_SECRET=${secret}`);
    const env: NodeJS.ProcessEnv = {};
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    // The names-only surface (what the caller logs) must contain the KEY...
    const summary = applied.join(', ');
    expect(summary).toContain('GOOGLE_CLIENT_SECRET');
    // ...but never the secret VALUE.
    expect(summary).not.toContain(secret);
    expect(applied).not.toContain(secret);
    // The value still made it into the env map (just not the log surface).
    expect(env.GOOGLE_CLIENT_SECRET).toBe(secret);
  });

  it('parses an `export KEY=value` line end-to-end through the loader', () => {
    writeEnvFile('.env.local', 'export GOOGLE_CLIENT_ID=exported-id');
    const env: NodeJS.ProcessEnv = {};
    const { applied } = loadSourceBuildEnvInto(tmpDir, false, env);

    expect(env.GOOGLE_CLIENT_ID).toBe('exported-id');
    expect(applied).toEqual(['GOOGLE_CLIENT_ID']);
  });
});
