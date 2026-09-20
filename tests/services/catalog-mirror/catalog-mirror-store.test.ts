/**
 * @fileoverview Tests for the mirror row mapping — the boundary a record crosses twice
 * on every mirror-served response. A field lost or reshaped here is a field the mirror
 * path returns differently from the live path, so the round trip is asserted against
 * real parsed records rather than hand-built ones.
 * @module tests/services/catalog-mirror/catalog-mirror-store.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
