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
  /** Eligible Text record formats; does not guarantee the mirror file exists. */
  is_readable: boolean;
  languages: string[];
  media_type: string;
  /** Direct RDF bibliographic notes; null when the source did not supply them. */
  source_notes: string[] | null;
  subjects: string[];
  /** Source summaries: sorted when read from RDF, upstream order from a live Gutendex search. */
  summaries: string[];
  /** First entry of {@link summaries}, not necessarily primary, or null when absent. */
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

/** Catalog substring matching ignores accents and expands letters NFKD leaves intact. */
export function foldCatalogText(value: string): string {
  return foldSearchText(value)
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll('æ', 'ae')
    .replaceAll('œ', 'oe')
    .replaceAll('ø', 'o')
    .replaceAll('ß', 'ss')
    .replaceAll('ł', 'l')
    .replaceAll('ð', 'd')
    .replaceAll('þ', 'th');
}

/** Remove reserved MARC subfields while retaining their bibliographic separators and literal dollars. */
export function normalizeTitle(value: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = value.indexOf('$'); index !== -1; index = value.indexOf('$', index + 1)) {
    let before = index;
    while (before > start && /\s/u.test(value.charAt(before - 1))) before -= 1;
    const separator =
      before > start && ':;='.includes(value.charAt(before - 1)) ? value[before - 1] : undefined;
    const code = value[index + 1];
    const marked =
      code !== undefined &&
      'bcv'.includes(code) &&
      (index + 2 === value.length || /[\s:;=]/u.test(value.charAt(index + 2)));
    if (
      !marked &&
      !(
        separator !== undefined &&
        (index + 1 === value.length || /\s/u.test(value.charAt(index + 1)))
      )
    )
      continue;
    if (separator === undefined && before === index && index !== 0) continue;
    let cut = separator === undefined ? before : before - 1;
    while (cut > start && /\s/u.test(value.charAt(cut - 1))) cut -= 1;
    let end = index + (marked ? 2 : 1);
    while (end < value.length && /\s/u.test(value.charAt(end))) end += 1;
    if (value[end] === ':') {
      end += 1;
      while (end < value.length && /\s/u.test(value.charAt(end))) end += 1;
    }
    parts.push(
      value.slice(start, cut),
      separator === '=' ? ' =' : (separator ?? ':'),
      end < value.length ? ' ' : '',
    );
    start = end;
    index = end - 1;
  }
  if (start === 0) return value;
  parts.push(value.slice(start));
  return parts.join('');
}

/** Strip NULs and collapse whitespace between words; a value with no words is unset. */
function normalizeWords(value: string | undefined): string | undefined {
  return (
    value
      ?.replaceAll('\0', '')
      .split(/\s+/u)
      .filter((word) => foldCatalogText(word) !== '')
      .join(' ') || undefined
  );
}

/**
 * A language code in lowercase. `İ` lowercases to two units, which can outgrow the
 * echoed criteria's length cap, so such a code stays as sent and matches nothing.
 */
function lowercaseCode(code: string): string {
  const lower = code.toLowerCase();
  return lower.length === code.length ? lower : code;
}

/** MIME parameter values retain literal case; only type and subtype are case-insensitive. */
function normalizeMimePrefix(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf(';');
  return separator === -1
    ? trimmed.toLowerCase()
    : trimmed.slice(0, separator).toLowerCase() + trimmed.slice(separator);
}

/** Normalize form blanks and query whitespace before either catalog source sees them. */
export function normalizeSearchParams(params: SearchParams): SearchParams {
  const topic = params.topic?.trim();
  return {
    ...params,
    query: normalizeWords(params.query),
    translator: normalizeWords(params.translator),
    topic: topic && foldCatalogText(topic).trim() ? topic : undefined,
    languages: params.languages?.length ? params.languages.map(lowercaseCode) : undefined,
    mime_type: normalizeMimePrefix(params.mime_type),
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

/** Eligible Text book formats for discovery; the reader independently attempts non-Sound records. */
export function isReadable(book: Pick<RawBook, 'media_type' | 'formats'>): boolean {
  return (
    book.media_type === 'Text' &&
    ('text/plain; charset=utf-8' in book.formats ||
      ('text/html' in book.formats &&
        !Object.keys(book.formats).some((key) => key.startsWith('audio/'))))
  );
}
