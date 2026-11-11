/**
 * @fileoverview Tests for the `mirror` subcommand, run the way an installed package runs
 * it: a separate process on the server entry point, from a working directory of its
 * own, against a loopback content mirror serving the committed fixture archive. Each
 * run gets a fresh environment, so the per-user default path, the exit codes, and the
 * framework's log records on stderr are what a terminal user would see.
 *
 * The subprocess runs the TypeScript entry point under Bun on both test lanes; the
 * compiled entry under Node is exercised from a packed tarball at release time.
 * @module tests/services/catalog-mirror/mirror-cli.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { CatalogMirrorService } from '@/services/catalog-mirror/catalog-mirror-service.js';
import { type ArchiveServer, startArchiveServer } from './archive-server.js';

const ENTRY = fileURLToPath(new URL('../../../src/index.ts', import.meta.url));
const BUN = process.versions.bun === undefined ? 'bun' : process.execPath;
const FIRST_BUILD = new Date('2026-08-21T14:40:50Z');
const SECOND_BUILD = new Date('2026-08-22T14:40:50Z');
/** A subprocess boots Bun and the framework from cold; the machine runs under heavy load. */
const RUN_TIMEOUT_MS = 120_000;

interface MirrorRun {
  code: number | null;
  stderr: string;
  stdout: string;
}

let archive: ArchiveServer;
let workDir: string;
/** Where the per-user default lands with `XDG_DATA_HOME` pointed into `workDir`. */
let defaultPath: string;

