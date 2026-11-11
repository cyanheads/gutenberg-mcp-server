/**
 * @fileoverview Tests for GutendexService — the has_plain_text computed flag that
 * gates gutenberg_get_text readability, the catalog retry ladder, the failure
 * classification shared by the live search and the per-book RDF lookup, and the
 * per-book record cache, all driven against a stubbed HTTP boundary so the real
 * withRetry/fetchWithTimeout path runs.
 * @module tests/services/gutendex/gutendex-service.test
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetBook } from '@/mcp-server/tools/definitions/gutenberg-get-book.tool.js';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import { GutenbergTextService } from '@/services/gutenberg-text/gutenberg-text-service.js';
import { GutendexService } from '@/services/gutendex/gutendex-service.js';
import type { RawBook } from '@/services/gutendex/types.js';
import { hasPlainText } from '@/services/gutendex/types.js';

/** Build a minimal RawBook, overriding only the fields a case cares about. */
function makeRawBook(overrides: Partial<RawBook>): RawBook {
  return {
    id: 1,
    title: 'Test Book',
    authors: [],
    translators: [],
    subjects: [],
    bookshelves: [],
    languages: ['en'],
    copyright: false,
    media_type: 'Text',
    download_count: 0,
    formats: {},
    ...overrides,
  };
}

describe('hasPlainText', () => {
  it('is true for a Text book with a UTF-8 plain-text format', () => {
    const book = makeRawBook({
      formats: { 'text/plain; charset=utf-8': 'https://example/pg1.txt' },
    });
    expect(hasPlainText(book)).toBe(true);
  });

  it('is false for a Text book whose only plain-text format is us-ascii', () => {
    // Regression (#7): us-ascii-only entries are no longer served by
    // gutenberg_get_text (no sanctioned-mirror path), so the flag must not
    // advertise them as readable.
    const book = makeRawBook({
      formats: { 'text/plain; charset=us-ascii': 'https://example/1.txt' },
    });
    expect(hasPlainText(book)).toBe(false);
  });

  it('is true when both us-ascii and UTF-8 are present (UTF-8 is served)', () => {
    const book = makeRawBook({
      formats: {
        'text/plain; charset=us-ascii': 'https://example/1.txt',
        'text/plain; charset=utf-8': 'https://example/pg1.txt',
      },
    });
    expect(hasPlainText(book)).toBe(true);
  });

  it('is false for an HTML-only book (the flag tracks plain text, not HTML-fallback readability)', () => {
    const book = makeRawBook({ formats: { 'text/html': 'https://example/pg1.html' } });
    expect(hasPlainText(book)).toBe(false);
  });

  it('is false when media_type is not "Text" even with a UTF-8 text/plain format', () => {
    // Audio books can carry text/plain readme entries — the media_type guard
    // keeps them from being flagged as readable literary text.
    const book = makeRawBook({
      media_type: 'Sound',
      formats: { 'text/plain; charset=utf-8': 'https://example/readme.txt' },
    });
    expect(hasPlainText(book)).toBe(false);
  });
});

// ── Catalog ladder against a stubbed HTTP boundary (#12) ─────────────────────
//
// These drive the real withRetry + fetchWithTimeout path. A mock that returns a
// non-2xx Response would be green on dead code — the real helper throws — so the
// upstream is stubbed at fetch and the service is the genuine article.

/** Host the stubbed catalog answers on. No real request ever leaves the suite. */
const CATALOG_HOST = 'https://catalog.test';
const CATALOG_BASE = `${CATALOG_HOST}/books/`;
/** Matches every catalog URL, whatever query the search builder produced. */
const ANY_CATALOG_URL = /^https:\/\/catalog\.test\/books\//;
/** Content mirror that serves the text and each book's own RDF record. */
const MIRROR_HOST = 'https://mirror.test';
/** Where a lookup the local mirror cannot answer reads the book's catalog record. */
const rdfUrl = (id: number) => `${MIRROR_HOST}/cache/epub/${id}/pg${id}.rdf`;
const RDF_DIR = new URL('../../fixtures/catalog-mirror/rdf/', import.meta.url);

