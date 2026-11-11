/**
 * @fileoverview End-to-end tests for the catalog mirror: a loopback content mirror
 * serving a real `rdf-files.tar.bz2`, through download, bzip2, tar, XML parsing, and
 * into an on-disk SQLite database that is then queried back. Nothing between the HTTP
 * boundary and the query is stubbed, so the wiring the ingester depends on — pipe error
 * forwarding, FTS triggers, cursor persistence — is exercised rather than described.
 * @module tests/services/catalog-mirror/catalog-mirror-service.test
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  CatalogMirrorService,
  initCatalogMirrorService,
  startCatalogMirrorRefresh,
  stopCatalogMirrorRefresh,
} from '@/services/catalog-mirror/catalog-mirror-service.js';
import { parseBookRdf } from '@/services/catalog-mirror/rdf-book-parser.js';
import { type ArchiveServer, startArchiveServer } from './archive-server.js';

const FIRST_BUILD = new Date('2026-08-21T14:40:50Z');
const SECOND_BUILD = new Date('2026-08-22T14:40:50Z');
/** Books in `catalog-sample.tar.bz2`. */
const SAMPLE_IDS = [84, 1000, 1073, 1399, 10001, 10056, 10137, 45304];

let mirror: ArchiveServer;
let workDir: string;
let service: CatalogMirrorService;

function makeService(options: { pageSize?: number } = {}): CatalogMirrorService {
  const config: ServerConfig = {
    gutendexBaseUrl: 'https://catalog.test/books/',
    gutenbergTextBaseUrl: mirror.baseUrl,
    mirrorPath: join(workDir, 'catalog.sqlite'),
  };
  return new CatalogMirrorService(config, options);
}

beforeEach(async () => {
  mirror = await startArchiveServer('catalog-sample.tar.bz2', FIRST_BUILD);
  workDir = mkdtempSync(join(tmpdir(), 'gutenberg-mirror-'));
  service = makeService();
});

