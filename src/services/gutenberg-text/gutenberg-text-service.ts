/**
 * @fileoverview Service for fetching and processing plain-text book files from
 * Project Gutenberg. Handles BOM stripping, boilerplate extraction via START/END
 * markers, CRLF normalization, HTML fallback, offset/limit chunking, and a 24-hour
 * in-process text cache keyed by Gutenberg ID.
 * @module services/gutenberg-text/gutenberg-text-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type { Book } from '@/services/gutendex/types.js';
import { withUpstreamDeadline } from '@/services/upstream-deadline.js';
import type { CachedText, FetchedText, SourceFormat, TextChunk } from './types.js';

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
 * Minimal HTML-to-text conversion: strips tags, decodes common HTML entities,
 * and preserves paragraph structure.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<\/?(?:p|div|h[1-6]|hr|br)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/g, ' ');
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
  private fetchRaw(url: string, id: number, ctx: Context): Promise<string> {
    return withUpstreamDeadline(
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
            const response = await fetchWithTimeout(url, TEXT_TIMEOUT_MS, reqCtx, { signal });
            const buffer = await response.arrayBuffer();
            return new TextDecoder('utf-8').decode(buffer);
          },
          {
            operation: 'GutenbergTextService.fetchRaw',
            baseDelayMs: 2000,
            signal,
          },
        ),
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
      text = htmlToText(text);
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
    const cacheKey = `gutenberg/text/${id}`;

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
    const raw = await this.fetchRaw(resolved.url, id, ctx);

    const processed = this.processRaw(raw, resolved.format);

    const entry: CachedText = {
      text: processed.text,
      sourceFormat: processed.sourceFormat,
      title: book.title,
    };

    await ctx.state.set(cacheKey, entry, { ttl: TEXT_TTL_SECONDS });
    return entry;
  }

  /**
   * Chunk the cached text at the requested offset/limit, with soft paragraph-boundary
   * trimming (backtracks up to 500 chars to the nearest \n\n to avoid mid-paragraph cuts).
   */
  chunkText(cached: CachedText, offset: number, limit: number): TextChunk {
    const { text, sourceFormat, title } = cached;
    const totalChars = text.length;

    const rawEnd = Math.min(offset + limit, totalChars);
    let end = rawEnd;

    // Soft paragraph-boundary trim: if not at EOF, backtrack to nearest \n\n
    if (end < totalChars) {
      const searchStart = Math.max(rawEnd - 500, offset + 1);
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
