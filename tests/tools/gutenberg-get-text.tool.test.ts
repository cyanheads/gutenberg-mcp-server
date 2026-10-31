/**
 * @fileoverview Tests for the gutenberg_get_text tool — handler logic, chunking, and
 * boilerplate-stripping behavior from the GutenbergTextService pipeline.
 * @module tests/tools/gutenberg-get-text.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetText } from '@/mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import { GutenbergTextService } from '@/services/gutenberg-text/gutenberg-text-service.js';
import type { CachedText } from '@/services/gutenberg-text/types.js';
import type { Book } from '@/services/gutendex/types.js';
import {
  ACTIVE_MARKDOWN,
  contentText,
  hostileLine,
  PROPERTY_RUNS,
  readBack,
} from './markdown-read-back.js';

// ── Service mocks ────────────────────────────────────────────────────────────

vi.mock('@/services/gutendex/gutendex-service.js', () => ({
  getGutendexService: vi.fn(() => mockGutendexService),
}));

vi.mock('@/services/gutenberg-text/gutenberg-text-service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/services/gutenberg-text/gutenberg-text-service.js')>();
  return {
    ...original, // keep GutenbergTextService class so we can use its real chunkText
    getGutenbergTextService: vi.fn(() => mockTextService),
  };
});

const mockGutendexService = { getBook: vi.fn() };
const mockTextService = { fetchAndCacheText: vi.fn(), chunkText: vi.fn(), findPassage: vi.fn() };

// ── Shared fixtures ──────────────────────────────────────────────────────────

const textBook = {
  id: 84,
  title: 'Frankenstein',
  authors: [{ name: 'Shelley, Mary Wollstonecraft', birth_year: 1797, death_year: 1851 }],
  translators: [],
  editors: [],
  subjects: ['Horror tales'],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 45000,
  summary: null,
  summaries: [],
  formats: {
    'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/84.txt.utf-8',
  },
  has_plain_text: true,
  is_readable: true,
  source_notes: null,
};

const audioBook = {
  ...textBook,
  id: 55555,
  title: 'An Audio Recording',
  media_type: 'Sound',
  formats: { 'audio/mpeg': 'https://www.gutenberg.org/ebooks/55555.mp3' },
  has_plain_text: false,
};

const LITERARY_TEXT =
  'Chapter 1. You will rejoice to hear that no disaster has accompanied\n\nthe commencement of an enterprise which you have regarded with such evil\n\npresentiments.';

const cachedText: CachedText = {
  text: LITERARY_TEXT,
  sourceFormat: 'text/plain; charset=utf-8',
  title: 'Frankenstein',
};

/** The real service class, so chunking and matching run unmocked. */
function realTextService(): GutenbergTextService {
  return new (
    GutenbergTextService as unknown as new (
      _c: unknown,
      _s: unknown,
      _sc: unknown,
    ) => GutenbergTextService
  )(null, null, {
    gutenbergTextBaseUrl: 'https://gutenberg.pglaf.org',
    gutendexBaseUrl: 'https://gutendex.com/books/',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: real chunkText and findPassage logic from the service class
  mockTextService.chunkText.mockImplementation(
    (cached: CachedText, offset: number, limit: number, matchLength?: number) =>
      realTextService().chunkText(cached, offset, limit, matchLength),
  );
  mockTextService.findPassage.mockImplementation((cached: CachedText, find: string, from: number) =>
    realTextService().findPassage(cached, find, from),
  );
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('gutenbergGetText — happy path', () => {
  it('renders literal book text in a collision-safe fence without changing offsets or structured text', async () => {
    const literary = '<em> *asterisks* _underscores_\n```\n``````\nend';
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue({ ...cachedText, text: literary });
    const result = await runToolContract(gutenbergGetText, { id: 84 });
    expect(result.structuredContent).toMatchObject({
      text: literary,
      offset: 0,
      length: literary.length,
    });
    const rendered = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(rendered).toContain(`\n\`\`\`\`\`\`\`text\n${literary}\n\`\`\`\`\`\`\`\n`);
  });
  it.each([50000, 50001, 1_000_000])(
    'caps a requested %i characters on both surfaces',
    async (limit) => {
      mockGutendexService.getBook.mockResolvedValue(textBook);
      mockTextService.fetchAndCacheText.mockResolvedValue({
        ...cachedText,
        text: 'x'.repeat(100001),
      });
      const result = await runToolContract(gutenbergGetText, { id: 84, limit });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        requestedLimit: limit,
        appliedLimit: 50000,
        length: 50000,
        hasMore: true,
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(`Requested limit: ${limit.toLocaleString()}`);
      expect(text).toContain('Applied limit: 50,000');
      expect(text).toContain('offset=50000');
      expect(mockTextService.chunkText).toHaveBeenCalledWith(expect.anything(), 0, 50000);
    },
  );

  it('does not claim remaining text merely because the requested limit was clamped', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(cachedText);
    const result = await runToolContract(gutenbergGetText, { id: 84, limit: 50001 });
    expect(result.structuredContent).toMatchObject({
      hasMore: false,
      remainingChars: 0,
      requestedLimit: 50001,
      appliedLimit: 50000,
    });
  });

  it.each([0, -1, 1.5, Infinity, NaN])(
    'rejects invalid limit %s before fetching',
    async (limit) => {
      const result = await runToolContract(gutenbergGetText, { id: 84, limit });
      expect(result.isError).toBe(true);
      expect(mockGutendexService.getBook).not.toHaveBeenCalled();
    },
  );

  it('returns the first chunk with correct metadata', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(cachedText);

    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84, offset: 0, limit: 50000 });
    const result = await gutenbergGetText.handler(input, ctx);

    expect(result.id).toBe(84);
    expect(result.title).toBe('Frankenstein');
    expect(result.text).toBe(LITERARY_TEXT);
    expect(result.offset).toBe(0);
    expect(result.totalChars).toBe(LITERARY_TEXT.length);
    expect(result.hasMore).toBe(false);
    expect(result.remainingChars).toBe(0);
    expect(result.provenance).toContain('84');
    expect(result.provenance).toContain('Frankenstein');
    expect(result.provenance).toContain('gutenberg.org/ebooks/84');
    expect(result.sourceFormat).toBe('text/plain; charset=utf-8');
  });

  it('applies defaults: offset=0, limit=20000', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(cachedText);
    const input = gutenbergGetText.input.parse({ id: 84 });

    expect(input.offset).toBe(0);
    expect(input.limit).toBe(20000);
  });
});

