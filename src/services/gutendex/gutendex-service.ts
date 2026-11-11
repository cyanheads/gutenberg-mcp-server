/**
 * @fileoverview The Project Gutenberg catalog service. Search and popularity browse
 * read the local catalog mirror, falling back to the live Gutendex API; a single-book
 * lookup reads the mirror, falling back to the book's own RDF record on the content
 * mirror. Every catalog fetch shares one failure classifier and a retry ladder under
 * one deadline, with in-process caching (1-hour TTL).
 * @module services/gutendex/gutendex-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  forbidden,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  fetchWithTimeout,
  type RetryAttempt,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import { bestEffortCache } from '@/services/best-effort-cache.js';
import { getCatalogMirrorService } from '@/services/catalog-mirror/catalog-mirror-service.js';
import { parseBookRdf } from '@/services/catalog-mirror/rdf-book-parser.js';
import { withUpstreamDeadline } from '@/services/upstream-deadline.js';
import { isRejection } from '@/services/upstream-rejection.js';
import {
  type Book,
  hasPlainText,
  isReadable,
  normalizeSearchParams,
  normalizeTitle,
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
 * exact shape so any other search 404 — an endpoint that is not there —
 * is classified as a rejection, not an out-of-range page.
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

/** A parsed Gutendex search page, or null for JSON of any other shape. */
function parseSearchPage(text: string): RawBooksPage | null {
  const page: unknown = JSON.parse(text);
  if (typeof page !== 'object' || page === null) return null;
  const { count, results } = page as Partial<Record<keyof RawBooksPage, unknown>>;
  return typeof count === 'number' && Array.isArray(results) ? (page as RawBooksPage) : null;
}

/**
 * Whole catalog ladder budget. Each attempt can use all remaining time, so a
 * slow successful response is not restarted. Catalog plus text stays below 50s.
 */
const CATALOG_BUDGET_MS = 15_000;
/** Contract reason the catalog-backed tools declare for a catalog that did not answer. */
const CATALOG_UNAVAILABLE = 'catalog_unavailable';
/** Contract reason the catalog-backed tools declare for a request the catalog refuses. */
const CATALOG_REJECTED = 'catalog_rejected';
const CATALOG_TTL_SECONDS = 3600; // 1 hour

/** One catalog document: where it lives, how its body reads, and what its 404 means. */
interface CatalogRequest<T> {
  accept?: string;
  /** The domain failure a 404 stands for, or undefined to classify it as a rejection. */
  onNotFound: (error: McpError) => McpError | undefined;
  /** Log label for the ladder and each attempt. */
  operation: string;
  /** The document in the body, or null when the body is not one; may throw. */
  parse: (text: string) => T | null;
  /** The request in client-facing words, such as `the search request` — never a URL. */
  subject: string;
  /** Client-facing wording when the budget runs out or every attempt failed. */
  unavailableMessage: string;
  url: string;
}

/**
 * Fetch one catalog document under the catalog budget and classify every failure the
 * way the text reader classifies a text file. Inside each attempt: a caller cancel
 * passes through untouched; a 404 becomes the request's domain failure where it names
 * one; any other rejection status becomes `catalog_rejected`, which is not retried; a
 * 2xx body that does not parse is raised as an outage, so it is retried like one.
 * Everything transient is left to the ladder, which reports it as
 * `catalog_unavailable` once the budget or the attempts run out. Messages name the
 * catalog and the request, never its URL; the upstream error stays on `cause`.
 */
