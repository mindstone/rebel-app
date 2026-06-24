import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';



vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
  }),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-data',
  isPackaged: () => false,
  getAppRoot: () => '/tmp/test-app',
}));

vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/test-core' }),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => 0,
    onDrained: vi.fn(),
  },
}));

const mockClassifyByPid = vi.fn();
const mockKillProcessTreeIfStillIdentity = vi.fn();
const mockIsOwnerAlive = vi.fn();
const mockReadProcessCmdline = vi.fn();
vi.mock('../superMcpOwnershipClassifier', () => ({
  classifyByPid: (...args: unknown[]) => mockClassifyByPid(...args),
  killProcessTreeIfStillIdentity: (...args: unknown[]) =>
    mockKillProcessTreeIfStillIdentity(...args),
  isOwnerAlive: (...args: unknown[]) => mockIsOwnerAlive(...args),
  readProcessCmdline: (...args: unknown[]) => mockReadProcessCmdline(...args),
  looksLikeSuperMcpCmdline: (cmdline: string) => cmdline.toLowerCase().includes('super-mcp'),
}));

const mockParseOwnerTagFromCmdline = vi.fn();
vi.mock('../superMcpOwnerTag', () => ({
  buildOwnerTagArgs: vi.fn(),
  parseOwnerTagFromCmdline: (...args: unknown[]) => mockParseOwnerTagFromCmdline(...args),
}));

const mockGetProcessStartTimeMs = vi.fn();
vi.mock('@core/utils/processStartTime', () => ({
  getProcessStartTimeMs: (...args: unknown[]) => mockGetProcessStartTimeMs(...args),
}));

