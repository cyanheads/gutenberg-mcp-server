/**
 * @fileoverview Local mirror of the Project Gutenberg catalog — an embedded SQLite +
 * FTS5 index of every book record, harvested from the bulk per-book RDF archive.
 *
 * Gutendex is a single live upstream on the catalog read path, and it has been down
 * for extended stretches. This service owns the mirror instance, the RDF ingester, and
 * the hydrated read helpers the tool layer serves from; the live Gutendex client stays
 * in place as the fallback for a cold mirror or an ID the mirror does not hold.
 *
 * A full harvest costs a ~121 MB download and ~79,000 XML parses, so it runs
 * out-of-band via the `mirror:init` / `mirror:refresh` scripts rather than at startup.
 * @module services/catalog-mirror/catalog-mirror-service
 */

import {
  defineMirror,
  type Mirror,
  type MirrorRunOptions,
  type MirrorStatus,
  type QueryOptions,
  type SyncContext,
  type SyncPage,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { Book } from '@/services/gutendex/types.js';
import {
  bookFromRow,
  CATALOG_TABLE,
  type CatalogBookRow,
  catalogStoreSpec,
  rowFromBook,
} from './catalog-mirror-store.js';
import {
  catalogArchiveUrl,
  readArchiveTimestamp,
  streamCatalogArchive,
} from './rdf-archive-stream.js';
import { parseBookRdf } from './rdf-book-parser.js';

/** Stable mirror name used in framework logs and telemetry. */
const MIRROR_NAME = 'gutenberg-catalog';

/**
 * Default records per persisted page. Each page is one transaction and one state write,
 * so the size trades resume granularity against write amplification: at this size a full
 * harvest of ~79,000 books costs under a hundred state writes, and an interrupted run
 * re-parses at most a page.
 */
const PAGE_SIZE = 1_000;

/** Cron job id for the optional in-process refresh. */
const REFRESH_JOB_ID = 'gutenberg-catalog-mirror-refresh';

/** Result of a hydrated mirror query. */
export interface CatalogQueryResult {
  books: Book[];
  /** Total matches before `limit` / `offset`. */
  total: number;
}

/** Health report for the mirror database, as `mirror:verify` prints it. */
export interface CatalogMirrorReport {
  /**
   * Resume position of an interrupted run. Read from the persisted sync state rather
   * than {@link MirrorStatus}, which does not carry the volatile cursor.
   */
  cursor: string | undefined;
  /** `PRAGMA integrity_check` + `quick_check` outcome. */
  integrity: { ok: boolean; results: string[] };
  /** Rows currently stored. */
  rows: number;
  status: MirrorStatus;
}

/**
 * Entries to skip when resuming, from a persisted `<timestamp>|<position>` cursor.
 * A cursor recorded against a different archive rebuild is discarded: positions do not
 * survive a repack, and re-reading from the top is cheaper than a silent gap.
 */
function resumePosition(cursor: string | undefined, archiveStamp: string): number {
  if (cursor === undefined) return 0;
  const separator = cursor.lastIndexOf('|');
  if (separator === -1 || cursor.slice(0, separator) !== archiveStamp) return 0;
  const position = Number.parseInt(cursor.slice(separator + 1), 10);
  return Number.isSafeInteger(position) && position > 0 ? position : 0;
}

export class CatalogMirrorService {
  readonly mirror: Mirror;
  private readonly archiveUrl: string;
  private readonly pageSize: number;

  constructor(serverConfig: ServerConfig, options: { pageSize?: number } = {}) {
    this.archiveUrl = catalogArchiveUrl(serverConfig.gutenbergTextBaseUrl);
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.mirror = defineMirror({
      name: MIRROR_NAME,
      store: sqliteMirrorStore(catalogStoreSpec(serverConfig.mirrorPath)),
      sync: (ctx) => this.harvest(ctx),
    });
  }

  /**
   * Whether the mirror has ever completed a full sync. Keys off the durable completion
   * marker, not live status, so a mirror mid-refresh — or one whose last refresh failed
   * — keeps serving the dataset it already has.
   */
  ready(): Promise<boolean> {
    return this.mirror.ready();
  }

  /** Sync state for `mirror:verify` and operational reporting. */
  status(): Promise<MirrorStatus> {
    return this.mirror.status();
  }

  /** Run a full (`init`) or incremental (`refresh`) harvest. */
  runSync(options: MirrorRunOptions): ReturnType<Mirror['runSync']> {
    return this.mirror.runSync(options);
  }

  /** Release the SQLite handle. */
  close(): Promise<void> {
    return this.mirror.close();
  }

  /** Row count, sync state, and SQLite integrity — the mirror's operational health. */
  async verify(): Promise<CatalogMirrorReport> {
    const [rows, status, state, integrity] = await Promise.all([
      this.mirror.store.count(),
      this.mirror.status(),
      this.mirror.store.readState(),
      this.mirror.store.integrityCheck(),
    ]);
    return { rows, status, cursor: state.cursor, integrity };
  }

  /** Resume position persisted by an interrupted run, if any. */
  async cursor(): Promise<string | undefined> {
    return (await this.mirror.store.readState()).cursor;
  }

  /**
   * Fetch books by Gutenberg ID, preserving the requested order and skipping IDs the
   * mirror does not hold — the caller decides whether a miss falls through to the live
   * catalog.
   *
   * Uses a filtered query rather than the store's `getByIds`, which takes string keys
   * and re-keys its results by the raw column value: against this table's `INTEGER`
   * primary key the SQL matches but the string-to-number lookup does not, so every row
   * is dropped. A numeric `in` filter has no such mismatch.
   */
  async getBooks(ids: number[]): Promise<Book[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.mirror.query({
      filters: [{ column: 'id', op: 'in', value: ids }],
      limit: ids.length,
      offset: 0,
    });
    const byId = new Map(rows.map((row) => [Number(row.id), bookFromRow(row)]));
    return ids.map((id) => byId.get(id)).filter((book): book is Book => book !== undefined);
  }

  /**
   * Run a mirror query and hydrate the rows into normalized books. The caller owns the
   * FTS expression and filters; this only crosses the row/record boundary.
   */
  async queryBooks(options: QueryOptions): Promise<CatalogQueryResult> {
    const { rows, total } = await this.mirror.query(options);
    return { books: rows.map(bookFromRow), total };
  }

  /**
   * The ingester: stream the bulk RDF archive, parse each per-book document, and yield
   * pages of rows.
   *
   * `cursor` is `<archive timestamp>|<entries consumed>`. Archive order is stable for a
   * given rebuild but is not sorted, so position is the only usable resume key — and it
   * is only valid against the rebuild it was recorded from, which is why the timestamp
   * travels with it. Resuming against a newer archive discards the position and re-reads
   * from the top rather than skipping entries whose contents have shifted. The download
   * always restarts either way: a bzip2 stream has no seekable index.
   *
   * `checkpoint` is the archive's own `Last-Modified`. Project Gutenberg rebuilds the
   * archive daily; a refresh against an unchanged archive has nothing to harvest and
   * costs one HEAD request. It advances only on the final page, so an interrupted run
   * never leaves the mirror claiming to hold an archive it did not finish reading.
   */
  private async *harvest({
    mode,
    cursor,
    checkpoint,
    signal,
  }: SyncContext): AsyncGenerator<SyncPage> {
    const archiveStamp = (await readArchiveTimestamp(this.archiveUrl, signal)) ?? '';
    if (
      mode === 'refresh' &&
      checkpoint !== undefined &&
      archiveStamp !== '' &&
      archiveStamp <= checkpoint
    ) {
      return;
    }

    const skip = resumePosition(cursor, archiveStamp);
    /**
     * Tombstones need the complete set of IDs this archive carries, which a resumed run
     * does not have — its earlier entries were consumed by the interrupted run. Only a
     * pass that starts at the top of the archive can tell a deleted book from a skipped
     * one, so a resumed run yields no tombstones and the next full pass reaps them.
     */
    const seen = skip === 0 ? new Set<number>() : null;
    let records: CatalogBookRow[] = [];

    for await (const entry of streamCatalogArchive(this.archiveUrl, signal, skip)) {
      const book = parseBookRdf(entry.xml, entry.id);
      if (book !== null) {
        seen?.add(entry.id);
        records.push(rowFromBook(book));
      }
      if (records.length >= this.pageSize) {
        yield { records, cursor: `${archiveStamp}|${entry.index + 1}` };
        records = [];
      }
    }

    yield {
      records,
      tombstones: seen === null ? [] : await this.staleIds(seen),
      cursor: undefined,
      ...(archiveStamp !== '' && { checkpoint: archiveStamp }),
    };
  }

  /** IDs the mirror still holds that the archive no longer carries — books withdrawn upstream. */
  private async staleIds(seen: ReadonlySet<number>): Promise<string[]> {
    const handle = await this.mirror.raw();
    const stored = handle.prepare<{ id: number }>(`SELECT id FROM ${CATALOG_TABLE}`).all();
    return stored.filter((row) => !seen.has(row.id)).map((row) => String(row.id));
  }
}

// --- Init/accessor pattern ---

let _service: CatalogMirrorService | undefined;

export function initCatalogMirrorService(
  serverConfig: ServerConfig,
  options?: { pageSize?: number },
): CatalogMirrorService {
  _service = new CatalogMirrorService(serverConfig, options);
  return _service;
}

export function getCatalogMirrorService(): CatalogMirrorService {
  if (!_service) {
    throw new Error(
      'CatalogMirrorService not initialized — call initCatalogMirrorService() in setup()',
    );
  }
  return _service;
}

/** Whether a refresh cron was registered this process, so teardown knows what to unwind. */
let _refreshScheduled = false;

/**
 * Register and start the in-process refresh cron, when one is configured.
 *
 * Off unless `GUTENBERG_MIRROR_REFRESH_CRON` is set, because a refresh is a full
 * re-harvest — the archive publishes no incremental delta — and that is a poor
 * neighbour for a process that is also serving requests. Deployments with a host
 * scheduler should run `mirror:refresh` out-of-band instead.
 */
export async function startCatalogMirrorRefresh(serverConfig: ServerConfig): Promise<void> {
  const schedule = serverConfig.mirrorRefreshCron;
  if (schedule === undefined) return;
  const service = getCatalogMirrorService();
  await schedulerService.schedule(
    REFRESH_JOB_ID,
    schedule,
    async () => {
      await service.runSync({ mode: 'refresh' });
    },
    'Re-harvest the Project Gutenberg catalog mirror from the bulk RDF archive.',
  );
  schedulerService.start(REFRESH_JOB_ID);
  _refreshScheduled = true;
}

/**
 * Stop and unregister the refresh cron, when one was registered.
 *
 * The framework clears every scheduled job during shutdown, but only after the
 * `teardown` hook has run — and teardown is where the mirror's SQLite handle is
 * released. Stopping the job first is what keeps a refresh tick from re-opening
 * the database on a process that is on its way out.
 */
export function stopCatalogMirrorRefresh(): void {
  if (!_refreshScheduled) return;
  schedulerService.remove(REFRESH_JOB_ID);
  _refreshScheduled = false;
}