function fetchCatalogDocument<T>(
  request: CatalogRequest<T>,
  ctx: Context,
  budgetMs: number,
): Promise<T> {
  const attempt = async ({ signal, remainingMs }: RetryAttempt): Promise<T> => {
    const reqCtx = requestContextService.createRequestContext({
      parentContext: ctx,
      operation: request.operation,
    });
    let text: string;
    try {
      const response = await fetchWithTimeout(request.url, remainingMs, reqCtx, {
        signal,
        ...(request.accept !== undefined && { headers: { Accept: request.accept } }),
        expectedStatuses: [404],
      });
      text = await response.text();
    } catch (error: unknown) {
      if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
      const status = error.data?.status;
      if (typeof status !== 'number') throw error;
      const domainError = status === 404 ? request.onNotFound(error) : undefined;
      if (domainError) throw domainError;
      if (isRejection(status)) {
        throw forbidden(
          `The Project Gutenberg catalog rejected ${request.subject}.`,
          { reason: CATALOG_REJECTED, ...ctx.recoveryFor(CATALOG_REJECTED) },
          { cause: error },
        );
      }
      throw error;
    }
    const unreadable = `The Project Gutenberg catalog returned an unreadable response to ${request.subject}.`;
    let document: T | null;
    try {
      document = request.parse(text);
    } catch (error: unknown) {
      throw serviceUnavailable(unreadable, undefined, { cause: error });
    }
    if (document === null) throw serviceUnavailable(unreadable);
    return document;
  };
  return withUpstreamDeadline(
    ctx,
    { budgetMs, message: request.unavailableMessage, reason: CATALOG_UNAVAILABLE },
    (signal) =>
      withRetry(attempt, {
        operation: request.operation,
        baseDelayMs: 1000,
        deadlineMs: budgetMs,
        signal,
      }),
  );
}

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
    title: normalizeTitle(raw.title),
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
    is_readable: isReadable(raw),
    source_notes: null,
  };
}

