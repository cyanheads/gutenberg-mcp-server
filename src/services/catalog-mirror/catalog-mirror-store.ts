/**
 * @fileoverview Schema and row mapping for the local Gutendex catalog mirror. Holds
 * the SQLite column declaration, the FTS5 index over the fields
 * `gutenberg_search_books` matches on, and the two-way translation between a
 * normalized {@link Book} and one stored row.
 *
 * Structured fields (people, string lists, the formats map) are stored as JSON so a
 * hydrated row is byte-identical to the live record. The FTS index cannot search JSON
 * without indexing its keys and punctuation as terms, so each searchable list also
 * gets a flattened text column that carries only the values.
 * @module services/catalog-mirror/catalog-mirror-store
 */

import type { MirrorRow, SqliteMirrorStoreSpec } from '@cyanheads/mcp-ts-core/mirror';
import type { Book, Person } from '@/services/gutendex/types.js';

/** Primary table holding one row per Gutenberg book. */
export const CATALOG_TABLE = 'books';

/**
 * Columns the FTS5 index covers. `gutenberg_search_books` matches its `query` against
 * title and author name and its `topic` against subject and bookshelf, mirroring
 * Gutendex's own filters; `languages_text` joins them so a language filter is served
 * by the same index instead of a table scan.
 */
export const CATALOG_FTS_COLUMNS = [
  'title',
  'authors_text',
  'subjects_text',
  'bookshelves_text',
  'languages_text',
] as const;

/** Separator joining a list's values in a flattened FTS column. */
const FLATTEN_SEPARATOR = '\n';

/** One stored catalog row. */
export interface CatalogBookRow extends MirrorRow {
  author_birth_max: number | null;
  author_birth_min: number | null;
  author_death_max: number | null;
  author_death_min: number | null;
  /** JSON `Person[]`. */
  authors: string;
  /** Flattened author names, for FTS. */
  authors_text: string;
  /** JSON `string[]`. */
  bookshelves: string;
  bookshelves_text: string;
  /** 1 = copyrighted, 0 = public domain, null = unknown. */
  copyright: number | null;
  download_count: number;
  /** JSON `Person[]`. */
  editors: string;
  /** JSON `Record<string, string>` of MIME type → URL. */
  formats: string;
  /** 1 when `gutenberg_get_text` can serve this book, else 0. */
  has_plain_text: number;
  id: number;
  /** JSON `string[]`. */
  languages: string;
  languages_text: string;
  media_type: string;
  /** JSON `string[]`. */
  subjects: string;
  subjects_text: string;
  /** JSON `string[]`. */
  summaries: string;
  title: string;
}

/**
 * Store spec for the catalog mirror.
 *
 * The `download_count` index backs `gutenberg_browse_popular` and the default
 * `sort: 'popular'` ordering, which are the only ordered scans over the whole table.
 * The four `author_*` columns collapse Gutendex's author-lifespan filter — which is an
 * OR over every author of a book — into scalar comparisons a single row can answer.
 */
export function catalogStoreSpec(path: string): SqliteMirrorStoreSpec {
  return {
    path,
    table: CATALOG_TABLE,
    primaryKey: 'id',
    columns: {
      id: 'INTEGER',
      title: 'TEXT NOT NULL',
      authors: 'TEXT NOT NULL',
      translators: 'TEXT NOT NULL',
      editors: 'TEXT NOT NULL',
      subjects: 'TEXT NOT NULL',
      bookshelves: 'TEXT NOT NULL',
      languages: 'TEXT NOT NULL',
      summaries: 'TEXT NOT NULL',
      formats: 'TEXT NOT NULL',
      copyright: 'INTEGER',
      media_type: 'TEXT NOT NULL',
      download_count: 'INTEGER NOT NULL',
      has_plain_text: 'INTEGER NOT NULL',
      authors_text: 'TEXT NOT NULL',
      subjects_text: 'TEXT NOT NULL',
      bookshelves_text: 'TEXT NOT NULL',
      languages_text: 'TEXT NOT NULL',
      author_birth_min: 'INTEGER',
      author_birth_max: 'INTEGER',
      author_death_min: 'INTEGER',
      author_death_max: 'INTEGER',
    },
    fts: [...CATALOG_FTS_COLUMNS],
    indexes: [{ columns: ['download_count'] }],
  };
}

/** Smallest and largest known value of one lifespan field across a book's authors. */
function lifespanRange(
  authors: Person[],
  field: 'birth_year' | 'death_year',
): { min: number | null; max: number | null } {
  const years = authors
    .map((author) => author[field])
    .filter((year): year is number => year !== null);
  if (years.length === 0) return { min: null, max: null };
  return { min: Math.min(...years), max: Math.max(...years) };
}

/** Translate a normalized book into its stored row. */
export function rowFromBook(book: Book): CatalogBookRow {
  const birth = lifespanRange(book.authors, 'birth_year');
  const death = lifespanRange(book.authors, 'death_year');
  return {
    id: book.id,
    title: book.title,
    authors: JSON.stringify(book.authors),
    translators: JSON.stringify(book.translators),
    editors: JSON.stringify(book.editors),
    subjects: JSON.stringify(book.subjects),
    bookshelves: JSON.stringify(book.bookshelves),
    languages: JSON.stringify(book.languages),
    summaries: JSON.stringify(book.summaries),
    formats: JSON.stringify(book.formats),
    copyright: book.copyright === null ? null : Number(book.copyright),
    media_type: book.media_type,
    download_count: book.download_count,
    has_plain_text: Number(book.has_plain_text),
    authors_text: book.authors.map((author) => author.name).join(FLATTEN_SEPARATOR),
    subjects_text: book.subjects.join(FLATTEN_SEPARATOR),
    bookshelves_text: book.bookshelves.join(FLATTEN_SEPARATOR),
    languages_text: book.languages.join(FLATTEN_SEPARATOR),
    author_birth_min: birth.min,
    author_birth_max: birth.max,
    author_death_min: death.min,
    author_death_max: death.max,
  };
}

/** Read a JSON column back into its parsed value. */
function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

/** Translate a stored row back into the normalized book shape the live path returns. */
export function bookFromRow(row: MirrorRow): Book {
  const summaries = parseJson<string[]>(row.summaries);
  return {
    id: Number(row.id),
    title: String(row.title),
    authors: parseJson<Person[]>(row.authors),
    translators: parseJson<Person[]>(row.translators),
    editors: parseJson<Person[]>(row.editors),
    subjects: parseJson<string[]>(row.subjects),
    bookshelves: parseJson<string[]>(row.bookshelves),
    languages: parseJson<string[]>(row.languages),
    copyright: row.copyright === null ? null : Boolean(row.copyright),
    media_type: String(row.media_type),
    download_count: Number(row.download_count),
    summaries,
    summary: summaries[0] ?? null,
    formats: parseJson<Record<string, string>>(row.formats),
    has_plain_text: Boolean(row.has_plain_text),
  };
}
