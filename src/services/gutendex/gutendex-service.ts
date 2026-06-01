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
import type { Book, RawBook, RawBooksPage, RawPerson, SearchParams } from './types.js';

/**
 * Hash a URL to a storage-safe key (alphanumeric only).
 * The framework's key validator rejects query-string characters (?, =, +, &).
 */
function urlCacheKey(prefix: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex');
  return `${prefix}${hash}`;
}

const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_TTL_SECONDS = 3600; // 1 hour

function normalizePerson(p: RawPerson) {
  return {
    name: p.name,
    birth_year: p.birth_year,
    death_year: p.death_year,
  };
}

function hasPlainText(book: RawBook): boolean {
  if (book.media_type !== 'Text') return false;
  return (
    'text/plain; charset=utf-8' in book.formats || 'text/plain; charset=us-ascii' in book.formats
  );
}

function normalizeBook(raw: RawBook): Book {
  return {
    id: raw.id,
    title: raw.title,
    authors: raw.authors.map(normalizePerson),
    translators: raw.translators.map(normalizePerson),
    editors: [],
    subjects: raw.subjects,
    bookshelves: raw.bookshelves,
    languages: raw.languages,
    copyright: raw.copyright,
    media_type: raw.media_type,
    download_count: raw.download_count,
    summary: raw.summaries?.[0] ?? null,
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
  private async fetchPage(url: string, ctx: Context): Promise<RawBooksPage> {
    const cacheKey = urlCacheKey('gutendex/page/', url);

    const cached = await ctx.state.get<RawBooksPage>(cacheKey);
    if (cached) {
      ctx.log.debug('Catalog cache hit', { url });
      return cached;
    }

    const page = await withRetry(
      async () => {
        const reqCtx = requestContextService.createRequestContext({
          parentContext: ctx as unknown as Record<string, unknown>,
          operation: 'GutendexService.fetchPage',
        });
        const response = await fetchWithTimeout(url, CATALOG_TIMEOUT_MS, reqCtx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
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
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, page, { ttl: CATALOG_TTL_SECONDS });
    return page;
  }

  /** Search books by the given parameters. Returns normalized books + count + pagination. */
  async searchBooks(
    params: SearchParams,
    ctx: Context,
  ): Promise<{ books: Book[]; totalCount: number; hasMore: boolean; page: number }> {
    const url = this.buildSearchUrl(params);
    const page = await this.fetchPage(url, ctx);
    const books = page.results.map(normalizeBook);
    return {
      books,
      totalCount: page.count,
      hasMore: page.next !== null,
      page: params.page ?? 1,
    };
  }

  /** Fetch a single book by Gutenberg ID. Throws not_found if 404. */
  async getBook(id: number, ctx: Context): Promise<Book> {
    const url = `${this.baseUrl}${id}/`;
    const cacheKey = `gutendex/book/${id}`;

    const cached = await ctx.state.get<RawBook>(cacheKey);
    if (cached) {
      ctx.log.debug('Book cache hit', { id });
      return normalizeBook(cached);
    }

    const raw = await withRetry(
      async () => {
        const reqCtx = requestContextService.createRequestContext({
          parentContext: ctx as unknown as Record<string, unknown>,
          operation: 'GutendexService.getBook',
        });
        // fetchWithTimeout throws McpError(NotFound) for HTTP 404 — not in the
        // transient set, so withRetry won't retry it.
        const response = await fetchWithTimeout(url, CATALOG_TIMEOUT_MS, reqCtx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
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
        signal: ctx.signal,
      },
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
