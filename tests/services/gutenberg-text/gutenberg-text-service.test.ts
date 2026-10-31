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
import type { CachedText } from '@/services/gutenberg-text/types.js';
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

/** Serve `html` as the HTML-only book's mirror file and return what the real pipeline stores. */
async function fetchHtmlEntry(http: FetchMockHarness, html: string): Promise<CachedText> {
  http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
  const ctx = createMockContext({ errors: gutenbergGetText.errors });
  return makeService().fetchAndCacheText(htmlOnlyBook, BOOK_ID, ctx);
}

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

  it('does not serve an entry cached under the previous text key', async () => {
    http.route({ match: RESOLVED_URL, respond: () => new Response(MIRROR_FILE) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    await ctx.state.set(`gutenberg/text/v2/${BOOK_ID}`, {
      text: 'text from the previous processing version',
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
    const entry = await fetchHtmlEntry(http, MIRROR_HTML_FILE);
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
    const entry = await fetchHtmlEntry(http, html);
    expect(entry.text).toContain('Café — “quoted” 😀 😀 &lt;em&gt;');
    expect(entry.text).toContain('Year\tValue\n1900\t42');
    expect(entry.text).toContain('Nested prose.');
    expect(entry.text).not.toContain('hidden');
  });

  it('suppresses nested template contents and separates prose after a table closes', async () => {
    const html =
      '<p>Before.</p><template>outer hidden<template><div>inner hidden</div></template>outer still hidden</template><table><tr><td>cell one<td>cell two</table>After.';
    const entry = await fetchHtmlEntry(http, html);
    expect(entry.text).not.toContain('hidden');
    expect(entry.text).toMatch(/cell one\tcell two\nAfter\./);
    expect(entry.text).toContain('Before.');
  });

  it('separates surrounding prose when a table omits its row start tag', async () => {
    const entry = await fetchHtmlEntry(http, 'intro<table><td>one<td>two</table>after');
    expect(entry.text).toBe('intro\none\ttwo\nafter');
  });

  it('preserves optional table end tags and a head closed implicitly by body', async () => {
    const html =
      '<html><head><title>Excluded title</title><body><p>Visible prose.</p><table><tr><td>one<td>two<tr><td>three<td>four</table></body></html>';
    const entry = await fetchHtmlEntry(http, html);
    expect(entry.text).toContain('Visible prose.');
    expect(entry.text).toContain('one\ttwo\nthree\tfour');
    expect(entry.text).not.toContain('Excluded title');
  });

  it('closes head implicitly when literary body content starts without a body tag', async () => {
    const html =
      '<head><title>Hidden title</title><style>hidden style</style><p>Visible book prose.</p>';
    const entry = await fetchHtmlEntry(http, html);
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

// ── chunkText without find: every byte of an ordinary read is pinned ─────────

describe('GutenbergTextService.chunkText — ordinary reads', () => {
  const TEXT = `${'a'.repeat(10)}\n\n${'b'.repeat(10)}\n\n${'c'.repeat(10)}`;
  const cached = { text: TEXT, sourceFormat: 'text/plain; charset=utf-8', title: 'T' } as const;

  it.each([
    ['ends on a paragraph break', 0, 12, 'aaaaaaaaaa\n\n'],
    ['ends just past a paragraph break', 0, 13, 'aaaaaaaaaa\n\n'],
    ['ends inside a paragraph break', 0, 11, 'aaaaaaaaaa\n'],
    ['starts on a paragraph break', 10, 5, '\n\nbbb'],
    ['starts one character before a paragraph break', 9, 5, 'a\n\n'],
    ['holds two paragraph breaks', 0, 30, `aaaaaaaaaa\n\nbbbbbbbbbb\n\n`],
    ['reaches the end of the text', 20, 100, 'bb\n\ncccccccccc'],
  ])('%s', (_name, offset, limit, expected) => {
    const chunk = makeService().chunkText(cached, offset, limit);
    expect(chunk).toEqual({
      text: expected,
      offset,
      length: expected.length,
      totalChars: 34,
      remainingChars: 34 - offset - expected.length,
      hasMore: offset + expected.length < 34,
      title: 'T',
      sourceFormat: 'text/plain; charset=utf-8',
    });
  });

  it('ignores a paragraph break more than 500 characters behind the limit', () => {
    const text = `${'a'.repeat(100)}\n\n${'b'.repeat(600)}`;
    const chunk = makeService().chunkText({ ...cached, text }, 0, 650);
    expect(chunk.length).toBe(650);
  });
});

// ── Plain-text and in-line whitespace the HTML rule must leave alone (#32) ───

describe('GutenbergTextService — whitespace that stays', () => {
  let http: FetchMockHarness;

  /** The stored text the real pipeline produces for an HTML-only book. */
  const storedHtml = async (html: string) => (await fetchHtmlEntry(http, html)).text;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('keeps a space-only line in a plain-text edition', async () => {
    const file = [
      '*** START OF THE PROJECT GUTENBERG EBOOK PLAIN ***',
      'A stanza.',
      '   ',
      'Another stanza.',
      '*** END OF THE PROJECT GUTENBERG EBOOK PLAIN ***',
    ].join('\n');
    http.route({ match: RESOLVED_URL, respond: () => new Response(file) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const entry = await makeService().fetchAndCacheText(book, BOOK_ID, ctx);
    expect(entry.text).toBe('A stanza.\n   \nAnother stanza.');
  });

  it('keeps U+00A0 inside a line', async () => {
    expect((await storedHtml('<p>a&nbsp;b</p>')).trim()).toBe('a\xa0b');
  });

  it('keeps indentation at the start of a line, in pre verse and in &nbsp; runs', async () => {
    const text = await storedHtml(
      '<pre>   Verse one\n      verse two</pre><p>&nbsp;&nbsp;Indented prose.</p>',
    );
    expect(text).toContain('   Verse one\n      verse two');
    expect(text).toContain('\xa0\xa0Indented prose.');
  });

  it('keeps a compact table exact', async () => {
    const text = await storedHtml(
      '<table><tr><th>Year</th><th>Value</th></tr><tr><td>1900</td><td>42</td></tr></table>',
    );
    expect(text).toBe('\nYear\tValue\n1900\t42\n');
  });

  it('keeps an empty cell tab in a row that holds data', async () => {
    const text = await storedHtml(
      '<table><tr><td>a</td><td></td><td>c</td></tr><tr><td></td><td>e</td></tr></table>',
    );
    expect(text).toBe('\na\t\tc\n\te\n');
  });

  it('keeps text between tags outside a cell', async () => {
    const text = await storedHtml('<table>before<tr>inside<td>a</td>middle<td>b</td></tr></table>');
    expect(text).toBe('\nbefore\ninsideamiddle\tb\n');
  });
});

// ── Locating a passage (#35) ─────────────────────────────────────────────────

describe('GutenbergTextService.findPassage', () => {
  const locate = (text: string, find: string, from = 0) =>
    makeService().findPassage(
      { text, sourceFormat: 'text/plain; charset=utf-8', title: 'T' },
      find,
      from,
    );

  it.each([
    ['folds case', 'Well, Prince, so', 'WELL, PRINCE', { offset: 0, length: 12, laterMatches: 0 }],
    ['matches a line break with a space', 'of the\nBuonapartes', 'the Buonapartes', 3],
    ['matches a run with one space', 'a \n\t b', 'a b', { offset: 0, length: 6, laterMatches: 0 }],
    [
      'matches one space with a run',
      'x a b',
      'a \n\t b',
      { offset: 2, length: 3, laterMatches: 0 },
    ],
    ['matches U+00A0 with a space', 'a\xa0b', 'a b', 0],
    ['matches a straight apostrophe with a curly one', 'I’m afraid', "I'm afraid", 0],
    ['matches a curly apostrophe with a straight one', "I'm afraid", 'I’m afraid', 0],
    ['matches the opening curly quote', '‘tis', "'tis", 0],
    ['matches a straight double quote with curly ones', '“yes”', '"yes"', 0],
    ['matches curly double quotes with a straight one', '"yes"', '“yes”', 0],
    ['keeps stored offsets past İ, whose fold changes length', 'İİİ match', 'MATCH', 4],
    ['compares İ as itself', 'İx', 'İX', 0],
    ['folds final sigma', 'λόγος', 'ΛΌΓΟΣ', 0],
    ['folds sigma to final sigma', 'ΛΌΓΟΣ', 'λόγος', 0],
  ] as const)('%s', (_name, text, find, expected) => {
    const match = locate(text, find);
    if (typeof expected === 'number') expect(match?.offset).toBe(expected);
    else expect(match).toEqual(expected);
  });

  it.each([
    ['accents count in the text', 'café', 'cafe'],
    ['accents count in find', 'cafe', 'café'],
    ['ß does not match ss', 'straße', 'strasse'],
    ['ss does not match ß', 'strasse', 'straße'],
    ['the two-unit fold of İ does not match it', 'İx', `${'İ'.toLowerCase()}x`],
    ['a dot is literal', 'abc', 'a.c'],
    ['a star is literal', 'aaa', 'a*'],
    ['an unbalanced bracket is literal', 'abc', '['],
    ['an en dash does not match a hyphen', 'a-b', 'a–b'],
    ['a run does not match no whitespace', 'ab', 'a b'],
    ['the match does not run off the text', 'a  ', 'a b'],
  ])('%s', (_name, text, find) => {
    expect(locate(text, find)).toBeUndefined();
  });

  it('counts later occurrences without overlap', () => {
    expect(locate('aaaaa', 'aa')).toEqual({ offset: 0, length: 2, laterMatches: 1 });
    expect(locate('aaaaa', 'aa', 2)).toEqual({ offset: 2, length: 2, laterMatches: 0 });
  });

  it('starts at from', () => {
    expect(locate('a b a', 'a', 1)).toEqual({ offset: 4, length: 1, laterMatches: 0 });
  });

  it('never starts a match before from, even inside a surrogate pair', () => {
    expect(locate('😀😀', '😀', 1)).toEqual({ offset: 2, length: 2, laterMatches: 0 });
  });

  it('reports a match that ends the text', () => {
    expect(locate('one two', 'two')).toEqual({ offset: 4, length: 3, laterMatches: 0 });
  });

  it('falls back within a failed partial match', () => {
    expect(locate('aabaabaaab', 'aabaaab')?.offset).toBe(3);
    expect(locate('a a a b', 'a a b')).toEqual({ offset: 2, length: 5, laterMatches: 0 });
    expect(locate('a  a\n\na\tb', 'a a b')).toEqual({ offset: 3, length: 6, laterMatches: 0 });
  });

  it('takes a find of any length', () => {
    const passage = 'word '.repeat(200_000).trimEnd();
    expect(locate(`lead ${passage}.`, passage)).toEqual({
      offset: 5,
      length: passage.length,
      laterMatches: 0,
    });
  });

  it.each([
    [
      'periodic text and find',
      (n: number) => 'ab'.repeat(n * 2),
      (n: number) => `${'ab'.repeat(n)}c`,
      () => undefined,
    ],
    [
      'one long line ending in a break',
      (n: number) => `${'§1 x'.repeat(n)}\ny`,
      () => 'x y',
      (n: number) => ({ offset: n * 4 - 1, length: 3, laterMatches: 0 }),
    ],
    [
      'breaks throughout',
      (n: number) => `${'  \r\n'.repeat(n)}z`,
      () => 'z',
      (n: number) => ({ offset: n * 4, length: 1, laterMatches: 0 }),
    ],
    [
      'a run of matches',
      (n: number) => 'e'.repeat(n * 4),
      () => 'e',
      (n: number) => ({ offset: 0, length: 1, laterMatches: n * 4 - 1 }),
    ],
  ])(
    'bounds scan CPU growth over a 64× span: %s',
    (_name, buildText, buildFind, expected) => {
      const measure = (size: number) => {
        const units = Math.ceil(size / 4);
        const text = buildText(units);
        const find = buildFind(units);
        const service = makeService();
        const cached = { text, sourceFormat: 'text/plain; charset=utf-8', title: 'T' } as const;
        const start = process.threadCpuUsage();
        let match: unknown;
        for (let i = 0; i < 32; i++) match = service.findPassage(cached, find, 0);
        const elapsed = process.threadCpuUsage(start);
        expect(match).toEqual(expected(units));
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
});

describe('GutenbergTextService.chunkText — a matched passage', () => {
  const TAIL = 'y'.repeat(600);
  const cachedOf = (text: string) =>
    ({ text, sourceFormat: 'text/plain; charset=utf-8', title: 'T' }) as const;

  it('never trims inside the match', () => {
    const text = `one\n\ntwo ${TAIL}`;
    const chunk = makeService().chunkText(cachedOf(text), 0, 200, 8);
    expect(chunk.text).toBe(text.slice(0, 200));
  });

  it('trims at a paragraph break past the match', () => {
    const text = `one\n\ntwo\n\n${TAIL}`;
    const chunk = makeService().chunkText(cachedOf(text), 0, 200, 8);
    expect(chunk.text).toBe('one\n\ntwo\n\n');
  });

  it('returns limit characters when limit is below the match length', () => {
    const chunk = makeService().chunkText(cachedOf(`one\n\ntwo ${TAIL}`), 0, 4, 8);
    expect(chunk.text).toBe('one\n');
    expect(chunk.length).toBe(4);
  });

  it('caps a match longer than the limit at the limit, with a break anywhere in it', () => {
    const text = `${'a'.repeat(100)}\n\n${'b'.repeat(100)}`;
    expect(makeService().chunkText(cachedOf(`${text}\n\n${TAIL}`), 0, 150, 202).length).toBe(150);
  });
});

// ── Source whitespace between table tags (#39) ───────────────────────────────

describe('GutenbergTextService — table source whitespace', () => {
  let http: FetchMockHarness;

  const storedHtml = async (html: string) => (await fetchHtmlEntry(http, html)).text;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it.each([
    ['newlines', '<table>\n<tr>\n<td>Birth and Parentage</td>\n<td>1</td>\n</tr>\n</table>'],
    [
      'deep indentation',
      '<table>\n\t<tr>\n\t\t<td>Birth and Parentage</td>\n\t\t<td>1</td>\n\t</tr>\n</table>',
    ],
    [
      'carriage returns',
      '<table>\r\n<tr>\r\n<td>Birth and Parentage</td>\r\n<td>1</td>\r\n</tr>\r\n</table>',
    ],
    ['no-break spaces', '<table><tr><td>Birth and Parentage</td>&nbsp;<td>1</td></tr></table>'],
    [
      'section tags',
      '<table>\n<colgroup>\n<col>\n</colgroup>\n<tbody>\n<tr>\n<td>Birth and Parentage</td>\n<td>1</td>\n</tr>\n</tbody>\n</table>',
    ],
  ])('reads a row on one line whatever the source: %s', async (_name, html) => {
    expect(await storedHtml(html)).toBe('\nBirth and Parentage\t1\n');
  });

  it('reads every row of an indented table on its own line', async () => {
    const html =
      '<table>\n  <tr>\n    <th>Year</th>\n    <th>Value</th>\n  </tr>\n  <tr>\n    <td>1900</td>\n    <td>42</td>\n  </tr>\n</table>\n<p>After.</p>';
    expect(await storedHtml(html)).toBe('\nYear\tValue\n1900\t42\n\nAfter.\n\n');
  });

  it('keeps an empty cell tab in an indented row', async () => {
    const html = '<table>\n<tr>\n<td>a</td>\n<td></td>\n<td>c</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\na\t\tc\n');
  });

  it('keeps a cell its own whitespace and &nbsp;', async () => {
    const html = '<table>\n<tr>\n<td> <b>a</b> <i>b</i> </td>\n<td>c&nbsp;d</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\n a b \tc\xa0d\n');
  });

  it('keeps a hard-wrapped cell wrapped', async () => {
    const html = '<table>\n<tr>\n<td>Birth and\nParentage</td>\n<td>1</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\nBirth and\nParentage\t1\n');
  });

  it.each([
    [
      'paragraphs',
      '<table>\n<tr>\n<td>\n<p>one</p>\n<p>two</p>\n</td>\n<td>x</td>\n</tr>\n</table>',
      '\n\none\n\ntwo\n\n\tx\n',
    ],
    [
      'a line break',
      '<table>\n<tr>\n<td>a<br>b</td>\n<td>c</td>\n</tr>\n</table>',
      '\na\n\nb\tc\n',
    ],
  ])('breaks a row at block markup inside a cell: %s', async (_name, html, text) => {
    expect(await storedHtml(html)).toBe(text);
  });

  it('keeps whitespace in a cell left open by an omitted end tag', async () => {
    const html = '<table>\n<tr>\n<td><b>a</b> <b>b</b>\n<td>c\n<tr>\n<td>d\n</table>';
    expect(await storedHtml(html)).toBe('\na b\n\tc\nd\n');
  });

  it('keeps a caption its own whitespace', async () => {
    const html =
      '<table>\n<caption><b>Table</b> <i>One</i></caption>\n<tr>\n<td>a</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\nTable One\na\n');
  });

  it('keeps text between tags outside a cell when it is not whitespace', async () => {
    const html = '<table>\n<tr>\n<td>a</td>\nstray\n<td>b</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\na\nstray\n\tb\n');
  });

  it('treats whitespace after a table as ordinary text', async () => {
    expect(await storedHtml('<table><tr><td>a</td></tr></table> <b>x</b>')).toBe('\na\n x');
  });

  it('keeps the rows and cells of nested tables, two levels down', async () => {
    const html = [
      '<table>',
      '<tr>',
      '<td>outer one',
      '<table>',
      '<tr>',
      '<td>inner a</td>',
      '<td>inner b</td>',
      '</tr>',
      '<tr>',
      '<td>inner c</td>',
      '<td>',
      '<table>',
      '<tr>',
      '<td>deep x</td>',
      '<td>deep y</td>',
      '</tr>',
      '</table>',
      '</td>',
      '</tr>',
      '</table>',
      '</td>',
      '<td>outer two</td>',
      '</tr>',
      '</table>',
    ].join('\n');
    expect(await storedHtml(html)).toBe(
      '\nouter one\ninner a\tinner b\ninner c\t\ndeep x\tdeep y\n\n\touter two\n',
    );
  });

  it('returns to the outer cell when a nested table closes', async () => {
    const html =
      '<table>\n<tr>\n<td><table>\n<tr>\n<td>x</td>\n</tr>\n</table><b>a</b> <b>b</b></td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\nx\na b\n');
  });

  it.each([
    ['no rows', '<table></table>'],
    ['an empty row', '<table><tr></tr></table>'],
  ])("keeps the outer row's tab past a nested table with %s", async (_name, nested) => {
    const html = `<table><tr><td>a</td><td>${nested}</td><td>c</td></tr></table>`;
    expect(await storedHtml(html)).toBe('\na\t\n\tc\n');
  });

  it('ignores table structure inside a template', async () => {
    const html =
      '<table>\n<tr>\n<td>a</td><template><table><tr><td>hidden</td></tr></table></template>\n<td>b</td>\n</tr>\n</table>';
    expect(await storedHtml(html)).toBe('\na\tb\n');
  });

  it('leaves plain-text editions alone', async () => {
    const file = [
      '*** START OF THE PROJECT GUTENBERG EBOOK PLAIN ***',
      '<table>',
      '<tr>',
      '  <td>literal markup</td>',
      '</tr>',
      '</table>',
      '*** END OF THE PROJECT GUTENBERG EBOOK PLAIN ***',
    ].join('\n');
    http.route({ match: RESOLVED_URL, respond: () => new Response(file) });
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    expect((await makeService().fetchAndCacheText(book, BOOK_ID, ctx)).text).toBe(
      '<table>\n<tr>\n  <td>literal markup</td>\n</tr>\n</table>',
    );
  });

  it.each([
    [
      'one long line ending in a break',
      (n: number) => `<table>${'§1 x'.repeat(n)}\ny</table>`,
      (n: number) => n * 4 + 4,
    ],
    [
      'breaks throughout',
      (n: number) => `<table>${'  \r\n'.repeat(n)}<tr><td>y</td></tr></table>`,
      () => 3,
    ],
    [
      'whitespace between many cells',
      (n: number) => `<table><tr>${'<td>y</td>\n'.repeat(n / 2)}</tr></table>`,
      (n: number) => n + 1,
    ],
  ])(
    'bounds CPU growth dropping table whitespace over a 64× span: %s',
    (_name, build, expectedLength) => {
      const service = makeService() as unknown as {
        processRaw(raw: string, format: string): { text: string };
      };
      const measure = (size: number) => {
        const units = Math.ceil(size / 4);
        const raw = build(units);
        const start = process.threadCpuUsage();
        let text = '';
        for (let i = 0; i < 32; i++) text = service.processRaw(raw, 'text/html').text;
        const elapsed = process.threadCpuUsage(start);
        expect(text).toHaveLength(expectedLength(units));
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
});

// ── Whitespace-only lines on the HTML path (#32) ─────────────────────────────

describe('GutenbergTextService — whitespace-only lines on the HTML path', () => {
  let http: FetchMockHarness;

  const SPACED_BOOK = [
    '<html><body>',
    '<p>*** START OF THE PROJECT GUTENBERG EBOOK SPACED ***</p>',
    '<p>Copyright line</p>',
    '<p>&nbsp;</p>',
    '<p>&nbsp;</p>',
    '  <div>',
    '    <p>First paragraph.</p>',
    '  </div>',
    '<p>Second paragraph.</p>',
    '<p>*** END OF THE PROJECT GUTENBERG EBOOK SPACED ***</p>',
    '</body></html>',
  ].join('\n');
  const SPACED_TEXT = 'Copyright line\n\nFirst paragraph.\n\nSecond paragraph.';

  const storedHtml = (html: string) => fetchHtmlEntry(http, html);

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('empties indentation and &nbsp; spacer lines before the blank-line collapse', async () => {
    expect((await storedHtml(SPACED_BOOK)).text).toBe(SPACED_TEXT);
  });

  it('pins totalChars and chunk boundaries on the shortened text', async () => {
    const cached = await storedHtml(SPACED_BOOK);
    const service = makeService();
    const first = service.chunkText(cached, 0, 40);
    expect(first).toMatchObject({
      text: 'Copyright line\n\nFirst paragraph.\n\n',
      length: 34,
      totalChars: 51,
      remainingChars: 17,
      hasMore: true,
    });
    expect(service.chunkText(cached, first.length, 40)).toMatchObject({
      text: 'Second paragraph.',
      offset: 34,
      remainingChars: 0,
      hasMore: false,
    });
  });

  it('reads a row of empty cells as a blank line', async () => {
    const html =
      '<table><tr><td>a</td></tr><tr><td></td><td></td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>b</td></tr></table>';
    expect((await storedHtml(html)).text).toBe('\na\n\nb\n');
  });

  it.each([
    ['U+00A0', 'a0'],
    ['a tab', '9'],
    ['U+3000', '3000'],
    ['U+FEFF', 'feff'],
    ['U+2028', '2028'],
    ['a carriage return', 'd'],
  ])('treats a line of only %s as blank', async (_name, hex) => {
    const { text } = await storedHtml(`<pre>one\n&#x${hex};&#x${hex};\ntwo</pre>`);
    expect(text.trim()).toBe('one\n\ntwo');
  });

  it('does not blank a line holding U+200B, which is not whitespace', async () => {
    const { text } = await storedHtml('<pre>one\n&#x200B;\ntwo</pre>');
    expect(text.trim()).toBe(`one\n${String.fromCodePoint(0x200b)}\ntwo`);
  });

  it('delimits lines on line feeds alone, so U+2028 leaves a line its trailing spaces', async () => {
    const { text } = await storedHtml('<pre>one&#x2028;  \ntwo</pre>');
    expect(text.trim()).toBe(`one${String.fromCodePoint(0x2028)}  \ntwo`);
  });

  /** Serve an HTML-only book through the real catalog and text services. */
  function serveHtmlBook(html: string): void {
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
      respond: () => Response.json(htmlOnlyBook),
    });
    http.route({ match: RESOLVED_HTML_URL, respond: () => new Response(html) });
  }

  it('reports match offsets in the coordinates of the shortened text', async () => {
    serveHtmlBook(SPACED_BOOK);
    const result = await runToolContract(gutenbergGetText, {
      id: BOOK_ID,
      find: 'PARAGRAPH.\nsecond',
    });
    expect(result.structuredContent).toMatchObject({
      match: { offset: 22, length: 18, laterMatches: 0 },
      offset: 22,
      totalChars: 51,
      remainingChars: 0,
      text: 'paragraph.\n\nSecond paragraph.',
    });
  });

  it('turns an offset past the shortened text into offset_out_of_range', async () => {
    serveHtmlBook(`<p>Short.</p>${'<p>&nbsp;</p>'.repeat(100)}<p>Tail.</p>`);
    const inside = await runToolContract(gutenbergGetText, { id: BOOK_ID, offset: 10 });
    expect(inside.structuredContent).toMatchObject({ totalChars: 17 });
    const past = await runToolContract(gutenbergGetText, { id: BOOK_ID, offset: 200 });
    expect(past.structuredContent).toMatchObject({
      error: { data: { reason: 'offset_out_of_range' } },
    });
  });

  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n)}\ny`, 4, 2],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n), 0, 2],
  ])(
    'bounds CPU growth blanking lines over a 64× span: %s',
    (_name, build, perUnit, tail) => {
      const service = makeService() as unknown as {
        processRaw(raw: string, format: string): { text: string };
      };
      const measure = (size: number) => {
        const raw = build(Math.ceil(size / 4));
        const start = process.threadCpuUsage();
        let text = '';
        for (let i = 0; i < 32; i++) text = service.processRaw(raw, 'text/html').text;
        const elapsed = process.threadCpuUsage(start);
        expect(text).toHaveLength(Math.ceil(size / 4) * perUnit + tail);
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
});