// ── Offset/limit chunking ────────────────────────────────────────────────────

describe('gutenbergGetText — offset/limit chunking', () => {
  const LONG_TEXT = `${'AAAA'.repeat(100)}\n\n${'BBBB'.repeat(100)}\n\n${'CCCC'.repeat(100)}`;
  const longCached: CachedText = {
    text: LONG_TEXT,
    sourceFormat: 'text/plain; charset=utf-8',
    title: 'Long Book',
  };
  const longBook = { ...textBook, title: 'Long Book' };

  beforeEach(() => {
    mockGutendexService.getBook.mockResolvedValue(longBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(longCached);
  });

  it('first chunk: offset=0, length ≤ limit, hasMore=true when text is long', async () => {
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84, offset: 0, limit: 200 });
    const result = await gutenbergGetText.handler(input, ctx);

    expect(result.offset).toBe(0);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.totalChars).toBe(LONG_TEXT.length);
    expect(result.hasMore).toBe(true);
    expect(result.remainingChars).toBeGreaterThan(0);
    expect(result.remainingChars).toBe(result.totalChars - result.offset - result.length);
  });

  it('subsequent chunk: offset > 0 returns the next slice', async () => {
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input1 = gutenbergGetText.input.parse({ id: 84, offset: 0, limit: 200 });
    const result1 = await gutenbergGetText.handler(input1, ctx);

    const ctx2 = createMockContext({ errors: gutenbergGetText.errors });
    const nextOffset = result1.offset + result1.length;
    const input2 = gutenbergGetText.input.parse({ id: 84, offset: nextOffset, limit: 200 });
    const result2 = await gutenbergGetText.handler(input2, ctx2);

    // Second chunk starts at the correct offset
    expect(result2.offset).toBe(nextOffset);
    // offset advances with each chunk
    expect(result2.offset).toBeGreaterThan(result1.offset);
    // Both chunks together cover the right amount of text
    expect(result1.length + result2.length).toBeLessThanOrEqual(400);
  });

  it('last chunk: hasMore=false, remainingChars=0 at end of book', async () => {
    const total = LONG_TEXT.length;
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    // Offset near the end — limit large enough to reach end
    const input = gutenbergGetText.input.parse({ id: 84, offset: total - 50, limit: 100 });
    const result = await gutenbergGetText.handler(input, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.remainingChars).toBe(0);
    expect(result.offset + result.length).toBe(total);
  });

  it('reports "N more remaining" signal correctly: remainingChars = totalChars - offset - length', async () => {
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84, offset: 0, limit: 200 });
    const result = await gutenbergGetText.handler(input, ctx);

    expect(result.remainingChars).toBe(result.totalChars - result.offset - result.length);
    expect(result.length).toBe(result.text.length);
  });

  it('soft paragraph-boundary trim: actual length may be slightly less than limit', async () => {
    // Construct text where a \n\n exists 100 chars before the limit (500-char backtrack zone)
    const para1 = 'A'.repeat(100);
    const para2 = 'B'.repeat(600); // long second paragraph
    const bigText = `${para1}\n\n${para2}`;
    const bigCached: CachedText = {
      text: bigText,
      sourceFormat: 'text/plain; charset=utf-8',
      title: 'Big',
    };
    mockTextService.fetchAndCacheText.mockResolvedValue(bigCached);

    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    // limit=500 lands inside para2; the \n\n at offset 100 is within the 500-char backtrack
    const input = gutenbergGetText.input.parse({ id: 84, offset: 0, limit: 500 });
    const result = await gutenbergGetText.handler(input, ctx);

    // Result must be ≤ 500 chars
    expect(result.length).toBeLessThanOrEqual(500);
    // And the chunk should end at the paragraph break — text ends with "AA..A\n\n"
    expect(result.text).toContain('\n\n');
  });
});

