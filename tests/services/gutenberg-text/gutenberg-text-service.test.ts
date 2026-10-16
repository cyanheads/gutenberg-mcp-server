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
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetText } from '@/mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import {
  GutenbergTextService,
  initGutenbergTextService,
} from '@/services/gutenberg-text/gutenberg-text-service.js';
import { initGutendexService } from '@/services/gutendex/gutendex-service.js';
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
  is_readable: true,
  source_notes: null,
};

const MIRROR_FILE = [
  'Title: Pride and Prejudice',
  '',
  '*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***',
  'It is a truth universally acknowledged.',
  '*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***',
  'License boilerplate.',
].join('\n');

/** The HTML cache path resolveTextUrl derives for a book with no plain-text format. */
const RESOLVED_HTML_URL = `${MIRROR_HOST}/cache/epub/${BOOK_ID}/pg${BOOK_ID}-images.html`;

/** Same book, but only the mirror's generated HTML is on offer — the htmlToText path. */
const htmlOnlyBook: Book = {
  ...book,
  formats: { 'text/html': 'https://www.gutenberg.org/ebooks/1342.html.images' },
  has_plain_text: false,
};

/**
 * An HTML book whose prose carries both plain character references and references
 * that are themselves escaped — `&amp;lt;` is the four characters `&lt;`, not `<`.
 */