afterEach(async () => {
  await service.close();
  await mirror.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('CatalogMirrorService — readiness', () => {
  it('is not ready before any sync has completed', async () => {
    await expect(service.ready()).resolves.toBe(false);
    const report = await service.verify();
    expect(report.rows).toBe(0);
    expect(report.status.status).toBe('pending');
    expect(report.status.completedAt).toBeUndefined();
  });

  it('becomes ready after a full harvest and reports a clean database', async () => {
    await service.runSync({ mode: 'init' });
    await expect(service.ready()).resolves.toBe(true);
    const report = await service.verify();
    expect(report.rows).toBe(SAMPLE_IDS.length);
    expect(report.status.status).toBe('complete');
    expect(report.status.checkpoint).toBe(FIRST_BUILD.toISOString());
    expect(report.integrity.ok).toBe(true);
    /** The volatile cursor is meaningless once a run completes. */
    expect(report.cursor).toBeUndefined();
  });
});

describe('CatalogMirrorService — harvest', () => {
  beforeEach(async () => {
    await service.runSync({ mode: 'init' });
  });

  it('stores every book in the archive', async () => {
    const books = await service.getBooks(SAMPLE_IDS);
    expect(books.map((book) => book.id)).toEqual(SAMPLE_IDS);
  });

  it('serves a record identical to what the parser produces from the same document', async () => {
    const xml = readFileSync(
      new URL('../../fixtures/catalog-mirror/rdf/pg84.rdf', import.meta.url),
      'utf8',
    );
    const [stored] = await service.getBooks([84]);
    expect(stored).toEqual(parseBookRdf(xml, 84));
  });

  it('preserves the requested order and drops IDs the mirror does not hold', async () => {
    const books = await service.getBooks([1399, 999_999, 84]);
    expect(books.map((book) => book.id)).toEqual([1399, 84]);
  });

  it('returns nothing for an empty ID list', async () => {
    await expect(service.getBooks([])).resolves.toEqual([]);
  });

  it('reads the INTEGER key through the store getByIds, a repeated ID at each position', async () => {
    /**
     * Characterization of the framework store `getBooks` reads through: a string ID
     * matches the `INTEGER` key as `id = ?` does, in the requested order.
     */
    const rows = await service.mirror.store.getByIds(['84']);
    expect(rows.map((row) => row.id)).toEqual([84]);
    const books = await service.getBooks([84, 1399, 84]);
    expect(books.map((book) => book.id)).toEqual([84, 1399, 84]);
  });
});

describe('CatalogMirrorService — queries', () => {
  beforeEach(async () => {
    await service.runSync({ mode: 'init' });
  });

  it('matches a title through the full-text index', async () => {
    const { books, total } = await service.queryBooks({
      match: '{title authors_text} : frankenstein',
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(books[0]?.id).toBe(84);
  });

  it('applies every substring term before counting and paging', async () => {
    const result = await service.searchBooks({
      query: 'shel franken stein modern prometheus',
      page: 1,
    });
    expect(result.books.map((book) => book.id)).toEqual([84]);
    expect(result.total).toBe(1);
    expect((await service.searchBooks({ query: 'shel franken stein modern absent' })).total).toBe(
      0,
    );
  });

  it('filters exact language, topic, MIME, copyright and IDs together', async () => {
    const result = await service.searchBooks({
      ids: [84, 1399],
      languages: ['EN'],
      topic: 'gothic',
      mime_type: 'text/plain',
      copyright: ['false'],
    });
    expect(result.books.map((book) => book.id)).toEqual([84]);
    expect(result.total).toBe(1);
    expect((await service.searchBooks({ languages: ['e'] })).total).toBe(0);
    expect((await service.searchBooks({ mime_type: 'missing' })).total).toBe(0);
  });

  it('matches an author name through the full-text index', async () => {
    const { books } = await service.queryBooks({
      match: '{title authors_text} : tolstoy',
      limit: 10,
      offset: 0,
    });
    expect(books.map((book) => book.id)).toEqual([1399]);
  });

  it('matches a subject or bookshelf separately from title and author', async () => {
    const { books } = await service.queryBooks({
      match: '{subjects_text bookshelves_text} : gothic',
      limit: 10,
      offset: 0,
    });
    expect(books.map((book) => book.id)).toEqual([84]);
    const byTitle = await service.queryBooks({
      match: '{title authors_text} : gothic',
      limit: 10,
      offset: 0,
    });
    expect(byTitle.books).toEqual([]);
  });

  it('orders by download count for the popularity paths', async () => {
    const { books } = await service.queryBooks({
      sort: { column: 'download_count', direction: 'desc' },
      limit: 100,
      offset: 0,
    });
    const counts = books.map((book) => book.download_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(books).toHaveLength(SAMPLE_IDS.length);
  });

  it('filters by language through the same index', async () => {
    const { books } = await service.queryBooks({
      match: 'languages_text : it',
      limit: 10,
      offset: 0,
    });
    expect(books.map((book) => book.id)).toEqual([1000]);
  });

  it('answers an offset past the end with an empty page and the true total', async () => {
    const { books, total } = await service.queryBooks({ limit: 10, offset: 500 });
    expect(books).toEqual([]);
    expect(total).toBe(SAMPLE_IDS.length);
  });

  it('caps a page at the requested limit', async () => {
    const { books, total } = await service.queryBooks({ limit: 3, offset: 0 });
    expect(books).toHaveLength(3);
    expect(total).toBe(SAMPLE_IDS.length);
  });
});

describe('CatalogMirrorService — refresh', () => {
  it('does no work when the archive has not been rebuilt', async () => {
    await service.runSync({ mode: 'init' });
    const downloadsAfterInit = mirror.gets;
    const result = await service.runSync({ mode: 'refresh' });
    expect(result.pagesFetched).toBe(0);
    expect(mirror.gets).toBe(downloadsAfterInit);
    await expect(service.ready()).resolves.toBe(true);
  });

  it('re-harvests a rebuilt archive, updating changed records', async () => {
    await service.runSync({ mode: 'init' });
    expect((await service.getBooks([84]))[0]?.download_count).toBe(58824);

    mirror.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    const result = await service.runSync({ mode: 'refresh' });

    expect(result.pagesFetched).toBeGreaterThan(0);
    expect((await service.getBooks([84]))[0]?.download_count).toBe(99999);
    expect((await service.verify()).status.checkpoint).toBe(SECOND_BUILD.toISOString());
  });

  it('removes books the rebuilt archive no longer carries', async () => {
    await service.runSync({ mode: 'init' });
    expect(await service.getBooks([1073])).toHaveLength(1);

    mirror.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    const result = await service.runSync({ mode: 'refresh' });

    expect(result.tombstonesApplied).toBe(1);
    expect(await service.getBooks([1073])).toEqual([]);
    expect((await service.verify()).rows).toBe(SAMPLE_IDS.length - 1);
  });

  it('keeps serving the previous dataset when a refresh fails', async () => {
    await service.runSync({ mode: 'init' });
    mirror.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    mirror.failWith(503);

    await expect(service.runSync({ mode: 'refresh' })).rejects.toThrow();

    /** Readiness keys off the last completed sync, so a failed refresh still serves. */
    await expect(service.ready()).resolves.toBe(true);
    expect((await service.verify()).rows).toBe(SAMPLE_IDS.length);
    expect((await service.getBooks([84]))[0]?.download_count).toBe(58824);
  });
});

describe('CatalogMirrorService — resume', () => {
  it('continues from the persisted position instead of restarting', async () => {
    service = makeService({ pageSize: 2 });
    const controller = new AbortController();

    await expect(
      service.runSync({
        mode: 'init',
        signal: controller.signal,
        onProgress: ({ pages }) => {
          if (pages === 1) controller.abort(new Error('interrupted'));
        },
      }),
    ).rejects.toThrow();

    const interrupted = await service.verify();
    expect(interrupted.rows).toBe(2);
    expect(interrupted.status.status).toBe('error');
    expect(interrupted.cursor).toBe(`${FIRST_BUILD.toISOString()}|2`);
    await expect(service.ready()).resolves.toBe(false);

    const resumed = await service.runSync({ mode: 'init' });

    /** Six of the eight records remained: the run resumed, it did not start over. */
    expect(resumed.recordsApplied).toBe(SAMPLE_IDS.length - 2);
    expect(resumed.total).toBe(SAMPLE_IDS.length);
    await expect(service.ready()).resolves.toBe(true);
    expect((await service.verify()).cursor).toBeUndefined();
  });

  it('emits no tombstones on a resumed run, whose ID set is incomplete', async () => {
    service = makeService({ pageSize: 2 });
    const controller = new AbortController();
    await expect(
      service.runSync({
        mode: 'init',
        signal: controller.signal,
        onProgress: ({ pages }) => {
          if (pages === 1) controller.abort(new Error('interrupted'));
        },
      }),
    ).rejects.toThrow();

    const resumed = await service.runSync({ mode: 'init' });
    expect(resumed.tombstonesApplied).toBe(0);
  });

  it('discards the position when the archive was rebuilt under it', async () => {
    service = makeService({ pageSize: 2 });
    const controller = new AbortController();
    await expect(
      service.runSync({
        mode: 'init',
        signal: controller.signal,
        onProgress: ({ pages }) => {
          if (pages === 1) controller.abort(new Error('interrupted'));
        },
      }),
    ).rejects.toThrow();

    /** Entry positions do not survive a repack, so a stale position must not be trusted. */
    mirror.serve('catalog-sample.tar.bz2', SECOND_BUILD);
    const resumed = await service.runSync({ mode: 'init' });

    expect(resumed.recordsApplied).toBe(SAMPLE_IDS.length);
    expect((await service.verify()).rows).toBe(SAMPLE_IDS.length);
  });
});

describe('CatalogMirrorService — refresh cron', () => {
  afterEach(async () => {
    await stopCatalogMirrorRefresh();
    vi.restoreAllMocks();
  });

  /**
   * Build the shared service's mirror and register the cron with the real scheduler,
   * returning the registered task to fire as a tick. The scheduler's own wrapper logs a
   * throwing task instead of rethrowing it, so the test calls the task directly.
   */
  async function startCron(): Promise<() => Promise<void>> {
    const config: ServerConfig = {
      gutendexBaseUrl: 'https://catalog.test/books/',
      gutenbergTextBaseUrl: mirror.baseUrl,
      mirrorPath: join(workDir, 'catalog.sqlite'),
      mirrorRefreshCron: '0 4 * * *',
    };
    await service.close();
    service = initCatalogMirrorService(config);
    await service.runSync({ mode: 'init' });
    const schedule = vi.spyOn(schedulerService, 'schedule');
    await startCatalogMirrorRefresh(config);
    const task = schedule.mock.calls[0]?.[2];
    if (!task) throw new Error('The refresh cron registered no task.');
    return async () => {
      await task(requestContextService.createRequestContext({ operation: 'test:cron-tick' }));
    };
  }

  it('stops an in-flight refresh and waits for it to record its state', async () => {
    const tick = await startCron();
    mirror.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    mirror.throttle(true);
    const downloading = mirror.nextGet();
    const ticked = tick();
    await downloading;

    await stopCatalogMirrorRefresh();

    expect(schedulerService.listJobs().map((job) => job.id)).toEqual([]);
    const report = await service.verify();
    expect(report.status.status).toBe('error');
    expect(report.status.ready).toBe(true);
    expect(report.status.checkpoint).toBe(FIRST_BUILD.toISOString());
    expect(report.rows).toBe(SAMPLE_IDS.length);
    await expect(ticked).resolves.toBeUndefined();
  });

  it('skips a tick while another sync of the same store holds the lock', async () => {
    const tick = await startCron();
    mirror.serve('catalog-sample-updated.tar.bz2', SECOND_BUILD);
    mirror.throttle(true);
    /** A `mirror refresh` run in another process, holding the store's sync lock. */
    const other = makeService();
    const stopOther = new AbortController();
    const downloading = mirror.nextGet();
    const holding = other.runSync({ mode: 'refresh', signal: stopOther.signal });
    try {
      await downloading;
      await expect(tick()).resolves.toBeUndefined();
    } finally {
      stopOther.abort();
      await expect(holding).rejects.toThrow();
      await other.close();
    }
  });
});