// ── Locating a passage with find (#35) ───────────────────────────────────────

describe('gutenbergGetText — find', () => {
  const OPENING =
    'Well, Prince, so Genoa and Lucca are now just family estates of the\nBuonapartes.';
  const PASSAGE_BOOK = [
    'CHAPTER I',
    '',
    OPENING,
    '',
    'I’m afraid of it, she said. I’m afraid of everything.',
    '',
    'He thought of the abc of it, and of Catherine.',
    '',
    'I’m afraid.',
  ].join('\n');
  const SENTINEL = 'an absent passage nobody wrote';

  const passageCache: CachedText = {
    text: PASSAGE_BOOK,
    sourceFormat: 'text/plain; charset=utf-8',
    title: 'Frankenstein',
  };

  const wire = (result: { content?: unknown }) => JSON.stringify(result.content);

  beforeEach(() => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(passageCache);
  });

  it('starts the chunk at the first occurrence and reports match on both surfaces', async () => {
    const offset = PASSAGE_BOOK.indexOf(OPENING);
    const find = 'Well, Prince, so Genoa and Lucca are now just family estates of the Buonapartes';

    const result = await runToolContract(gutenbergGetText, { id: 84, find });

    expect(result.structuredContent).toMatchObject({
      match: { offset, length: find.length, laterMatches: 0 },
      offset,
      totalChars: PASSAGE_BOOK.length,
      remainingChars: 0,
      hasMore: false,
      text: PASSAGE_BOOK.slice(offset),
    });
    expect(wire(result)).toContain(`**Match:** offset ${offset} | length ${find.length} | 0 later`);
  });

  it.each(['WELL, PRINCE', '  well,\n\tprince ', 'well,   PRINCE'])(
    'folds case and whitespace in %j',
    async (find) => {
      const result = await runToolContract(gutenbergGetText, { id: 84, find });
      expect(result.structuredContent).toMatchObject({
        match: { offset: PASSAGE_BOOK.indexOf(OPENING), length: 12, laterMatches: 0 },
      });
    },
  );

  it('walks every occurrence with offset = match.offset + match.length', async () => {
    const find = "I'm afraid";
    const seen: { laterMatches: number; offset: number }[] = [];
    let offset = 0;
    for (let call = 0; call < 3; call++) {
      const result = await runToolContract(gutenbergGetText, { id: 84, find, offset });
      const { match } = result.structuredContent as {
        match: { laterMatches: number; length: number; offset: number };
      };
      seen.push({ offset: match.offset, laterMatches: match.laterMatches });
      offset = match.offset + match.length;
    }
    const first = PASSAGE_BOOK.indexOf('I’m afraid');
    const second = PASSAGE_BOOK.indexOf('I’m afraid', first + 1);
    const third = PASSAGE_BOOK.lastIndexOf('I’m afraid');
    expect(seen).toEqual([
      { offset: first, laterMatches: 2 },
      { offset: second, laterMatches: 1 },
      { offset: third, laterMatches: 0 },
    ]);
  });

  it('counts a match in front matter as an ordinary match', async () => {
    const result = await runToolContract(gutenbergGetText, { id: 84, find: 'chapter i' });
    expect(result.structuredContent).toMatchObject({ match: { offset: 0, laterMatches: 0 } });
  });

  it.each(['', '   ', ' \n\t\xa0'])('reads as usual for the blank find %j', async (find) => {
    const ordinary = await runToolContract(gutenbergGetText, { id: 84, offset: 3, limit: 40 });
    const blank = await runToolContract(gutenbergGetText, { id: 84, offset: 3, limit: 40, find });
    expect(blank).toEqual(ordinary);
    expect(blank.structuredContent).not.toHaveProperty('match');
    expect(mockTextService.findPassage).not.toHaveBeenCalled();
  });

  it('applies limit from the match start, below the match length included', async () => {
    const result = await runToolContract(gutenbergGetText, {
      id: 84,
      find: 'Well, Prince',
      limit: 5,
    });
    expect(result.structuredContent).toMatchObject({
      match: { length: 12 },
      text: 'Well,',
      length: 5,
      requestedLimit: 5,
      appliedLimit: 5,
      hasMore: true,
    });
  });

  it('returns a whole match with a paragraph break inside it', async () => {
    const text = `Lead. one\n\ntwo ${'y'.repeat(600)}`;
    mockTextService.fetchAndCacheText.mockResolvedValue({ ...passageCache, text });
    const result = await runToolContract(gutenbergGetText, { id: 84, find: 'one two', limit: 200 });
    expect(result.structuredContent).toMatchObject({
      match: { offset: 6, length: 8, laterMatches: 0 },
      text: text.slice(6, 206),
    });
  });

  it('caps the chunk at 50,000 characters when find matches', async () => {
    const text = `needle${'x'.repeat(60000)}`;
    mockTextService.fetchAndCacheText.mockResolvedValue({ ...passageCache, text });
    const result = await runToolContract(gutenbergGetText, {
      id: 84,
      find: 'needle',
      limit: 60000,
    });
    expect(result.structuredContent).toMatchObject({ length: 50000, appliedLimit: 50000 });
  });

  it('runs offset_out_of_range before the scan, with find and without', async () => {
    const offset = PASSAGE_BOOK.length;
    for (const input of [
      { id: 84, offset },
      { id: 84, offset, find: 'Prince' },
    ]) {
      const result = await runToolContract(gutenbergGetText, input);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'offset_out_of_range' } },
      });
    }
    expect(mockTextService.findPassage).not.toHaveBeenCalled();
  });

  it('reports laterMatches 0 for a match ending the text, and continuing there is out of range', async () => {
    const find = 'afraid.';
    const hit = await runToolContract(gutenbergGetText, { id: 84, find });
    const { match } = hit.structuredContent as { match: { length: number; offset: number } };
    expect(hit.structuredContent).toMatchObject({ match: { laterMatches: 0 }, remainingChars: 0 });
    expect(match.offset + match.length).toBe(PASSAGE_BOOK.length);
    const next = await runToolContract(gutenbergGetText, {
      id: 84,
      find,
      offset: match.offset + match.length,
    });
    expect(next.structuredContent).toMatchObject({
      error: { data: { reason: 'offset_out_of_range' } },
    });
  });

  it('fails an absent passage as passage_not_found on both surfaces, with no other chunk', async () => {
    const result = await runToolContract(gutenbergGetText, { id: 84, find: SENTINEL });
    const declared = gutenbergGetText.errors?.find((e) => e.reason === 'passage_not_found');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'passage_not_found', recovery: { hint: declared?.recovery } },
      },
    });
    expect(wire(result)).toContain('Recovery:');
    expect(wire(result)).toContain('whitespace');
    expect(wire(result)).not.toContain('Well, Prince');
    expect(result.structuredContent).not.toHaveProperty('text');
  });

  it('carries the same failure shape as a declared reason raised in the handler', async () => {
    const fails = (input: { find?: string; id: number; offset?: number }) =>
      runToolContract(gutenbergGetText, input).then(
        (r) => (r.structuredContent as { error: { data: object } }).error.data,
      );
    const missing = await fails({ id: 84, find: SENTINEL });
    const pastEnd = await fails({ id: 84, offset: PASSAGE_BOOK.length });
    expect(Object.keys(missing).sort()).toEqual(Object.keys(pastEnd).sort());
  });

  it('treats a dot in find as a literal, though the text holds abc', async () => {
    const result = await runToolContract(gutenbergGetText, { id: 84, find: 'a.c' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'passage_not_found' } },
    });
  });

  it('finds nothing before offset', async () => {
    const result = await runToolContract(gutenbergGetText, {
      id: 84,
      find: 'Prince',
      offset: PASSAGE_BOOK.indexOf('Prince') + 1,
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'passage_not_found' } },
    });
  });

  it('never echoes find in a result, an error, or a log', async () => {
    const hitContext = createMockContext({ errors: gutenbergGetText.errors });
    const find = 'Well, PRINCE, so GENOA';
    await gutenbergGetText.handler(gutenbergGetText.input.parse({ id: 84, find }), hitContext);
    expect(JSON.stringify((hitContext.log as MockContextLogger).calls)).not.toContain(find);

    const missContext = createMockContext({ errors: gutenbergGetText.errors });
    const failure = await Promise.resolve(
      gutenbergGetText.handler(
        gutenbergGetText.input.parse({ id: 84, find: SENTINEL }),
        missContext,
      ),
    ).catch((e: unknown) => e as McpError);
    expect((failure as McpError).data).toMatchObject({ reason: 'passage_not_found' });
    expect((failure as McpError).message).not.toContain(SENTINEL);
    expect(JSON.stringify((failure as McpError).data)).not.toContain(SENTINEL);
    expect(JSON.stringify((missContext.log as MockContextLogger).calls)).not.toContain(SENTINEL);

    for (const input of [
      { id: 84, find },
      { id: 84, find: SENTINEL },
      { id: 84, find: SENTINEL, offset: PASSAGE_BOOK.length },
      { id: 84, find: SENTINEL, limit: 0 },
    ]) {
      const wholeResult = JSON.stringify(await runToolContract(gutenbergGetText, input));
      expect(wholeResult).not.toContain(input.find);
    }
  });

  it('does not start a scan once the caller has cancelled', async () => {
    const controller = new AbortController();
    mockTextService.fetchAndCacheText.mockImplementation(async () => {
      controller.abort();
      return passageCache;
    });
    const result = await runToolContract(
      gutenbergGetText,
      { id: 84, find: 'Prince' },
      { context: { signal: controller.signal } },
    );
    expect(mockTextService.findPassage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
  });
});