const MIRROR_HTML_FILE = [
  '<html><body>',
  '<p>*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***</p>',
  '<p>Tom &amp; Jerry wrote &amp;lt;b&amp;gt; on the slate.</p>',
  '<p>Markup: &lt;em&gt;, quote: &quot;yes&quot;, apostrophe: &apos;tis, numeric: &#65;.</p>',
  '<p>Unknown:&nbsp;entity.</p>',
  '<p>Prototype:&constructor;entity.</p>',
  '<p>*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***</p>',
  '</body></html>',
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

  it.each([
    [404, 'text_file_not_found', JsonRpcErrorCode.NotFound],
    [403, 'text_fetch_rejected', JsonRpcErrorCode.Forbidden],
    [400, 'text_fetch_rejected', JsonRpcErrorCode.Forbidden],
  ])('sanitizes permanent HTTP %i without retrying or caching', async (status, reason, code) => {
    http.route({
      match: RESOLVED_URL,
      respond: () => new Response('private upstream body', { status }),
    });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const set = vi.spyOn(ctx.state, 'set');
    const error = (await makeService()
      .fetchAndCacheText(book, BOOK_ID, ctx)
      .catch((e: unknown) => e)) as McpError;
    expect(error.code).toBe(code);
    expect(error.data).toMatchObject({ reason, recovery: { hint: expect.any(String) } });
    expect(JSON.stringify({ message: error.message, data: error.data })).not.toMatch(
      /mirror.test|private upstream body|cache\/epub/,
    );
    expect(error.cause).toBeInstanceOf(McpError);
    expect(http.calls).toHaveLength(1);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    [
      'text/plain; charset=utf-8',
      'text/html',
      '<html><body>Service unavailable; retry later.</body></html>',
    ],
    [
      'text/plain; charset=utf-8',
      'text/plain',
      '<!doctype html><html><body><h1>404 Not Found</h1></body></html>',
    ],
    ['text/html', 'text/html', '<html><body>Service unavailable; retry later.</body></html>'],
    [
      'text/html',
      'text/html',
      '<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><hr><center>nginx</center></body></html>',
    ],
    ['text/plain; charset=utf-8', 'application/json', '{"error":"private"}'],
    ['text/plain; charset=utf-8', 'text/plain', ''],
  ])('rejects invalid %s responses (%s) without caching', async (format, contentType, body) => {
    const html = format === 'text/html';
    http.route({
      match: html ? RESOLVED_HTML_URL : RESOLVED_URL,
      respond: () => new Response(body, { headers: { 'content-type': contentType } }),
    });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const set = vi.spyOn(ctx.state, 'set');
    await expect(
      makeService().fetchAndCacheText(html ? htmlOnlyBook : book, BOOK_ID, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'invalid_text_response', recovery: { hint: expect.any(String) } },
    });
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    'The service unavailable error haunted him. Retry later, she said.\nA new chapter began.',
    '<html><body><h1>Service unavailable</h1><p>This was the name of a poem about errors.</p></body></html>',
  ])('accepts markerless literature mentioning errors', async (body) => {
    const html = body.startsWith('<html>');
    http.route({
      match: html ? RESOLVED_HTML_URL : RESOLVED_URL,
      respond: () =>
        new Response(body, { headers: { 'content-type': html ? 'text/html' : 'text/plain' } }),
    });
    const entry = await makeService().fetchAndCacheText(
      html ? htmlOnlyBook : book,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).toContain(html ? 'name of a poem' : 'A new chapter');
  });

  it.each([
    ['text/plain; charset=utf-8', 'application/octet-stream'],
    ['text/plain; charset=utf-8', 'text/html'],
    ['text/plain; charset=utf-8', 'application/json'],
    ['text/html', 'application/octet-stream'],
    ['text/html', 'application/json'],
    ['text/html', undefined],
    ['text/plain; charset=utf-8', undefined],
  ])('preserves legitimate %s despite a %s response header', async (format, contentType) => {
    const html = format === 'text/html';
    const body = html ? '<p>Caf&eacute; and markerless prose.</p>' : 'Café and markerless prose.';
    http.route({
      match: html ? RESOLVED_HTML_URL : RESOLVED_URL,
      respond: () => {
        const response = new Response(body);
        if (contentType) response.headers.set('content-type', contentType);
        else response.headers.delete('content-type');
        return response;
      },
    });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const service = makeService();
    for (let i = 0; i < 2; i++) {
      expect(
        (await service.fetchAndCacheText(html ? htmlOnlyBook : book, BOOK_ID, ctx)).text.trim(),
      ).toBe('Café and markerless prose.');
    }
    expect(http.calls).toHaveLength(1);
  });

  it('does not trust processed cache entries from the old extraction/validation version', async () => {
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    await ctx.state.set(`gutenberg/text/${BOOK_ID}`, {
      text: 'old invalid document',
      sourceFormat: 'text/plain; charset=utf-8',
      title: book.title,
    });
    expect((await makeService().fetchAndCacheText(book, BOOK_ID, ctx)).text).toBe(
      'It is a truth universally acknowledged.',
    );
    expect(http.calls).toHaveLength(1);
  });

  it('propagates a cache-read failure unchanged without fetching', async () => {
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const failure = databaseError('Cache read rejected');
    vi.spyOn(ctx.state, 'get').mockRejectedValue(failure);
    await expect(makeService().fetchAndCacheText(book, BOOK_ID, ctx)).rejects.toBe(failure);
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [404, 'text/plain', 'private upstream body', 'text_file_not_found'],
    [403, 'text/plain', 'private upstream body', 'text_fetch_rejected'],
    [200, 'text/html', '<html><body>private upstream body</body></html>', 'invalid_text_response'],
  ])(
    'carries HTTP %i failures through both real tool surfaces',
    async (status, contentType, body, reason) => {
      const config = {
        gutendexBaseUrl: 'https://catalog.test/books/',
        gutenbergTextBaseUrl: MIRROR_HOST,
        mirrorPath: ':memory:',
      };
      const storage = createInMemoryStorage();
      initGutendexService({} as AppConfig, storage, config);
      initGutenbergTextService({} as AppConfig, storage, config);
      http.route({
        match: `https://catalog.test/books/${BOOK_ID}/`,
        respond: () => Response.json(book),
      });
      http.route({
        match: RESOLVED_URL,
        respond: () => new Response(body, { status, headers: { 'content-type': contentType } }),
      });
      const result = await runToolContract(gutenbergGetText, { id: BOOK_ID });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      const wire = JSON.stringify(result);
      expect(wire).toContain('Recovery:');
      expect(wire).not.toMatch(/mirror.test|private upstream body|cache\/epub/);
    },
  );

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

// ── HTML entity decoding on the text/html fallback (#16) ─────────────────────

