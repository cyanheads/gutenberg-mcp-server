/**
 * @fileoverview Tests for the gutenberg_browse_popular tool.
 * @module tests/tools/gutenberg-browse-popular.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergBrowsePopular } from '@/mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';

vi.mock('@/services/gutendex/gutendex-service.js', () => ({
  getGutendexService: vi.fn(() => mockGutendexService),
}));

const mockGutendexService = {
  searchBooks: vi.fn(),
  getBook: vi.fn(),
};

const makeBook = (n: number) => ({
  id: n,
  title: `Book ${n}`,
  authors: [{ name: `Author ${n}`, birth_year: 1800, death_year: 1900 }],
  translators: [],
  editors: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 10000 - n,
  summary: null,
  formats: { 'text/plain; charset=utf-8': `https://www.gutenberg.org/ebooks/${n}.txt.utf-8` },
  has_plain_text: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergBrowsePopular', () => {
  it('returns the top N books ordered by popularity', async () => {
    const allBooks = Array.from({ length: 32 }, (_, i) => makeBook(i + 1));
    mockGutendexService.searchBooks.mockResolvedValue({
      books: allBooks,
      totalCount: 65000,
      hasMore: true,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ limit: 5 });
    const result = await gutenbergBrowsePopular.handler(input, ctx);

    expect(result.books).toHaveLength(5);
    expect(result.books[0].id).toBe(1);
    expect(result.totalInCatalog).toBe(65000);
  });

  it('discloses truncation when the catalog holds more than the returned page', async () => {
    const allBooks = Array.from({ length: 32 }, (_, i) => makeBook(i + 1));
    mockGutendexService.searchBooks.mockResolvedValue({
      books: allBooks,
      totalCount: 65000,
      hasMore: true,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ limit: 5 });
    await gutenbergBrowsePopular.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      shown: 5,
      cap: 5,
      truncationCeiling: makeBook(5).download_count,
    });
  });

  it('omits truncation disclosure when all matches are returned', async () => {
    const allBooks = Array.from({ length: 3 }, (_, i) => makeBook(i + 1));
    mockGutendexService.searchBooks.mockResolvedValue({
      books: allBooks,
      totalCount: 3,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ limit: 20 });
    await gutenbergBrowsePopular.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('applies limit default of 20', async () => {
    const allBooks = Array.from({ length: 32 }, (_, i) => makeBook(i + 1));
    mockGutendexService.searchBooks.mockResolvedValue({
      books: allBooks,
      totalCount: 65000,
      hasMore: true,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({});

    expect(input.limit).toBe(20);
    const result = await gutenbergBrowsePopular.handler(input, ctx);
    expect(result.books).toHaveLength(20);
  });

  it('passes sort=popular to the service', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({});
    await gutenbergBrowsePopular.handler(input, ctx);

    expect(mockGutendexService.searchBooks).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'popular' }),
      expect.anything(),
    );
  });

  it('passes language filter to the service when provided', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 500,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ languages: ['fr'] });
    await gutenbergBrowsePopular.handler(input, ctx);

    expect(mockGutendexService.searchBooks).toHaveBeenCalledWith(
      expect.objectContaining({ languages: ['fr'] }),
      expect.anything(),
    );
  });

  it('strips empty languages array before passing to service', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ languages: [] });
    await gutenbergBrowsePopular.handler(input, ctx);

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

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ topic: 'zzznomatch' });

    await expect(gutenbergBrowsePopular.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('handles a book with no authors (sparse upstream)', async () => {
    const bookNoAuthor = { ...makeBook(1), authors: [] };
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [bookNoAuthor],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({});
    const result = await gutenbergBrowsePopular.handler(input, ctx);

    expect(result.books[0].authors).toEqual([]);
  });

  describe('format()', () => {
    it('renders ranked list with rank number, title, authors, language, downloads, and text flag', () => {
      const output = {
        books: [
          {
            id: 1342,
            title: 'Pride and Prejudice',
            authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
            languages: ['en'],
            download_count: 75000,
            has_plain_text: true,
          },
          {
            id: 11,
            title: 'Alice in Wonderland',
            authors: [{ name: 'Carroll, Lewis', birth_year: 1832, death_year: 1898 }],
            languages: ['en'],
            download_count: 65000,
            has_plain_text: true,
          },
        ],
        totalInCatalog: 65000,
      };
      const blocks = gutenbergBrowsePopular.format!(output);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('1.');
      expect(text).toContain('2.');
      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('Alice in Wonderland');
      expect(text).toContain('Austen, Jane');
      expect(text).toContain('75');
      expect(text).toContain('Yes');
      expect(text).toContain('65,000'); // totalInCatalog
    });

    it('renders authors with null years without crashing', () => {
      const output = {
        books: [
          {
            id: 99,
            title: 'Anon Work',
            authors: [{ name: 'Anonymous', birth_year: null, death_year: null }],
            languages: ['en'],
            download_count: 100,
            has_plain_text: false,
          },
        ],
        totalInCatalog: 1,
      };
      const blocks = gutenbergBrowsePopular.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Anonymous');
      expect(text).toContain('No'); // has_plain_text false
    });
  });
});
