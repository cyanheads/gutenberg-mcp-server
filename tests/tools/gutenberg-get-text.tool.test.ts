/**
 * @fileoverview Tests for the gutenberg_get_text tool — handler logic, chunking, and
 * boilerplate-stripping behavior from the GutenbergTextService pipeline.
 * @module tests/tools/gutenberg-get-text.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetText } from '@/mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import { GutenbergTextService } from '@/services/gutenberg-text/gutenberg-text-service.js';
import type { CachedText } from '@/services/gutenberg-text/types.js';

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
const mockTextService = { fetchAndCacheText: vi.fn(), chunkText: vi.fn() };

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
  formats: {
    'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/84.txt.utf-8',
  },
  has_plain_text: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: real chunkText logic from the service class
  mockTextService.chunkText.mockImplementation(
    (cached: CachedText, offset: number, limit: number) => {
      const realService = new (
        GutenbergTextService as unknown as new (
          _c: unknown,
          _s: unknown,
          _sc: unknown,
        ) => GutenbergTextService
      )(null, null, {
        gutenbergTextBaseUrl: 'https://www.gutenberg.org',
        gutendexBaseUrl: 'https://gutendex.com/books/',
      });
      return realService.chunkText(cached, offset, limit);
    },
  );
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('gutenbergGetText — happy path', () => {
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
      gutenbergTextBaseUrl: 'https://www.gutenberg.org',
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
    mockGutendexService.getBook.mockRejectedValue({
      code: JsonRpcErrorCode.NotFound,
      message: 'Not found',
    });
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
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'audio_book' },
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

  it('throws ctx.fail("offset_out_of_range") when offset ≥ totalChars', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    mockTextService.fetchAndCacheText.mockResolvedValue(cachedText);
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const pastEnd = LITERARY_TEXT.length + 1;
    const input = gutenbergGetText.input.parse({ id: 84, offset: pastEnd });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'offset_out_of_range' },
    });
  });

  it('propagates text_fetch_failed reason when the text service fetch fails', async () => {
    mockGutendexService.getBook.mockResolvedValue(textBook);
    // Simulate what GutenbergTextService.fetchAndCacheText does on network failure:
    // it wraps the error in serviceUnavailable with data.reason = 'text_fetch_failed'
    mockTextService.fetchAndCacheText.mockRejectedValue(
      serviceUnavailable('Failed to fetch text for book 84: Connection timeout', {
        reason: 'text_fetch_failed',
      }),
    );
    const ctx = createMockContext({ errors: gutenbergGetText.errors });
    const input = gutenbergGetText.input.parse({ id: 84 });

    await expect(gutenbergGetText.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'text_fetch_failed' },
    });
  });
});

// ── format() ─────────────────────────────────────────────────────────────────

describe('gutenbergGetText — format()', () => {
  const baseOutput = {
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
    expect(blocks[0].type).toBe('text');
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
});
