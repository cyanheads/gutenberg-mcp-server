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
import type { Book, Person } from '@/services/gutendex/types.js';
import { contentText } from '../tools/markdown-read-back.js';

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
const person = (name: string, birth_year: number | null, death_year: number | null): Person => ({
  name,
  birth_year,
  death_year,
});
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
const bookIds = (result: ToolResult) =>
  (result.structuredContent as { books: { id: number }[] }).books.map((book) => book.id);
const noticeOf = (result: ToolResult) => (result.structuredContent as { notice?: string }).notice;
const seed = (books: Book[]) => mirror.mirror.store.applyBatch(books.map(rowFromBook), []);

/** Every way the mirror declines a discovery call, each of which reaches the same guards. */
const decliningMirrors = [
  ['cold', () => vi.spyOn(mirror, 'ready').mockResolvedValue(false)],
  ['unreadable', () => vi.spyOn(mirror, 'ready').mockRejectedValue(new Error('private path'))],
  [
    'failing on the call',
    () => vi.spyOn(mirror, 'searchBooks').mockRejectedValue(new Error('busy')),
  ],
] as const;
const answerLive = (results: unknown[]) =>
  http.route({
    match: /^https:\/\/catalog\.test\/books\//,
    respond: () => Response.json({ count: results.length, next: null, previous: null, results }),
  });
const liveRecord = {
  id: 1430,
  title: 'Beautiful Stories from Shakespeare',
  authors: [],
  translators: [],
  editors: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  download_count: 1,
  summaries: [],
  formats: {},
};

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