// ── Boilerplate stripping via the real pipeline ──────────────────────────────

describe('GutenbergTextService.processRaw — boilerplate stripping', () => {
  /**
   * Access the private processRaw method via the real service instance to verify
   * the BOM + START/END marker extraction pipeline in isolation, without network calls.
   */
  function makeService(): GutenbergTextService {
    return new (
      GutenbergTextService as unknown as new (
        _c: unknown,
        _s: unknown,
        _sc: unknown,
      ) => GutenbergTextService
    )(null, null, {
      gutenbergTextBaseUrl: 'https://gutenberg.pglaf.org',
      gutendexBaseUrl: 'https://gutendex.com/books/',
    });
  }

  // Access private processRaw
  function processRaw(
    service: GutenbergTextService,
    raw: string,
    format: string,
  ): { text: string; sourceFormat: string } {
    return (
      service as unknown as {
        processRaw: (r: string, f: string) => { text: string; sourceFormat: string };
      }
    ).processRaw(raw, format);
  }

  it('strips UTF-8 BOM (\\xEF\\xBB\\xBF) at the start of the file', () => {
    const withBom =
      '﻿*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\nHello world\n*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\n';
    const service = makeService();
    const result = processRaw(service, withBom, 'text/plain; charset=utf-8');
    expect(result.text).not.toContain('﻿');
    expect(result.text).toContain('Hello world');
  });

  it('extracts literary content between *** START *** and *** END *** markers', () => {
    const raw =
      'Title: Frankenstein\nAuthor: Mary Shelley\n\n' +
      '*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\n' +
      'Chapter 1. You will rejoice to hear...\n\n' +
      'More content here.\n' +
      '*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\n' +
      'Project Gutenberg License text...\nEnd of Project Gutenberg...\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=utf-8');

    expect(result.text).toContain('Chapter 1. You will rejoice to hear');
    expect(result.text).not.toContain('Project Gutenberg License text');
    expect(result.text).not.toContain('Title: Frankenstein');
  });

  it('strips both the header block and the license footer', () => {
    const raw =
      'Title: Test\r\nAuthor: Someone\r\nRelease date: January 1, 2020 [eBook #99]\r\n' +
      'Language: English\r\n\r\n' +
      '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n' +
      'Chapter 1.\r\nThe story begins here.\r\n\r\n' +
      'Second paragraph.\r\n' +
      '*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n' +
      '*** END: FULL LICENSE ***\r\n' +
      'This eBook is for the use of anyone...\r\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=utf-8');

    expect(result.text).toContain('Chapter 1');
    expect(result.text).toContain('Second paragraph');
    expect(result.text).not.toContain('Title: Test');
    expect(result.text).not.toContain('This eBook is for the use of anyone');
  });

  it('normalizes CRLF line endings to LF', () => {
    const raw =
      '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n' +
      'Line one.\r\nLine two.\r\n' +
      '*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=utf-8');

    expect(result.text).not.toContain('\r\n');
    expect(result.text).toContain('Line one.\n');
  });

  it('collapses 3+ consecutive blank lines to 2', () => {
    const raw =
      '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n' +
      'Para 1.\n\n\n\n\nPara 2.\n' +
      '*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=utf-8');

    expect(result.text).not.toMatch(/\n{3,}/);
    expect(result.text).toContain('Para 1.');
    expect(result.text).toContain('Para 2.');
  });

  it('handles US-ASCII format (no BOM, START marker at line 1)', () => {
    // Older Gutenberg entries: no header block, marker appears at line 1
    const raw =
      '*** START OF THE PROJECT GUTENBERG EBOOK OLD BOOK ***\r\n' +
      'Chapter I.\r\nOnce upon a time...\r\n' +
      '*** END OF THE PROJECT GUTENBERG EBOOK OLD BOOK ***\r\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=us-ascii');

    expect(result.text).toContain('Chapter I.');
    expect(result.text).not.toContain('*** START OF');
    expect(result.text).not.toContain('*** END OF');
  });

  it('returns the full processed text when no START/END markers are found', () => {
    // Rare malformed file — no markers
    const raw = 'No markers here.\nJust plain content.\nLine 3.\n';
    const service = makeService();
    const result = processRaw(service, raw, 'text/plain; charset=utf-8');

    // Should fall through to full content (processRaw uses the full text when no markers found)
    expect(result.text).toContain('No markers here.');
    expect(result.text).toContain('Just plain content.');
  });
});