const mockListAllOwners = vi.fn();
const mockUnregister = vi.fn();
vi.mock('../superMcpOwnerRegistrySingleton', () => ({
  getOwnerRegistry: () => ({
    listAllOwners: (...args: unknown[]) => mockListAllOwners(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    register: vi.fn().mockResolvedValue(undefined),
    startHeartbeatTimer: vi.fn(),
    updateChildInfo: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockExec = vi.fn(
  (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (command.startsWith('lsof -iTCP:')) {
      callback(null, '4321\n', '');
      return;
    }
    // Default: return empty output (no super-mcp processes in Leg A)
    callback(null, '', '');
  },
);

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
    mockExec(command, callback),
}));

vi.mock('@core/processSpawner', () => ({
  getProcessSpawner: () => ({
    spawn: vi.fn(),
    exec: vi.fn(async (command: string) => {
      return await new Promise<{ stdout: string; stderr: string; error: Error | null }>((resolve) => {
        mockExec(command, (err, stdout, stderr) => resolve({ stdout, stderr, error: err }));
      });
    }),
    kill: vi.fn(() => true),
    waitForExit: vi.fn(async () => ({ code: 0, signal: null, timedOut: false })),
  }),
  setProcessSpawnerFactory: vi.fn(),
}));

vi.mock('node:net', () => {
  const netMock = {
    createServer: vi.fn(() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      server.listen = vi.fn((_port: number, _host: string) => {
        process.nextTick(() => {
          const error = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
          server.emit('error', error);
        });
      });
      server.close = vi.fn((cb?: () => void) => {
        if (cb) cb();
      });
      server.unref = vi.fn();
      return server;
    }),
  };

  return {
    ...netMock,
    default: netMock,
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
  },
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    openSync: vi.fn().mockReturnValue(42),
    closeSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  openSync: vi.fn().mockReturnValue(42),
  closeSync: vi.fn(),
}));

import {
  findAvailablePort,
  reapCrossLaunchSuperMcpOrphans,
  parseWmicCsvLine,
  parsePsJsonProcessList,
} from '../superMcpHttpManager';
import type { OwnerRecord } from '../superMcpOwnerRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOwnerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    ownerId: 'owner-aaa',
    ownerKind: 'desktop',
    ownerPid: 11111,
    ownerStartTimeMs: 1_700_000_000_000,
    childPid: 22222,
    childStartTimeMs: 1_700_000_001_000,
    childPort: null,
    spawnedAt: 1_700_000_000_000,
    lastHeartbeatAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('findAvailablePort orphan cleanup protections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyByPid.mockResolvedValue({
      decision: 'protected',
      reason: 'owner-alive-via-cmdline-tag',
      identity: {
        pid: 4321,
        observedStartTimeMs: 1_730_000_000_000,
      },
      ownerSnapshot: {
        ownerPid: 9999,
      },
    });
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({
      killed: true,
      reason: 'killed',
    });
  });

  it('F4 scenario: protected classifier result prevents kill in range cleanup', async () => {
    await expect(findAvailablePort(3200, 1)).rejects.toThrow(
      /Unable to find available port starting at 3200/,
    );

    expect(mockClassifyByPid).toHaveBeenCalledWith(4321);
    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 1: cross-launch boot reaper
// ---------------------------------------------------------------------------

describe('reapCrossLaunchSuperMcpOrphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no super-mcp processes enumerated in Leg A (ps returns empty)
    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command.startsWith('lsof -iTCP:')) {
          callback(null, '4321\n', '');
          return;
        }
        callback(null, '', '');
      },
    );
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({ killed: true, reason: 'killed' });
    mockUnregister.mockResolvedValue(undefined);
    mockReadProcessCmdline.mockResolvedValue(null);
    mockParseOwnerTagFromCmdline.mockReturnValue(null);
    mockGetProcessStartTimeMs.mockResolvedValue(1_600_000_001_000);
  });

  // -------------------------------------------------------------------------
  // Existing registry-leg (Leg B) behaviour tests
  // -------------------------------------------------------------------------

  it('RED: kills child of dead owner without port exhaustion', async () => {
    // Seed a registry record: dead owner, live port-less child.
    const deadOwnerRecord = makeOwnerRecord({
      ownerPid: 55555,
      ownerStartTimeMs: 1_600_000_000_000,
      childPid: 66666,
      childStartTimeMs: 1_600_000_001_000,
      childPort: null, // port-less — the current per-port scan can't see it
    });
    mockListAllOwners.mockResolvedValue([deadOwnerRecord]);
    // Classifier says owner is dead-or-reused
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');
    // Identity guard says kill succeeded
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({ killed: true, reason: 'killed' });

    await reapCrossLaunchSuperMcpOrphans();

    // Must have killed the child
    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledWith(
      deadOwnerRecord.childPid,
      deadOwnerRecord.childStartTimeMs,
      expect.any(Function),
    );
    // Must have unregistered for registry hygiene
    expect(mockUnregister).toHaveBeenCalledWith(deadOwnerRecord.ownerId);
    // Must NOT have invoked the port-exhaustion scan (classifyByPid = port scan path)
    expect(mockClassifyByPid).not.toHaveBeenCalled();
  });

  it('alive owner — no kill, no unregister', async () => {
    const aliveOwnerRecord = makeOwnerRecord({ ownerPid: 77777, childPid: 88888 });
    mockListAllOwners.mockResolvedValue([aliveOwnerRecord]);
    mockIsOwnerAlive.mockResolvedValue('alive');

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('unknown liveness — no kill, no unregister', async () => {
    const unknownRecord = makeOwnerRecord({ ownerPid: 11111, ownerStartTimeMs: null, childPid: 22222 });
    mockListAllOwners.mockResolvedValue([unknownRecord]);
    mockIsOwnerAlive.mockResolvedValue('unknown');

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('null childPid — skip kill, still unregister dead owner for hygiene', async () => {
    const noChildRecord = makeOwnerRecord({ childPid: null, childStartTimeMs: null });
    mockListAllOwners.mockResolvedValue([noChildRecord]);
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');

    await reapCrossLaunchSuperMcpOrphans();

    // No kill because childPid is null
    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    // But still unregister dead-owner record for hygiene
    expect(mockUnregister).toHaveBeenCalledWith(noChildRecord.ownerId);
  });

  it('identity mismatch (PID reuse) — no kill but still unregisters dead owner', async () => {
    const record = makeOwnerRecord({ childPid: 33333, childStartTimeMs: 1_500_000_000_000 });
    mockListAllOwners.mockResolvedValue([record]);
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');
    // Identity guard says PID was reused — don't kill the new process
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({ killed: false, reason: 'no-longer-matches' });

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledTimes(1);
    // Still unregisters the stale record (no-longer-matches is a terminal outcome)
    expect(mockUnregister).toHaveBeenCalledWith(record.ownerId);
  });

  it('empty registry — no kills, no errors', async () => {
    mockListAllOwners.mockResolvedValue([]);

    await expect(reapCrossLaunchSuperMcpOrphans()).resolves.toBeUndefined();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('multiple records — only dead-owner children are killed', async () => {
    const deadRecord = makeOwnerRecord({
      ownerId: 'dead-owner',
      ownerPid: 10001,
      ownerStartTimeMs: 1_600_000_000_000,
      childPid: 20001,
      childStartTimeMs: 1_600_000_001_000,
    });
    const aliveRecord = makeOwnerRecord({
      ownerId: 'alive-owner',
      ownerPid: 10002,
      ownerStartTimeMs: 1_700_000_000_000,
      childPid: 20002,
      childStartTimeMs: 1_700_000_001_000,
    });
    mockListAllOwners.mockResolvedValue([deadRecord, aliveRecord]);
    mockIsOwnerAlive
      .mockResolvedValueOnce('dead-or-reused')  // deadRecord owner
      .mockResolvedValueOnce('alive');           // aliveRecord owner

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledTimes(1);
    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledWith(
      deadRecord.childPid,
      deadRecord.childStartTimeMs,
      expect.any(Function),
    );
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith(deadRecord.ownerId);
  });

  // -------------------------------------------------------------------------
  // Failure-path tests (Leg B — registry leg)
  // -------------------------------------------------------------------------

  it('[B] listAllOwners throws — no kill, resolves cleanly (fail-open)', async () => {
    mockListAllOwners.mockRejectedValue(new Error('disk read error'));

    await expect(reapCrossLaunchSuperMcpOrphans()).resolves.toBeUndefined();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('[B] isOwnerAlive throws mid-loop — other records still processed', async () => {
    const errorRecord = makeOwnerRecord({
      ownerId: 'error-owner',
      ownerPid: 55001,
      childPid: 65001,
      childStartTimeMs: 1_600_000_001_000,
    });
    const deadRecord = makeOwnerRecord({
      ownerId: 'dead-owner',
      ownerPid: 55002,
      childPid: 65002,
      childStartTimeMs: 1_600_000_001_000,
    });
    mockListAllOwners.mockResolvedValue([errorRecord, deadRecord]);
    mockIsOwnerAlive
      .mockRejectedValueOnce(new Error('isOwnerAlive threw'))  // errorRecord: throws
      .mockResolvedValueOnce('dead-or-reused');                 // deadRecord: dead

    await reapCrossLaunchSuperMcpOrphans();

    // The error record should NOT kill
    // The dead record SHOULD be killed
    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledTimes(1);
    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledWith(
      deadRecord.childPid,
      deadRecord.childStartTimeMs,
      expect.any(Function),
    );
    // Only the dead record should be unregistered
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith(deadRecord.ownerId);
  });

  it('[B] identity-unverifiable — record is RETAINED (not unregistered)', async () => {
    const record = makeOwnerRecord({ childPid: 44444, childStartTimeMs: 1_600_000_001_000 });
    mockListAllOwners.mockResolvedValue([record]);
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');
    // Identity check could not verify — non-terminal outcome
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({ killed: false, reason: 'identity-unverifiable' });

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledTimes(1);
    // Record must NOT be unregistered — next boot should retry
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('[B] kill throws — record is RETAINED (not unregistered)', async () => {
    const record = makeOwnerRecord({ childPid: 44445, childStartTimeMs: 1_600_000_001_000 });
    mockListAllOwners.mockResolvedValue([record]);
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');
    mockKillProcessTreeIfStillIdentity.mockRejectedValue(new Error('kill failed unexpectedly'));

    await reapCrossLaunchSuperMcpOrphans();

    // Record must NOT be unregistered since kill threw
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Leg A: cmdline/argv scan — primary mechanism
  // -------------------------------------------------------------------------

  it('[A] cmdline leg: super-mcp PID with dead owner, no registry record → killed via identity guard', async () => {
    const orphanPid = 99001;
    const ownerPid = 88001;
    const ownerStartTimeMs = 1_600_000_000_000;
    const orphanStartTimeMs = 1_600_000_001_000;
    const fakeOwnerTag = { ownerId: 'orphan-owner', ownerPid, ownerStartTimeMs };

    // No registry records (simulates exit-handler erasure)
    mockListAllOwners.mockResolvedValue([]);

    // Leg A: ps enumerates this orphan PID
    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === 'ps -axo pid=,command=') {
          // Return one super-mcp process
          callback(null, `${orphanPid} node /path/to/super-mcp/dist/cli.js --port 3010\n`, '');
          return;
        }
        if (command.startsWith('lsof -iTCP:')) {
          callback(null, '4321\n', '');
          return;
        }
        callback(null, '', '');
      },
    );

    // readProcessCmdline returns cmdline with owner tag
    mockReadProcessCmdline.mockResolvedValue(
      `node /path/to/super-mcp/dist/cli.js --port 3010 --rebel-owner-id ${fakeOwnerTag.ownerId} --rebel-owner-pid ${ownerPid} --rebel-owner-start ${ownerStartTimeMs}`,
    );

    // parseOwnerTagFromCmdline returns the owner tag
    mockParseOwnerTagFromCmdline.mockReturnValue(fakeOwnerTag);

    // Owner is confirmed dead
    mockIsOwnerAlive.mockResolvedValue('dead-or-reused');

    // getProcessStartTimeMs returns the orphan's start time for identity guard
    mockGetProcessStartTimeMs.mockResolvedValue(orphanStartTimeMs);

    // Identity guard says kill succeeded
    mockKillProcessTreeIfStillIdentity.mockResolvedValue({ killed: true, reason: 'killed' });

    await reapCrossLaunchSuperMcpOrphans();

    // Leg A must have killed the orphan via identity guard
    expect(mockKillProcessTreeIfStillIdentity).toHaveBeenCalledWith(
      orphanPid,
      orphanStartTimeMs,
      expect.any(Function),
    );
    // Must NOT have needed the registry (proves cmdline leg works without registry record)
    // unregister should NOT have been called (no registry records)
    expect(mockUnregister).not.toHaveBeenCalled();
    // classifyByPid (port-scan path) must not have been called
    expect(mockClassifyByPid).not.toHaveBeenCalled();
  });

  it('[A] cmdline leg: untagged super-mcp (no owner flags) — skipped', async () => {
    const orphanPid = 99002;

    mockListAllOwners.mockResolvedValue([]);

    // ps returns a super-mcp process with no owner tag
    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === 'ps -axo pid=,command=') {
          callback(null, `${orphanPid} node /path/to/super-mcp/dist/cli.js --port 3010\n`, '');
          return;
        }
        callback(null, '', '');
      },
    );

    // readProcessCmdline returns cmdline without owner tag
    mockReadProcessCmdline.mockResolvedValue('node /path/to/super-mcp/dist/cli.js --port 3010');

    // parseOwnerTagFromCmdline returns null (no owner tag)
    mockParseOwnerTagFromCmdline.mockReturnValue(null);

    await reapCrossLaunchSuperMcpOrphans();

    // Must NOT kill an untagged standalone super-mcp
    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockIsOwnerAlive).not.toHaveBeenCalled();
  });

  it('[A] cmdline leg: enumerator returns zero PIDs — no-op', async () => {
    mockListAllOwners.mockResolvedValue([]);

    // ps returns nothing (no super-mcp processes)
    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, '', '');
      },
    );

    await expect(reapCrossLaunchSuperMcpOrphans()).resolves.toBeUndefined();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    expect(mockIsOwnerAlive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Leg A: additional owner-liveness guard and error-path coverage (F2)
  // -------------------------------------------------------------------------

  it('[A] live owner → process is SKIPPED (not killed)', async () => {
    const orphanPid = 99010;
    const ownerPid = 88010;
    const ownerStartTimeMs = 1_700_000_000_000;
    const fakeOwnerTag = { ownerId: 'live-owner', ownerPid, ownerStartTimeMs };

    mockListAllOwners.mockResolvedValue([]);

    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === 'ps -axo pid=,command=') {
          callback(null, `${orphanPid} node /path/to/super-mcp/dist/cli.js\n`, '');
          return;
        }
        callback(null, '', '');
      },
    );

    mockReadProcessCmdline.mockResolvedValue(
      `node /path/to/super-mcp/dist/cli.js --rebel-owner-id ${fakeOwnerTag.ownerId}`,
    );
    mockParseOwnerTagFromCmdline.mockReturnValue(fakeOwnerTag);
    mockGetProcessStartTimeMs.mockResolvedValue(1_700_000_001_000);

    // Owner is alive — must not kill
    mockIsOwnerAlive.mockResolvedValue('alive');

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
  });

  it('[A] unknown-liveness owner → process is SKIPPED (not killed)', async () => {
    const orphanPid = 99011;
    const ownerPid = 88011;
    const ownerStartTimeMs = null; // missing start time → unknown liveness
    const fakeOwnerTag = { ownerId: 'unknown-owner', ownerPid, ownerStartTimeMs };

    mockListAllOwners.mockResolvedValue([]);

    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === 'ps -axo pid=,command=') {
          callback(null, `${orphanPid} node /path/to/super-mcp/dist/cli.js\n`, '');
          return;
        }
        callback(null, '', '');
      },
    );

    mockReadProcessCmdline.mockResolvedValue(
      `node /path/to/super-mcp/dist/cli.js --rebel-owner-id ${fakeOwnerTag.ownerId}`,
    );
    mockParseOwnerTagFromCmdline.mockReturnValue(fakeOwnerTag);
    mockGetProcessStartTimeMs.mockResolvedValue(1_700_000_001_000);

    // Liveness is unknown — must not kill
    mockIsOwnerAlive.mockResolvedValue('unknown');

    await reapCrossLaunchSuperMcpOrphans();

    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
  });

  it('[A] enumerator exec error (ps fails) → logged as warn, returns [], no kill, resolves cleanly', async () => {
    const { logger } = await import('@core/logger');

    mockListAllOwners.mockResolvedValue([]);

    // Simulate ps returning an error via the spawner (resolves with error field set)
    mockExec.mockImplementation(
      (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === 'ps -axo pid=,command=') {
          callback(new Error('ps: command not found'), '', 'ps: command not found');
          return;
        }
        callback(null, '', '');
      },
    );

    await expect(reapCrossLaunchSuperMcpOrphans()).resolves.toBeUndefined();

    // Must not kill anything
    expect(mockKillProcessTreeIfStillIdentity).not.toHaveBeenCalled();
    // Must log a warning (not swallow silently)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining('enumerateAllSuperMcpPids'),
    );
  });
});