/** An unedited per-book RDF document from the upstream archive. */
function readRdf(id: number): string {
  return readFileSync(new URL(`pg${id}.rdf`, RDF_DIR), 'utf8');
}

/** The title `pg84.rdf` normalizes to. */
const FRANKENSTEIN = 'Frankenstein; or, the modern prometheus';

function makeService(): GutendexService {
  return new GutendexService({} as AppConfig, createInMemoryStorage(), {
    gutendexBaseUrl: CATALOG_BASE,
    gutenbergTextBaseUrl: MIRROR_HOST,
    mirrorPath: ':memory:',
  });
}

/** An upstream that accepts the request and never answers until aborted. */
function stallingResponder(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason);
      return;
    }
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
}

const rawBook: RawBook = {
  id: 1342,
  title: 'Pride and Prejudice',
  authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
  translators: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 75000,
  formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/1342.txt.utf-8' },
};

describe('GutendexService — catalog ladder', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it.each([
    ['Text', { 'text/html': 'https://example/book.html' }, true, false],
    ['Text', { 'text/plain; charset=utf-8': 'https://example/book.txt' }, true, true],
    ['Sound', { 'text/html': 'https://example/readme.html' }, false, false],
    ['Image', { 'text/html': 'https://example/book.html' }, false, false],
    [
      'Text',
      { 'text/html': 'https://example/book.html', 'audio/mpeg': 'https://example/audio.mp3' },
      false,
      false,
    ],
    [
      'Text',
      {
        'text/plain; charset=utf-8': 'https://example/book.txt',
        'audio/mpeg': 'https://example/audio.mp3',
      },
      true,
      true,
    ],
    ['Text', { 'text/plain; charset=us-ascii': 'https://example/book.txt' }, false, false],
  ])(
    'normalizes %s readability with formats %j on live and cached search pages',
    async (media_type, formats, readable, plain) => {
      http.route({
        match: ANY_CATALOG_URL,
        respond: () =>
          Response.json({
            count: 1,
            next: null,
            previous: null,
            results: [{ ...rawBook, media_type, formats }],
          }),
      });
      const service = makeService();
      const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
      for (let i = 0; i < 2; i++) {
        const { books } = await service.searchBooks({ ids: [1342] }, ctx);
        expect(books[0]).toMatchObject({
          is_readable: readable,
          has_plain_text: plain,
          source_notes: null,
        });
      }
      expect(http.calls).toHaveLength(1);
    },
  );

  it('returns a parsed page on the first attempt', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const result = await makeService().searchBooks({ query: 'austen' }, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.books[0]?.id).toBe(1342);
    expect(result.books[0]?.has_plain_text).toBe(true);
    expect(result.source).toBe('live');
    expect(http.calls).toHaveLength(1);
  });

  it('normalizes live and cached search titles while preserving literal dollars and summary order', async () => {
    let title = 'Peter Pan : $b [Peter and Wendy]';
    http.route({
      match: ANY_CATALOG_URL,
      respond: () =>
        Response.json({
          count: 1,
          next: null,
          previous: null,
          results: [{ ...rawBook, title, summaries: ['Z first', 'A second'] }],
        }),
    });
    const service = makeService();
    const ctx = createMockContext();
    for (let index = 0; index < 2; index++) {
      expect((await service.searchBooks({ ids: [1342] }, ctx)).books[0]).toMatchObject({
        title: 'Peter Pan: [Peter and Wendy]',
        summary: 'Z first',
        summaries: ['Z first', 'A second'],
      });
    }
    expect(http.calls).toHaveLength(1);
    title = 'The $30,000 Bequest, and Other Stories';
    expect((await service.searchBooks({ ids: [1343] }, ctx)).books[0]?.title).toBe(
      'The $30,000 Bequest, and Other Stories',
    );
  });

  it('characterizes literal punctuation and four search words on the live URL', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    await makeService().searchBooks(
      { query: 'austen pride % _', ids: [1342], sort: 'ascending' },
      createMockContext(),
    );
    const url = new URL(http.calls[0]!.request.url);
    expect(url.searchParams.get('search')).toBe('austen pride % _');
    expect(url.searchParams.get('ids')).toBe('1342');
    expect(url.searchParams.get('sort')).toBe('ascending');
  });

  it('returns an explicit empty selection without catalog I/O', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    const result = await makeService().searchBooks(
      { ids: [], query: 'one two three four five', page: 99 },
      createMockContext(),
    );
    expect(result).toEqual({ books: [], totalCount: 0, hasMore: false, page: 99, source: 'none' });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects more than four live query words before catalog I/O', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    await expect(
      makeService().searchBooks({ query: 'dickens a tale of two' }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'query_requires_mirror' } });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects a translator filter before catalog I/O and ahead of the long-query check', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    for (const params of [
      { translator: 'maude' },
      { translator: 'maude', query: 'dickens a tale of two' },
    ]) {
      await expect(makeService().searchBooks(params, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'translator_requires_mirror',
          recovery: { hint: expect.stringContaining('gutenberg_get_book') },
        },
      });
    }
    expect(http.calls).toHaveLength(0);
  });

  it('treats a blank translator as unset on the live path', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    await makeService().searchBooks({ translator: '   ' }, createMockContext());
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.request.url).searchParams.has('translator')).toBe(false);
  });

  it('answers an empty selection ahead of a translator filter', async () => {
    const result = await makeService().searchBooks(
      { ids: [], translator: 'maude' },
      createMockContext(),
    );
    expect(result).toMatchObject({ books: [], totalCount: 0, source: 'none' });
    expect(http.calls).toHaveLength(0);
  });

  it.each(['page', 'book'])(
    'allows a six-second %s response to finish in one attempt',
    async (kind) => {
      vi.useFakeTimers();
      http.route({
        match: kind === 'book' ? rdfUrl(84) : ANY_CATALOG_URL,
        respond: (request) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () =>
                resolve(
                  kind === 'book'
                    ? new Response(readRdf(84))
                    : Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
                ),
              6000,
            );
            request.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(request.signal.reason);
              },
              { once: true },
            );
          }),
      });
      const service = makeService();
      const pending = (
        kind === 'book'
          ? service.getBook(84, createMockContext())
          : service.searchBooks({}, createMockContext())
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(16000);
      expect(await pending).toMatchObject(
        kind === 'book' ? { id: 84, title: FRANKENSTEIN } : { totalCount: 1 },
      );
      expect(http.calls).toHaveLength(1);
    },
  );

  it('keeps a page-beyond-range 404 as page_out_of_range and does not retry it', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ detail: 'Invalid page.' }, { status: 404 }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const err = (await makeService()
      .searchBooks({ query: 'austen', page: 99 }, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'page_out_of_range' });
    // Non-transient: one request, and the deadline left the classification alone.
    expect(http.calls).toHaveLength(1);
  });

  it('answers a missing book as not_found from its RDF 404, with no retry and no Gutendex request', async () => {
    http.route({
      match: rdfUrl(99999999),
      respond: () =>
        new Response('<html><head><title>404 Not Found</title></head></html>', { status: 404 }),
    });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const err = (await makeService()
      .getBook(99999999, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect(err.message).toBe('No book found with Gutenberg ID 99999999.');
    expect(http.calls.map((call) => call.request.url)).toEqual([rdfUrl(99999999)]);
  });

  it('classifies a non-page search 404 as catalog_rejected, not an exhausted page or outage', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ detail: 'Not found.' }, { status: 404 }),
    });
    const error = await makeService()
      .searchBooks({ page: 99 }, createMockContext({ errors: gutenbergSearchBooks.errors }))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'catalog_rejected' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([false, true])(
    'keeps standalone network allowance after a cache wait (shared deadline: %s)',
    async (shared) => {
      vi.useFakeTimers();
      const ctx = createMockContext({ errors: gutenbergGetBook.errors });
      vi.spyOn(ctx.state, 'get').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return null;
      });
      http.route({
        match: rdfUrl(84),
        respond: (request) =>
          new Response(
            new ReadableStream({
              start(controller) {
                const timer = setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode(readRdf(84)));
                  controller.close();
                }, 14000);
                request.signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    controller.error(request.signal.reason);
                  },
                  { once: true },
                );
              },
            }),
          ),
      });
      const deadlineAtMs = Date.now() + 15000;
      const pending = (
        shared ? makeService().getBook(84, ctx, deadlineAtMs) : makeService().getBook(84, ctx)
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(17000);
      expect(await pending).toMatchObject(
        shared ? { data: { reason: 'catalog_unavailable' } } : { id: 84, title: FRANKENSTEIN },
      );
      expect(http.calls).toHaveLength(1);
    },
  );

  it('lets a retry consume the remaining budget after a fast transient failure', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => {
        attempt += 1;
        return attempt === 1
          ? new Response('busy', { status: 503 })
          : new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
                  ),
                6000,
              ),
            );
      },
    });
    const pending = makeService().searchBooks({}, createMockContext());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ totalCount: 1 });
    expect(http.calls).toHaveLength(2);
  });

  it('reports an exhausted ladder as catalog_unavailable with recovery, leaking no URL', async () => {
    vi.useFakeTimers();
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => new Response('upstream busy', { status: 503 }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const pending = makeService()
      .searchBooks({ query: 'austen' }, ctx)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(12_000);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: expect.any(String) },
    });
    expect(err.message).not.toContain(CATALOG_HOST);
    expect(err.message).not.toContain('austen');
    // The upstream's own error payload and status stay server-side on `cause`.
    expect(err.data).not.toHaveProperty('body');
    expect(err.data).not.toHaveProperty('status');
    expect(err.cause).toBeInstanceOf(McpError);
    // A fast-failing upstream still spends every attempt inside the budget.
    expect(http.calls).toHaveLength(4);
  });

  it.each(['search', 'book'] as const)(
    'aborts a stalled %s ladder at the budget rather than running attempts out',
    async (kind) => {
      vi.useFakeTimers();
      http.route({ match: () => true, respond: stallingResponder });
      const ctx = createMockContext({
        errors: kind === 'book' ? gutenbergGetBook.errors : gutenbergSearchBooks.errors,
      });

      const pending = (
        kind === 'book'
          ? makeService().getBook(84, ctx)
          : makeService().searchBooks({ query: 'austen' }, ctx)
      ).catch((e: unknown) => e);

      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(14_900);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      const err = (await pending) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({
        reason: 'catalog_unavailable',
        recovery: { hint: expect.any(String) },
      });
      // The budget fired mid-attempt, so the ladder never reached its own
      // exhaustion enrichment — neither marker is present.
      expect(err.data).not.toHaveProperty('retryAttempts');
      expect(err.message).not.toContain('failed after');
      // A still-running attempt consumes the budget rather than being restarted.
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each(['search', 'book'] as const)(
    'propagates a caller cancel landing mid-fetch on the %s lookup instead of reporting an outage',
    async (kind) => {
      const controller = new AbortController();
      http.route({
        match: () => true,
        respond: (request) => {
          controller.abort('client gave up');
          return stallingResponder(request);
        },
      });
      const ctx = createMockContext({
        errors: kind === 'book' ? gutenbergGetBook.errors : gutenbergSearchBooks.errors,
        signal: controller.signal,
      });

      const err = (await (kind === 'book'
        ? makeService().getBook(84, ctx)
        : makeService().searchBooks({ query: 'austen' }, ctx)
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.data).toMatchObject({ errorSource: 'FetchAborted' });
      expect(err.data).not.toHaveProperty('reason');
      expect(http.calls).toHaveLength(1);
    },
  );

  it('settles a slow catalog hop plus stalled text hop below the client timeout', async () => {
    vi.useFakeTimers();
    http.route({
      match: rdfUrl(84),
      respond: () =>
        new Promise((resolve) => setTimeout(() => resolve(new Response(readRdf(84))), 14000)),
    });
    http.route({ match: `${MIRROR_HOST}/cache/epub/84/pg84.txt`, respond: stallingResponder });
    const ctx = createMockContext();
    const text = new GutenbergTextService({} as AppConfig, createInMemoryStorage(), {
      gutendexBaseUrl: CATALOG_BASE,
      gutenbergTextBaseUrl: MIRROR_HOST,
      mirrorPath: ':memory:',
    });
    const deadlineAtMs = Date.now() + 50_000;
    const pending = makeService()
      .getBook(84, ctx, deadlineAtMs)
      .then((book) => text.fetchAndCacheText(book, 84, ctx, deadlineAtMs))
      .catch((error: unknown) => error);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(49900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ data: { reason: 'text_fetch_failed' } });
    expect(settled).toBe(true);
    expect(http.calls.filter((call) => call.request.url === rdfUrl(84))).toHaveLength(1);
  });

  it.each(['search', 'book'] as const)(
    'propagates a caller cancel landing mid-backoff on the %s lookup, reason string and all',
    async (kind) => {
      // A notifications/cancelled carries the client's reason as a bare string, and
      // withRetry's sleep rejects with that value verbatim — not an Error.
      const controller = new AbortController();
      let attempts = 0;
      http.route({
        match: () => true,
        respond: () => {
          attempts += 1;
          if (attempts === 1) setTimeout(() => controller.abort('client gave up'), 10);
          return new Response('upstream busy', { status: 503 });
        },
      });
      const ctx = createMockContext({
        errors: kind === 'book' ? gutenbergGetBook.errors : gutenbergSearchBooks.errors,
        signal: controller.signal,
      });

      const err = await (kind === 'book'
        ? makeService().getBook(84, ctx)
        : makeService().searchBooks({ query: 'austen' }, ctx)
      ).catch((e: unknown) => e);

      expect(err).toBe('client gave up');
      expect(http.calls).toHaveLength(1);
    },
  );
});

