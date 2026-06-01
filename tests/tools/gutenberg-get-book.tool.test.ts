/**
 * @fileoverview Tests for the gutenberg_get_book tool.
 * @module tests/tools/gutenberg-get-book.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.authors[0].name).toBe('Austen, Jane');
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

  it('propagates NotFound when service throws for a nonexistent ID', async () => {
    const notFoundErr = { code: JsonRpcErrorCode.NotFound, message: 'Not found' };
    mockGutendexService.getBook.mockRejectedValue(notFoundErr);
    const ctx = createMockContext({ errors: gutenbergGetBook.errors });
    const input = gutenbergGetBook.input.parse({ id: 9999999 });

    await expect(gutenbergGetBook.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
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
    expect(result.translators[0].name).toBe('Maude, Aylmer');
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
      formats: {
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
        'text/html': 'https://www.gutenberg.org/ebooks/1342.html',
      },
      has_plain_text: true,
    };

    it('renders title, ID, authors, subjects, and formats', () => {
      const blocks = gutenbergGetBook.format!(fullOutput);
      expect(blocks[0].type).toBe('text');
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
  });
});