export class GutendexService {
  private readonly baseUrl: string;
  /** Content mirror root, without a trailing slash; per-book RDF records live under it. */
  private readonly contentBaseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    // Ensure trailing slash
    this.baseUrl = serverConfig.gutendexBaseUrl.endsWith('/')
      ? serverConfig.gutendexBaseUrl
      : `${serverConfig.gutendexBaseUrl}/`;
    this.contentBaseUrl = serverConfig.gutenbergTextBaseUrl.replace(/\/$/, '');
  }

  /** Optional diagnostics never fall back to a live request or invalidate an answered search. */
  async hasMirrorLanguages(codes: string[], ctx: Context): Promise<boolean | undefined> {
    try {
      return await getCatalogMirrorService().hasLanguages(codes);
    } catch (error: unknown) {
      if (ctx.signal.aborted) throw error;
      return undefined;
    }
  }

  /** Build a Gutendex query URL from search parameters. */
  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(this.baseUrl);
    if (params.query) url.searchParams.set('search', params.query);
    if (params.topic) url.searchParams.set('topic', params.topic);
    if (params.languages?.length) url.searchParams.set('languages', params.languages.join(','));
    if (params.mime_type) url.searchParams.set('mime_type', params.mime_type);
    if (params.copyright?.length) url.searchParams.set('copyright', params.copyright.join(','));
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

    const page = await fetchCatalogDocument(
      {
        url,
        accept: 'application/json',
        operation: 'GutendexService.fetchPage',
        subject: 'the search request',
        unavailableMessage: 'The Project Gutenberg catalog did not respond.',
        parse: parseSearchPage,
        /**
         * Gutendex returns 404 + {"detail":"Invalid page."} when the requested page is
         * past the last page for a query; only that shape is a page out of range.
         */
        onNotFound: (error) =>
          isInvalidPageResponse(error.data)
            ? notFound('The requested page is beyond the available result range.', {
                reason: 'page_out_of_range',
              })
            : undefined,
      },
      ctx,
      CATALOG_BUDGET_MS,
    );

    await bestEffortCache(ctx, cacheKey, page, CATALOG_TTL_SECONDS);
    return page;
  }

  /**
   * Search books by the given parameters. Returns normalized books + count + pagination,
   * plus the `source` that answered: the local mirror, the live catalog, or `none` for an
   * empty ID selection that reached neither.
   */
  async searchBooks(
    params: SearchParams,
    ctx: Context,
  ): Promise<{
    books: Book[];
    totalCount: number;
    hasMore: boolean;
    page: number;
    source: 'mirror' | 'live' | 'none';
  }> {
    ctx.signal.throwIfAborted();
    params = normalizeSearchParams(params);
    const pageNumber = params.page ?? 1;
    if (params.ids?.length === 0)
      return { books: [], totalCount: 0, hasMore: false, page: pageNumber, source: 'none' };
    const mirrored = await this.mirrorSearch(params, ctx);
    ctx.signal.throwIfAborted();
    if (mirrored !== null) {
      if (pageNumber > 1 && (pageNumber - 1) * 32 >= mirrored.total) {
        throw notFound('The requested page is beyond the available result range.', {
          reason: 'page_out_of_range',
        });
      }
      return {
        books: mirrored.books,
        totalCount: mirrored.total,
        hasMore: pageNumber * 32 < mirrored.total,
        page: pageNumber,
        source: 'mirror',
      };
    }
    if (params.translator) {
      throw validationError('The translator filter requires the local catalog mirror.', {
        reason: 'translator_requires_mirror',
        ...ctx.recoveryFor('translator_requires_mirror'),
      });
    }
    if ((params.query?.split(' ').length ?? 0) > 4) {
      throw validationError('More than four query words require the local catalog mirror.', {
        reason: 'query_requires_mirror',
        ...ctx.recoveryFor('query_requires_mirror'),
      });
    }
    const page = await this.fetchPage(params, ctx);
    const books = page.results.map(normalizeBook);
    return {
      books,
      totalCount: page.count,
      hasMore: page.next !== null,
      page: pageNumber,
      source: 'live',
    };
  }

  /** A valid empty answer is distinct from an unavailable mirror. */
  private async mirrorSearch(params: SearchParams, ctx: Context) {
    try {
      const mirror = getCatalogMirrorService();
      if (!(await mirror.ready())) return null;
      ctx.signal.throwIfAborted();
      return await mirror.searchBooks(params);
    } catch (err: unknown) {
      if (ctx.signal.aborted) throw err;
      ctx.log.debug('Catalog mirror unavailable; falling back to the live catalog');
      return null;
    }
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
   * availability optimization layered under a working upstream path; a corrupt
   * database or a missing file should cost latency, never correctness.
   */
  private async mirrorBook(id: number, ctx: Context): Promise<Book | null> {
    try {
      const mirror = getCatalogMirrorService();
      if (!(await mirror.ready())) return null;
      const [book] = await mirror.getBooks([id]);
      return book ?? null;
    } catch (err: unknown) {
      ctx.log.debug("Catalog mirror unavailable; falling back to the book's RDF record", {
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetch a single book by Gutenberg ID. Serves from the local mirror when it holds
   * the record, and otherwise reads the book's own RDF record from the content mirror
   * the text comes from, parsed exactly as the mirror harvest parses it. That record is
   * Project Gutenberg's authority for the ID, so its 404 is `not_found`. Gutendex is
   * never asked: it is slow or silent for the books a mirror lacks, those posted since
   * the last harvest.
   *
   * @param deadlineAtMs - Absolute deadline a caller shares with later upstream work;
   *   the lookup takes at most the catalog budget out of it.
   */
  async getBook(id: number, ctx: Context, deadlineAtMs?: number): Promise<Book> {
    const mirrored = await this.mirrorBook(id, ctx);
    if (mirrored !== null) {
      ctx.log.debug('Catalog mirror hit', { id });
      return mirrored;
    }

    /** The parsed record; the retired `gutendex/book/<id>` key held a Gutendex payload. */
    const cacheKey = `gutenberg/book/v1/${id}`;
    const cached = await ctx.state.get<Book>(cacheKey);
    if (cached) {
      ctx.log.debug('Book cache hit', { id });
      return cached;
    }

    const budgetMs =
      deadlineAtMs === undefined
        ? CATALOG_BUDGET_MS
        : Math.max(0, Math.min(CATALOG_BUDGET_MS, deadlineAtMs - Date.now()));
    const book = await fetchCatalogDocument(
      {
        url: `${this.contentBaseUrl}/cache/epub/${id}/pg${id}.rdf`,
        operation: 'GutendexService.getBook',
        subject: `the lookup for book ${id}`,
        unavailableMessage: `The Project Gutenberg catalog did not respond for book ${id}.`,
        /**
         * The parser raises nothing on a body that ends between tags and returns the
         * record read so far, so a record counts only once its root element closes.
         * Parsing first keeps a malformed body's parser error on `cause`.
         */
        parse: (text) => {
          const book = parseBookRdf(text, id);
          return book !== null && text.trimEnd().endsWith('</rdf:RDF>') ? book : null;
        },
        onNotFound: () =>
          notFound(`No book found with Gutenberg ID ${id}.`, { reason: 'not_found' }),
      },
      ctx,
      budgetMs,
    );

    await bestEffortCache(ctx, cacheKey, book, CATALOG_TTL_SECONDS);
    return book;
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
