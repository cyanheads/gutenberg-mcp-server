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
import { type Book, foldSearchText, isReadable, type Person } from '@/services/gutendex/types.js';

/** Primary table holding one row per Gutenberg book. */
export const CATALOG_TABLE = 'books';

/**
 * Columns retained for generic FTS queries. Discovery uses the separate Unicode-
 * folded columns to preserve literal substring semantics rather than FTS tokens.
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
  authors_folded: string;
  /** Flattened author names, for FTS. */
  authors_text: string;
  /** JSON `string[]`. */
  bookshelves: string;
  bookshelves_folded: string;
  bookshelves_text: string;
  /** 1 = copyrighted, 0 = public domain, null = unknown. */
  copyright: number | null;
  download_count: number;
  /** JSON `Person[]`. */
  editors: string;
  /** JSON `Record<string, string>` of MIME type → URL. */
  formats: string;
  /** 1 for Text records with a UTF-8 plain-text format, else 0. */
  has_plain_text: number;
  id: number;
  /** JSON `string[]`. */
  languages: string;
  languages_text: string;
  media_type: string;
  /** JSON notes, or null for rows whose source notes were unavailable. */
  source_notes?: string | null;
  /** JSON `string[]`. */
  subjects: string;
  subjects_folded: string;
  subjects_text: string;
  /** JSON `string[]`. */
  summaries: string;
  title: string;
  title_folded: string;
  /** JSON `Person[]`. */
  translators: string;
  /** JSON folded names; `[]` or, on a row the v4 backfill skipped, null: neither matches. */
  translators_folded?: string | null;
}

/**
 * Store spec for the catalog mirror.
 *
 * The `download_count` index backs `gutenberg_browse_popular` and the default
 * `sort: 'popular'` ordering, which are the only ordered scans over the whole table.
 * The four `author_*` columns collapse one author-lifespan bound — an OR over every
 * author of a book — into scalar comparisons a single row can answer. Two bounds need
 * one author to meet both, so `searchBooks` also reads `authors` for that case.
 */
