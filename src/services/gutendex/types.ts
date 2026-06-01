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
  /** True when media_type is "Text" and a text/plain format is available. */
  has_plain_text: boolean;
  id: number;
  languages: string[];
  media_type: string;
  subjects: string[];
  summary: string | null;
  title: string;
  translators: Person[];
}

/** Parameters for a Gutendex book search. */
export interface SearchParams {
  author_year_end?: number | undefined;
  author_year_start?: number | undefined;
  ids?: number[] | undefined;
  languages?: string[] | undefined;
  page?: number | undefined;
  query?: string | undefined;
  sort?: 'popular' | 'ascending' | 'descending' | undefined;
  topic?: string | undefined;
}
