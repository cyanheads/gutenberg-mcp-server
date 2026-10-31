/**
 * @fileoverview Service for fetching and processing plain-text book files from
 * Project Gutenberg. Handles BOM stripping, boilerplate extraction via START/END
 * markers, CRLF normalization, HTML fallback, offset/limit chunking, passage search
 * over the stored text, and a 24-hour tenant-scoped text cache keyed by Gutenberg ID.
 * @module services/gutenberg-text/gutenberg-text-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { SAXParser } from 'parse5-sax-parser';
import type { ServerConfig } from '@/config/server-config.js';
import { type Book, foldSearchText } from '@/services/gutendex/types.js';
import { withUpstreamDeadline } from '@/services/upstream-deadline.js';
import type { CachedText, FetchedText, PassageMatch, SourceFormat, TextChunk } from './types.js';

/**
 * Per-attempt ceiling for one mirror file request. Books are whole files —
 * multi-megabyte texts legitimately take tens of seconds — so this stays
 * generous and the ladder budget below is what bounds the exchange.
 */
const TEXT_TIMEOUT_MS = 30_000;
/**
 * Wall-clock ceiling for a whole mirror ladder, aborting any request still in
 * flight. Sized so a catalog hop plus a text hop still finishes inside the 60 s
 * default MCP client request timeout with headroom to spare.
 */
const TEXT_BUDGET_MS = 35_000;
const TEXT_TTL_SECONDS = 86_400; // 24 hours

/** Regex matching the START marker (multiline, case from real files). */
const START_RE = /^\*{3} START OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m;
/** Regex matching the END marker. */
const END_RE = /^\*{3} END OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m;

/** Strip the UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Extract the literary content between the START and END markers.
 * Returns null if neither marker is found (rare, malformed file).
 */
function extractLiteraryContent(text: string): string | null {
  const startMatch = START_RE.exec(text);
  const endMatch = END_RE.exec(text);
  if (!startMatch || !endMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const endIdx = endMatch.index;

  if (startIdx >= endIdx) return null;
  return text.slice(startIdx, endIdx);
}

/** Normalize CRLF to LF and collapse 3+ consecutive blank lines to 2. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Empty every `\n`-delimited line holding no visible character. Converted HTML
 * alone needs this: indentation nodes, `&nbsp;` spacers, and empty cells leave
 * such lines, while a plain-text edition's are its own and keep their offsets.
 * Splitting rather than a multiline regex keeps U+2028 from delimiting a line.
 */
function blankWhitespaceLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (/\S/.test(line) ? line : ''))
    .join('\n');
}

/** Block boundaries in the literary stream; inline markup leaves prose intact. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'br',
  'li',
  'blockquote',
  'pre',
]);

/** End tags that leave a cell, explicitly or by closing what holds it. */
const CELL_END_TAGS = new Set(['td', 'th', 'tr', 'caption']);

/**
 * Tokenize HTML once: references decode once, independently of presentation.
 * Whitespace-only text between table, row, and cell tags is source layout: left
 * in, it breaks a row across lines. `cellOpen` holds one flag per open table,
 * innermost last, so a nested table's cells never end the cell that holds it;
 * `outerRowCells` sets aside the row count a nested table interrupts.
 * A tokenizer sees no implied end tags, so a row or the table closes a cell too.
 */
