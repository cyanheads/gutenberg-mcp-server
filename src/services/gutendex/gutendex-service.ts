/**
 * @fileoverview Service wrapping the Gutendex catalog API (gutendex.com/books/).
 * Provides search, single-book lookup, and popularity browse with retry, timeout,
 * and in-process response caching (1-hour TTL).
 * @module services/gutendex/gutendex-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { getCatalogMirrorService } from '@/services/catalog-mirror/catalog-mirror-service.js';
import { withUpstreamDeadline } from '@/services/upstream-deadline.js';
import {
  type Book,
  hasPlainText,
  type RawBook,
  type RawBooksPage,
  type RawPerson,
  type SearchParams,
} from './types.js';

/**
 * Hash a URL to a storage-safe key (alphanumeric only).
 * The framework's key validator rejects query-string characters (?, =, +, &).
 */
function urlCacheKey(prefix: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex');
  return `${prefix}${hash}`;
}

/**
 * Gutendex answers a page beyond the result set with HTTP 404 +
 * `{"detail":"Invalid page."}`. `fetchWithTimeout` surfaces that body on
 * `McpError.data.body`; key the page-out-of-range translation off that
 * exact shape so genuinely-missing resources (any other 404) aren't
 * misclassified as an out-of-range page.
 */
function isInvalidPageResponse(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const body = (data as { body?: unknown }).body;
  if (typeof body !== 'string') return false;
  try {
    return (JSON.parse(body) as { detail?: unknown }).detail === 'Invalid page.';
  } catch {
    return false;
  }
}

/**
 * Per-attempt ceiling for one catalog request. Gutendex answers a warm query in
 * tens of milliseconds and a cold one not at all until its own ~15 s gateway
 * boundary, with nothing observed in between; what clears a cold query is the
 * next attempt finding the cache filled, not the current one waiting longer. So
 * this sits far above the warm band and well below the boundary, spending the
 * ladder budget on more attempts rather than on one long wait.
 */
const CATALOG_TIMEOUT_MS = 5_000;
/**
 * Wall-clock ceiling for a whole catalog ladder, aborting any request still in
 * flight. Leaves room for three attempts, the last with over a second of runway —
 * several times the slowest warm answer. Sized so a catalog hop plus a text hop
 * still finishes inside the 60 s default MCP client request timeout, which is what
 * keeps `gutenberg_get_text` returning a usable error rather than nothing at all.
 */
const CATALOG_BUDGET_MS = 15_000;
/** Contract reason the catalog-backed tools declare for an unreachable Gutendex. */
const CATALOG_UNAVAILABLE = 'catalog_unavailable';
const CATALOG_TTL_SECONDS = 3600; // 1 hour

function normalizePerson(p: RawPerson) {
  return {
    name: p.name,
    birth_year: p.birth_year,
    death_year: p.death_year,
  };
}

function normalizeBook(raw: RawBook): Book {
  return {
    id: raw.id,
    title: raw.title,
    authors: raw.authors.map(normalizePerson),
    translators: raw.translators.map(normalizePerson),
    editors: raw.editors?.map(normalizePerson) ?? [],
    subjects: raw.subjects,
    bookshelves: raw.bookshelves,
    languages: raw.languages,
    copyright: raw.copyright,
    media_type: raw.media_type,
    download_count: raw.download_count,
    /**
     * Gutendex sends `summaries` as an array. `summary` keeps the first entry for
     * callers that read the singular field; `summaries` carries the whole set so
     * the remainder is not silently dropped.
     */
    summary: raw.summaries?.[0] ?? null,
    summaries: raw.summaries ?? [],
    formats: raw.formats,
    has_plain_text: hasPlainText(raw),
  };
}