export function catalogStoreSpec(path: string): SqliteMirrorStoreSpec {
  return {
    path,
    table: CATALOG_TABLE,
    primaryKey: 'id',
    version: 4,
    migrations: [
      {
        version: 2,
        up(db) {
          const columns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[];
          if (!columns.some((column) => column.name === 'source_notes'))
            db.exec('ALTER TABLE books ADD COLUMN source_notes TEXT');
        },
      },
      {
        version: 3,
        up(db) {
          /**
           * Folded-only writes do not change FTS content. Suspend its UPDATE
           * trigger inside the migration transaction to avoid rebuilding every
           * indexed record; rollback restores the trigger if backfill fails.
           */
          const { sql: updateTrigger } = db
            .prepare<{ sql: string }>(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='books_au'",
            )
            .get() as { sql: string };
          db.exec('DROP TRIGGER books_au');
          const columns = db.prepare<{ name: string }>('PRAGMA table_info(books)').all();
          for (const name of [
            'title_folded',
            'authors_folded',
            'subjects_folded',
            'bookshelves_folded',
          ]) {
            if (!columns.some((column) => column.name === name))
              db.exec(`ALTER TABLE books ADD COLUMN ${name} TEXT`);
          }
          const read = db.prepare<CatalogBookRow>(
            'SELECT id, title, authors, subjects, bookshelves FROM books WHERE id > ? ORDER BY id LIMIT 500',
          );
          const write = db.prepare(
            'UPDATE books SET title_folded=?, authors_folded=?, subjects_folded=?, bookshelves_folded=? WHERE id=?',
          );
          let after = 0;
          for (;;) {
            const rows = read.all(after);
            if (rows.length === 0) break;
            for (const row of rows) {
              const folded = foldedFields(
                row.title,
                JSON.parse(row.authors) as Person[],
                JSON.parse(row.subjects) as string[],
                JSON.parse(row.bookshelves) as string[],
              );
              write.run(
                folded.title_folded,
                folded.authors_folded,
                folded.subjects_folded,
                folded.bookshelves_folded,
                row.id,
              );
              after = row.id;
            }
          }
          db.exec(updateTrigger);
        },
      },
      {
        version: 4,
        up(db) {
          /**
           * Same FTS suspension as v3. A null column matches no translator filter, so
           * only rows that list a translator are written, and the harvest fills `[]`
           * on the rest as it rewrites them.
           */
          const { sql: updateTrigger } = db
            .prepare<{ sql: string }>(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='books_au'",
            )
            .get() as { sql: string };
          db.exec('DROP TRIGGER books_au');
          const columns = db.prepare<{ name: string }>('PRAGMA table_info(books)').all();
          if (!columns.some((column) => column.name === 'translators_folded'))
            db.exec('ALTER TABLE books ADD COLUMN translators_folded TEXT');
          const read = db.prepare<Pick<CatalogBookRow, 'id' | 'translators'>>(
            "SELECT id, translators FROM books WHERE id > ? AND translators <> '[]' ORDER BY id LIMIT 500",
          );
          const write = db.prepare('UPDATE books SET translators_folded=? WHERE id=?');
          let after = 0;
          for (;;) {
            const rows = read.all(after);
            if (rows.length === 0) break;
            for (const row of rows) {
              write.run(foldedNames(JSON.parse(row.translators) as Person[]), row.id);
              after = row.id;
            }
          }
          db.exec(updateTrigger);
        },
      },
    ],
    columns: {
      id: 'INTEGER',
      title: 'TEXT NOT NULL',
      title_folded: 'TEXT',
      authors_folded: 'TEXT',
      subjects_folded: 'TEXT',
      bookshelves_folded: 'TEXT',
      translators_folded: 'TEXT',
      authors: 'TEXT NOT NULL',
      translators: 'TEXT NOT NULL',
      editors: 'TEXT NOT NULL',
      subjects: 'TEXT NOT NULL',
      bookshelves: 'TEXT NOT NULL',
      languages: 'TEXT NOT NULL',
      summaries: 'TEXT NOT NULL',
      source_notes: 'TEXT',
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

/** A people list's folded names, as JSON. */
function foldedNames(people: Person[]): string {
  return JSON.stringify(people.map((person) => foldSearchText(person.name)));
}

/** Unicode case conversion is done at ingest, since SQLite LOWER only folds ASCII. */
function foldedFields(title: string, authors: Person[], subjects: string[], bookshelves: string[]) {
  return {
    title_folded: foldSearchText(title),
    authors_folded: foldedNames(authors),
    subjects_folded: JSON.stringify(subjects.map(foldSearchText)),
    bookshelves_folded: JSON.stringify(bookshelves.map(foldSearchText)),
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
    ...foldedFields(book.title, book.authors, book.subjects, book.bookshelves),
    translators_folded: foldedNames(book.translators),
    id: book.id,
    title: book.title,
    authors: JSON.stringify(book.authors),
    translators: JSON.stringify(book.translators),
    editors: JSON.stringify(book.editors),
    subjects: JSON.stringify(book.subjects),
    bookshelves: JSON.stringify(book.bookshelves),
    languages: JSON.stringify(book.languages),
    summaries: JSON.stringify(book.summaries),
    source_notes: book.source_notes === null ? null : JSON.stringify(book.source_notes),
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
  const formats = parseJson<Record<string, string>>(row.formats);
  const media_type = String(row.media_type);
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
    media_type,
    download_count: Number(row.download_count),
    summaries,
    summary: summaries[0] ?? null,
    source_notes: row.source_notes == null ? null : parseJson<string[]>(row.source_notes),
    formats,
    is_readable: isReadable({ media_type, formats }),
    has_plain_text: Boolean(row.has_plain_text),
  };
}
