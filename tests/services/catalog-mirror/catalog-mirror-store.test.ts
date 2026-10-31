/**
 * @fileoverview Tests for the mirror row mapping — the boundary a record crosses twice
 * on every mirror-served response. A field lost or reshaped here is a field the mirror
 * path returns differently from the live path, so the round trip is asserted against
 * real parsed records rather than hand-built ones.
 * @module tests/services/catalog-mirror/catalog-mirror-store.test
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SyncState, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it } from 'vitest';
import { CatalogMirrorService } from '@/services/catalog-mirror/catalog-mirror-service.js';
import {
  bookFromRow,
  CATALOG_FTS_COLUMNS,
  catalogStoreSpec,
  rowFromBook,
} from '@/services/catalog-mirror/catalog-mirror-store.js';
import { parseBookRdf } from '@/services/catalog-mirror/rdf-book-parser.js';
import type { Book } from '@/services/gutendex/types.js';

const RDF_DIR = new URL('../../fixtures/catalog-mirror/rdf/', import.meta.url);

function parse(id: number): Book {
  const book = parseBookRdf(readFileSync(new URL(`pg${id}.rdf`, RDF_DIR), 'utf8'), id);
  if (book === null) throw new Error(`Fixture pg${id}.rdf carries no ebook element.`);
  return book;
}

describe('catalogStoreSpec', () => {
  it('backfills Unicode search columns across multiple legacy batches without a harvest', async () => {
    const dir = mkdtempSync(
      join(process.env.GUTENBERG_TEST_SCRATCH ?? tmpdir(), 'gutenberg-discovery-migration-'),
    );
    const path = join(dir, 'legacy.sqlite');
    const spec = catalogStoreSpec(path);
    const folded = ['title_folded', 'authors_folded', 'subjects_folded', 'bookshelves_folded'];
    for (const column of folded) delete spec.columns[column];
    const old = sqliteMirrorStore({ ...spec, version: 2, migrations: [] });
    try {
      const row = {
        ...rowFromBook({
          ...parse(84),
          title: 'ÉLÉPHANT % _',
          authors: [{ name: 'ÅNGSTRÖM', birth_year: null, death_year: 1900 }],
          subjects: ['ÉTUDES'],
          bookshelves: ['Über Bücher'],
        }),
      };
      for (const column of folded) delete row[column];
      await old.applyBatch(
        Array.from({ length: 1001 }, (_, i) => ({ ...row, id: i + 1 })),
        [],
      );
      await old.writeState({
        status: 'complete',
        completedAt: '2026-10-01T00:00:00.000Z',
        total: 1001,
      });
    } finally {
      await old.close();
    }
    const upgraded = sqliteMirrorStore(catalogStoreSpec(path));
    try {
      const db = await upgraded.raw();
      const rows = db
        .prepare<{
          id: number;
          title_folded: string;
          authors_folded: string;
          subjects_folded: string;
          bookshelves_folded: string;
        }>(
          'SELECT id,title_folded,authors_folded,subjects_folded,bookshelves_folded FROM books ORDER BY id',
        )
        .all();
      expect(rows).toHaveLength(1001);
      for (const row of rows)
        expect(row).toMatchObject({
          title_folded: 'éléphant % _',
          authors_folded: '["ångström"]',
          subjects_folded: '["études"]',
          bookshelves_folded: '["über bücher"]',
        });
      expect((await upgraded.readState()).completedAt).toBe('2026-10-01T00:00:00.000Z');
      expect((await upgraded.integrityCheck()).ok).toBe(true);
      expect((await upgraded.query({ match: 'ÉLÉPHANT', limit: 1, offset: 0 })).total).toBe(1001);
      await upgraded.applyBatch(
        [
          rowFromBook({
            ...parse(84),
            id: 1001,
            title: 'Renamed Ωμέγα',
            authors: [{ name: 'Newauthor', birth_year: null, death_year: null }],
          }),
        ],
        [],
      );
      expect((await upgraded.query({ match: 'ÉLÉPHANT', limit: 1, offset: 0 })).total).toBe(1000);
      expect((await upgraded.query({ match: 'Ωμέγα', limit: 1, offset: 0 })).total).toBe(1);
      expect((await upgraded.query({ match: 'Newauthor', limit: 1, offset: 0 })).total).toBe(1);
    } finally {
      await upgraded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('schema v4 translator backfill', () => {
    /** One past the migration's 500-row batch, so the backfill takes a second read. */
    const TRANSLATED_ROWS = 501;
    const UNTRANSLATED_ROWS = 3;
    const TOTAL_ROWS = TRANSLATED_ROWS + UNTRANSLATED_ROWS;
    const scratch = (name: string) =>
      mkdtempSync(join(process.env.GUTENBERG_TEST_SCRATCH ?? tmpdir(), name));

    const record: Book = {
      ...parse(84),
      subjects: [],
      bookshelves: [],
      summaries: [],
      formats: {},
    };

    /** A stored row as schema v3 wrote it, with no folded translator column. */
    function v3Row(id: number, translators: Book['translators'], title = `Book ${id}`) {
      const row = rowFromBook({ ...record, id, title, translators });
      delete row.translators_folded;
      return row;
    }

    /** A store at schema v3: declared without the column, with no migration pending. */
    function v3Store(path: string) {
      const spec = catalogStoreSpec(path);
      delete spec.columns.translators_folded;
      return sqliteMirrorStore({ ...spec, version: 3, migrations: [] });
    }

    const columnNames = async (store: ReturnType<typeof sqliteMirrorStore>) =>
      (await store.raw())
        .prepare<{ name: string }>('PRAGMA table_info(books)')
        .all()
        .map((column) => column.name);

    const updateTrigger = async (store: ReturnType<typeof sqliteMirrorStore>) =>
      (await store.raw())
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='books_au'")
        .all();

    async function writeV3(path: string, state: SyncState) {
      const v3 = v3Store(path);
      try {
        expect(await columnNames(v3)).not.toContain('translators_folded');
        await v3.applyBatch(
          [
            ...Array.from({ length: TRANSLATED_ROWS }, (_, i) =>
              v3Row(i + 1, [
                { name: 'GRENIER, Édouard', birth_year: 1819, death_year: 1901 },
                { name: 'Maude, Louise', birth_year: 1855, death_year: 1939 },
              ]),
            ),
            ...Array.from({ length: UNTRANSLATED_ROWS }, (_, i) =>
              v3Row(TRANSLATED_ROWS + i + 1, []),
            ),
          ],
          [],
        );
        await v3.writeState(state);
        return await v3.readState();
      } finally {
        await v3.close();
      }
    }

    it.each([
      [
        'a complete mirror',
        {
          status: 'complete',
          completedAt: '2026-10-01T00:00:00.000Z',
          checkpoint: '2026-09-30T14:35:59.000Z',
          total: TOTAL_ROWS,
        },
        true,
      ],
      [
        'an interrupted harvest',
        { status: 'error', cursor: 'stamp|4000', checkpoint: 'earlier stamp', total: TOTAL_ROWS },
        false,
      ],
    ] as const)(
      'upgrades %s without a harvest, keeping its sync state and readiness',
      async (_name, state, ready) => {
        const dir = scratch('gutenberg-translator-backfill-');
        const path = join(dir, 'v3.sqlite');
        const before = await writeV3(path, state);
        const service = new CatalogMirrorService({
          gutendexBaseUrl: 'https://catalog.test/books/',
          gutenbergTextBaseUrl: 'https://mirror.test',
          mirrorPath: path,
        });
        try {
          expect(await service.ready()).toBe(ready);
          const { store } = service.mirror;
          const db = await service.mirror.raw();
          expect(
            db
              .prepare<{ rows: number; folded: number }>(
                'SELECT count(*) AS rows, count(translators_folded) AS folded FROM books',
              )
              .get(),
          ).toEqual({ rows: TOTAL_ROWS, folded: TRANSLATED_ROWS });
          expect(
            db
              .prepare<{ translators_folded: string }>(
                'SELECT DISTINCT translators_folded FROM books WHERE translators_folded IS NOT NULL',
              )
              .all(),
          ).toEqual([{ translators_folded: '["grenier, édouard","maude, louise"]' }]);
          expect(await store.readState()).toEqual(before);
          expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 4 }]);
          expect((await store.integrityCheck()).ok).toBe(true);

          for (const translator of ['ÉDOUARD', 'louise grenier']) {
            const found = await service.searchBooks({ translator });
            expect(found.total).toBe(TRANSLATED_ROWS);
            expect(found.books[0]?.translators).toHaveLength(2);
          }
          expect(
            (await service.searchBooks({ translator: 'maude', ids: [TOTAL_ROWS] })).total,
          ).toBe(0);

          /** The suspended FTS trigger is back: a later write reaches the index. */
          expect(await updateTrigger(store)).toHaveLength(1);
          expect((await store.query({ match: 'Book', limit: 1, offset: 0 })).total).toBe(
            TOTAL_ROWS,
          );
          await store.applyBatch(
            [
              rowFromBook({
                ...parse(84),
                id: 1,
                title: 'Renamed Ωμέγα',
                translators: [{ name: 'Nouveau', birth_year: null, death_year: null }],
              }),
            ],
            [],
          );
          expect((await store.query({ match: 'Ωμέγα', limit: 1, offset: 0 })).total).toBe(1);
          expect((await service.searchBooks({ translator: 'nouveau' })).total).toBe(1);
        } finally {
          await service.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it('rolls the column back and restores the FTS trigger when the backfill fails', async () => {
      const dir = scratch('gutenberg-translator-rollback-');
      const path = join(dir, 'v3.sqlite');
      const v3 = v3Store(path);
      await v3.applyBatch(
        [
          v3Row(1, [{ name: 'Good', birth_year: null, death_year: null }]),
          { ...v3Row(2, []), translators: 'not-json' },
        ],
        [],
      );
      await v3.close();
      const failing = sqliteMirrorStore(catalogStoreSpec(path));
      await expect(failing.raw()).rejects.toThrow();
      await failing.close();
      const recovered = v3Store(path);
      try {
        expect(await columnNames(recovered)).not.toContain('translators_folded');
        expect(await updateTrigger(recovered)).toHaveLength(1);
        expect(await recovered.count()).toBe(2);
        await recovered.applyBatch([v3Row(1, [], 'Renamed')], []);
        expect((await recovered.query({ match: 'renamed', limit: 1, offset: 0 })).total).toBe(1);
      } finally {
        await recovered.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates the column on a fresh database, which needs no backfill', async () => {
      const dir = scratch('gutenberg-translator-fresh-');
      const store = sqliteMirrorStore(catalogStoreSpec(join(dir, 'fresh.sqlite')));
      try {
        expect(await columnNames(store)).toContain('translators_folded');
        const db = await store.raw();
        expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([{ version: 4 }]);
        expect(await updateTrigger(store)).toHaveLength(1);
        await store.applyBatch([rowFromBook(parse(1399))], []);
        const { rows } = await store.query({ limit: 1, offset: 0 });
        expect(rows[0]?.translators_folded).toBe('["garnett, constance"]');
      } finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('rolls back derived columns and restores FTS triggers when a backfill fails', async () => {
    const dir = mkdtempSync(
      join(process.env.GUTENBERG_TEST_SCRATCH ?? tmpdir(), 'gutenberg-discovery-rollback-'),
    );
    const path = join(dir, 'legacy.sqlite');
    const spec = catalogStoreSpec(path);
    const folded = ['title_folded', 'authors_folded', 'subjects_folded', 'bookshelves_folded'];
    for (const column of folded) delete spec.columns[column];
    const row = { ...rowFromBook(parse(84)) };
    for (const column of folded) delete row[column];
    const old = sqliteMirrorStore({ ...spec, version: 2, migrations: [] });
    await old.applyBatch([{ ...row, authors: 'not-json' }], []);
    await old.close();
    const failing = sqliteMirrorStore(catalogStoreSpec(path));
    await expect(failing.raw()).rejects.toThrow();
    await failing.close();
    const recovered = sqliteMirrorStore({ ...spec, version: 2, migrations: [] });
    try {
      const db = await recovered.raw();
      expect(
        db
          .prepare<{ name: string }>('PRAGMA table_info(books)')
          .all()
          .map((column) => column.name),
      ).not.toContain('title_folded');
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='books_au'").all(),
      ).toHaveLength(1);
      await recovered.applyBatch([{ ...row, title: 'Recovered updated title' }], []);
      expect((await recovered.query({ match: 'Recovered', limit: 1, offset: 0 })).total).toBe(1);
    } finally {
      await recovered.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('migrates an existing database without a harvest and safely creates fresh databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gutenberg-notes-migration-'));
    try {
      for (const legacy of [true, false]) {
        const path = join(dir, `${legacy ? 'legacy' : 'fresh'}.sqlite`);
        if (legacy) {
          const spec = catalogStoreSpec(path);
          delete spec.columns.source_notes;
          const old = sqliteMirrorStore({ ...spec, version: 1, migrations: [] });
          try {
            const row = rowFromBook(parse(84));
            delete row.source_notes;
            await old.applyBatch([row], []);
          } finally {
            await old.close();
          }
        }
        const store = sqliteMirrorStore(catalogStoreSpec(path));
        try {
          if (legacy) {
            const {
              rows: [row],
            } = await store.query({
              filters: [{ column: 'id', op: 'eq', value: 84 }],
              limit: 1,
              offset: 0,
            });
            expect(row).toBeDefined();
            expect(bookFromRow(row ?? {}).source_notes).toBeNull();
            expect(bookFromRow(row ?? {}).is_readable).toBe(true);
            expect(
              (await store.query({ match: 'Frankenstein', limit: 10, offset: 0 })).rows,
            ).toHaveLength(1);
          }
          const refreshed = { ...parse(84), source_notes: ['Édition #42324', '1818 #41445'] };
          await store.applyBatch([rowFromBook(refreshed)], []);
          expect((await store.query({ limit: 1, offset: 0 })).rows.map(bookFromRow)).toEqual([
            refreshed,
          ]);
          expect(await store.count()).toBe(1);
        } finally {
          await store.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('indexes only declared columns', () => {
    const spec = catalogStoreSpec(':memory:');
    const columns = Object.keys(spec.columns);
    for (const column of spec.fts ?? []) expect(columns).toContain(column);
    for (const index of spec.indexes ?? []) {
      for (const column of index.columns) expect(columns).toContain(column);
    }
    expect(columns).toContain(spec.primaryKey);
  });

  it('covers every field gutenberg_search_books matches on', () => {
    /** `query` hits title and author name; `topic` hits subject and bookshelf. */
    expect(CATALOG_FTS_COLUMNS).toEqual([
      'title',
      'authors_text',
      'subjects_text',
      'bookshelves_text',
      'languages_text',
    ]);
  });

  it('indexes download_count so popularity ordering does not scan', () => {
    expect(catalogStoreSpec(':memory:').indexes).toEqual([{ columns: ['download_count'] }]);
  });
});

describe('rowFromBook / bookFromRow', () => {
  it('derives readability from legacy formats without requiring a harvest', () => {
    const legacy = {
      ...rowFromBook(parse(84)),
      formats: JSON.stringify({ 'text/html': 'https://example/book.html' }),
      has_plain_text: 0,
    };
    expect(bookFromRow(legacy)).toMatchObject({ is_readable: true, has_plain_text: false });
  });

  it('distinguishes unavailable legacy notes, inspected empty notes, and Unicode notes in order', () => {
    const book = parse(84);
    const legacy = { ...rowFromBook(book) };
    delete legacy.source_notes;
    expect(bookFromRow(legacy).source_notes).toBeNull();
    for (const source_notes of [null, [], ['Édition #42324', 'First #41445']]) {
      expect(bookFromRow(rowFromBook({ ...book, source_notes })).source_notes).toEqual(
        source_notes,
      );
    }
  });
  it.each([84, 1073, 1399, 10056, 10137, 45304])(
    'round-trips book %i without losing a field',
    (id) => {
      const book = parse(id);
      expect(bookFromRow(rowFromBook(book))).toEqual(book);
    },
  );

  it('flattens the searchable lists into plain text, values only', () => {
    const row = rowFromBook(parse(10056));
    expect(row.authors_text).toBe('Confucius\nFaxian\nMencius');
    expect(row.subjects_text.split('\n')).toEqual(parse(10056).subjects);
    expect(row.languages_text).toBe('en');
  });

  it('folds translator names for the filter, and stores an empty list for none', () => {
    expect(rowFromBook(parse(1399)).translators_folded).toBe('["garnett, constance"]');
    expect(rowFromBook(parse(84)).translators_folded).toBe('[]');
    const book = {
      ...parse(84),
      translators: [
        { name: 'Grenier, Édouard', birth_year: 1819, death_year: 1901 },
        { name: 'ΟΣΑΣ', birth_year: null, death_year: null },
      ],
    };
    expect(rowFromBook(book).translators_folded).toBe('["grenier, édouard","οσασ"]');
    expect(bookFromRow(rowFromBook(book))).toEqual(book);
  });

  it('reduces author lifespans to the range the year filters compare against', () => {
    /** Confucius (-551/-479), Faxian (unknown), Mencius (-385/-289). */
    const row = rowFromBook(parse(10056));
    expect(row.author_birth_min).toBe(-551);
    expect(row.author_birth_max).toBe(-385);
    expect(row.author_death_min).toBe(-479);
    expect(row.author_death_max).toBe(-289);
  });

  it('leaves the lifespan range null when no author has a known year', () => {
    const row = rowFromBook(parse(1073));
    expect(row.author_birth_min).toBeNull();
    expect(row.author_birth_max).toBeNull();
    expect(row.author_death_min).toBeNull();
    expect(row.author_death_max).toBeNull();
  });

  it('stores copyright as a tri-state, keeping unknown distinct from false', () => {
    const book = parse(84);
    expect(rowFromBook({ ...book, copyright: false }).copyright).toBe(0);
    expect(rowFromBook({ ...book, copyright: true }).copyright).toBe(1);
    expect(rowFromBook({ ...book, copyright: null }).copyright).toBeNull();
    expect(bookFromRow(rowFromBook({ ...book, copyright: null })).copyright).toBeNull();
    expect(bookFromRow(rowFromBook({ ...book, copyright: true })).copyright).toBe(true);
  });

  it('stores has_plain_text as a filterable flag matching the record', () => {
    expect(rowFromBook(parse(84)).has_plain_text).toBe(1);
    expect(rowFromBook(parse(10137)).has_plain_text).toBe(0);
  });

  it('only ever writes SQLite-storable values', () => {
    for (const value of Object.values(rowFromBook(parse(84)))) {
      expect(['string', 'number', 'object']).toContain(typeof value);
      if (typeof value === 'object') expect(value).toBeNull();
    }
  });
});