/**
 * The child's whole environment. `HOME` is a scratch directory so nothing can reach the
 * real one; `NODE_ENV` is set because Vitest's `test` turns the framework's stderr log
 * sink off; Gutendex points at a closed loopback port.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(workDir, 'home'),
    NODE_ENV: 'production',
    MCP_LOG_LEVEL: 'info',
    LOGS_DIR: join(workDir, 'logs'),
    XDG_DATA_HOME: join(workDir, 'data'),
    GUTENDEX_BASE_URL: 'http://127.0.0.1:9/books/',
    GUTENBERG_TEXT_BASE_URL: archive.baseUrl,
    ...extra,
  };
}

/** A fresh working directory, so no run can lean on another's cwd. */
function freshCwd(name: string): string {
  const dir = join(workDir, 'cwd', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startMirror(
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): { child: ChildProcess; done: Promise<MirrorRun> } {
  const child = spawn(BUN, [ENTRY, 'mirror', ...args], {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<MirrorRun>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function runMirror(
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<MirrorRun> {
  return startMirror(args, options).done;
}

/** The framework's JSON log records on stderr, by message. */
function logMessages(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => (JSON.parse(line) as { msg: string }).msg);
}

function serviceAt(mirrorPath: string): CatalogMirrorService {
  const config: ServerConfig = {
    gutendexBaseUrl: 'http://127.0.0.1:9/books/',
    gutenbergTextBaseUrl: archive.baseUrl,
    mirrorPath,
  };
  return new CatalogMirrorService(config);
}

async function verifyAt(mirrorPath: string) {
  const service = serviceAt(mirrorPath);
  try {
    return await service.verify();
  } finally {
    await service.close();
  }
}

/** A copy of the initialized default mirror, for a case that changes or damages it. */
function copyOfDefault(name: string): string {
  mkdirSync(join(workDir, 'copies'), { recursive: true });
  const target = join(workDir, 'copies', name);
  copyFileSync(defaultPath, target);
  return target;
}

/**
 * Flip the last byte of the download-count index's root page: the rowid of one index
 * entry. Queries still run, and the integrity check reports the entry missing.
 */
async function damageIndex(mirrorPath: string): Promise<void> {
  const service = serviceAt(mirrorPath);
  const db = await service.mirror.raw();
  const { rootpage } = db
    .prepare<{ rootpage: number }>(
      "SELECT rootpage FROM sqlite_schema WHERE name = 'books_download_count_idx'",
    )
    .get() as { rootpage: number };
  const { page_size: pageSize } = db.prepare<{ page_size: number }>('PRAGMA page_size').get() as {
    page_size: number;
  };
  await service.close();
  const lastByte = rootpage * pageSize - 1;
  const fd = openSync(mirrorPath, 'r+');
  const byte = Buffer.alloc(1);
  readSync(fd, byte, 0, 1, lastByte);
  writeSync(fd, Buffer.from([byte.readUInt8(0) ^ 0x40]), 0, 1, lastByte);
  closeSync(fd);
}

beforeAll(async () => {
  archive = await startArchiveServer('catalog-sample.tar.bz2', FIRST_BUILD);
  workDir = mkdtempSync(join(tmpdir(), 'gutenberg-mirror-cli-'));
  defaultPath = join(workDir, 'data', 'gutenberg-mcp-server', 'gutenberg-catalog.sqlite');
});

afterAll(async () => {
  await archive.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('mirror subcommand — usage', { timeout: RUN_TIMEOUT_MS }, () => {
  it.each([
    ['no action', []],
    ['an unknown action', ['sync']],
    ['an extra argument', ['init', 'now']],
  ])('exits 2 with usage for %s, starting nothing', async (_label, args) => {
    const name = `usage-${args.join('-') || 'none'}`;
    const dataHome = join(workDir, name);
    const run = await runMirror(args, { cwd: freshCwd(name), env: { XDG_DATA_HOME: dataHome } });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^Usage: gutenberg-mcp-server mirror <init\|refresh\|verify>/);
    expect(run.stdout).toBe('');
    /** A booting server, or an initialized logger, writes JSON records to stderr. */
    expect(logMessages(run.stderr)).toEqual([]);
    /** Nor is a database created. */
    expect(existsSync(dataHome)).toBe(false);
  });
});

describe('mirror subcommand — verify without a mirror', { timeout: RUN_TIMEOUT_MS }, () => {
  it('exits 1 naming the missing mirror and `mirror init`, creating nothing', async () => {
    const dataHome = join(workDir, 'never-built');
    const missing = join(dataHome, 'gutenberg-mcp-server', 'gutenberg-catalog.sqlite');
    const run = await runMirror(['verify'], {
      cwd: freshCwd('verify-missing'),
      env: { XDG_DATA_HOME: dataHome },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(`mirror path: ${missing}\n`);
    /** One line beside the logger's JSON records. */
    expect(run.stderr.split('\n').filter((line) => line !== '' && !line.startsWith('{'))).toEqual([
      `No catalog mirror at ${missing}. Build one with \`gutenberg-mcp-server mirror init\`.`,
    ]);
    expect(existsSync(dataHome)).toBe(false);
  });
});

describe('mirror subcommand — lifecycle', { timeout: RUN_TIMEOUT_MS }, () => {
  let init: MirrorRun;

  beforeAll(async () => {
    init = await runMirror(['init'], { cwd: freshCwd('init') });
  }, RUN_TIMEOUT_MS);

  it('init builds the per-user mirror, printing its path first and logging to stderr', () => {
    expect(init.code).toBe(0);
    expect(init.stdout.split('\n')[0]).toBe(`mirror path: ${defaultPath}`);
    expect(init.stdout).toContain('8 books in the mirror');
    expect(existsSync(defaultPath)).toBe(true);
    /** Every stderr line is a JSON record: the runner's completion, then the logger's close. */
    const lines = init.stderr.split('\n').filter((line) => line !== '');
    expect(lines.every((line) => line.startsWith('{'))).toBe(true);
    expect(logMessages(init.stderr)).toContain('Mirror sync complete');
    expect(logMessages(init.stderr).at(-1)).toBe('Logger shutting down.');
  });

  it('verify from another directory reads the same mirror', async () => {
    const run = await runMirror(['verify'], { cwd: freshCwd('verify') });
    expect(run.code).toBe(0);
    expect(run.stdout.split('\n')[0]).toBe(`mirror path: ${defaultPath}`);
    expect(run.stdout).toContain('rows:        8');
    expect(run.stdout).toContain('ready:       true');
    expect(run.stdout).toContain('integrity:   ok');
  });

  it('prints a relative GUTENBERG_MIRROR_PATH resolved against the working directory', async () => {
    const cwd = freshCwd('verify-relative');
    copyFileSync(defaultPath, join(cwd, 'relative.sqlite'));
    const run = await runMirror(['verify'], {
      cwd,
      env: { GUTENBERG_MIRROR_PATH: './relative.sqlite' },
    });
    expect(run.code).toBe(0);
    /** The child's working directory is the real path; macOS reaches tmpdir through a symlink. */
    expect(run.stdout.split('\n')[0]).toBe(
      `mirror path: ${join(realpathSync(cwd), 'relative.sqlite')}`,
    );
    expect(run.stdout).toContain('rows:        8');
  });

  it('refresh on an unchanged archive sends one HEAD and downloads nothing', async () => {
    const heads = archive.heads;
    const gets = archive.gets;
    const run = await runMirror(['refresh'], { cwd: freshCwd('refresh-unchanged') });
    expect(run.code).toBe(0);
    expect(archive.heads).toBe(heads + 1);
    expect(archive.gets).toBe(gets);
    expect(run.stdout).toContain('Archive unchanged since the last sync');
  });

  it('verify exits 1 when the integrity check fails', async () => {
    const damaged = copyOfDefault('damaged.sqlite');
    await damageIndex(damaged);
    const run = await runMirror(['verify'], {
      cwd: freshCwd('verify-damaged'),
      env: { GUTENBERG_MIRROR_PATH: damaged },
    });
    expect(run.code).toBe(1);
    expect(run.stdout.split('\n')[0]).toBe(`mirror path: ${damaged}`);
    expect(run.stdout).toContain('rows:        8');
    expect(run.stdout).toMatch(/integrity: {3}integrity_check: row \d+ missing from index/);
  });

  it('a failed sync exits 1 and logs the runner failure record', async () => {
    archive.failWith(503);
    try {
      const run = await runMirror(['init'], {
        cwd: freshCwd('init-failed'),
        env: { GUTENBERG_MIRROR_PATH: join(workDir, 'copies', 'failed.sqlite') },
      });
      expect(run.code).toBe(1);
      expect(logMessages(run.stderr)).toContain('Mirror sync failed');
      expect(run.stderr).toContain('answered 503 for the catalog archive');
    } finally {
      archive.failWith(null);
    }
  });

  it('an interrupted refresh keeps a ready mirror with every row, and a re-run completes it', async () => {
    const mirrorPath = copyOfDefault('interrupted.sqlite');
    const env = { GUTENBERG_MIRROR_PATH: mirrorPath };
    archive.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    archive.throttle(true);
    try {
      const downloading = archive.nextGet();
      const { child, done } = startMirror(['refresh'], {
        cwd: freshCwd('refresh-interrupted'),
        env,
      });
      await downloading;
      child.kill('SIGINT');
      const run = await done;
      expect(run.code).toBe(1);
      expect(run.stdout).toContain('SIGINT received');
      expect(logMessages(run.stderr)).toContain('Mirror sync stopped');

      const interrupted = await verifyAt(mirrorPath);
      expect(interrupted.status.status).toBe('error');
      expect(interrupted.status.ready).toBe(true);
      expect(interrupted.rows).toBe(8);
      expect(interrupted.status.checkpoint).toBe(FIRST_BUILD.toISOString());

      archive.throttle(false);
      const rerun = await runMirror(['refresh'], { cwd: freshCwd('refresh-rerun'), env });
      expect(rerun.code).toBe(0);
      const refreshed = await verifyAt(mirrorPath);
      expect(refreshed.status.status).toBe('complete');
      expect(refreshed.status.checkpoint).toBe(SECOND_BUILD.toISOString());
      expect(refreshed.rows).toBe(7);
    } finally {
      archive.throttle(false);
      archive.serve('catalog-sample.tar.bz2', FIRST_BUILD);
    }
  });
});