describe('author-year bounds', () => {
  const LIVE_BOUNDS_CAVEAT =
    'The live catalog answered, so author_year_start and author_year_end were checked separately: one author can satisfy each bound.';
  const NO_MATCH =
    'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.';
  const EMPTY_SELECTION =
    'The empty ID selection selects no books. Supply one or more IDs, or omit ids to search the catalog.';
  const scope = [301, 302, 303, 304, 305, 1430, 13725];

  beforeEach(() =>
    seed([
      fixture(301, { authors: [person('Birth, Only', 1800, null)] }),
      fixture(302, { authors: [person('Death, Only', null, 1850)] }),
      fixture(303, { authors: [] }),
      fixture(304, { authors: [person('Undated', null, null)] }),
      fixture(305, { authors: [person('Homer', -750, -650)] }),
      fixture(306, {
        authors: [
          person('Early, A.', 1700, 1750),
          person('Undated, B.', null, null),
          person('Late, C.', 1850, 1900),
        ],
      }),
      fixture(1430, {
        authors: [
          person('Nesbit, E. (Edith)', 1858, 1924),
          person('Shakespeare, William', 1564, 1616),
        ],
      }),
      fixture(13725, {
        authors: [person('Havell, H. L.', null, 1913), person('Homer', -750, -650)],
      }),
    ]),
  );

  it.each([
    [{ author_year_start: 1800 }, [301, 302, 1430, 13725]],
    [{ author_year_start: 1801 }, [302, 1430, 13725]],
    [{ author_year_start: 1851 }, [1430, 13725]],
    [{ author_year_start: 1914 }, [1430]],
    [{ author_year_start: -650 }, [301, 302, 305, 1430, 13725]],
    [{ author_year_end: 1850 }, [301, 302, 305, 1430, 13725]],
    [{ author_year_end: 1800 }, [301, 305, 1430, 13725]],
    [{ author_year_end: 1799 }, [305, 1430, 13725]],
    [{ author_year_end: -750 }, [305, 13725]],
    [{ author_year_end: -751 }, []],
  ])('keeps the books a single bound returns for %j', async (bound, expected) => {
    const result = await mirror.searchBooks({ ...bound, ids: scope, sort: 'ascending' });
    expect(result.books.map((book) => book.id)).toEqual(expected);
    expect(result.total).toBe(expected.length);
  });

  it.each([
    [1430, 1800, 1800, 0],
    [1430, 1900, 1900, 1],
    [1430, 1600, 1600, 1],
    [1430, 1500, 1500, 0],
    [13725, 1800, 1899, 0],
  ])(
    'requires one author of book %i to meet %i and %i, reporting %i on both surfaces',
    async (id, author_year_start, author_year_end, totalCount) => {
      const result = await runToolContract(gutenbergSearchBooks, {
        ids: [id],
        author_year_start,
        author_year_end,
      });
      expect(result.structuredContent).toMatchObject({ totalCount });
      expect(contentText(result)).toContain(`**${totalCount} books found**`);
      expect(http.calls).toHaveLength(0);
    },
  );

  /** A year bound as text sorts above every number, so each expected match below would miss. */
  it.each([
    [305, -700, -700, 1],
    [305, -750, -750, 1],
    [305, -650, -650, 1],
    [305, -800, -800, 0],
    [305, -600, -600, 0],
    [306, 1880, 1890, 1],
    [306, 1760, 1790, 0],
    [301, 1800, 1800, 1],
    [301, 1790, 1810, 1],
    [301, 1801, 1810, 0],
    [302, 1850, 1850, 1],
    [302, 1800, 1849, 0],
    [303, 1800, 1899, 0],
    [304, 1800, 1899, 0],
    [1430, 1900, 1800, 0],
  ])(
    'compares book %i against bounds %i and %i numerically on this driver',
    async (id, author_year_start, author_year_end, total) => {
      const result = await mirror.searchBooks({ ids: [id], author_year_start, author_year_end });
      expect(result.total).toBe(total);
    },
  );

  it('counts and pages only same-author matches', async () => {
    await seed([
      fixture(500, {
        download_count: 9_000,
        authors: [person('Earlier, A.', 1700, 1750), person('Later, B.', 1950, 2000)],
      }),
    ]);
    const input = { author_year_start: 1800, author_year_end: 1900, sort: 'popular' } as const;
    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      const result = await getGutendexService().searchBooks(
        { ...input, page },
        createMockContext(),
      );
      /** The 69 base rows plus 301, 302, 306 and 1430; 500 and 13725 split the bounds. */
      expect(result.totalCount).toBe(73);
      expect(result.hasMore).toBe(page < 3);
      seen.push(...result.books.map((book) => book.id));
    }
    expect(seen).toHaveLength(73);
    expect(seen).not.toContain(500);
    expect(seen).not.toContain(13725);
    expect((await mirror.searchBooks({ author_year_start: 1800 })).books[0]?.id).toBe(500);
  });

  it.each(decliningMirrors)(
    'states that the live catalog checked the bounds separately on a %s mirror',
    async (_state, decline) => {
      decline();
      answerLive([liveRecord]);
      const result = await runToolContract(gutenbergSearchBooks, {
        ids: [1430],
        author_year_start: 1800,
        author_year_end: 1800,
      });
      expect(result.structuredContent).toMatchObject({ totalCount: 1 });
      expect(noticeOf(result)).toBe(LIVE_BOUNDS_CAVEAT);
      expect(contentText(result)).toContain(LIVE_BOUNDS_CAVEAT);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('opens one notice with the caveat, then the empty-result text', async () => {
    vi.spyOn(mirror, 'ready').mockResolvedValue(false);
    answerLive([]);
    const result = await runToolContract(gutenbergSearchBooks, {
      author_year_start: 1500,
      author_year_end: 1500,
    });
    expect(noticeOf(result)).toBe(`${LIVE_BOUNDS_CAVEAT} ${NO_MATCH}`);
    expect(contentText(result)).toContain(`${LIVE_BOUNDS_CAVEAT} ${NO_MATCH}`);
  });

  it('omits the caveat for one bound and when the mirror answers', async () => {
    const answered = await runToolContract(gutenbergSearchBooks, {
      ids: [1430],
      author_year_start: 1900,
      author_year_end: 1900,
    });
    expect(answered.structuredContent).not.toHaveProperty('notice');
    const emptied = await runToolContract(gutenbergSearchBooks, {
      ids: [1430],
      author_year_start: 1800,
      author_year_end: 1800,
    });
    expect(noticeOf(emptied)).toBe(NO_MATCH);

    vi.spyOn(mirror, 'ready').mockResolvedValue(false);
    answerLive([liveRecord]);
    for (const bound of [{ author_year_start: 1800 }, { author_year_end: 1800 }]) {
      const live = await runToolContract(gutenbergSearchBooks, bound);
      expect(live.isError).toBeFalsy();
      expect(live.structuredContent).not.toHaveProperty('notice');
    }
  });

  it.each(decliningMirrors)(
    'keeps only the empty-selection text for ids: [] on a %s mirror',
    async (_state, decline) => {
      decline();
      const result = await runToolContract(gutenbergSearchBooks, {
        ids: [],
        author_year_start: 1800,
        author_year_end: 1800,
      });
      expect(noticeOf(result)).toBe(EMPTY_SELECTION);
      expect(http.calls).toHaveLength(0);
    },
  );

  it('reports which source answered, and keeps that out of tool output', async () => {
    const service = getGutendexService();
    const fromMirror = await service.searchBooks({ ids: [1430] }, createMockContext());
    expect(fromMirror.source).toBe('mirror');
    expect((await service.searchBooks({ ids: [] }, createMockContext())).source).toBe('none');
    const shown = await runToolContract(gutenbergSearchBooks, { ids: [1430] });
    expect(shown.structuredContent).not.toHaveProperty('source');

    vi.spyOn(mirror, 'ready').mockResolvedValue(false);
    answerLive([liveRecord]);
    expect((await service.searchBooks({ ids: [1430] }, createMockContext())).source).toBe('live');
  });
});

describe('catalog language codes', () => {
  const EXACT_CODES = 'Language codes match exactly: English is "en", not "eng".';
  const NO_SEARCH_MATCH =
    'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.';
  const NO_BROWSE_MATCH =
    'No books matched these criteria. Try a broader topic or remove a language, format, or copyright filter.';

  beforeEach(() =>
    seed([
      fixture(8102, { title: 'The Forme of Cury', languages: ['en', 'enm'] }),
      fixture(8103, { title: 'Middle English only', languages: ['enm'] }),
      fixture(9700, { title: 'Beowulf', languages: ['ang', 'en'], download_count: 5 }),
      fixture(9701, { title: 'Beowulf, old', languages: ['ang'], download_count: 9 }),
    ]),
  );

  it.each([['enm'], ['ENM']])('searches a three-letter code given as %s', async (code) => {
    const result = await runToolContract(gutenbergSearchBooks, { languages: [code] });
    expect(result.isError).toBeFalsy();
    expect(bookIds(result)).toEqual([8102, 8103]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      effectiveCriteria: { languages: ['enm'] },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('[8102]');
  });

  it('answers empty for a code that a full lowercase would push past the cap', async () => {
    const search = await runToolContract(gutenbergSearchBooks, { languages: ['İİ'] });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toMatchObject({
      totalCount: 0,
      effectiveCriteria: { languages: ['İİ'] },
    });
    const browse = await runToolContract(gutenbergBrowsePopular, { languages: ['İİ'] });
    expect(browse.isError).toBeFalsy();
    expect(bookIds(browse)).toEqual([]);
  });

  it('browses a three-letter code on both surfaces', async () => {
    const result = await runToolContract(gutenbergBrowsePopular, { languages: ['ang'] });
    expect(result.isError).toBeFalsy();
    expect(bookIds(result)).toEqual([9701, 9700]);
    expect(result.structuredContent).toMatchObject({
      totalInCatalog: 2,
      effectiveCriteria: { languages: ['ang'] },
    });
    expect(contentText(result)).toContain('[9701]');
  });

  it.each([['en'], ['EN']])('leaves the two-letter filter %s unchanged', async (code) => {
    const search = await runToolContract(gutenbergSearchBooks, { languages: [code] });
    expect(search.structuredContent).toMatchObject({ totalCount: 72 });
    const browse = await runToolContract(gutenbergBrowsePopular, { languages: [code] });
    expect(browse.structuredContent).toMatchObject({ totalInCatalog: 72 });
  });

  it('tells a caller that a three-letter miss may be the wrong form of the code', async () => {
    const search = await runToolContract(gutenbergSearchBooks, { languages: ['eng'] });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toMatchObject({ books: [], totalCount: 0 });
    expect(noticeOf(search)).toBe(`${NO_SEARCH_MATCH} ${EXACT_CODES}`);
    expect(contentText(search)).toContain(EXACT_CODES);

    const browse = await runToolContract(gutenbergBrowsePopular, { languages: ['eng'] });
    expect(browse.isError).toBeFalsy();
    expect(browse.structuredContent).toMatchObject({ books: [], totalInCatalog: 0 });
    expect(noticeOf(browse)).toBe(`${NO_BROWSE_MATCH} ${EXACT_CODES}`);
    expect(contentText(browse)).toContain(EXACT_CODES);
  });

  it('keeps the plain notice for an unknown two-letter code', async () => {
    const search = await runToolContract(gutenbergSearchBooks, { languages: ['xx'] });
    expect(noticeOf(search)).toBe(NO_SEARCH_MATCH);
    const browse = await runToolContract(gutenbergBrowsePopular, { languages: ['xx'] });
    expect(noticeOf(browse)).toBe(NO_BROWSE_MATCH);
  });

  it('leaves the empty-selection notice alone, since no language was consulted', async () => {
    const result = await runToolContract(gutenbergSearchBooks, { ids: [], languages: ['eng'] });
    expect(noticeOf(result)).toBe(
      'The empty ID selection selects no books. Supply one or more IDs, or omit ids to search the catalog.',
    );
  });

  it('composes the live bounds caveat, the empty text and the code sentence in one notice', async () => {
    vi.spyOn(mirror, 'ready').mockResolvedValue(false);
    answerLive([]);
    const result = await runToolContract(gutenbergSearchBooks, {
      languages: ['eng'],
      author_year_start: 1800,
      author_year_end: 1899,
    });
    expect(noticeOf(result)).toBe(
      `The live catalog answered, so author_year_start and author_year_end were checked separately: one author can satisfy each bound. ${NO_SEARCH_MATCH} ${EXACT_CODES}`,
    );
  });

  it('still rejects a four-character value on both tools', async () => {
    for (const tool of [gutenbergSearchBooks, gutenbergBrowsePopular]) {
      const result = await runToolContract(tool, { languages: ['abcd'] });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(contentText(result)).toContain('languages');
    }
    expect(http.calls).toHaveLength(0);
  });

  it('keeps a three-letter code through a truncated browse continuation into search', async () => {
    const browse = await runToolContract(gutenbergBrowsePopular, { languages: ['ang'], limit: 1 });
    expect(bookIds(browse)).toEqual([9701]);
    const { continuation } = JSON.parse(JSON.stringify(browse.structuredContent)) as {
      continuation: { tool: string; arguments: Record<string, unknown> };
    };
    expect(continuation.tool).toBe('gutenberg_search_books');
    expect(continuation.arguments).toEqual({ languages: ['ang'], sort: 'popular', page: 1 });
    expect(contentText(browse)).toContain('"languages":["ang"]');

    const parsed = gutenbergSearchBooks.input.parse(continuation.arguments);
    expect(parsed.languages).toEqual(['ang']);
    const next = await runToolContract(gutenbergSearchBooks, continuation.arguments);
    expect(next.isError).toBeFalsy();
    expect(bookIds(next)).toEqual([9701, 9700]);
    expect(next.structuredContent).toMatchObject({ totalCount: 2 });
  });

  it.each(decliningMirrors)(
    'forwards a three-letter code to the live catalog on a %s mirror',
    async (_state, decline) => {
      decline();
      answerLive([{ ...liveRecord, id: 8102, languages: ['en', 'enm'] }]);
      const result = await runToolContract(gutenbergSearchBooks, { languages: ['ENM'] });
      expect(result.isError).toBeFalsy();
      expect(bookIds(result)).toEqual([8102]);
      expect(new URL(http.calls[0]!.request.url).searchParams.get('languages')).toBe('enm');
    },
  );
});

describe('translator filter', () => {
  const tolstoy = person('Tolstoy, Leo, graf', 1828, 1910);
  const maudes = [person('Maude, Aylmer', 1858, 1938), person('Maude, Louise', 1855, 1939)];
  const garnett = person('Garnett, Constance', 1861, 1946);

  beforeEach(() =>
    seed([
      fixture(2600, { title: 'War and Peace', authors: [tolstoy], translators: maudes }),
      fixture(1399, { title: 'Anna Karenina', authors: [tolstoy], translators: [garnett] }),
      fixture(2554, {
        title: 'Crime and Punishment',
        authors: [person('Dostoyevsky, Fyodor', 1821, 1881)],
        translators: [garnett],
      }),
      fixture(17509, {
        title: 'Faust',
        languages: ['fr'],
        translators: [person('Grenier, Édouard', 1819, 1901)],
      }),
      fixture(69566, {
        title: 'Other',
        translators: [person('Naville, Edouard', 1844, 1926)],
      }),
      fixture(5000, { title: 'Maude, a title word' }),
      fixture(5001, { title: 'Greek', translators: [person('ΟΣΑ', null, null)] }),
    ]),
  );

  it.each([
    ['maude', [2600]],
    ['garnett', [1399, 2554]],
    ['édouard', [17509]],
    ['ÉDOUARD', [17509]],
    ['edouard', [69566]],
    ['louise aylmer', [2600]],
    ['maude garnett', []],
    ['aude, Lou', [2600]],
    ['m_ude', []],
    ['ος', [5001]],
    ['ΟΣ', [5001]],
  ])('matches %j against translator names', async (translator, expected) => {
    const result = await runToolContract(gutenbergSearchBooks, {
      translator,
      sort: 'ascending',
    });
    expect(result.isError).toBeFalsy();
    expect(bookIds(result)).toEqual(expected);
    expect(result.structuredContent).toMatchObject({
      totalCount: expected.length,
      effectiveCriteria: { translator },
    });
    expect(contentText(result)).toContain(`**${expected.length} books found**`);
    expect(http.calls).toHaveLength(0);
  });

  it('narrows the other filters and leaves the query surface alone', async () => {
    const narrowed = await runToolContract(gutenbergSearchBooks, {
      query: 'tolstoy',
      translator: 'maude',
      languages: ['en'],
    });
    expect(bookIds(narrowed)).toEqual([2600]);
    const query = await runToolContract(gutenbergSearchBooks, { query: 'maude' });
    expect(bookIds(query)).toEqual([5000]);
  });

  it('succeeds empty with the plain notice, and rejects a value that is not a string', async () => {
    const empty = await runToolContract(gutenbergSearchBooks, { translator: 'nobody' });
    expect(empty.isError).toBeFalsy();
    expect(noticeOf(empty)).toBe(
      'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.',
    );
    // @ts-expect-error Exercise invalid wire arguments through the production schema boundary.
    const invalid = await runToolContract(gutenbergSearchBooks, { translator: {} });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: -32602 } });
  });

  it('counts and pages only matching books', async () => {
    await seed(
      Array.from({ length: 33 }, (_, i) =>
        fixture(1000 + i, { translators: [person('Pager, Paula', null, null)] }),
      ),
    );
    const first = await getGutendexService().searchBooks(
      { translator: 'pager' },
      createMockContext(),
    );
    expect(first).toMatchObject({ totalCount: 33, hasMore: true, page: 1, source: 'mirror' });
    expect(first.books).toHaveLength(32);
    const second = await getGutendexService().searchBooks(
      { translator: 'pager', page: 2 },
      createMockContext(),
    );
    expect(second).toMatchObject({ totalCount: 33, hasMore: false, page: 2 });
    expect(second.books).toHaveLength(1);
    const past = await runToolContract(gutenbergSearchBooks, { translator: 'pager', page: 3 });
    expect(past.structuredContent).toMatchObject({
      error: { data: { reason: 'page_out_of_range' } },
    });
  });

  it('echoes the normalized value, and treats a blank as omitted', async () => {
    const result = await runToolContract(gutenbergSearchBooks, { translator: '  maude \n ' });
    expect(result.structuredContent).toMatchObject({ effectiveCriteria: { translator: 'maude' } });
    expect(contentText(result)).toContain('"translator":"maude"');

    const unfiltered = await runToolContract(gutenbergSearchBooks, {});
    const total = (unfiltered.structuredContent as { totalCount: number }).totalCount;
    expect(total).toBe(77);
    for (const translator of ['', '   ']) {
      const blank = await runToolContract(gutenbergSearchBooks, { translator });
      expect(blank.structuredContent).toMatchObject({ totalCount: total });
      expect(JSON.stringify(blank.structuredContent)).not.toContain('"translator"');
      expect(contentText(blank)).not.toContain('"translator"');
    }
  });

  it('matches nothing on a row whose folded column is null', async () => {
    const db = await mirror.mirror.raw();
    db.prepare('UPDATE books SET translators_folded = NULL WHERE id = 2600').run();
    expect((await mirror.searchBooks({ translator: 'maude' })).total).toBe(0);
    expect((await mirror.searchBooks({ translator: 'garnett' })).total).toBe(2);
    expect((await mirror.searchBooks({ ids: [2600] })).total).toBe(1);
  });

  it('keeps many distinct and repeated words in one parameter', async () => {
    const words = Array.from({ length: 1100 }, (_, i) => `word${i}`);
    await seed([fixture(3000, { translators: [person(words.join(' '), null, null)] })]);
    expect((await mirror.searchBooks({ translator: words.join(' ') })).books[0]?.id).toBe(3000);
    expect(
      (await mirror.searchBooks({ translator: Array(2000).fill('maude').join(' ') })).total,
    ).toBe(1);
  });

  it.each(decliningMirrors)(
    'declines with recovery and no request on a %s mirror',
    async (_state, decline) => {
      decline();
      for (const input of [
        { translator: 'maude' },
        { translator: 'maude', query: 'one two three four five' },
      ]) {
        const result = await runToolContract(gutenbergSearchBooks, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            data: {
              reason: 'translator_requires_mirror',
              recovery: {
                hint: 'Remove the translator filter and read translators from gutenberg_get_book, or ask the server operator to initialize or repair the local catalog mirror.',
              },
            },
          },
        });
        expect(contentText(result)).toContain('gutenberg_get_book');
      }
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each(decliningMirrors)(
    'lets an empty ID selection win on a %s mirror',
    async (_state, decline) => {
      decline();
      const result = await runToolContract(gutenbergSearchBooks, {
        ids: [],
        translator: 'maude',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        books: [],
        totalCount: 0,
        notice:
          'The empty ID selection selects no books. Supply one or more IDs, or omit ids to search the catalog.',
        effectiveCriteria: { ids: [], translator: 'maude' },
      });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('propagates cancellation instead of reporting a declining mirror', async () => {
    const controller = new AbortController();
    vi.spyOn(mirror, 'ready').mockImplementation(async () => {
      controller.abort('cancelled');
      throw new Error('read failed');
    });
    await expect(
      getGutendexService().searchBooks(
        { translator: 'maude' },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow('read failed');
    expect(http.calls).toHaveLength(0);
  });

  it('keeps browse input closed, with a continuation that carries no translator', async () => {
    const rejected = await runToolContract(gutenbergBrowsePopular, {
      // @ts-expect-error Exercise an unknown wire argument through the production schema boundary.
      translator: 'maude',
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({ error: { code: -32602 } });

    const browse = await runToolContract(gutenbergBrowsePopular, { limit: 1 });
    const { continuation } = JSON.parse(JSON.stringify(browse.structuredContent)) as {
      continuation: { arguments: object };
    };
    expect(continuation.arguments).not.toHaveProperty('translator');
    const next = await runToolContract(gutenbergSearchBooks, continuation.arguments);
    expect(next.isError).toBeFalsy();
  });
});
