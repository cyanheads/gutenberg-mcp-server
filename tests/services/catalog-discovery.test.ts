/**
 * @fileoverview Discovery contract across real SQLite, service routing and tool output.
 * @module tests/services/catalog-discovery.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergBrowsePopular } from '@/mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import {
  type CatalogMirrorService,
  initCatalogMirrorService,
} from '@/services/catalog-mirror/catalog-mirror-service.js';
import { rowFromBook } from '@/services/catalog-mirror/catalog-mirror-store.js';
import { getGutendexService, initGutendexService } from '@/services/gutendex/gutendex-service.js';
import type { Book } from '@/services/gutendex/types.js';

const config = {
  gutendexBaseUrl: 'https://catalog.test/books/',
  gutenbergTextBaseUrl: 'https://mirror.test',
  mirrorPath: ':memory:',
};
const fixture = (id: number, overrides: Partial<Book> = {}): Book => ({
  id,
  title: 'Éléphant % _ modern tale two',
  authors: [{ name: 'Ångström, Émile', birth_year: null, death_year: 1900 }],
  translators: [],
  editors: [],
  subjects: ['ÉTUDES -- Fiction'],
  bookshelves: ['Long shelf phrase'],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 10,
  summaries: [],
  summary: null,
  source_notes: null,
  formats: { 'text/plain; charset=utf-8': 'https://mirror.test/book.txt' },
  has_plain_text: true,
  is_readable: true,
  ...overrides,
});
let mirror: CatalogMirrorService;
let http: ReturnType<typeof createFetchMock>;

beforeEach(async () => {
  mirror = initCatalogMirrorService(config);
  initGutendexService({} as AppConfig, createInMemoryStorage(), config);
  await mirror.mirror.store.applyBatch(
    Array.from({ length: 70 }, (_, i) =>
      rowFromBook(
        fixture(i + 1, {
          copyright: i % 3 === 0 ? null : i % 3 === 1,
          languages: i % 2 ? ['en', 'fr'] : ['en'],
          ...(i === 69
            ? {
                title: 'Different record',
                authors: [],
                formats: {},
                subjects: [],
                bookshelves: [],
                download_count: 0,
              }
            : {}),
        }),
      ),
    ),
    [],
  );
  await mirror.mirror.store.writeState({
    status: 'complete',
    completedAt: new Date().toISOString(),
    total: 70,
  });
  http = createFetchMock();
  http.install();
});
afterEach(async () => {
  http.restore();
  vi.restoreAllMocks();
  await mirror.close();
});

describe('complete mirror discovery', () => {
  it('executes browse continuation through later search pages without losing filters or books', async () => {
    for (const limit of [20, 32]) {
      const browse = await runToolContract(gutenbergBrowsePopular, {
        limit,
        languages: ['EN'],
        mime_type: 'text/',
        copyright: ['true', 'false', 'null'],
      });
      expect(browse.isError).toBeFalsy();
      const output = browse.structuredContent as {
        books: { id: number }[];
        continuation: { arguments: Record<string, unknown> };
      };
      const args = output.continuation.arguments;
      expect(args).toMatchObject({
        languages: ['en'],
        mime_type: 'text/',
        copyright: ['true', 'false', 'null'],
        sort: 'popular',
        page: limit === 20 ? 1 : 2,
      });
      const seen = new Set(output.books.map((book) => book.id));
      let hasMore = true;
      let page = Number(args.page);
      while (hasMore) {
        const search = await runToolContract(gutenbergSearchBooks, { ...args, page });
        expect(search.isError).toBeFalsy();
        const result = search.structuredContent as {
          books: { id: number }[];
          totalCount: number;
          hasMore: boolean;
        };
        expect(result.totalCount).toBe(69);
        for (const book of result.books) seen.add(book.id);
        hasMore = result.hasMore;
        page += 1;
      }
      expect([...seen]).toEqual(Array.from({ length: 69 }, (_, i) => i + 1));
    }
  });

  it('does not leak mutable query arguments, criteria or books into later calls', async () => {
    const input = { ids: [1, 2], languages: ['en'] };
    const first = await runToolContract(gutenbergSearchBooks, input);
    const output = first.structuredContent as {
      books: { title: string }[];
      effectiveCriteria: { ids: number[]; languages: string[] };
    };
    output.books[0]!.title = 'mutated';
    output.effectiveCriteria.ids.push(70);
    output.effectiveCriteria.languages[0] = 'xx';
    expect(input).toEqual({ ids: [1, 2], languages: ['en'] });
    const second = await runToolContract(gutenbergSearchBooks, input);
    expect(second.structuredContent).toMatchObject({
      totalCount: 2,
      books: [{ id: 1, title: 'Éléphant % _ modern tale two' }, { id: 2 }],
      effectiveCriteria: input,
    });
  });

  it('keeps many distinct terms in one parameter and keeps topic phrases within one heading', async () => {
    const words = Array.from({ length: 1100 }, (_, i) => `word${i}`);
    await mirror.mirror.store.applyBatch(
      [
        rowFromBook(
          fixture(71, {
            title: words.join(' '),
            subjects: ['alpha', 'beta'],
            bookshelves: ['gamma', 'delta'],
          }),
        ),
      ],
      [],
    );
    expect(
      (await mirror.searchBooks({ query: words.join(' ') })).books.map((book) => book.id),
    ).toEqual([71]);
    expect((await mirror.searchBooks({ topic: 'alpha beta', ids: [71] })).total).toBe(0);
    expect((await mirror.searchBooks({ topic: 'gamma delta', ids: [71] })).total).toBe(0);
  });
  it('matches Greek sigma variants at word boundaries in each searchable field', async () => {
    await mirror.mirror.store.applyBatch(
      [
        rowFromBook(
          fixture(71, {
            title: 'ΟΣΑ',
            authors: [{ name: 'ΟΣΑ', birth_year: null, death_year: null }],
            subjects: ['ΟΣΑ'],
            bookshelves: ['ΟΣΑ'],
          }),
        ),
      ],
      [],
    );
    for (const query of ['ΟΣ', 'οσ', 'ος', 'ΟΣΑ']) {
      expect((await mirror.searchBooks({ query, ids: [71] })).total).toBe(1);
    }
    for (const topic of ['ΟΣ', 'οσ', 'ος']) {
      expect((await mirror.searchBooks({ topic, ids: [71] })).total).toBe(1);
    }
  });
  it('rejects malformed new filters and preserves optional form blanks on both tools', async () => {
    for (const tool of [gutenbergSearchBooks, gutenbergBrowsePopular]) {
      for (const input of [{ mime_type: {} }, { copyright: [123] }, { copyright: ['unknown'] }]) {
        // @ts-expect-error Exercise invalid wire arguments through the production schema boundary.
        const result = await runToolContract(tool, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      }
      const result = await runToolContract(tool, {
        topic: ' ',
        languages: [],
        mime_type: ' ',
        copyright: [],
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        effectiveCriteria: { sort: 'popular', page: 1 },
      });
    }
    expect(http.calls).toHaveLength(0);
  });

  it('does not turn a cancelled empty-ID tool call into an empty success', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const result = await runToolContract(
      gutenbergSearchBooks,
      { ids: [] },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(http.calls).toHaveLength(0);
  });
  it('accepts many repeated terms and IDs without SQLite expression or variable limits', async () => {
    const result = await mirror.searchBooks({
      query: Array(2000).fill('modern').join(' '),
      ids: Array.from({ length: 40000 }, (_, i) => i + 1),
    });
    expect(result.total).toBe(69);
    expect(result.books).toHaveLength(32);
  });
  it('uses Unicode literal substrings and all words at the actual SQL seam', async () => {
    const result = await mirror.searchBooks({ query: 'ÉLÉ åNG % _ modern tale two' });
    expect(result.total).toBe(69);
    expect(result.books.map((book) => book.id)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1),
    );
    expect((await mirror.searchBooks({ query: 'elephant' })).total).toBe(0);
    expect((await mirror.searchBooks({ query: 'ÉLÉ åNG % _ modern tale absent' })).total).toBe(0);
    expect((await mirror.searchBooks({ topic: 'études' })).total).toBe(69);
    expect((await mirror.searchBooks({ topic: 'shelf phrase' })).total).toBe(69);
    expect((await mirror.searchBooks({ query: 'fiction' })).total).toBe(0);
  });

  it.each([
    [{ copyright: ['null'] }, 24],
    [{ copyright: ['false'] }, 23],
    [{ copyright: ['true'] }, 23],
    [{ copyright: ['false', 'null'] }, 47],
    [{ copyright: [] }, 70],
    [{ mime_type: 'text/' }, 69],
    [{ mime_type: 'missing' }, 0],
    [{ mime_type: 'text/%' }, 0],
    [{ languages: ['FR'] }, 35],
    [{ languages: ['e'] }, 0],
    [{ author_year_start: 1899 }, 69],
    [{ author_year_start: 1901 }, 0],
    [{ author_year_end: 1900 }, 69],
    [{ author_year_end: 1899 }, 0],
    [{ ids: [1, 2, 70], copyright: ['null'], mime_type: 'text/' }, 1],
  ])('filters %j before counts and pages', async (params, total) => {
    const result = await mirror.searchBooks(params as Parameters<typeof mirror.searchBooks>[0]);
    expect(result.total).toBe(total);
    expect(result.books.length).toBe(Math.min(total, 32));
  });

  it('walks all pages deterministically, with stable totals and explicit exhausted-page errors', async () => {
    const ids: number[] = [];
    for (const page of [1, 2, 3]) {
      const result = await getGutendexService().searchBooks({ page }, createMockContext());
      ids.push(...result.books.map((book) => book.id));
      expect(result.totalCount).toBe(70);
      expect(result.hasMore).toBe(page < 3);
    }
    expect(ids).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    expect((await mirror.searchBooks({ sort: 'descending', page: 2 })).books[0]?.id).toBe(38);
    expect(
      (await mirror.searchBooks({ sort: 'ascending', page: 3 })).books.map((book) => book.id),
    ).toEqual([65, 66, 67, 68, 69, 70]);
    expect((await mirror.searchBooks({ page: 4 })).books).toEqual([]);
    const result = await runToolContract(gutenbergSearchBooks, { page: 4 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'page_out_of_range', recovery: { hint: expect.any(String) } } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('serves both discovery contracts, including empty successes, without live I/O', async () => {
    for (const tool of [gutenbergSearchBooks, gutenbergBrowsePopular]) {
      const empty = await runToolContract(tool, { topic: 'absent' });
      expect(empty.isError).toBeFalsy();
      expect(empty.structuredContent).toMatchObject({
        books: [],
        notice: expect.any(String),
        effectiveCriteria: { topic: 'absent', page: 1, sort: 'popular' },
      });
      expect(
        empty.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('No books matched');
      const result = await runToolContract(tool, { mime_type: 'text/', copyright: ['null'] });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        effectiveCriteria: { mime_type: 'text/', copyright: ['null'] },
      });
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('text/');
    }
    expect(http.calls).toHaveLength(0);
  });

  it('does no mirror operation for an empty ID selection, even with a long query', async () => {
    const ready = vi.spyOn(mirror, 'ready');
    expect(
      await getGutendexService().searchBooks(
        { ids: [], query: 'one two three four five' },
        createMockContext(),
      ),
    ).toMatchObject({ books: [], totalCount: 0 });
    expect(ready).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it.each(['cold', 'unreadable'])(
    'uses live fallback for %s mirrors and rejects long queries on both surfaces',
    async (state) => {
      if (state === 'cold') vi.spyOn(mirror, 'ready').mockResolvedValue(false);
      else vi.spyOn(mirror, 'searchBooks').mockRejectedValue(new Error('private database path'));
      http.route({
        match: /^https:\/\/catalog\.test\/books\//,
        respond: () => Response.json({ count: 0, next: null, previous: null, results: [] }),
      });
      const result = await runToolContract(gutenbergSearchBooks, {
        query: 'dickens a tale of two',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: { reason: 'query_requires_mirror', recovery: { hint: expect.any(String) } },
        },
      });
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('four');
      expect(http.calls).toHaveLength(0);
      for (const copyright of [['true'], ['false'], ['null'], ['false', 'null']] as const) {
        await getGutendexService().searchBooks(
          {
            query: 'a\t tale\n of  two',
            languages: ['EN'],
            mime_type: 'text/plain',
            copyright: [...copyright],
          },
          createMockContext(),
        );
        const url = new URL(http.calls.at(-1)!.request.url);
        expect(url.searchParams.get('search')).toBe('a tale of two');
        expect(url.searchParams.get('languages')).toBe('en');
        expect(url.searchParams.get('mime_type')).toBe('text/plain');
        expect(url.searchParams.get('copyright')).toBe(copyright.join(','));
      }
    },
  );

  it('propagates cancellation before mirror work and through a failed mirror read', async () => {
    const controller = new AbortController();
    vi.spyOn(mirror, 'ready').mockImplementation(async () => {
      controller.abort('cancelled');
      throw new Error('read failed');
    });
    await expect(
      getGutendexService().searchBooks({}, createMockContext({ signal: controller.signal })),
    ).rejects.toThrow('read failed');
    expect(http.calls).toHaveLength(0);
    const query = vi.spyOn(mirror, 'searchBooks');
    await expect(
      getGutendexService().searchBooks({}, createMockContext({ signal: controller.signal })),
    ).rejects.toBe('cancelled');
    expect(query).not.toHaveBeenCalled();
  });
});
