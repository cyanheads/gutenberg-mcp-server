/**
 * @fileoverview Schema and row mapping for the local Project Gutenberg catalog mirror. Holds
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
import {
  type Book,
  type Contributor,
  foldCatalogPhrase,
  foldCatalogText,
  isReadable,
  normalizeTitle,
  type Person,
} from '@/services/gutendex/types.js';

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

/** RDF metadata added without a backfill. Old rows remain readable until the next harvest. */
const RDF_METADATA_COLUMNS = {
  alternative_titles: 'TEXT',
  alternatives_folded: 'TEXT',
  author_aliases: 'TEXT',
  author_aliases_folded: 'TEXT',
  author_webpages: 'TEXT',
  contents: 'TEXT',
  contents_folded: 'TEXT',
  contributors: 'TEXT',
  contributors_folded: 'TEXT',
  lcc: 'TEXT',
  reading_ease: 'TEXT',
  release_date: 'TEXT',
  source_imprint: 'TEXT',
} as const;

/** Separator joining a list's values in a flattened FTS column. */
const FLATTEN_SEPARATOR = '\n';

/** One stored catalog row. */
export interface CatalogBookRow
  extends MirrorRow,
    Partial<Record<keyof typeof RDF_METADATA_COLUMNS, string | null>> {
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
    version: 6,
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
      {
        version: 5,
        up(db) {
          const titles = db.prepare<Pick<CatalogBookRow, 'id' | 'title'>>(
            'SELECT id,title FROM books WHERE id > ? ORDER BY id LIMIT 500',
          );
          const writeTitle = db.prepare('UPDATE books SET title=? WHERE id=?');
          let after = 0;
          for (;;) {
            const rows = titles.all(after);
            if (rows.length === 0) break;
            for (const row of rows) {
              const title = normalizeTitle(row.title);
              if (title !== row.title) writeTitle.run(title, row.id);
              after = row.id;
            }
          }
          /** Titles must reach FTS before folded-only writes suspend its UPDATE trigger. */
          const { sql: updateTrigger } = db
            .prepare<{ sql: string }>(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='books_au'",
            )
            .get() as { sql: string };
          db.exec('DROP TRIGGER books_au');
          const read = db.prepare<CatalogBookRow>(
            'SELECT id,title,authors,subjects,bookshelves,translators,translators_folded FROM books WHERE id > ? ORDER BY id LIMIT 500',
          );
          const write = db.prepare(
            'UPDATE books SET title_folded=?,authors_folded=?,subjects_folded=?,bookshelves_folded=?,translators_folded=? WHERE id=?',
          );
          after = 0;
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
                row.translators_folded === null
                  ? null
                  : foldedNames(JSON.parse(row.translators) as Person[]),
                row.id,
              );
              after = row.id;
            }
          }
          db.exec(updateTrigger);
        },
      },
      {
        version: 6,
        up(db) {
          const existing = new Set(
            db
              .prepare<{ name: string }>('PRAGMA table_info(books)')
              .all()
              .map(({ name }) => name),
          );
          for (const [name, type] of Object.entries(RDF_METADATA_COLUMNS)) {
            if (!existing.has(name)) db.exec(`ALTER TABLE books ADD COLUMN ${name} ${type}`);
          }
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
      ...RDF_METADATA_COLUMNS,
    },
    fts: [...CATALOG_FTS_COLUMNS],
    indexes: [{ columns: ['download_count'] }],
  };
}

/** A people list's folded names, as JSON. */
function foldedNames(people: Person[]): string {
  return JSON.stringify(people.map((person) => foldCatalogText(person.name)));
}

/** Unicode case conversion is done at ingest, since SQLite LOWER only folds ASCII. */
function foldedFields(title: string, authors: Person[], subjects: string[], bookshelves: string[]) {
  return {
    title_folded: foldCatalogText(title),
    authors_folded: foldedNames(authors),
    subjects_folded: JSON.stringify(subjects.map(foldCatalogText)),
    bookshelves_folded: JSON.stringify(bookshelves.map(foldCatalogText)),
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
  const aliases = book.authors.map((author) => author.aliases);
  return {
    ...foldedFields(book.title, book.authors, book.subjects, book.bookshelves),
    translators_folded: foldedNames(book.translators),
    id: book.id,
    title: book.title,
    authors: JSON.stringify(
      book.authors.map(({ name, birth_year, death_year }) => ({
        name,
        birth_year,
        death_year,
      })),
    ),
    author_aliases: JSON.stringify(aliases),
    author_aliases_folded: JSON.stringify(aliases.map((list) => list?.map(foldCatalogText) ?? [])),
    author_webpages: JSON.stringify(book.authors.map((author) => author.webpage)),
    alternative_titles: nullableJson(book.alternative_titles),
    alternatives_folded: nullableJson(book.alternative_titles?.map(foldCatalogText) ?? null),
    contents: book.contents,
    contents_folded: book.contents === null ? null : foldCatalogPhrase(book.contents),
    contributors: nullableJson(book.contributors),
    contributors_folded: book.contributors === null ? null : foldedNames(book.contributors),
    lcc: nullableJson(book.lcc),
    reading_ease: book.reading_ease,
    release_date: book.release_date,
    source_imprint: book.source_imprint,
    translators: JSON.stringify(book.translators),
    editors: JSON.stringify(book.editors),
    subjects: JSON.stringify(book.subjects),
    bookshelves: JSON.stringify(book.bookshelves),
    languages: JSON.stringify(book.languages),
    summaries: JSON.stringify(book.summaries),
    source_notes: nullableJson(book.source_notes),
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

function nullableJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parseNullableJson<T>(value: unknown): T | null {
  return value == null ? null : parseJson<T>(value);
}

/** Translate a stored row back into the normalized book shape the live path returns. */
export function bookFromRow(row: MirrorRow): Book {
  const summaries = parseJson<string[]>(row.summaries);
  const formats = parseJson<Record<string, string>>(row.formats);
  const media_type = String(row.media_type);
  const aliases = parseNullableJson<(string[] | null)[]>(row.author_aliases);
  const webpages = parseNullableJson<(string | null)[]>(row.author_webpages);
  return {
    id: Number(row.id),
    title: String(row.title),
    authors: parseJson<Person[]>(row.authors).map((author, index) => ({
      ...author,
      aliases: aliases?.[index] ?? null,
      webpage: webpages?.[index] ?? null,
    })),
    alternative_titles: parseNullableJson<string[]>(row.alternative_titles),
    contents: typeof row.contents === 'string' ? row.contents : null,
    contributors: parseNullableJson<Contributor[]>(row.contributors),
    lcc: parseNullableJson<string[]>(row.lcc),
    reading_ease: typeof row.reading_ease === 'string' ? row.reading_ease : null,
    release_date: typeof row.release_date === 'string' ? row.release_date : null,
    source_imprint: typeof row.source_imprint === 'string' ? row.source_imprint : null,
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
    source_notes: parseNullableJson<string[]>(row.source_notes),
    formats,
    is_readable: isReadable({ media_type, formats }),
    has_plain_text: Boolean(row.has_plain_text),
  };
}