// ---------------------------------------------------------------------------
// Pure parsing helpers — Windows enumerator (G1)
// ---------------------------------------------------------------------------

describe('parseWmicCsvLine', () => {
  it('parses a standard wmic row (pid last, no commas in cmdline)', () => {
    const result = parseWmicCsvLine('MYHOST,node C:\\super-mcp\\dist\\cli.js --port 3010,4567');
    expect(result).toEqual({ pid: 4567, cmdline: 'node C:\\super-mcp\\dist\\cli.js --port 3010' });
  });

  it('S1: correctly extracts pid when CommandLine contains commas', () => {
    // The key regression case: wmic does NOT quote commas in CommandLine.
    // Node is first, ProcessId is last — CommandLine is everything in between.
    const result = parseWmicCsvLine(
      'MYHOST,node C:\\super-mcp\\dist\\cli.js --args a,b,c --port 3010,4567',
    );
    expect(result).toEqual({
      pid: 4567,
      cmdline: 'node C:\\super-mcp\\dist\\cli.js --args a,b,c --port 3010',
    });
  });

  it('returns null for the header row', () => {
    expect(parseWmicCsvLine('Node,CommandLine,ProcessId')).toBeNull();
  });

  it('returns null for a quoted header row', () => {
    expect(parseWmicCsvLine('"Node","CommandLine","ProcessId"')).toBeNull();
  });

  it('returns null for an empty/blank line', () => {
    expect(parseWmicCsvLine('')).toBeNull();
    expect(parseWmicCsvLine('   ')).toBeNull();
  });

  it('returns null for a row with fewer than 3 parts', () => {
    expect(parseWmicCsvLine('MYHOST,4567')).toBeNull();
  });

  it('returns null when ProcessId (last field) is not a valid number', () => {
    expect(parseWmicCsvLine('MYHOST,node super-mcp.js,not-a-number')).toBeNull();
  });

  it('returns null when pid is zero', () => {
    expect(parseWmicCsvLine('MYHOST,node super-mcp.js,0')).toBeNull();
  });
});