// ── Catalog failure classification (#58, #59) ────────────────────────────────
//
// One table for the classifier both catalog fetches share: the live search page
// and the per-book RDF a lookup reads when the local mirror cannot answer.

const BOT_PAGE =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
/** Upstream text no failure may carry to a client: an origin, a body, or parser output. */
const UPSTREAM_TEXT = [
  'mirror.test',
  'catalog.test',
  '://',
  'secret upstream body',
  'Just a moment',
  'not json',
  'JSON',
  'Unexpected',
  'readTagExp',
  'dcterms',
];

const LOOKUPS = {
  book: {
    run: (service: GutendexService, ctx: Context) => service.getBook(84, ctx),
    errors: gutenbergGetBook.errors,
    match: rdfUrl(84),
    rejected: 'The Project Gutenberg catalog rejected the lookup for book 84.',
    unavailable: 'The Project Gutenberg catalog did not respond for book 84.',
  },
  search: {
    run: (service: GutendexService, ctx: Context) =>
      service.searchBooks({ query: 'frankenstein' }, ctx),
    errors: gutenbergSearchBooks.errors,
    match: ANY_CATALOG_URL,
    rejected: 'The Project Gutenberg catalog rejected the search request.',
    unavailable: 'The Project Gutenberg catalog did not respond.',
  },
} as const;
type Lookup = keyof typeof LOOKUPS;