function htmlToText(html: string): string {
  const chunks: string[] = [];
  const parser = new SAXParser();
  let excluded: string | undefined;
  let templateDepth = 0;
  let cellsInRow = 0;
  const outerRowCells: number[] = [];
  const cellOpen: boolean[] = [];
  const setCellOpen = (open: boolean) => {
    if (cellOpen.length > 0) cellOpen[cellOpen.length - 1] = open;
  };
  const rowBoundary = () => {
    if (!chunks.at(-1)?.endsWith('\n')) chunks.push('\n');
  };
  parser.on('startTag', ({ tagName }) => {
    if (excluded) return;
    if (tagName === 'template') {
      templateDepth += 1;
      return;
    }
    if (templateDepth > 0) return;
    if (tagName === 'title' || tagName === 'script' || tagName === 'style') {
      excluded = tagName;
    } else if (BLOCK_TAGS.has(tagName)) {
      chunks.push('\n\n');
    } else if (tagName === 'tr' || tagName === 'table') {
      rowBoundary();
      if (tagName === 'table') {
        outerRowCells.push(cellsInRow);
        cellOpen.push(false);
      } else {
        setCellOpen(false);
      }
      cellsInRow = 0;
    } else if (tagName === 'td' || tagName === 'th') {
      if (cellsInRow > 0) chunks.push('\t');
      cellsInRow += 1;
      setCellOpen(true);
    } else if (tagName === 'caption') {
      setCellOpen(true);
    }
  });
  parser.on('endTag', ({ tagName }) => {
    if (excluded) {
      if (tagName === excluded) excluded = undefined;
      return;
    }
    if (templateDepth > 0) {
      if (tagName === 'template') templateDepth -= 1;
      return;
    }
    if (tagName === 'tr' || tagName === 'table') rowBoundary();
    else if (BLOCK_TAGS.has(tagName)) chunks.push('\n\n');
    if (tagName === 'table') {
      cellOpen.pop();
      cellsInRow = outerRowCells.pop() ?? 0;
    } else if (CELL_END_TAGS.has(tagName)) {
      setCellOpen(false);
    }
  });
  parser.on('text', ({ text }) => {
    if (excluded || templateDepth > 0) return;
    if (cellOpen.at(-1) === false && !/\S/.test(text)) return;
    chunks.push(text);
  });
  parser.end(html);
  return chunks.join('');
}

/** The comparison key every `\s` unit shares; a run of them reads as one. */
const WHITESPACE_KEY = 0x20;

/** Comparison key per UTF-16 code unit, indexed by unit. Built by the first search. */
let passageKeys: Uint16Array | undefined;

/**
 * One key per code unit keeps a match in stored-text offsets, which lowercasing
 * the whole text cannot: `İ` folds to two units, shifting every later offset. So
 * a unit whose fold changes length compares as itself.
 */
function buildPassageKeys(): Uint16Array {
  const keys = new Uint16Array(0x10000);
  for (let unit = 0; unit < keys.length; unit++) {
    const character = String.fromCharCode(unit);
    const folded = foldSearchText(character);
    keys[unit] = folded.length === 1 ? folded.charCodeAt(0) : unit;
    if (/\s/.test(character)) keys[unit] = WHITESPACE_KEY;
  }
  keys[0x2018] = keys[0x2019] = 0x27; // ‘ ’ read as '
  keys[0x201c] = keys[0x201d] = 0x22; // “ ” read as "
  return keys;
}

/**
 * Build the direct HTTPS cache-path URL for a book's generated UTF-8 plain text
 * on the configured mirror. Derived from the book id — never from the upstream
 * Gutendex format URL — so no main-site (www.gutenberg.org) URL is ever fetched.
 * Example (base https://gutenberg.pglaf.org): .../cache/epub/1342/pg1342.txt
 */
function rewriteToHttpsCachePath(id: number, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/cache/epub/${id}/pg${id}.txt`;
}

/**
 * Build the direct HTTPS cache-path URL for a book's generated HTML on the
 * configured mirror — the fallback when no UTF-8 plain text is available.
 * Id-derived like the plain-text path, so no upstream URL is fetched.
 * Example (base https://gutenberg.pglaf.org): .../cache/epub/1342/pg1342-images.html
 */
function rewriteToHttpsHtmlCachePath(id: number, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/cache/epub/${id}/pg${id}-images.html`;
}