describe('parsePsJsonProcessList', () => {
  it('parses a JSON array of process objects', () => {
    const json = JSON.stringify([
      { ProcessId: 1234, CommandLine: 'node C:\\super-mcp\\dist\\cli.js --port 3010' },
      { ProcessId: 5678, CommandLine: 'notepad.exe' },
    ]);
    const result = parsePsJsonProcessList(json);
    expect(result).toEqual([
      { pid: 1234, cmdline: 'node C:\\super-mcp\\dist\\cli.js --port 3010' },
      { pid: 5678, cmdline: 'notepad.exe' },
    ]);
  });

  it('handles a single-object response (PS wraps single result as object, not array)', () => {
    const json = JSON.stringify({
      ProcessId: 9999,
      CommandLine: 'node C:\\super-mcp\\dist\\cli.js',
    });
    const result = parsePsJsonProcessList(json);
    expect(result).toEqual([{ pid: 9999, cmdline: 'node C:\\super-mcp\\dist\\cli.js' }]);
  });

  it('S1: correctly includes pid when CommandLine contains commas', () => {
    // JSON is inherently comma-safe — this is the key advantage over CSV.
    const json = JSON.stringify([
      { ProcessId: 4567, CommandLine: 'node super-mcp.js --args a,b,c --port 3010' },
    ]);
    const result = parsePsJsonProcessList(json);
    expect(result).toEqual([
      { pid: 4567, cmdline: 'node super-mcp.js --args a,b,c --port 3010' },
    ]);
  });

  it('skips entries with null or missing CommandLine', () => {
    const json = JSON.stringify([
      { ProcessId: 1111, CommandLine: null },
      { ProcessId: 2222, CommandLine: 'node super-mcp.js' },
    ]);
    const result = parsePsJsonProcessList(json);
    expect(result).toEqual([{ pid: 2222, cmdline: 'node super-mcp.js' }]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parsePsJsonProcessList('not json at all')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parsePsJsonProcessList('')).toEqual([]);
  });

  it('returns empty array for a JSON array of non-objects', () => {
    expect(parsePsJsonProcessList(JSON.stringify([1, 'foo', null]))).toEqual([]);
  });

  it('skips entries with invalid ProcessId', () => {
    const json = JSON.stringify([
      { ProcessId: 0, CommandLine: 'node super-mcp.js' },
      { ProcessId: 'bad', CommandLine: 'node super-mcp.js' },
      { ProcessId: 8888, CommandLine: 'node super-mcp.js' },
    ]);
    const result = parsePsJsonProcessList(json);
    expect(result).toEqual([{ pid: 8888, cmdline: 'node super-mcp.js' }]);
  });
});