export class GutendexService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    // Ensure trailing slash
    this.baseUrl = serverConfig.gutendexBaseUrl.endsWith('/')
      ? serverConfig.gutendexBaseUrl
      : `${serverConfig.gutendexBaseUrl}/`;
  }

  /** Build a Gutendex query URL from search parameters. */
  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(this.baseUrl);
    if (params.query) url.searchParams.set('search', params.query);
    if (params.topic) url.searchParams.set('topic', params.topic);
    if (params.languages?.length) url.searchParams.set('languages', params.languages.join(','));
    if (params.author_year_start != null)
      url.searchParams.set('author_year_start', String(params.author_year_start));
    if (params.author_year_end != null)
      url.searchParams.set('author_year_end', String(params.author_year_end));
    if (params.sort && params.sort !== 'popular') url.searchParams.set('sort', params.sort);
    if (params.ids?.length) url.searchParams.set('ids', params.ids.join(','));
    if (params.page && params.page > 1) url.searchParams.set('page', String(params.page));
    return url.toString();
  }

  /** Fetch and parse a raw Gutendex page, with cache. */
  private async fetchPage(params: SearchParams, ctx: Context): Promise<RawBooksPage> {
    const url = this.buildSearchUrl(params);
    const cacheKey = urlCacheKey('gutendex/page/', url);

    const cached = await ctx.state.get<RawBooksPage>(cacheKey);
    if (cached) {
      /**
       * `ctx.log` is a dual sink — every call also leaves as
       * `notifications/message`, so the payload is client-visible. The request
       * URL carries the operator's configured catalog host; the caller's own
       * search arguments identify the cached page without it.
       */
      ctx.log.debug('Catalog cache hit', { ...params });
      return cached;
    }

    const page = await withUpstreamDeadline(
      ctx,
      {
        budgetMs: CATALOG_BUDGET_MS,
        message: 'The Project Gutenberg catalog did not respond.',
        reason: CATALOG_UNAVAILABLE,
      },
      (signal) =>
        withRetry(
          async () => {
            const reqCtx = requestContextService.createRequestContext({
              parentContext: ctx,
              operation: 'GutendexService.fetchPage',
            });
            // fetchWithTimeout throws McpError(NotFound) for HTTP 404 — not in the
            // transient set, so withRetry won't retry it. Gutendex returns 404 +
            // {"detail":"Invalid page."} when the requested page is past the last
            // page for a query; translate only that shape to a distinct domain
            // reason the tool can surface with recovery, and let other 404s bubble.
            const response = await fetchWithTimeout(url, CATALOG_TIMEOUT_MS, reqCtx, {
              signal,
              headers: { Accept: 'application/json' },
              expectedStatuses: [404],
            }).catch((err: unknown) => {
              if (
                err instanceof McpError &&
                err.code === JsonRpcErrorCode.NotFound &&
                isInvalidPageResponse(err.data)
              ) {
                throw notFound('The requested page is beyond the available result range.', {
                  reason: 'page_out_of_range',
                });
              }
              throw err;
            });
            const text = await response.text();
            if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
              throw serviceUnavailable(
                'Gutendex returned an HTML error page instead of JSON — likely rate-limited or unavailable.',
              );
            }
            return JSON.parse(text) as RawBooksPage;
          },
          {
            operation: 'GutendexService.fetchPage',
            baseDelayMs: 1000,
            signal,
          },
        ),
    );

    await ctx.state.set(cacheKey, page, { ttl: CATALOG_TTL_SECONDS });
    return page;
  }

  /** Search books by the given parameters. Returns normalized books + count + pagination. */
  async searchBooks(
    params: SearchParams,
    ctx: Context,
  ): Promise<{ books: Book[]; totalCount: number; hasMore: boolean; page: number }> {
    const page = await this.fetchPage(params, ctx);
    const books = page.results.map(normalizeBook);
    return {
      books,
      totalCount: page.count,
      hasMore: page.next !== null,
      page: params.page ?? 1,
    };
  }

  /**
   * Read one book from the local catalog mirror, or `null` when the mirror cannot
   * answer — not ready, does not hold the ID, or unreadable.
   *
   * A miss is deliberately indistinguishable from a cold mirror: both mean "ask the
   * upstream". The mirror is a daily snapshot, so a book published or revised since
   * the last harvest is legitimately absent, and treating that as `not_found` would
   * turn a staleness window into a wrong answer.
   *
   * A mirror fault is downgraded to a miss rather than propagated. The mirror is an
   * availability optimization layered under a working live path; a corrupt database
   * or a missing file should cost latency, never correctness.
   */
  private async mirrorBook(id: number, ctx: Context): Promise<Book | null> {
    try {
      const mirror = getCatalogMirrorService();
      if (!(await mirror.ready())) return null;
      const [book] = await mirror.getBooks([id]);
      return book ?? null;
    } catch (err: unknown) {
      ctx.log.debug('Catalog mirror unavailable; falling back to the live catalog', {
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetch a single book by Gutenberg ID. Serves from the local mirror when it holds
   * the record, and falls through to the live catalog otherwise. Throws not_found if
   * the live lookup 404s.
   */
  async getBook(id: number, ctx: Context): Promise<Book> {
    const mirrored = await this.mirrorBook(id, ctx);
    if (mirrored !== null) {
      ctx.log.debug('Catalog mirror hit', { id });
      return mirrored;
    }

    const url = `${this.baseUrl}${id}/`;
    const cacheKey = `gutendex/book/${id}`;

    const cached = await ctx.state.get<RawBook>(cacheKey);
    if (cached) {
      ctx.log.debug('Book cache hit', { id });
      return normalizeBook(cached);
    }

    const raw = await withUpstreamDeadline(
      ctx,
      {
        budgetMs: CATALOG_BUDGET_MS,
        message: `The Project Gutenberg catalog did not respond for book ${id}.`,
        reason: CATALOG_UNAVAILABLE,
      },
      (signal) =>
        withRetry(
          async () => {
            const reqCtx = requestContextService.createRequestContext({
              parentContext: ctx,
              operation: 'GutendexService.getBook',
            });
            // fetchWithTimeout throws McpError(NotFound) for HTTP 404 — not in the
            // transient set, so withRetry won't retry it.
            const response = await fetchWithTimeout(url, CATALOG_TIMEOUT_MS, reqCtx, {
              signal,
              headers: { Accept: 'application/json' },
              expectedStatuses: [404],
            }).catch((err: unknown) => {
              if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
                throw notFound(`No book found with Gutenberg ID ${id}.`, { reason: 'not_found' });
              }
              throw err;
            });
            const text = await response.text();
            if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
              throw serviceUnavailable('Gutendex returned an HTML error page.');
            }
            return JSON.parse(text) as RawBook;
          },
          {
            operation: 'GutendexService.getBook',
            baseDelayMs: 1000,
            signal,
          },
        ),
    );

    await ctx.state.set(cacheKey, raw, { ttl: CATALOG_TTL_SECONDS });
    return normalizeBook(raw);
  }
}

// --- Init/accessor pattern ---

let _service: GutendexService | undefined;

export function initGutendexService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new GutendexService(config, storage, serverConfig);
}

export function getGutendexService(): GutendexService {
  if (!_service) {
    throw new Error('GutendexService not initialized — call initGutendexService() in setup()');
  }
  return _service;
}