/** The recovery a tool declares for a reason — what the service must put on the throw. */
function declaredRecovery(lookup: Lookup, reason: string): string | undefined {
  return (LOOKUPS[lookup].errors as readonly { reason: string; recovery: string }[]).find(
    (entry) => entry.reason === reason,
  )?.recovery;
}

/** Every error on the `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let node = error; node instanceof Error; node = node.cause) chain.push(node);
  return chain;
}

/** The string-keyed message and data a client envelope is built from. */
function wireText(error: McpError): string {
  return JSON.stringify({
    message: error.message,
    data: Object.fromEntries(Object.entries(error.data ?? {})),
  });
}

/** Settle a lookup, letting fake time run out every backoff and the whole budget. */
async function settle(lookup: Lookup): Promise<McpError> {
  const pending = LOOKUPS[lookup]
    .run(makeService(), createMockContext({ errors: LOOKUPS[lookup].errors }))
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(16_000);
  return (await pending) as McpError;
}

describe('GutendexService — catalog failure classification', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
    vi.useFakeTimers();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it.each([
    ...[400, 401, 403, 405, 410, 451, 501].flatMap((status) =>
      (['book', 'search'] as const).map((lookup) => [lookup, status] as const),
    ),
    ['search', 404] as const,
  ])('classifies a %s HTTP %i as catalog_rejected after one request', async (lookup, status) => {
    http.route({
      match: LOOKUPS[lookup].match,
      respond: () => new Response('secret upstream body', { status }),
    });

    const err = await settle(lookup);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.message).toBe(LOOKUPS[lookup].rejected);
    expect(Object.fromEntries(Object.entries(err.data ?? {}))).toEqual({
      reason: 'catalog_rejected',
      recovery: { hint: declaredRecovery(lookup, 'catalog_rejected') },
    });
    for (const leak of UPSTREAM_TEXT) expect(wireText(err)).not.toContain(leak);
    // The upstream answer stays on `cause` for the server log.
    expect((err.cause as McpError).data).toMatchObject({ status, body: 'secret upstream body' });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ...[408, 429, 500, 502, 503, 504].flatMap((status) =>
      (['book', 'search'] as const).map((lookup) => [lookup, status] as const),
    ),
  ])(
    'retries a %s HTTP %i inside the budget, then reports catalog_unavailable',
    async (lookup, status) => {
      http.route({
        match: LOOKUPS[lookup].match,
        respond: () => new Response('secret upstream body', { status }),
      });

      const err = await settle(lookup);

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(LOOKUPS[lookup].unavailable);
      expect(Object.fromEntries(Object.entries(err.data ?? {}))).toEqual({
        reason: 'catalog_unavailable',
        recovery: { hint: declaredRecovery(lookup, 'catalog_unavailable') },
      });
      for (const leak of UPSTREAM_TEXT) expect(wireText(err)).not.toContain(leak);
      expect(http.calls).toHaveLength(4);
    },
  );

  it.each(['book', 'search'] as const)(
    'fails a %s 429 whose Retry-After outlasts the cap fast, as catalog_unavailable',
    async (lookup) => {
      http.route({
        match: LOOKUPS[lookup].match,
        respond: () =>
          new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      });

      const err = await settle(lookup);

      expect(err.data).toMatchObject({ reason: 'catalog_unavailable' });
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each(['book', 'search'] as const)(
    'retries a %s network failure, then reports catalog_unavailable',
    async (lookup) => {
      http.route({
        match: LOOKUPS[lookup].match,
        respond: () => Promise.reject(new TypeError('fetch failed')),
      });

      const err = await settle(lookup);

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(LOOKUPS[lookup].unavailable);
      expect(err.data).toMatchObject({ reason: 'catalog_unavailable' });
      expect(http.calls).toHaveLength(4);
    },
  );

  it.each([
    ['book', 'an HTML page', BOT_PAGE],
    ['search', 'an HTML page', BOT_PAGE],
    ['book', 'plain text', 'not json at all'],
    ['search', 'plain text', 'not json at all'],
    ['book', 'an empty body', ''],
    ['search', 'an empty body', ''],
    ['book', 'a truncated record', readRdf(84).slice(0, 2971)],
    [
      'book',
      'a record with no ebook',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>',
    ],
    ['search', 'JSON that is not a page', '{"detail":"dcterms"}'],
    ['search', 'a JSON null', 'null'],
  ] as const)(
    'reports a %s 200 carrying %s as catalog_unavailable, with no upstream text',
    async (lookup, _shape, body) => {
      http.route({ match: LOOKUPS[lookup].match, respond: () => new Response(body) });

      const err = await settle(lookup);

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(LOOKUPS[lookup].unavailable);
      expect(Object.fromEntries(Object.entries(err.data ?? {}))).toEqual({
        reason: 'catalog_unavailable',
        recovery: { hint: declaredRecovery(lookup, 'catalog_unavailable') },
      });
      for (const leak of UPSTREAM_TEXT) expect(wireText(err)).not.toContain(leak);
      // An unreadable document is retried like an outage, as the HTML page always was.
      expect(http.calls).toHaveLength(4);
    },
  );

  it.each([
    ['search', 'not json at all', (node: unknown) => node instanceof SyntaxError],
    [
      'book',
      readRdf(84).slice(0, 2971),
      (node: unknown) => node instanceof Error && node.message.includes('readTagExp'),
    ],
  ] as const)(
    'keeps the %s parser failure on the cause chain for the server log',
    async (lookup, body, isParserError) => {
      http.route({ match: LOOKUPS[lookup].match, respond: () => new Response(body) });

      const err = await settle(lookup);

      expect(err.data).toMatchObject({ reason: 'catalog_unavailable' });
      expect(causeChain(err).some(isParserError)).toBe(true);
    },
  );
});