// ── Error paths ──────────────────────────────────────────────────────────────

describe('gutenbergGetText — error paths', () => {
  it('throws ctx.fail("not_found") when the book does not exist', async () => {
    mockGutendexService.getBook.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Not found'),
    );
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 9999999 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('throws ctx.fail("audio_book") for media_type="Sound" books', async () => {
    mockGutendexService.getBook.mockResolvedValue(audioBook);
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 55555 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'audio_book' },
    });
  });

  it('carries the declared audio_book recovery hint to the wire without a throw-site forward', async () => {
    mockGutendexService.getBook.mockResolvedValue(audioBook);

    const result = await runToolContract(gutenbergGetText, { id: 55555 });
    const structured = result.structuredContent as {
      error: { code: number; data?: Record<string, unknown> };
    };
    const audioEntry = gutenbergGetText.errors?.find((e) => e.reason === 'audio_book');

    expect(result.isError).toBe(true);
    expect(structured.error.data).toMatchObject({
      reason: 'audio_book',
      recovery: { hint: audioEntry?.recovery },
    });
  });

  it('throws ctx.fail("no_text_format") when no readable format exists', async () => {
    const epubOnlyBook = {
      ...textBook,
      formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/84.epub' },
      has_plain_text: false,
    };
    mockGutendexService.getBook.mockResolvedValue(epubOnlyBook);
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_text_format' },
    });
  });

  it('throws ctx.fail("no_text_format") with a recovery hint for an ascii-only book, without calling the text service', async () => {
    // us-ascii has no compliant mirror path — the tool-level guard must catch this
    // itself (and populate the declared recovery hint via ctx.fail) rather than
    // falling through to GutenbergTextService, whose own no_text_format throw is a
    // bare error factory call with no recovery data.
    const asciiOnlyBook = {
      ...textBook,
      formats: { 'text/plain; charset=us-ascii': 'https://www.gutenberg.org/files/52/52.txt' },
      has_plain_text: false,
    };
    mockGutendexService.getBook.mockResolvedValue(asciiOnlyBook);
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 52 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_text_format', recovery: { hint: expect.any(String) } },
    });
    expect(mockTextService.fetchAndCacheText).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("offset_out_of_range") when offset ≥ totalChars', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(cachedText);
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const pastEnd = LITERARY_TEXT.length + 1;
    const input = gutenbergGetText.input.parse({ id: 84, offset: pastEnd });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'offset_out_of_range' },
    });
  });

  it('propagates text_fetch_failed with the declared recovery hint when the mirror fails', async () => {
    // Mirrors what GutenbergTextService raises on a spent mirror ladder: a stable
    // message naming the book, plus the hint resolved from the calling tool's own
    // contract. Asserting the hint is what separates a fixed contract from a bare
    // reason tag — a subset match on the reason alone passes either way.
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockImplementation(
      (_book: unknown, id: number, ctx: Context) =>
        Promise.reject(
          serviceUnavailable(
            `Failed to fetch text for book ${id}: the Gutenberg mirror did not respond.`,
            { reason: 'text_fetch_failed', ...ctx.recoveryFor('text_fetch_failed') },
          ),
        ),
    );
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'text_fetch_failed', recovery: { hint: expect.any(String) } },
    });
  });

  it('propagates catalog_unavailable from the catalog hop, distinct from a mirror failure', async () => {
    // This tool touches two upstreams that fail independently; a catalog outage
    // must not be reported as the file server refusing to serve text.
    mockGutendexService.getBook.mockImplementation((id: number, ctx: Context) =>
      Promise.reject(
        serviceUnavailable(`The Project Gutenberg catalog did not respond for book ${id}.`, {
          reason: 'catalog_unavailable',
          ...ctx.recoveryFor('catalog_unavailable'),
        }),
      ),
    );
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'catalog_unavailable', recovery: { hint: expect.any(String) } },
    });
    expect(mockTextService.fetchAndCacheText).not.toHaveBeenCalled();
  });
});