describe('GutenbergTextService — HTML entity decoding', () => {
  let http: FetchMockHarness;

  /** Fetch the HTML-only book through the real pipeline and return its stripped text. */
  async function readHtmlBook(): Promise<string> {
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(MIRROR_HTML_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const entry = await makeService().fetchAndCacheText(htmlOnlyBook, BOOK_ID, ctx);
    expect(entry.sourceFormat).toBe('text/html');
    return entry.text;
  }

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it.each(['<', '<p', '&amp', '<div>'])(
    'bounds CPU growth for repeated HTML prefix %s over a 64× input span',
    (prefix) => {
      const service = makeService() as unknown as {
        processRaw(raw: string, format: string): { text: string };
      };
      const measure = (size: number) => {
        const raw = prefix.repeat(Math.ceil(size / prefix.length)).slice(0, size);
        const start = process.threadCpuUsage();
        for (let i = 0; i < 32; i++) service.processRaw(raw, 'text/html');
        const elapsed = process.threadCpuUsage(start);
        return elapsed.user + elapsed.system;
      };
      measure(5000);
      const baseline = measure(5000);
      expect(baseline).toBeGreaterThan(0);
      for (let size = 10000; size <= 320000; size *= 2) {
        const cpu = measure(size);
        expect(cpu).toBeLessThan(2_000_000);
        expect(cpu / baseline).toBeLessThan(256);
      }
    },
    15000,
  );

  it('preserves Unicode, nested blocks and table boundaries while excluding executable and style text', async () => {
    const html =
      '<html><head><style>hidden style</style></head><body><script>hidden script</script><div><p>Caf&eacute; &mdash; &ldquo;quoted&rdquo; &#x1F600; &#128512; &amp;lt;em&amp;gt;</p><div><p>Nested prose.</p></div></div><table><tr><th>Year</th><th>Value</th></tr><tr><td>1900</td><td>42</td></tr></table></body></html>';
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
    const entry = await makeService().fetchAndCacheText(
      htmlOnlyBook,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).toContain('Café — “quoted” 😀 😀 &lt;em&gt;');
    expect(entry.text).toContain('Year\tValue\n1900\t42');
    expect(entry.text).toContain('Nested prose.');
    expect(entry.text).not.toContain('hidden');
  });

  it('suppresses nested template contents and separates prose after a table closes', async () => {
    const html =
      '<p>Before.</p><template>outer hidden<template><div>inner hidden</div></template>outer still hidden</template><table><tr><td>cell one<td>cell two</table>After.';
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
    const entry = await makeService().fetchAndCacheText(
      htmlOnlyBook,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).not.toContain('hidden');
    expect(entry.text).toMatch(/cell one\tcell two\nAfter\./);
    expect(entry.text).toContain('Before.');
  });

  it('separates surrounding prose when a table omits its row start tag', async () => {
    http.route({
      match: RESOLVED_HTML_URL,
      respond: () => new Response('intro<table><td>one<td>two</table>after'),
    });
    const entry = await makeService().fetchAndCacheText(
      htmlOnlyBook,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).toBe('intro\none\ttwo\nafter');
  });

  it('preserves optional table end tags and a head closed implicitly by body', async () => {
    const html =
      '<html><head><title>Excluded title</title><body><p>Visible prose.</p><table><tr><td>one<td>two<tr><td>three<td>four</table></body></html>';
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
    const entry = await makeService().fetchAndCacheText(
      htmlOnlyBook,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).toContain('Visible prose.');
    expect(entry.text).toContain('one\ttwo\nthree\tfour');
    expect(entry.text).not.toContain('Excluded title');
  });

  it('closes head implicitly when literary body content starts without a body tag', async () => {
    const html =
      '<head><title>Hidden title</title><style>hidden style</style><p>Visible book prose.</p>';
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
    const entry = await makeService().fetchAndCacheText(
      htmlOnlyBook,
      BOOK_ID,
      createMockContext({ errors: gutenbergGetText.errors }),
    );
    expect(entry.text).toContain('Visible book prose.');
    expect(entry.text).not.toMatch(/Hidden title|hidden style/);
  });

  it('decodes each character reference exactly once, so an escaped reference stays text', async () => {
    const text = await readHtmlBook();

    // `&amp;lt;b&amp;gt;` is prose *about* markup — the reference the first
    // decode uncovers must not be decoded a second time into a real tag.
    expect(text).toContain('Tom & Jerry wrote &lt;b&gt; on the slate.');
    expect(text).not.toContain('<b>');
  });

  it('keeps decoding every reference form it handled before', async () => {
    const text = await readHtmlBook();

    expect(text).toContain('Markup: <em>, quote: "yes", apostrophe: \'tis, numeric: A.');
    expect(text).toContain('Unknown:\u00a0entity.');
  });

  it('treats a reference naming an Object prototype member as unknown', async () => {
    const text = await readHtmlBook();

    // `&constructor;` is a name, not a lookup into the prototype chain — a
    // plain-object table would resolve it and stringify a native function
    // into the reader's book text.
    expect(text).toContain('Prototype:&constructor;entity.');
    expect(text).not.toContain('native code');
  });
});
