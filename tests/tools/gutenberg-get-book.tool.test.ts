/**
 * @fileoverview Tests for the gutenberg_get_book tool.
 * @module tests/tools/gutenberg-get-book.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetBook } from '@/mcp-server/tools/definitions/gutenberg-get-book.tool.js';

vi.mock('@/services/gutendex/gutendex-service.js', () => ({
  getGutendexService: vi.fn(() => mockGutendexService),
}));

const mockGutendexService = {
  searchBooks: vi.fn(),
  getBook: vi.fn(),
};

const mockBook = {
  id: 1342,
  title: 'Pride and Prejudice',
  authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
  translators: [],
  editors: [],
  subjects: ['England -- Social life and customs -- 19th century -- Fiction'],
  bookshelves: ['Best Books Ever Listings'],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 75000,
  summary: null,
  summaries: [],
  formats: {
    'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/1342.txt.utf-8',
    'text/html': 'https://www.gutenberg.org/ebooks/1342.html',
    'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub.noimages',
  },
  has_plain_text: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergGetBook', () => {
  it('returns the full book record for a valid ID', async () => {
    mockGutendexService.getBook.mockResolvedValue(mockBook);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 1342 });
    const result = await gutenbergGetBook.handler(input, ctx);

    expect(result.id).toBe(1342);
    expect(result.title).toBe('Pride and Prejudice');
    expect(result.authors).toHaveLength(1);
    expect(result.authors[0]?.name).toBe('Austen, Jane');
    expect(result.translators).toEqual([]);
    expect(result.editors).toEqual([]);
    expect(result.languages).toEqual(['en']);
    expect(result.copyright).toBe(false);
    expect(result.media_type).toBe('Text');
    expect(result.has_plain_text).toBe(true);
    expect(result.summary).toBeNull();
    expect(Object.keys(result.formats)).toHaveLength(3);
  });

  it('returns a book with a summary when available', async () => {
    const bookWithSummary = {
      ...mockBook,
      summary: 'A novel about love and society in Regency England.',
    };
    mockGutendexService.getBook.mockResolvedValue(bookWithSummary);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 1342 });
    const result = await gutenbergGetBook.handler(input, ctx);

    expect(result.summary).toBe('A novel about love and society in Regency England.');
  });

  it('returns has_plain_text=false for audio books (sparse: no text format)', async () => {
    const audioBook = {
      ...mockBook,
      id: 99999,
      title: 'An Audio Book',
      media_type: 'Sound',
      formats: { 'audio/mpeg': 'https://www.gutenberg.org/ebooks/99999.mp3' },
      has_plain_text: false,
    };
    mockGutendexService.getBook.mockResolvedValue(audioBook);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 99999 });
    const result = await gutenbergGetBook.handler(input, ctx);

    expect(result.has_plain_text).toBe(false);
    expect(result.media_type).toBe('Sound');
  });

  it('translates a service NotFound into ctx.fail("not_found") with recovery guidance', async () => {
    mockGutendexService.getBook.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'No book found with Gutenberg ID 9999999.'),
    );
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 9999999 });

    // The service raises a bare NotFound; the handler must re-throw through
    // ctx.fail so both data.reason and the declared recovery hint reach the client.
    await expect(gutenbergGetBook.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('gutenberg_search_books') },
      },
    });
  });

  it('propagates non-NotFound service errors unchanged', async () => {
    mockGutendexService.getBook.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Gutendex is unavailable'),
    );
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 1342 });

    const err = await Promise.resolve(gutenbergGetBook.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data?.reason).toBeUndefined();
  });

  it('handles a translated work (translators populated)', async () => {
    const translatedBook = {
      ...mockBook,
      id: 2600,
      title: 'War and Peace',
      authors: [{ name: 'Tolstoy, Leo', birth_year: 1828, death_year: 1910 }],
      translators: [{ name: 'Maude, Aylmer', birth_year: 1858, death_year: 1938 }],
    };
    mockGutendexService.getBook.mockResolvedValue(translatedBook);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 2600 });
    const result = await gutenbergGetBook.handler(input, ctx);

    expect(result.translators).toHaveLength(1);
    expect(result.translators[0]?.name).toBe('Maude, Aylmer');
  });

  it('handles a book with unknown copyright (null)', async () => {
    const unknownCopyright = { ...mockBook, copyright: null };
    mockGutendexService.getBook.mockResolvedValue(unknownCopyright);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 1342 });
    const result = await gutenbergGetBook.handler(input, ctx);

    expect(result.copyright).toBeNull();
  });

  describe('format()', () => {
    const fullOutput = {
      id: 1342,
      title: 'Pride and Prejudice',
      authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
      translators: [],
      editors: [],
      subjects: ['English fiction'],
      bookshelves: ['Best Books Ever Listings'],
      languages: ['en'],
      copyright: false,
      media_type: 'Text',
      download_count: 75000,
      summary: null,
      summaries: [],
      formats: {
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
        'text/html': 'https://www.gutenberg.org/ebooks/1342.html',
      },
      has_plain_text: true,
    };

    it('renders title, ID, authors, subjects, and formats', () => {
      const blocks = gutenbergGetBook.format!(fullOutput);
      expect(blocks[0]?.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('1342');
      expect(text).toContain('Austen, Jane');
      expect(text).toContain('1775');
      expect(text).toContain('English fiction');
      expect(text).toContain('text/plain; charset=utf-8');
      expect(text).toContain('Yes');
    });

    it('renders copyright=false as "Public Domain (USA)"', () => {
      const blocks = gutenbergGetBook.format!(fullOutput);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Public Domain');
    });

    it('renders copyright=null as "Unknown"', () => {
      const nullCopyright = { ...fullOutput, copyright: null };
      const blocks = gutenbergGetBook.format!(nullCopyright);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Unknown');
    });

    it('renders summary when present', () => {
      const withSummary = { ...fullOutput, summary: 'A classic novel.' };
      const blocks = gutenbergGetBook.format!(withSummary);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('A classic novel.');
    });

    it('renders translators when present', () => {
      const withTranslator = {
        ...fullOutput,
        translators: [{ name: 'Maude, Aylmer', birth_year: null, death_year: null }],
      };
      const blocks = gutenbergGetBook.format!(withTranslator);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Maude, Aylmer');
    });

    it('renders editors when present', () => {
      const withEditor = {
        ...fullOutput,
        editors: [{ name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 }],
      };
      const blocks = gutenbergGetBook.format!(withEditor);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Dods, Marcus');
      expect(text).toContain('1834');
    });

    // ── Explicit empty/null states (#10) ─────────────────────────────────────
    //
    // structuredContent carries `[]` and `null` verbatim; a content[]-only client
    // that sees no line cannot tell "known empty" from "not reported".

    it('renders an explicit line for every empty collection', () => {
      const empty = {
        ...fullOutput,
        authors: [],
        translators: [],
        editors: [],
        subjects: [],
        bookshelves: [],
      };
      const blocks = gutenbergGetBook.format!(empty);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('**Authors:** None');
      expect(text).toContain('**Translators:** None');
      expect(text).toContain('**Editors:** None');
      expect(text).toContain('**Subjects:** None');
      expect(text).toContain('**Bookshelves:** None');
    });

    it('renders a null summary as explicitly unavailable rather than omitting it', () => {
      const blocks = gutenbergGetBook.format!({ ...fullOutput, summary: null });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Summary:** Not available');
    });

    // ── Full summary set (#11) ───────────────────────────────────────────────

    it('renders every summary beyond the first, not only the singular summary', () => {
      const twoSummaries = {
        ...fullOutput,
        summary: 'The first English translation.',
        summaries: ['The first English translation.', 'A shorter blurb.'],
      };
      const blocks = gutenbergGetBook.format!(twoSummaries);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('The first English translation.');
      expect(text).toContain('A shorter blurb.');
    });

    it('does not repeat the singular summary in the additional-summaries list', () => {
      const oneSummary = {
        ...fullOutput,
        summary: 'Only summary.',
        summaries: ['Only summary.'],
      };
      const text = (gutenbergGetBook.format!(oneSummary)[0] as { text: string }).text;
      expect(text.match(/Only summary\./g)).toHaveLength(1);
    });

    it('renders the summaries field explicitly when the array is empty', () => {
      const blocks = gutenbergGetBook.format!({ ...fullOutput, summary: null, summaries: [] });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Additional summaries:** None');
    });
  });
});

// ── Editors and full summary set on both surfaces (#10, #11) ─────────────────

describe('gutenbergGetBook — sparse and multi-summary records end to end', () => {
  it('carries editors and every summary on structuredContent and content[]', async () => {
    mockGutendexService.getBook.mockResolvedValue({
      ...mockBook,
      id: 45304,
      title: 'The City of God, Volume I',
      editors: [{ name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 }],
      summary: 'A work of Christian philosophy.',
      summaries: ['A work of Christian philosophy.', 'A shorter blurb.'],
    });

    const result = await runToolContract(gutenbergGetBook, { id: 45304 });
    const structured = result.structuredContent as {
      editors: { name: string }[];
      summaries: string[];
      summary: string;
    };
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBeFalsy();
    expect(structured.editors).toHaveLength(1);
    expect(structured.summaries).toHaveLength(2);
    expect(structured.summary).toBe('A work of Christian philosophy.');
    expect(text).toContain('Dods, Marcus');
    expect(text).toContain('A shorter blurb.');
  });

  it('states every absent field explicitly on content[] for a bare record', async () => {
    mockGutendexService.getBook.mockResolvedValue({
      ...mockBook,
      authors: [],
      translators: [],
      editors: [],
      subjects: [],
      bookshelves: [],
      summary: null,
      summaries: [],
    });

    const result = await runToolContract(gutenbergGetBook, { id: 1342 });
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBeFalsy();
    for (const line of [
      '**Authors:** None',
      '**Translators:** None',
      '**Editors:** None',
      '**Subjects:** None',
      '**Bookshelves:** None',
      '**Summary:** Not available',
      '**Additional summaries:** None',
    ]) {
      expect(text).toContain(line);
    }
  });
});

// ── Catalog outage contract (#12) ────────────────────────────────────────────

describe('gutenbergGetBook — catalog_unavailable', () => {
  it('surfaces the declared reason and recovery hint on both client surfaces', async () => {
    mockGutendexService.getBook.mockImplementation((_id: number, ctx: Context) =>
      Promise.reject(
        serviceUnavailable('The Project Gutenberg catalog did not respond for book 1342.', {
          reason: 'catalog_unavailable',
          ...ctx.recoveryFor('catalog_unavailable'),
        }),
      ),
    );

    const result = await runToolContract(gutenbergGetBook, { id: 1342 });
    const structured = result.structuredContent as {
      error: { code: number; message: string; data?: Record<string, unknown> };
    };
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(structured.error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(structured.error.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: expect.any(String) },
    });
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('gutendex.com');
  });
});