// ── Upstream outages on both client surfaces (#9, #12) ───────────────────────

describe('gutenbergGetText — upstream outages reach both client surfaces', () => {
  it('carries the text_fetch_failed hint to structuredContent and content[], with no mirror URL', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockImplementation(
      (_book: unknown, id: number, ctx: Context) =>
        Promise.reject(
          serviceUnavailable(
            `Failed to fetch text for book ${id}: the Gutenberg mirror did not respond.`,
            { reason: 'text_fetch_failed', ...ctx.recoveryFor('text_fetch_failed') },
          ),
        ),
    );

    const result = await runToolContract(gutenbergGetText, { id: 84 });
    const structured = result.structuredContent as {
      error: { code: number; message: string; data?: Record<string, unknown> };
    };
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(structured.error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(structured.error.data).toMatchObject({
      reason: 'text_fetch_failed',
      recovery: { hint: expect.any(String) },
    });
    expect(text).toContain('Recovery:');
    expect(structured.error.message).toContain('84');
    expect(structured.error.message).not.toContain('pglaf');
    expect(structured.error.message).not.toContain('cache/epub');
    expect(structured.error.message).not.toContain('http');
  });

  it('carries the catalog_unavailable hint to structuredContent and content[]', async () => {
    mockGutendexService.getBook.mockImplementation((id: number, ctx: Context) =>
      Promise.reject(
        serviceUnavailable(`The Project Gutenberg catalog did not respond for book ${id}.`, {
          reason: 'catalog_unavailable',
          ...ctx.recoveryFor('catalog_unavailable'),
        }),
      ),
    );

    const result = await runToolContract(gutenbergGetText, { id: 84 });
    const structured = result.structuredContent as {
      error: { code: number; message: string; data?: Record<string, unknown> };
    };
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(structured.error.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: expect.any(String) },
    });
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('gutendex.com');
  });
});

// ── format() ─────────────────────────────────────────────────────────────────

