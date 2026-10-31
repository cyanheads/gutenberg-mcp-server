/**
 * @fileoverview Domain types for the Gutendex catalog API and normalized book records.
 * @module services/gutendex/types
 */

/** Raw person record from the Gutendex API (author, translator, editor). */
export interface RawPerson {
  birth_year: number | null;
  death_year: number | null;
  name: string;
}

/** Raw book record from the Gutendex API. */
export interface RawBook {
  authors: RawPerson[];
  bookshelves: string[];
  copyright: boolean | null;
  download_count: number;
  /** Absent on records Gutendex has no editor credit for; present as `[]` on most. */
  editors?: RawPerson[];
  formats: Record<string, string>;
  id: number;
  languages: string[];
  media_type: string;
  subjects: string[];
  summaries?: string[];
  title: string;
  translators: RawPerson[];
}

/** Raw paginated list response from Gutendex. */
export interface RawBooksPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: RawBook[];
}

/** Normalized person (author / translator / editor). */
export interface Person {
  birth_year: number | null;
  death_year: number | null;
  name: string;
}

/** Normalized book record with computed fields. */
export interface Book {
  authors: Person[];
  bookshelves: string[];
  copyright: boolean | null;
  download_count: number;
  editors: Person[];
  formats: Record<string, string>;
  /** True when media_type is "Text" and a UTF-8 text/plain format is available. */
  has_plain_text: boolean;
  id: number;
  /** True for non-Sound records with a supported UTF-8 plain-text or HTML format. */
  is_readable: boolean;
  languages: string[];
  media_type: string;
  /** Direct RDF bibliographic notes; null when the source did not supply them. */
  source_notes: string[] | null;
  subjects: string[];
  /** Every upstream summary, in upstream order. Empty when there are none. */
  summaries: string[];
  /** First entry of {@link summaries}, or null when upstream sent none. */
  summary: string | null;
  title: string;
  translators: Person[];
}

/** Parameters for a Gutendex book search. */
export interface SearchParams {
  author_year_end?: number | undefined;
  author_year_start?: number | undefined;
  copyright?: ('true' | 'false' | 'null')[] | undefined;
  ids?: number[] | undefined;
  languages?: string[] | undefined;
  mime_type?: string | undefined;
  page?: number | undefined;
  query?: string | undefined;
  sort?: 'popular' | 'ascending' | 'descending' | undefined;
  topic?: string | undefined;
  /** Mirror-only: Gutendex has no translator parameter. */
  translator?: string | undefined;
}

/** Fold catalog text without letting Greek final sigma depend on substring boundaries. */
export function foldSearchText(value: string): string {
  return value.toLowerCase().replaceAll('ς', 'σ');
}

/** Strip NULs and collapse whitespace between words; a value with no words is unset. */
function normalizeWords(value: string | undefined): string | undefined {
  return value?.replaceAll('\0', '').split(/\s+/u).filter(Boolean).join(' ') || undefined;
}

/**
 * A language code in lowercase. `İ` lowercases to two units, which can outgrow the
 * echoed criteria's length cap, so such a code stays as sent and matches nothing.
 */
function lowercaseCode(code: string): string {
  const lower = code.toLowerCase();
  return lower.length === code.length ? lower : code;
}

/** Normalize form blanks and query whitespace before either catalog source sees them. */
export function normalizeSearchParams(params: SearchParams): SearchParams {
  return {
    ...params,
    query: normalizeWords(params.query),
    translator: normalizeWords(params.translator),
    topic: params.topic?.trim() || undefined,
    languages: params.languages?.length ? params.languages.map(lowercaseCode) : undefined,
    mime_type: params.mime_type?.trim() || undefined,
    copyright: params.copyright?.length ? params.copyright : undefined,
    sort: params.sort ?? 'popular',
    page: params.page ?? 1,
  };
}

/**
 * Whether gutenberg_get_text can serve this book as plain text: media_type
 * "Text" with a UTF-8 text/plain format present. US-ASCII-only entries are
 * excluded — they have no path on the sanctioned mirror and resolve to
 * no_text_format — so the flag never advertises text the reader tool can't
 * deliver. (HTML-fallback-only books are likewise not counted here; the flag
 * tracks plain-text availability, not HTML-derived readability.)
 */
export function hasPlainText(book: RawBook): boolean {
  if (book.media_type !== 'Text') return false;
  return 'text/plain; charset=utf-8' in book.formats;
}

/** Whether the existing reader supports this record's media type and formats. */
export function isReadable(book: Pick<RawBook, 'media_type' | 'formats'>): boolean {
  return (
    book.media_type !== 'Sound' &&
    ('text/plain; charset=utf-8' in book.formats || 'text/html' in book.formats)
  );
}
