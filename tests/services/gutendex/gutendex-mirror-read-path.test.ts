/**
 * @fileoverview Tests the catalog-mirror read path on `GutendexService.getBook`: a
 * populated mirror answers without any upstream call, and a mirror that does not hold
 * the ID — or is not ready — falls through to the book's own RDF record on the content
 * mirror, never to Gutendex. The mirror is harvested for real from a loopback archive,
 * so a hit proves the stored row round-trips back into a `Book`, and the RDF path is
 * checked field for field against the row harvested from the same file.
 * @module tests/services/gutendex/gutendex-mirror-read-path.test
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { gutenbergGetBook } from '@/mcp-server/tools/definitions/gutenberg-get-book.tool.js';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import {
  type CatalogMirrorService,
  initCatalogMirrorService,
} from '@/services/catalog-mirror/catalog-mirror-service.js';
import { GutendexService } from '@/services/gutendex/gutendex-service.js';
import { type ArchiveServer, startArchiveServer } from '../catalog-mirror/archive-server.js';

const ARCHIVE_BUILD = new Date('2026-08-21T14:40:50Z');
const CATALOG_BASE = 'https://catalog.test/books/';
/** Present in `catalog-sample.tar.bz2`; 45304 is the fixture carrying an editor. */
const MIRRORED_ID = 45304;
/** Absent from the sample archive — posted after its build, the staleness case. */
const UNMIRRORED_ID = 79964;
/** The sample archive's translated record: Anna Karenina, translated by Constance Garnett. */
const TRANSLATED_ID = 1399;
/** Every record in `catalog-sample.tar.bz2`, each also committed as `rdf/pg<id>.rdf`. */
const ARCHIVED_IDS = [84, 1000, 1073, 1399, 10001, 10056, 10137, 45304];
const RDF_DIR = new URL('../../fixtures/catalog-mirror/rdf/', import.meta.url);

/** Where a lookup the mirror cannot answer reads the book's RDF on the content mirror. */
function rdfUrl(id: number): string {
  return `${archive.baseUrl}/cache/epub/${id}/pg${id}.rdf`;
}

/** The committed copy of one per-book RDF document. */
function readRdf(id: number): string {
  return readFileSync(new URL(`pg${id}.rdf`, RDF_DIR), 'utf8');
}

let archive: ArchiveServer;
let workDir: string;
let mirror: CatalogMirrorService;
let http: FetchMockHarness;

function makeGutendex(): GutendexService {
  return new GutendexService({} as AppConfig, createInMemoryStorage(), {
    gutendexBaseUrl: CATALOG_BASE,
    gutenbergTextBaseUrl: archive.baseUrl,
    mirrorPath: join(workDir, 'catalog.sqlite'),
  });
}

beforeEach(async () => {
  archive = await startArchiveServer('catalog-sample.tar.bz2', ARCHIVE_BUILD);
  workDir = mkdtempSync(join(tmpdir(), 'gutenberg-readpath-'));
  const config: ServerConfig = {
    gutendexBaseUrl: CATALOG_BASE,
    gutenbergTextBaseUrl: archive.baseUrl,
    mirrorPath: join(workDir, 'catalog.sqlite'),
  };
  mirror = initCatalogMirrorService(config);
  await mirror.runSync({ mode: 'init' });
  http = createFetchMock();
  http.install();
});

afterEach(async () => {
  http.restore();
  await mirror.close();
  await archive.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('GutendexService.getBook — catalog mirror read path', () => {
  it('serves a mirrored book without calling the live catalog', async () => {
    /** No route registered: any upstream call fails the strict harness. */
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeGutendex().getBook(MIRRORED_ID, ctx);

    expect(book.id).toBe(MIRRORED_ID);
    expect(book.title).not.toBe('');
    expect(book.editors.length).toBeGreaterThan(0);
    expect(http.calls).toHaveLength(0);
  });

  it("falls through to the book's RDF on the content mirror for an ID the mirror does not hold", async () => {
    http.route({
      match: rdfUrl(UNMIRRORED_ID),
      respond: () => new Response(readRdf(UNMIRRORED_ID)),
    });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeGutendex().getBook(UNMIRRORED_ID, ctx);

    expect(book).toMatchObject({ id: UNMIRRORED_ID, title: 'Mothers still', source_notes: [] });
    expect(http.calls.map((call) => call.request.url)).toEqual([rdfUrl(UNMIRRORED_ID)]);
  });

  it('answers an ID the content mirror has no record for as not_found, with no Gutendex request', async () => {
    http.route({
      match: rdfUrl(99999999),
      respond: () => new Response('<html>404 Not Found</html>', { status: 404 }),
    });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const error = await makeGutendex()
      .getBook(99999999, ctx)
      .catch((err: unknown) => err);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(http.calls.map((call) => call.request.url)).toEqual([rdfUrl(99999999)]);
  });

  it.each(ARCHIVED_IDS)(
    'reads %i from its RDF exactly as the mirror row harvested from the same file',
    async (id) => {
      const gutendex = makeGutendex();
      const fromMirror = await gutendex.getBook(id, createMockContext());
      expect(http.calls).toHaveLength(0);

      /** A store that never completed a sync is not ready, so every lookup reads the RDF. */
      const cold = initCatalogMirrorService({
        gutendexBaseUrl: CATALOG_BASE,
        gutenbergTextBaseUrl: archive.baseUrl,
        mirrorPath: join(workDir, 'cold.sqlite'),
      });
      try {
        http.route({ match: rdfUrl(id), respond: () => new Response(readRdf(id)) });
        const fromRecord = await gutendex.getBook(id, createMockContext());
        expect(http.calls.map((call) => call.request.url)).toEqual([rdfUrl(id)]);
        expect(fromRecord).toEqual(fromMirror);
      } finally {
        await cold.close();
      }
    },
  );
});

describe('GutendexService.searchBooks — harvested translators', () => {
  it('finds a translator the harvest ingested, without calling the live catalog', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const found = await makeGutendex().searchBooks({ translator: 'CONSTANCE garnett' }, ctx);

    expect(found.books.map((book) => book.id)).toEqual([TRANSLATED_ID]);
    expect(found).toMatchObject({ totalCount: 1, source: 'mirror' });
    expect(found.books[0]?.translators.map((person) => person.name)).toEqual([
      'Garnett, Constance',
    ]);
    expect(http.calls).toHaveLength(0);
  });

  it('matches no translator on the sample records that list none', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const missed = await makeGutendex().searchBooks({ translator: 'shelley' }, ctx);

    expect(missed).toMatchObject({ books: [], totalCount: 0, source: 'mirror' });
    expect(http.calls).toHaveLength(0);
  });
});
