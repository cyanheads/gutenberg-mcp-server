/**
 * @fileoverview The catalog mirror's lifecycle commands, `gutenberg-mcp-server mirror
 * <init|refresh|verify>`. Compiled into `dist/` with the server, so an installed package
 * runs them under Node or Bun from any directory. Each opens the mirror against the
 * server's own configuration and writes the framework's log records to stderr; a sync
 * stops on SIGINT or SIGTERM with its resume cursor persisted.
 * @module services/catalog-mirror/mirror-cli
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '@cyanheads/mcp-ts-core/config';
import type { SyncMode, SyncProgress, SyncResult } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { CatalogMirrorService } from './catalog-mirror-service.js';

/** Process exit codes: success, an operational failure, a usage error. */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

const USAGE = `Usage: gutenberg-mcp-server mirror <init|refresh|verify>

  init     Harvest the full Project Gutenberg catalog into the local mirror. An interrupted run resumes.
  refresh  Re-harvest when the bulk RDF archive has been rebuilt; does nothing when it has not.
  verify   Report the row count, sync state, and SQLite integrity. Exits 1 when no mirror exists or the integrity check fails.

The mirror is GUTENBERG_MIRROR_PATH, or $XDG_DATA_HOME/gutenberg-mcp-server/gutenberg-catalog.sqlite (~/.local/share when XDG_DATA_HOME is unset, empty, or relative).
`;

const count = (n: number) => n.toLocaleString();

/** Print harvest progress on a fixed page interval so a long run shows movement. */
function progressReporter(everyPages = 5): SyncProgress {
  const startedAt = Date.now();
  return (info) => {
    if (info.pages % everyPages !== 0) return;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(
      `  ${count(info.records)} records · ${info.pages} pages · ${elapsedSeconds}s · at ${info.cursor ?? '—'}\n`,
    );
  };
}

/**
 * Run one sync, stopped by the first SIGINT or SIGTERM. The runner persists its state
 * before unwinding, so a stopped run resumes from its last committed page; a second
 * signal finds no listener and ends the process outright.
 */
async function runSync(service: CatalogMirrorService, mode: SyncMode): Promise<SyncResult> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    process.stdout.write(
      `\n${signal} received — stopping. Re-run \`gutenberg-mcp-server mirror ${mode}\` to resume from the last committed page.\n`,
    );
    controller.abort(new Error(`Interrupted by ${signal}`));
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    return await service.runSync({
      mode,
      signal: controller.signal,
      onProgress: progressReporter(),
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

const ACTIONS = {
  async init(service: CatalogMirrorService): Promise<number> {
    process.stdout.write('Harvesting the Project Gutenberg catalog (full init)…\n');
    const result = await runSync(service, 'init');
    process.stdout.write(
      `Done — ${count(result.recordsApplied)} records applied, ${count(result.tombstonesApplied)} removed, ${count(result.total)} books in the mirror.\n`,
    );
    return EXIT.ok;
  },

  /**
   * Project Gutenberg rebuilds the archive daily and publishes no delta feed: an
   * unchanged archive costs one HEAD, a rebuilt one a full re-harvest. The mirror keeps
   * serving throughout, since readiness keys off the last completed sync.
   */
  async refresh(service: CatalogMirrorService): Promise<number> {
    const before = await service.status();
    process.stdout.write(`Refreshing (checkpoint: ${before.checkpoint ?? 'none'})…\n`);
    const result = await runSync(service, 'refresh');
    process.stdout.write(
      result.pagesFetched === 0
        ? 'Archive unchanged since the last sync — nothing to harvest.\n'
        : `Done — ${count(result.recordsApplied)} records applied, ${count(result.tombstonesApplied)} removed, ${count(result.total)} books in the mirror.\n`,
    );
    const after = await service.status();
    process.stdout.write(`Checkpoint: ${after.checkpoint ?? 'none'}\n`);
    return EXIT.ok;
  },

  /** Exits non-zero on a failed integrity check, so a scheduled run can page on a corrupt database. */
  async verify(service: CatalogMirrorService): Promise<number> {
    const { rows, status, cursor, integrity } = await service.verify();
    process.stdout.write(
      `${[
        `rows:        ${count(rows)}`,
        `status:      ${status.status}`,
        `ready:       ${status.ready}`,
        `completedAt: ${status.completedAt ?? 'never'}`,
        `checkpoint:  ${status.checkpoint ?? 'none'}`,
        `cursor:      ${cursor ?? 'none'}`,
        `integrity:   ${integrity.ok ? 'ok' : integrity.results.join('; ')}`,
        ...(status.error === undefined ? [] : [`lastError:   ${status.error}`]),
      ].join('\n')}\n`,
    );
    if (integrity.ok) return EXIT.ok;
    process.stderr.write('Mirror integrity check failed.\n');
    return EXIT.failed;
  },
};

type MirrorAction = keyof typeof ACTIONS;

function isMirrorAction(name: string | undefined): name is MirrorAction {
  return name !== undefined && Object.hasOwn(ACTIONS, name);
}

/**
 * Run `mirror <action>` and return the process exit code: 0 on success, 1 when a sync
 * or the integrity check fails or `verify` finds no mirror, 2 on a usage error. A usage
 * error writes the usage to stderr and returns before any configuration, logger, or
 * database is touched.
 */
export async function runMirrorCli(args: readonly string[]): Promise<number> {
  const [action, ...extra] = args;
  if (!isMirrorAction(action) || extra.length > 0) {
    process.stderr.write(USAGE);
    return EXIT.usage;
  }
  try {
    /**
     * Nothing outside `createApp()` initializes the logger, and records logged before
     * `initialize()` are dropped at exit. Reading the framework config first also loads
     * `.env` from the working directory, as the server does, before the server config
     * reads `process.env`.
     */
    await logger.initialize(config.logLevel, 'stdio');
    const serverConfig = getServerConfig();
    const mirrorPath = resolve(serverConfig.mirrorPath);
    /** Printed before the database opens: a GUI client may resolve `XDG_DATA_HOME` differently. */
    process.stdout.write(`mirror path: ${mirrorPath}\n`);
    /**
     * Opening the store creates the database and its directories, so a scheduled verify of
     * a never-built mirror, or of a mistyped path, would report an empty one as healthy.
     */
    if (action === 'verify' && !existsSync(mirrorPath)) {
      process.stderr.write(
        `No catalog mirror at ${mirrorPath}. Build one with \`gutenberg-mcp-server mirror init\`.\n`,
      );
      return EXIT.failed;
    }
    const service = new CatalogMirrorService(serverConfig);
    try {
      return await ACTIONS[action](service);
    } finally {
      await service.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failed;
  } finally {
    await logger.close();
  }
}