// ── Per-book RDF lookup and its cache (#59) ──────────────────────────────────

describe('GutendexService — per-book RDF lookup', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('reads a book the mirror cannot answer from its own RDF record, with no Gutendex request', async () => {
    http.route({
      match: rdfUrl(79964),
      respond: () =>
        new Response(readRdf(79964), { headers: { 'content-type': 'application/octet-stream' } }),
    });

    const book = await makeService().getBook(
      79964,
      createMockContext({ errors: gutenbergGetBook.errors }),
    );

    expect(book).toMatchObject({
      id: 79964,
      title: 'Mothers still',
      authors: [{ name: 'Hull, Helen R. (Helen Rose)', birth_year: 1888, death_year: 1971 }],
      languages: ['en'],
      copyright: false,
      media_type: 'Text',
      has_plain_text: true,
      is_readable: true,
      source_notes: [],
      formats: {
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/files/79964/79964-0.txt',
        'text/html': 'https://www.gutenberg.org/files/79964/79964-h/79964-h.htm',
      },
    });
    expect(http.calls.map((call) => call.request.url)).toEqual([rdfUrl(79964)]);
  });

  it('keeps direct bibliographic notes from the record, which the live catalog never carried', async () => {
    http.route({ match: rdfUrl(84), respond: () => new Response(readRdf(84)) });

    const book = await makeService().getBook(84, createMockContext());

    expect(book.source_notes).toEqual(
      expect.arrayContaining([expect.stringContaining('#41445 (1818 ed.) and #42324 (1831 ed.)')]),
    );
  });

  it('caches the parsed record for an hour, so a repeat makes no request', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-11T00:00:00Z') });
    http.route({ match: rdfUrl(84), respond: () => new Response(readRdf(84)) });
    const service = makeService();
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const first = await service.getBook(84, ctx);
    expect(first.title).toBe(FRANKENSTEIN);
    vi.setSystemTime(new Date('2026-11-11T00:59:00Z'));
    expect(await service.getBook(84, ctx)).toEqual(first);
    expect(http.calls).toHaveLength(1);
    // The entry is the parsed record, not the RDF document it came from.
    expect(await ctx.state.get('gutenberg/book/v1/84')).toEqual(first);

    vi.setSystemTime(new Date('2026-11-11T01:00:01Z'));
    await service.getBook(84, ctx);
    expect(http.calls).toHaveLength(2);
  });

  it('ignores a Gutendex record cached under the retired key', async () => {
    http.route({ match: rdfUrl(84), respond: () => new Response(readRdf(84)) });
    const ctx = createMockContext();
    await ctx.state.set('gutendex/book/84', { ...rawBook, id: 84, title: 'Stale Gutendex shape' });

    const book = await makeService().getBook(84, ctx);

    expect(book.title).toBe(FRANKENSTEIN);
    expect(http.calls).toHaveLength(1);
  });
});

