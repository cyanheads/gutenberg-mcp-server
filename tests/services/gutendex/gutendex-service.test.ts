/**
 * @fileoverview Tests for GutendexService — the has_plain_text computed flag that
 * gates gutenberg_get_text readability, plus the catalog retry ladder driven
 * against a stubbed HTTP boundary so the real withRetry/fetchWithTimeout path runs.
 * @module tests/services/gutendex/gutendex-service.test
 */

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
import { GutendexService, hasPlainText } from '@/services/gutendex/gutendex-service.js';
import type { RawBook } from '@/services/gutendex/types.js';

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

function makeService(): GutendexService {
  return new GutendexService({} as AppConfig, createInMemoryStorage(), {
    gutendexBaseUrl: CATALOG_BASE,
    gutenbergTextBaseUrl: 'https://mirror.test',
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
    expect(http.calls).toHaveLength(1);
  });

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

  it('keeps a missing book as not_found and does not retry it', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => Response.json({ detail: 'Not found.' }, { status: 404 }),
    });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const err = (await makeService()
      .getBook(9999999, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect(http.calls).toHaveLength(1);
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

  it('aborts a stalled ladder at the budget rather than running attempts out', async () => {
    vi.useFakeTimers();
    http.route({ match: ANY_CATALOG_URL, respond: stallingResponder });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const pending = makeService()
      .searchBooks({ query: 'austen' }, ctx)
      .catch((e: unknown) => e);

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
    // Three attempts fit inside the budget; a single long per-attempt wait
    // would have allowed fewer.
    expect(http.calls).toHaveLength(3);
  });

  it('propagates a caller cancel landing mid-fetch instead of reporting an outage', async () => {
    const controller = new AbortController();
    http.route({
      match: ANY_CATALOG_URL,
      respond: (request) => {
        controller.abort('client gave up');
        return stallingResponder(request);
      },
    });
    const ctx = createMockContext({
      errors: gutenbergSearchBooks.errors,
      signal: controller.signal,
    });

    const err = (await makeService()
      .searchBooks({ query: 'austen' }, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({ errorSource: 'FetchAborted' });
    expect(err.data).not.toHaveProperty('reason');
    expect(err.code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(1);
  });

  it('propagates a caller cancel landing mid-backoff, reason string and all', async () => {
    // A notifications/cancelled carries the client's reason as a bare string, and
    // withRetry's sleep rejects with that value verbatim — not an Error.
    const controller = new AbortController();
    let attempts = 0;
    http.route({
      match: ANY_CATALOG_URL,
      respond: () => {
        attempts += 1;
        if (attempts === 1) setTimeout(() => controller.abort('client gave up'), 10);
        return new Response('upstream busy', { status: 503 });
      },
    });
    const ctx = createMockContext({
      errors: gutenbergSearchBooks.errors,
      signal: controller.signal,
    });

    const err = await makeService()
      .searchBooks({ query: 'austen' }, ctx)
      .catch((e: unknown) => e);

    expect(err).toBe('client gave up');
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

  it('emits no catalog host on a single-book cache hit', async () => {
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(rawBook) });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const service = makeService();

    await service.getBook(1342, ctx);
    await service.getBook(1342, ctx);

    expect(http.calls).toHaveLength(1);
    expect(JSON.stringify((ctx.log as MockContextLogger).calls)).not.toContain(CATALOG_HOST);
  });
});

// ── Upstream editors and summaries preserved through normalization (#11) ─────

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
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(editedRawBook) });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeService().getBook(45304, ctx);

    expect(book.editors).toEqual([{ name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 }]);
  });

  it('preserves every upstream summary and keeps summary as the first of them', async () => {
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(twoSummaryRawBook) });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeService().getBook(76639, ctx);

    expect(book.summaries).toEqual(twoSummaryRawBook.summaries);
    expect(book.summary).toBe(twoSummaryRawBook.summaries?.[0]);
  });

  it('normalizes editors on the search path too, not only single-book lookup', async () => {
    http.route({
      match: ANY_CATALOG_URL,
      respond: () =>
        Response.json({ count: 1, next: null, previous: null, results: [editedRawBook] }),
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    const result = await makeService().searchBooks({ ids: [45304] }, ctx);

    expect(result.books[0]?.editors).toHaveLength(1);
    expect(result.books[0]?.summaries).toEqual(['A work of Christian philosophy.']);
  });

  it('falls back to empty collections when upstream omits editors and summaries', async () => {
    // Gutendex sends both keys, but the raw type marks them optional and older
    // cached payloads may predate a field — normalization must not throw or
    // invent entries.
    http.route({ match: ANY_CATALOG_URL, respond: () => Response.json(rawBook) });
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });

    const book = await makeService().getBook(1342, ctx);

    expect(book.editors).toEqual([]);
    expect(book.summaries).toEqual([]);
    expect(book.summary).toBeNull();
  });
});