describe('gutenbergGetText — format()', () => {
  const baseOutput = {
    requestedLimit: 20000,
    appliedLimit: 20000,
    id: 84,
    title: 'Frankenstein',
    text: 'Chapter 1. You will rejoice to hear...',
    offset: 0,
    length: 38,
    totalChars: 448000,
    remainingChars: 447962,
    hasMore: true,
    provenance:
      'Project Gutenberg eBook #84: Frankenstein — https://www.gutenberg.org/ebooks/84 — License: www.gutenberg.org/license',
    sourceFormat: 'text/plain; charset=utf-8' as const,
  };

  it('renders provenance, position summary, and text content', () => {
    const blocks = gutenbergGetText.format!(baseOutput);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Project Gutenberg eBook #84');
    expect(text).toContain('Frankenstein');
    expect(text).toContain('Chapter 1. You will rejoice to hear');
  });

  it('includes character position summary with offset, totalChars, and remainingChars', () => {
    const blocks = gutenbergGetText.format!(baseOutput);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('448'); // totalChars (with locale separator)
    expect(text).toContain('remaining');
    expect(text).toContain('hasMore: true');
  });

  it('appends "call again" next-chunk instruction when hasMore=true', () => {
    const blocks = gutenbergGetText.format!(baseOutput);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('gutenberg_get_text');
    expect(text).toContain('offset=38'); // offset + length
  });

  it('shows "End of book" message instead of next-chunk CTA when hasMore=false', () => {
    const lastChunk = { ...baseOutput, hasMore: false, remainingChars: 0 };
    const blocks = gutenbergGetText.format!(lastChunk);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('End of book');
    expect(text).not.toContain('Call');
  });

  const matched = {
    ...baseOutput,
    offset: 6620,
    match: { offset: 6620, length: 79, laterMatches: 3 },
  };
  const render = (output: typeof baseOutput & { match?: typeof matched.match }) =>
    (gutenbergGetText.format!(output)[0] as { text: string }).text;

  it('renders match as a numbers-only line above the text fence', () => {
    const text = render({ ...matched, text: '**Match:** offset 1 | length 2 | 3 later' });
    const line = '**Match:** offset 6,620 | length 79 | 3 later';
    expect(text).toContain(`\n\n${line}\n\n\`\`\`text\n`);
    expect(text.indexOf(line)).toBeLessThan(text.indexOf('```text'));
  });

  it('names the next occurrence while laterMatches > 0, without quoting find', () => {
    const text = render(matched);
    expect(text).toContain('with id=84, the same find, and offset=6699 for the next occurrence');
  });

  it('keeps the next-chunk continuation beside the next-occurrence one', () => {
    expect(render(matched)).toContain('offset=6658 to read the next chunk');
  });

  it('names the next occurrence on the last chunk too', () => {
    const text = render({ ...matched, hasMore: false, remainingChars: 0 });
    expect(text).toContain('End of book');
    expect(text).toContain('offset=6699 for the next occurrence');
  });

  it('drops the next-occurrence continuation at laterMatches 0', () => {
    const text = render({ ...matched, match: { ...matched.match, laterMatches: 0 } });
    expect(text).toContain('**Match:** offset 6,620 | length 79 | 0 later');
    expect(text).not.toContain('next occurrence');
  });

  it('renders no match line for an ordinary read', () => {
    expect(render(baseOutput)).not.toContain('Match');
  });

  // ── CommonMark read-back (#37) ─────────────────────────────────────────────
  //
  // format-parity's sentinels never reach an escape: these read a real parse.

  const titled = (title: string) => ({
    ...baseOutput,
    hasMore: false,
    remainingChars: 0,
    title,
    provenance: `Project Gutenberg eBook #84: ${title} — https://www.gutenberg.org/ebooks/84 — License: www.gutenberg.org/license`,
  });

  /** The page a reader should get, written from the raw values instead of from format(). */
  const wantPage = (output: ReturnType<typeof titled>) =>
    [
      output.provenance,
      `[84] ${output.title}`,
      'Characters 0–37 of 448,000 | Length: 38 chars | 0 remaining | hasMore: false | Format: text/plain; charset=utf-8',
      '---',
      'Requested limit: 20,000 | Applied limit: 20,000',
      output.text,
      '---',
      'End of book.',
    ].join('\n\n');

  it('reads a title holding syntax back on its line and in the provenance', () => {
    const output = titled(ACTIVE_MARKDOWN);
    expect(readBack(render(output)).text).toBe(wantPage(output));
  });

  it('reads a provenance holding syntax back inside its emphasis', () => {
    const provenance = 'Project Gutenberg eBook #84: *a* — License: www.gutenberg.org/license';
    expect(readBack(render({ ...baseOutput, provenance })).emphasis[0]).toBe(provenance);
  });

  it('keeps the title line readable for an empty title', () => {
    const output = titled('');
    expect(readBack(render(output)).blocks[1]).toEqual({
      container: undefined,
      kind: 'paragraph',
      text: '[84]',
    });
  });

  it('reads any title back from both lines, with the wrappers intact', () => {
    fc.assert(
      fc.property(hostileLine, (title) => {
        const output = titled(title);
        const doc = readBack(render(output));
        expect(doc.text).toBe(wantPage(output));
        expect(doc.emphasis).toEqual([output.provenance, 'End of book.']);
      }),
      PROPERTY_RUNS,
    );
  });

  it('leaves a title with nothing to encode byte-identical', () => {
    const text = render(baseOutput);
    expect(text).toContain('\n**[84]** Frankenstein\n');
    expect(text).toContain(`_${baseOutput.provenance}_`);
  });

  /** Titles from the 2026-10-30 catalog harvest, 30121 abridged. */
  it.each([
    [38430, 'The philosophy of Mr. B*rtr*nd R*ss*ll'],
    [30121, 'The Art of Confectionary: ... Figs, Grapes, &amp;c., Flowers and Herbs; ...'],
  ])('reads %i back through the wire contract, the fence holding its runs', async (id, title) => {
    const literary = 'Editor *note*\n```\n~~~\n```````\n    indented\n<em>end</em>';
    mockGutendexService.getBook.mockResolvedValue({ ...textBook, id, title });
    mockTextService.fetchAndCacheText.mockResolvedValue({ ...cachedText, text: literary });
    const result = await runToolContract(gutenbergGetText, { id, limit: 200 });
    const { provenance, text } = result.structuredContent as { provenance: string; text: string };

    expect(provenance).toContain(`#${id}: ${title} — `);
    expect(text).toBe(literary);
    const doc = readBack(contentText(result));
    expect(doc.blocks[0]).toEqual({ container: undefined, kind: 'paragraph', text: provenance });
    expect(doc.blocks[1]?.text).toBe(`[${id}] ${title}`);
    expect(doc.emphasis).toEqual([provenance, 'End of book.']);
    expect(doc.blocks.filter((block) => block.kind === 'code')).toEqual([
      { container: undefined, kind: 'code', text: literary },
    ]);
  });
});