// ── Catalog host disclosure through ctx.log (#14) ────────────────────────────

describe('GutendexService — log payload disclosure', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('emits no log payload carrying the configured catalog host on a cache hit', async () => {
    // ctx.log is dual-sink, so a URL in the payload is a URL a client that raised
    // its log level reads. Assert the host is absent rather than that the search
    // arguments are present — only the former catches a re-added url field.
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const service = makeService();

    await service.searchBooks({ query: 'austen', languages: ['en'] }, ctx);
    await service.searchBooks({ query: 'austen', languages: ['en'] }, ctx);

    expect(http.calls).toHaveLength(1);
    const payloads = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(payloads).not.toContain(CATALOG_HOST);
    expect(payloads).not.toContain('/books/');
  });

  it('keeps the search arguments in the cache-hit log so it stays diagnosable', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ count: 1, next: null, previous: null, results: [rawBook] }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const service = makeService();

    await service.searchBooks({ query: 'austen', languages: ['en'], page: 2 }, ctx);
    await service.searchBooks({ query: 'austen', languages: ['en'], page: 2 }, ctx);

    const hit = (ctx.log as MockContextLogger).calls.find(
      (call) => call.msg === 'Catalog cache hit',
    );
    expect(hit?.data).toMatchObject({ query: 'austen', languages: ['en'], page: 2 });
  });

  it('emits no catalog or content-mirror host on a single-book cache hit', async () => {
    http.route({ match: rdfUrl(84), respond: () => new Response(readRdf(84)) });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const service = makeService();

    await service.getBook(84, ctx);
    await service.getBook(84, ctx);

    expect(http.calls).toHaveLength(1);
    const payloads = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(payloads).not.toContain(CATALOG_HOST);
    expect(payloads).not.toContain(MIRROR_HOST);
  });
});

