/**
 * @fileoverview Types for the GutenbergTextService — text fetch, pipeline, and chunking.
 * @module services/gutenberg-text/types
 */

/** Available plain-text source formats, in preference order. */
export type SourceFormat =
  | 'text/plain; charset=utf-8'
  | 'text/plain; charset=us-ascii'
  | 'text/html';

/** Result of fetching and processing a book's full text. */
export interface FetchedText {
  /** The format that was fetched. */
  sourceFormat: SourceFormat;
  /** Stripped literary text (BOM removed, boilerplate removed, CRLF→LF, whitespace normalized). */
  text: string;
}

/** Cached stripped text entry. */
export interface CachedText {
  sourceFormat: SourceFormat;
  text: string;
  title: string;
}

/** Result of chunking a cached text. */
export interface TextChunk {
  hasMore: boolean;
  length: number;
  offset: number;
  remainingChars: number;
  sourceFormat: SourceFormat;
  text: string;
  title: string;
  totalChars: number;
}