export class GutenbergTextService {
  private readonly textBaseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    const base = serverConfig.gutenbergTextBaseUrl;
    this.textBaseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
  }

  /**
   * Resolve the best text URL and format from a book's formats map.
   * Returns null when no readable format is available.
   */
  private resolveTextUrl(book: Book, id: number): { url: string; format: SourceFormat } | null {
    const fmt = book.formats;

    // Primary: the mirror's generated UTF-8 plain text — a host swap of the
    // cache path, covering essentially every modern text book.
    if ('text/plain; charset=utf-8' in fmt) {
      return {
        url: rewriteToHttpsCachePath(id, this.textBaseUrl),
        format: 'text/plain; charset=utf-8',
      };
    }

    // Fallback: the mirror's generated HTML, converted to text downstream.
    if ('text/html' in fmt) {
      return {
        url: rewriteToHttpsHtmlCachePath(id, this.textBaseUrl),
        format: 'text/html',
      };
    }

    // No mirror-served text path — notably us-ascii-only books, whose upstream
    // us-ascii URL points at the main site (never fetched) and for which the
    // mirror exposes no stable plain-text filename. Surface a clean no-format
    // error rather than fetch www.gutenberg.org.
    return null;
  }

  /**
   * Fetch the raw bytes for a book URL and decode as UTF-8. The mirror serves
   * generated UTF-8 for both the plain-text and HTML cache files.
   *
   * The whole ladder runs under one budget, and an exhausted budget surfaces as
   * `text_fetch_failed` with the calling tool's declared recovery hint. The
   * message names the book rather than the resolved cache-path URL, which
   * carries the operator's configured mirror host; the original error stays on
   * `cause` for server-side logs. A caller cancel passes through unchanged.
   */
  private async fetchRaw(
    url: string,
    id: number,
    format: SourceFormat,
    ctx: Context,
  ): Promise<string> {
    const response = await withUpstreamDeadline(
      ctx,
      {
        budgetMs: TEXT_BUDGET_MS,
        message: `Failed to fetch text for book ${id}: the Gutenberg mirror did not respond.`,
        reason: 'text_fetch_failed',
      },
      (signal) =>
        withRetry(
          async () => {
            const reqCtx = requestContextService.createRequestContext({
              parentContext: ctx,
              operation: 'GutenbergTextService.fetchRaw',
            });
            try {
              const response = await fetchWithTimeout(url, TEXT_TIMEOUT_MS, reqCtx, { signal });
              const buffer = await response.arrayBuffer();
              return {
                raw: new TextDecoder('utf-8').decode(buffer),
                mediaType: response.headers
                  .get('content-type')
                  ?.split(';')[0]
                  ?.trim()
                  .toLowerCase(),
              };
            } catch (error) {
              if (ctx.signal.aborted) throw error;
              if (
                error instanceof McpError &&
                typeof error.data?.status === 'number' &&
                error.data.status >= 400 &&
                error.data.status < 500 &&
                error.data.status !== 408 &&
                error.data.status !== 429
              ) {
                const missing = error.data.status === 404;
                const reason = missing ? 'text_file_not_found' : 'text_fetch_rejected';
                throw new McpError(
                  missing ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.Forbidden,
                  `The Gutenberg mirror ${missing ? 'has no text file' : 'rejected the text request'} for book ${id}.`,
                  { reason, ...ctx.recoveryFor(reason) },
                  { cause: error },
                );
              }
              throw error;
            }
          },
          {
            operation: 'GutenbergTextService.fetchRaw',
            baseDelayMs: 2000,
            signal,
          },
        ),
    );
    // Mirrors can label valid books as generic binary or another incorrect MIME
    // type. A header alone cannot establish that the literary body is invalid.
    let jsonError = false;
    if (response.mediaType === 'application/json' && response.raw.trimStart().startsWith('{')) {
      try {
        const document: unknown = JSON.parse(response.raw);
        jsonError =
          document !== null &&
          typeof document === 'object' &&
          Object.keys(document).length === 1 &&
          'error' in document &&
          typeof document.error === 'string';
      } catch {
        // A mislabeled literary document need not be valid JSON.
      }
    }
    if (
      jsonError ||
      (format !== 'text/html' &&
        /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(response.raw))
    ) {
      throw this.invalidResponse(id, ctx);
    }
    return response.raw;
  }

  /** Invalid upstream content is distinct from a retryable transport outage. */
  private invalidResponse(id: number, ctx: Context): McpError {
    return new McpError(
      JsonRpcErrorCode.SerializationError,
      `The Gutenberg mirror returned an invalid text document for book ${id}.`,
      { reason: 'invalid_text_response', ...ctx.recoveryFor('invalid_text_response') },
    );
  }

  /**
   * Run the full text-processing pipeline for a given book.
   * Returns the stripped, normalized literary text.
   */
  private processRaw(raw: string, format: SourceFormat): FetchedText {
    let text = raw;

    // Strip BOM (UTF-8 files only, but harmless to check for all)
    text = stripBom(text);

    // If HTML, convert to plain text first
    if (format === 'text/html') {
      text = blankWhitespaceLines(htmlToText(text));
    }

    // Normalize CRLF → LF and collapse blank lines
    text = normalizeWhitespace(text);

    // Extract literary content between START/END markers
    const extracted = extractLiteraryContent(text);
    if (extracted !== null) {
      text = extracted;
      // Re-normalize after extraction (leading/trailing newlines from the markers)
      text = text.trim();
      text = normalizeWhitespace(text);
    }
    // If no markers found (rare), use the full processed text as-is

    return { text, sourceFormat: format };
  }

  /**
   * Fetch, process, and cache the full stripped text for a book.
   * Throws no_text_format if no usable format; `fetchRaw` throws text_fetch_failed
   * when the mirror ladder exhausts its budget.
   */
  async fetchAndCacheText(book: Book, id: number, ctx: Context): Promise<CachedText> {
    const cacheKey = `gutenberg/text/v3/${id}`;

    const cached = await ctx.state.get<CachedText>(cacheKey);
    if (cached) {
      ctx.log.debug('Text cache hit', { id });
      return cached;
    }

    const resolved = this.resolveTextUrl(book, id);
    if (!resolved) {
      throw notFound(`Book ${id} has no mirror-served plain-text or HTML format.`, {
        reason: 'no_text_format',
      });
    }

    /**
     * `ctx.log` is a dual sink — every call also leaves as `notifications/message`,
     * so the payload is client-visible. The resolved URL carries the operator's
     * configured mirror host; id and format identify the operation just as well,
     * and the URL is reconstructible server-side from the base-URL config.
     */
    ctx.log.info('Fetching book text', { id, format: resolved.format });

    // fetchRaw owns the text_fetch_failed translation. Keeping it there rather
    // than in a catch here leaves the two ctx.state cache operations around this
    // call outside the failure class — a storage error bubbles as itself instead
    // of being relabelled an upstream outage.
    const raw = await this.fetchRaw(resolved.url, id, resolved.format, ctx);

    const processed = this.processRaw(raw, resolved.format);

    /** Match complete, short server templates rather than keywords within prose. */
    const document = processed.text.trim().replace(/\s+/g, ' ');
    const failureTemplate =
      /^(?:Service unavailable[;.]? retry later\.?|(?:404 Not Found|403 Forbidden|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)(?: (?:nginx|Apache(?: Server)?))?)$/i;
    if (
      !document ||
      (resolved.format === 'text/html' && document.length <= 200 && failureTemplate.test(document))
    ) {
      throw this.invalidResponse(id, ctx);
    }

    const entry: CachedText = {
      text: processed.text,
      sourceFormat: processed.sourceFormat,
      title: book.title,
    };

    await ctx.state.set(cacheKey, entry, { ttl: TEXT_TTL_SECONDS });
    return entry;
  }

  /**
   * Locate the first occurrence of `find` at or after `from`, counting the
   * non-overlapping occurrences after it. `find` carries no surrounding whitespace
   * and holds at least one other character.
   *
   * One KMP pass over per-code-unit keys, so time is linear in text plus `find`
   * whatever either holds, and `find` needs no length limit. A regex built from
   * `find` throws on long input, goes super-linear on periodic text under Bun, and
   * can start a match before `from` inside a surrogate pair. No abort can arrive
   * while the scan holds the event loop, so the caller checks its signal first.
   */
  findPassage({ text }: CachedText, find: string, from: number): PassageMatch | undefined {
    passageKeys ??= buildPassageKeys();
    const keys = passageKeys;
    const keyAt = (source: string, index: number) => keys[source.charCodeAt(index)] as number;

    const pattern = new Uint16Array(find.length);
    let size = 0;
    for (let index = 0; index < find.length; index++) {
      const key = keyAt(find, index);
      if (key !== WHITESPACE_KEY || pattern[size - 1] !== WHITESPACE_KEY) pattern[size++] = key;
    }

    /** For each pattern prefix, the longest proper prefix that is also its suffix. */
    const fallback = new Int32Array(size);
    for (let index = 1, matched = 0; index < size; index++) {
      while (matched > 0 && pattern[index] !== pattern[matched]) {
        matched = fallback[matched - 1] as number;
      }
      if (pattern[index] === pattern[matched]) matched += 1;
      fallback[index] = matched;
    }

    /** Stored-text start of the last `size` keys, a ring indexed by key count. */
    const starts = new Int32Array(size);
    let first: PassageMatch | undefined;
    let position = from;
    let keyCount = 0;
    let matched = 0;
    while (position < text.length) {
      const start = position;
      const key = keyAt(text, position);
      position += 1;
      if (key === WHITESPACE_KEY) {
        while (position < text.length && keyAt(text, position) === WHITESPACE_KEY) position += 1;
      }
      starts[keyCount % size] = start;
      keyCount += 1;

      while (matched > 0 && key !== pattern[matched]) matched = fallback[matched - 1] as number;
      if (key === pattern[matched]) matched += 1;
      if (matched === size) {
        matched = 0;
        if (first) {
          first.laterMatches += 1;
        } else {
          const offset = starts[(keyCount - size) % size] as number;
          first = { offset, length: position - offset, laterMatches: 0 };
        }
      }
    }
    return first;
  }

  /**
   * Chunk the cached text at the requested offset/limit, with soft paragraph-boundary
   * trimming (backtracks up to 500 chars to the nearest \n\n to avoid mid-paragraph cuts).
   * A chunk starting at a passage match passes its length: trimming stops at the match
   * end, while `limit` still applies, so a limit below the length cuts the match short.
   */
  chunkText(cached: CachedText, offset: number, limit: number, matchLength = 0): TextChunk {
    const { text, sourceFormat, title } = cached;
    const totalChars = text.length;

    const rawEnd = Math.min(offset + limit, totalChars);
    let end = rawEnd;

    // Soft paragraph-boundary trim: if not at EOF, backtrack to nearest \n\n
    if (end < totalChars) {
      const searchStart = Math.max(rawEnd - 500, offset + Math.max(1, matchLength));
      const slice = text.slice(searchStart, rawEnd);
      const lastBreak = slice.lastIndexOf('\n\n');
      if (lastBreak !== -1) {
        end = searchStart + lastBreak + 2; // include the double-newline in the chunk
      }
    }

    const chunk = text.slice(offset, end);
    const length = chunk.length;
    const remainingChars = Math.max(0, totalChars - offset - length);

    return {
      text: chunk,
      offset,
      length,
      totalChars,
      remainingChars,
      hasMore: remainingChars > 0,
      title,
      sourceFormat,
    };
  }
}

// --- Init/accessor pattern ---

let _service: GutenbergTextService | undefined;

export function initGutenbergTextService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new GutenbergTextService(config, storage, serverConfig);
}

export function getGutenbergTextService(): GutenbergTextService {
  if (!_service) {
    throw new Error(
      'GutenbergTextService not initialized — call initGutenbergTextService() in setup()',
    );
  }
  return _service;
}