// ── Upstream editors and summaries preserved through normalization (#11) ─────
//
// Only the live search normalizes Gutendex records; a single-book lookup the local
// mirror cannot answer reads the book's RDF instead.

/** One live search page holding `book`, as Gutendex answers an `ids` query. */
function pageOf(book: RawBook) {
  return { count: 1, next: null, previous: null, results: [book] };
}

describe('GutendexService — normalizeBook fidelity', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  /** Shaped after the live Gutendex record for 45304, which carries one editor. */
  const editedRawBook: RawBook = makeRawBook({
    id: 45304,
    title: 'The City of God, Volume I',
    authors: [{ name: 'Augustine, of Hippo, Saint', birth_year: 354, death_year: 430 }],
    editors: [{ name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 }],
    summaries: ['A work of Christian philosophy.'],
  });

  /** Shaped after the live Gutendex record for 76639, which carries two summaries. */
  const twoSummaryRawBook: RawBook = makeRawBook({
    id: 76639,
    title: 'Eloisa : $b or, A series of original letters',
    translators: [{ name: 'Kenrick, W. (William)', birth_year: null, death_year: 1779 }],
    summaries: [
      'The first English translation of Julie, ou La Nouvelle Heloise.',
      'A shorter blurb.',
    ],
  });

  it('populates editors from the upstream array instead of hardcoding empty', async () => {
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(pageOf(editedRawBook)) });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const result = await makeService().searchBooks({ ids: [45304] }, ctx);

    expect(result.books[0]?.editors).toEqual([
      { name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 },
    ]);
    expect(result.books[0]?.summaries).toEqual(['A work of Christian philosophy.']);
  });

  it('preserves every upstream summary in upstream order and keeps summary as the first', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json(pageOf(twoSummaryRawBook)),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const [book] = (await makeService().searchBooks({ ids: [76639] }, ctx)).books;

    expect(book?.summaries).toEqual([
      'The first English translation of Julie, ou La Nouvelle Heloise.',
      'A shorter blurb.',
    ]);
    expect(book?.summary).toBe('The first English translation of Julie, ou La Nouvelle Heloise.');
  });

  it('falls back to empty collections when upstream omits editors and summaries', async () => {
    // Gutendex sends both keys, but the raw type marks them optional and older
    // cached payloads may predate a field — normalization must not throw or
    // invent entries.
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(pageOf(rawBook)) });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const [book] = (await makeService().searchBooks({ ids: [1342] }, ctx)).books;

    expect(book?.editors).toEqual([]);
    expect(book?.summaries).toEqual([]);
    expect(book?.summary).toBeNull();
  });
});