// ── Mirror sourcing: resolveTextUrl + no-format handling (issue #1) ───────────
//
// Text is sourced from the PG-sanctioned mirror (gutenberg.pglaf.org), never the
// human-only main site. These tests pin that every resolved fetch URL targets the
// mirror even when the Gutendex formats map carries the raw www.gutenberg.org URL,
// and that formats with no compliant mirror path degrade to a clean no_text_format
// error instead of falling back to the main site.

describe('GutenbergTextService.resolveTextUrl — mirror sourcing', () => {
  /** Real service pinned to the default PG mirror, for exercising URL resolution. */
  function makeMirrorService(): GutenbergTextService {
    return new (
      GutenbergTextService as unknown as new (
        _c: unknown,
        _s: unknown,
        _sc: unknown,
      ) => GutenbergTextService
    )(null, null, {
      gutenbergTextBaseUrl: 'https://gutenberg.pglaf.org',
      gutendexBaseUrl: 'https://gutendex.com/books/',
    });
  }

  /** Access the private resolveTextUrl for direct URL-resolution assertions. */
  function resolveTextUrl(
    service: GutenbergTextService,
    book: Book,
    id: number,
  ): { url: string; format: string } | null {
    return (
      service as unknown as {
        resolveTextUrl: (b: Book, i: number) => { url: string; format: string } | null;
      }
    ).resolveTextUrl(book, id);
  }

  it('resolves UTF-8 books to the mirror cache path, ignoring the raw www.gutenberg.org formats URL', () => {
    // The formats map carries the real Gutendex URL (main site); resolution must ignore it.
    const book: Book = {
      ...textBook,
      formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/84.txt.utf-8' },
    };
    const resolved = resolveTextUrl(makeMirrorService(), book, 84);

    expect(resolved?.url).toBe('https://gutenberg.pglaf.org/cache/epub/84/pg84.txt');
    expect(resolved?.format).toBe('text/plain; charset=utf-8');
    expect(resolved?.url).not.toContain('www.gutenberg.org');
  });

  it('falls back to the mirror HTML cache path when only HTML is available', () => {
    const book: Book = {
      ...textBook,
      formats: {
        'text/html': 'https://www.gutenberg.org/ebooks/116.html.images',
        'text/plain; charset=us-ascii': 'https://www.gutenberg.org/files/116/116-0.txt',
      },
    };
    const resolved = resolveTextUrl(makeMirrorService(), book, 116);

    expect(resolved?.url).toBe('https://gutenberg.pglaf.org/cache/epub/116/pg116-images.html');
    expect(resolved?.format).toBe('text/html');
    expect(resolved?.url).not.toContain('www.gutenberg.org');
  });

  it('returns null for us-ascii-only books (no compliant mirror path)', () => {
    const book: Book = {
      ...textBook,
      formats: { 'text/plain; charset=us-ascii': 'https://www.gutenberg.org/files/52/52.txt' },
    };
    expect(resolveTextUrl(makeMirrorService(), book, 52)).toBeNull();
  });

  it('fetchAndCacheText throws no_text_format (NotFound) for a us-ascii-only book without fetching', async () => {
    const service = makeMirrorService();
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const usAsciiOnly: Book = {
      ...textBook,
      formats: { 'text/plain; charset=us-ascii': 'https://www.gutenberg.org/files/52/52.txt' },
    };

    const err = await service.fetchAndCacheText(usAsciiOnly, 52, ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data).toMatchObject({ reason: 'no_text_format' });
  });
});
