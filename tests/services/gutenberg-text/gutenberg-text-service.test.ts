/**
 * @fileoverview Tests for GutenbergTextService's mirror ladder — the shared budget,
 * the sanitized text_fetch_failed contract it raises, and the boundaries of that
 * translation (caller cancels and cache errors are not upstream outages).
 * @module tests/services/gutenberg-text/gutenberg-text-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { databaseError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetText } from '@/mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import { GutenbergTextService } from '@/services/gutenberg-text/gutenberg-text-service.js';
import type { Book } from '@/services/gutendex/types.js';

/** Host the stubbed mirror answers on. No real request ever leaves the suite. */
const MIRROR_HOST = 'https://mirror.test';
const BOOK_ID = 1342;
/** The cache path resolveTextUrl derives from the id — what must not reach the client. */
const RESOLVED_URL = `${MIRROR_HOST}/cache/epub/${BOOK_ID}/pg${BOOK_ID}.txt`;

function makeService(): GutenbergTextService {
  return new GutenbergTextService({} as AppConfig, createInMemoryStorage(), {
    gutendexBaseUrl: 'https://catalog.test/books/',
    gutenbergTextBaseUrl: MIRROR_HOST,
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

const book: Book = {
  id: BOOK_ID,
  title: 'Pride and Prejudice',
  authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
  translators: [],
  editors: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 75000,
  summary: null,
  summaries: [],
  formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/1342.txt.utf-8' },
  has_plain_text: true,
};

const MIRROR_FILE = [
  'Title: Pride and Prejudice',
  '',
  '*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***',
  'It is a truth universally acknowledged.',
  '*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***',
  'License boilerplate.',
].join('\n');

describe('GutenbergTextService — mirror ladder', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  it('fetches, strips, and caches a book on the first attempt', async () => {
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });

    const entry = await makeService().fetchAndCacheText(book, BOOK_ID, ctx);

    expect(entry.text).toBe('It is a truth universally acknowledged.');
    expect(entry.sourceFormat).toBe('text/plain; charset=utf-8');
    expect(entry.title).toBe('Pride and Prejudice');
    expect(http.calls).toHaveLength(1);
  });

  it('reports an exhausted ladder as text_fetch_failed with recovery, naming the book not the mirror', async () => {
    vi.useFakeTimers();
    http.route({ match: RESOLVED_URL, respond: () => new Response('busy', { status: 503 }) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });

    const pending = makeService()
      .fetchAndCacheText(book, BOOK_ID, ctx)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'text_fetch_failed',
      recovery: { hint: expect.any(String) },
    });
    expect(err.message).toContain(String(BOOK_ID));
    expect(err.message).not.toContain(MIRROR_HOST);
    expect(err.message).not.toContain(RESOLVED_URL);
    expect(err.message).not.toContain('cache/epub');
    // The original — URL and all — stays reachable server-side for logs only.
    expect(err.cause).toBeInstanceOf(McpError);
    expect((err.cause as McpError).message).toContain('mirror.test');
    expect(http.calls).toHaveLength(4);
  });

  it('aborts a stalled mirror at the budget', async () => {
    vi.useFakeTimers();
    http.route({ match: RESOLVED_URL, respond: stallingResponder });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });

    const pending = makeService()
      .fetchAndCacheText(book, BOOK_ID, ctx)
      .catch((e: unknown) => e);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(34_900);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'text_fetch_failed',
      recovery: { hint: expect.any(String) },
    });
    expect(err.data).not.toHaveProperty('retryAttempts');
    expect(err.message).not.toContain('failed after');
  });

  it('propagates a caller cancel rather than reporting the mirror as failed', async () => {
    const controller = new AbortController();
    http.route({
      match: RESOLVED_URL,
      respond: (request) => {
        controller.abort('client gave up');
        return stallingResponder(request);
      },
    });
    const ctx = createMockContext({
      errors: gutenbergGetText.errors,
      signal: controller.signal,
    });

    const err = (await makeService()
      .fetchAndCacheText(book, BOOK_ID, ctx)
      .catch((e: unknown) => e)) as McpError;

    expect(err.data).toMatchObject({ errorSource: 'FetchAborted' });
    expect(err.data).not.toHaveProperty('reason');
    expect(err.code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('lets a cache-write failure bubble as itself instead of relabelling it text_fetch_failed', async () => {
    // The two ctx.state operations around the fetch are outside the mirror's
    // failure class — a storage error must not be handed the wrong recovery hint.
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const storageFailure = databaseError('Cache write rejected');
    vi.spyOn(ctx.state, 'set').mockRejectedValue(storageFailure);

    const err = await makeService()
      .fetchAndCacheText(book, BOOK_ID, ctx)
      .catch((e: unknown) => e);

    expect(err).toBe(storageFailure);
  });
});

// ── Mirror host disclosure through ctx.log (#14) ─────────────────────────────

describe('GutenbergTextService — log payload disclosure', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('emits no log payload carrying the configured mirror host on a successful fetch', async () => {
    // ctx.log is dual-sink: every call also leaves as notifications/message, so a
    // URL in the payload is a URL the client reads. Asserting the absence of the
    // host — rather than the presence of id/format — is what catches a re-added url.
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });

    await makeService().fetchAndCacheText(book, BOOK_ID, ctx);

    const payloads = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(payloads).not.toContain(MIRROR_HOST);
    expect(payloads).not.toContain('cache/epub');
  });

  it('keeps the book id and source format in the fetch log so it stays diagnosable', async () => {
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });

    await makeService().fetchAndCacheText(book, BOOK_ID, ctx);

    const fetchLog = (ctx.log as MockContextLogger).calls.find(
      (call) => call.msg === 'Fetching book text',
    );
    expect(fetchLog?.data).toEqual({ id: BOOK_ID, format: 'text/plain; charset=utf-8' });
  });

  it('emits no mirror host on the cache-hit path either', async () => {
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const service = makeService();

    await service.fetchAndCacheText(book, BOOK_ID, ctx);
    await service.fetchAndCacheText(book, BOOK_ID, ctx);

    expect(http.calls).toHaveLength(1);
    const payloads = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(payloads).not.toContain(MIRROR_HOST);
  });
});
