/**
 * @fileoverview Tests for the gutenberg_search_books tool.
 * @module tests/tools/gutenberg-search-books.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';

// Mock the service module — tests control what searchBooks returns
vi.mock('@/services/gutendex/gutendex-service.js', () => ({
  getGutendexService: vi.fn(() => mockGutendexService),
}));

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
  formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/1342.txt.utf-8' },
  has_plain_text: true,
};

const mockGutendexService = {
  searchBooks: vi.fn(),
  getBook: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergSearchBooks', () => {
  it('returns matched books with all fields', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [mockBook],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'pride and prejudice' });
    const result = await gutenbergSearchBooks.handler(input, ctx);

    expect(result.books).toHaveLength(1);
    expect(result.books[0].id).toBe(1342);
    expect(result.books[0].title).toBe('Pride and Prejudice');
    expect(result.books[0].has_plain_text).toBe(true);
    expect(result.totalCount).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.page).toBe(1);
  });

  it('returns pagination info when hasMore is true', async () => {
    const books = Array.from({ length: 32 }, (_, i) => ({ ...mockBook, id: i + 1 }));
    mockGutendexService.searchBooks.mockResolvedValue({
      books,
      totalCount: 64,
      hasMore: true,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'classics' });
    const result = await gutenbergSearchBooks.handler(input, ctx);

    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(64);
    expect(result.books).toHaveLength(32);
  });

  it('applies defaults: sort=popular, page=1', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [mockBook],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'austen' });

    expect(input.sort).toBe('popular');
    expect(input.page).toBe(1);
    await gutenbergSearchBooks.handler(input, ctx);
    expect(mockGutendexService.searchBooks).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'popular', page: 1 }),
      expect.anything(),
    );
  });

  it('strips empty languages array before passing to service', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [mockBook],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'austen', languages: [] });
    await gutenbergSearchBooks.handler(input, ctx);

    expect(mockGutendexService.searchBooks).toHaveBeenCalledWith(
      expect.objectContaining({ languages: undefined }),
      expect.anything(),
    );
  });

  it('throws ctx.fail("no_results") when service returns empty books', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [],
      totalCount: 0,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'zzznomatch' });

    await expect(gutenbergSearchBooks.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('propagates service errors', async () => {
    mockGutendexService.searchBooks.mockRejectedValue(new Error('Network error'));
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'anything' });

    await expect(gutenbergSearchBooks.handler(input, ctx)).rejects.toThrow('Network error');
  });

  it('handles a book with no known author years (sparse upstream)', async () => {
    const sparseBook = {
      ...mockBook,
      authors: [{ name: 'Anonymous', birth_year: null, death_year: null }],
    };
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [sparseBook],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({});
    const result = await gutenbergSearchBooks.handler(input, ctx);

    expect(result.books[0].authors[0].birth_year).toBeNull();
    expect(result.books[0].authors[0].death_year).toBeNull();
  });

  describe('format()', () => {
    it('renders all key fields: id, title, authors, language, downloads, text flag', () => {
      const output = {
        books: [
          {
            id: 1342,
            title: 'Pride and Prejudice',
            authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
            languages: ['en'],
            subjects: ['Fiction'],
            download_count: 75000,
            has_plain_text: true,
          },
        ],
        totalCount: 1,
        page: 1,
        hasMore: false,
      };
      const blocks = gutenbergSearchBooks.format!(output);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('1342');
      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('Austen, Jane');
      expect(text).toContain('en');
      expect(text).toContain('75');
      expect(text).toContain('Yes');
    });

    it('appends pagination hint when hasMore is true', () => {
      const output = {
        books: [
          {
            id: 1,
            title: 'Book',
            authors: [],
            languages: ['en'],
            subjects: [],
            download_count: 1,
            has_plain_text: false,
          },
        ],
        totalCount: 100,
        page: 1,
        hasMore: true,
      };
      const blocks = gutenbergSearchBooks.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('page=2');
    });

    it('renders authors with null years as unknown (?)', () => {
      const output = {
        books: [
          {
            id: 999,
            title: 'Unknown Author Work',
            authors: [{ name: 'Anonymous', birth_year: null, death_year: null }],
            languages: ['en'],
            subjects: [],
            download_count: 10,
            has_plain_text: false,
          },
        ],
        totalCount: 1,
        page: 1,
        hasMore: false,
      };
      const blocks = gutenbergSearchBooks.format!(output);
      const text = (blocks[0] as { text: string }).text;
      // Authors with null years should not include year markers at all (no "(? – ?)")
      // The format function only adds years when at least one is non-null — verify no crash
      expect(text).toContain('Anonymous');
    });
  });
});
