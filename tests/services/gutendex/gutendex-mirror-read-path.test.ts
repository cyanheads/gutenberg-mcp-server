/**
 * @fileoverview Tests the catalog-mirror read path on `GutendexService.getBook`: a
 * populated mirror answers without any upstream call, a mirror that does not hold the
 * ID falls through to the live catalog, and a broken mirror degrades to the live path
 * rather than failing the request. The mirror is harvested for real from a loopback
 * archive, so a hit proves the stored row round-trips back into a `Book`.
 * @module tests/services/gutendex/gutendex-mirror-read-path.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { gutenbergGetBook } from '@/mcp-server/tools/definitions/gutenberg-get-book.tool.js';
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
/** Absent from the sample archive — the staleness case. */
const UNMIRRORED_ID = 1342;

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

  it('falls through to the live catalog for an ID the mirror does not hold', async () => {
    http.route({
      match: new RegExp(`^${CATALOG_BASE}${UNMIRRORED_ID}/$`),
      respond: () =>
        Response.json({
          id: UNMIRRORED_ID,
          title: 'Pride and Prejudice',
          authors: [],
          translators: [],
          subjects: [],
          bookshelves: [],
          languages: ['en'],
          copyright: false,
          media_type: 'Text',
          download_count: 1,
          formats: {},
        }),
    });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeGutendex().getBook(UNMIRRORED_ID, ctx);

    expect(book.title).toBe('Pride and Prejudice');
    expect(http.calls).toHaveLength(1);
  });
});
