/**
 * @fileoverview Tests for the gutenberg_browse_popular tool.
 * @module tests/tools/gutenberg-browse-popular.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergBrowsePopular } from '@/mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';
import {
  ACTIVE_MARKDOWN,
  contentText,
  hostileLine,
  hostileText,
  PROPERTY_RUNS,
  readBack,
} from './markdown-read-back.js';

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
  is_readable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergBrowsePopular', () => {
  it.each([20, 32])(
    'preserves executable filters without skipping unseen books at limit %i',
    async (limit) => {
      mockGutendexService.searchBooks.mockResolvedValue({
        books: Array.from({ length: 32 }, (_, i) => makeBook(i + 1)),
        totalCount: 64,
        hasMore: true,
        page: 1,
      });
      const result = await runToolContract(gutenbergBrowsePopular, {
        limit,
        languages: ['EN'],
        topic: ' fiction ',
        mime_type: 'text/',
        copyright: ['false', 'null'],
      });
      expect(result.structuredContent).toMatchObject({
        effectiveCriteria: {
          languages: ['en'],
          topic: 'fiction',
          mime_type: 'text/',
          copyright: ['false', 'null'],
          sort: 'popular',
          page: 1,
        },
        continuation: {
          tool: 'gutenberg_search_books',
          arguments: {
            languages: ['en'],
            topic: 'fiction',
            mime_type: 'text/',
            copyright: ['false', 'null'],
            sort: 'popular',
            page: limit === 32 ? 2 : 1,
          },
        },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('text/');
      expect(text).toContain(`"page":${limit === 32 ? 2 : 1}`);
    },
  );

  it('keeps empty browse successful with caps and a notice on both surfaces', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [],
      totalCount: 0,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergBrowsePopular, { limit: 100 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      books: [],
      totalInCatalog: 0,
      requestedLimit: 100,
      appliedLimit: 32,
      shown: 0,
      cap: 32,
      truncated: false,
      notice: expect.any(String),
    });
    expect(result.structuredContent).not.toHaveProperty('continuation');
    expect(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).toContain(
      'No books matched',
    );
  });

  it('rejects translator as an unknown key before reaching the service', async () => {
    const result = await runToolContract(gutenbergBrowsePopular, {
      // @ts-expect-error Exercise an unknown wire argument through the production schema boundary.
      translator: 'maude',
    });
    expect(result.isError).toBe(true);
    expect(mockGutendexService.searchBooks).not.toHaveBeenCalled();
  });

  it('renders readability and the snapshot window for counts and the omitted-result ceiling', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [{ ...makeBook(1), is_readable: true, has_plain_text: false }],
      totalCount: 100,
      hasMore: true,
      page: 1,
    });
    const result = await runToolContract(gutenbergBrowsePopular, {});
    expect(result.structuredContent).toMatchObject({
      books: [{ is_readable: true, has_plain_text: false, download_count: 9999 }],
      truncationCeiling: 9999,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Readable: Yes');
    expect(text.match(/last 30 days/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('source snapshot');
  });
  it.each([32, 33, 1_000_000])('caps a requested %i books on both surfaces', async (limit) => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: Array.from({ length: 32 }, (_, i) => makeBook(i + 1)),
      totalCount: 100,
      hasMore: true,
      page: 1,
    });
    const result = await runToolContract(gutenbergBrowsePopular, {
      limit,
      languages: ['en'],
      topic: 'fiction',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      requestedLimit: limit,
      appliedLimit: 32,
      cap: 32,
      shown: 32,
      truncated: true,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`Requested limit: ${limit.toLocaleString()}`);
    expect(text).toContain('Applied limit: 32');
    expect(text).toContain('same language/topic');
    expect(mockGutendexService.searchBooks).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sort: 'popular', languages: ['en'], topic: 'fiction', page: 1 }),
      expect.anything(),
    );
  });

  it('keeps short clamped results complete', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergBrowsePopular, { limit: 1000 });
    expect(result.structuredContent).toMatchObject({
      requestedLimit: 1000,
      appliedLimit: 32,
      cap: 32,
      truncated: false,
    });
  });

  it.each([0, -1, 1.5, Infinity, NaN])(
    'rejects invalid limit %s before fetching',
    async (limit) => {
      expect((await runToolContract(gutenbergBrowsePopular, { limit })).isError).toBe(true);
      expect(mockGutendexService.searchBooks).not.toHaveBeenCalled();
    },
  );

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
    expect(result.books[0]?.id).toBe(1);
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

  it('reports the result set as complete when all matches are returned', async () => {
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

    // The three fields are required enrichment; leaving them unpopulated fails
    // the effective-output parse rather than reading as "nothing to disclose".
    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3, cap: 20 });
    expect(getEnrichment(ctx)).not.toHaveProperty('truncationCeiling');
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

  it('returns an empty collection when service returns empty books', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [],
      totalCount: 0,
      hasMore: false,
      page: 1,
    });

    const ctx = createMockContext({ errors: gutenbergBrowsePopular.errors });
    const input = gutenbergBrowsePopular.input.parse({ topic: 'zzznomatch' });

    await expect(gutenbergBrowsePopular.handler(input, ctx)).resolves.toMatchObject({
      books: [],
      totalInCatalog: 0,
      requestedLimit: 20,
      appliedLimit: 20,
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

    expect(result.books[0]?.authors).toEqual([]);
  });

  describe('enrichmentTrailer', () => {
    // The handler wires the enrichment data (covered by 'discloses truncation');
    // these render functions are what turn it into readable content[] trailer
    // text instead of a disconnected `**key:** value` dump. Testing them directly
    // — unit tests call handler(), which bypasses the wrapper that assembles the
    // trailer — the live field test covers the fully-assembled content[].
    const trailer = gutenbergBrowsePopular.enrichmentTrailer;

    it('renders each truncation field as a readable line', () => {
      expect(trailer?.truncated?.render?.(true)).toContain('more matching books');
      expect(trailer?.shown?.render?.(3)).toContain('3');
      const capLine = trailer?.cap?.render?.(3);
      expect(capLine).toContain('3');
      expect(capLine).toContain('32');
    });

    it('renders truncationCeiling with the count and the gutenberg_search_books pointer', () => {
      const line = trailer?.truncationCeiling?.render?.(103120);
      expect(line).toContain('103,120');
      expect(line).toContain('gutenberg_search_books');
      expect(line).toContain('sort="popular"');
    });

    it('renders no truncationCeiling line when the value is absent', () => {
      expect(trailer?.truncationCeiling?.render?.(undefined)).toBe('');
    });

    it('renders truncated=false as a completeness statement, not the truncation sentence', () => {
      // The framework calls this render for every key present in the enrichment
      // store, so a value-blind render would fire the truncation sentence on
      // exactly the complete responses it does not describe.
      const line = trailer?.truncated?.render?.(false);
      expect(line).not.toContain('more matching books');
      expect(line).toMatch(/complete/i);
    });
  });

  describe('format()', () => {
    it('renders ranked list with rank number, title, authors, language, downloads, and text flag', () => {
      const output = {
        requestedLimit: 20,
        appliedLimit: 20,
        books: [
          {
            id: 1342,
            title: 'Pride and Prejudice',
            authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
            languages: ['en'],
            download_count: 75000,
            has_plain_text: true,
            is_readable: true,
          },
          {
            id: 11,
            title: 'Alice in Wonderland',
            authors: [{ name: 'Carroll, Lewis', birth_year: 1832, death_year: 1898 }],
            languages: ['en'],
            download_count: 65000,
            has_plain_text: true,
            is_readable: true,
          },
        ],
        totalInCatalog: 65000,
      };
      const blocks = gutenbergBrowsePopular.format!(output);
      expect(blocks[0]?.type).toBe('text');
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
        requestedLimit: 20,
        appliedLimit: 20,
        books: [
          {
            id: 99,
            title: 'Anon Work',
            authors: [{ name: 'Anonymous', birth_year: null, death_year: null }],
            languages: ['en'],
            download_count: 100,
            has_plain_text: false,
            is_readable: false,
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

// ── Enrichment on the full contract boundary (#8) ────────────────────────────
//
// The three enrichment fields are required, and the effective-output parse that
// enforces that runs inside buildToolSuccessResult — which a direct .handler()
// call never reaches. These drive the definition through runToolContract so the
// non-truncated path is checked where it actually failed.

describe('gutenbergBrowsePopular — enrichment on both surfaces', () => {
  /** Join every content block: the enrichment trailer is its own trailing block. */
  const allText = (result: { content?: unknown[] }): string =>
    (result.content ?? []).map((block) => (block as { text?: string }).text ?? '').join('\n');

  it('returns a complete result when the catalog holds no more than the limit', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const result = await runToolContract(gutenbergBrowsePopular, { languages: ['ia'], limit: 32 });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(structured.truncated).toBe(false);
    expect(structured.shown).toBe(1);
    expect(structured.cap).toBe(32);
    expect(structured).not.toHaveProperty('truncationCeiling');
    expect((structured.books as unknown[]).length).toBe(1);
  });

  it('states completeness in the content[] trailer without the truncation sentence', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [makeBook(1)],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const text = allText(await runToolContract(gutenbergBrowsePopular, { limit: 32 }));

    expect(text).not.toContain('more matching books');
    expect(text).toMatch(/complete/i);
    expect(text).toContain(
      'Returned the top 1 by downloads in the last 30 days (source snapshot).',
    );
  });

  it('still discloses truncation on both surfaces when the catalog holds more', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: Array.from({ length: 32 }, (_, i) => makeBook(i + 1)),
      totalCount: 65000,
      hasMore: true,
      page: 1,
    });

    const result = await runToolContract(gutenbergBrowsePopular, { limit: 5 });
    const structured = result.structuredContent as Record<string, unknown>;
    const text = allText(result);

    expect(result.isError).toBeFalsy();
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(5);
    expect(structured.cap).toBe(5);
    expect(structured.truncationCeiling).toBe(makeBook(5).download_count);
    expect(text).toContain('more matching books');
    expect(text).toContain('gutenberg_search_books');
  });
});

// ── CommonMark read-back (#31, #37) ──────────────────────────────────────────
//
// Every assertion here reads a real parse of content[] against the raw value.
// format-parity's sentinels never reach an escape, so the lint proves nothing here.

describe('gutenbergBrowsePopular — content[] reads back as structuredContent', () => {
  type BrowseOutput = Parameters<NonNullable<typeof gutenbergBrowsePopular.format>>[0];
  type Row = BrowseOutput['books'][number];

  const row: Row = {
    id: 1342,
    title: 'Pride and Prejudice',
    authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
    languages: ['en'],
    download_count: 75000,
    has_plain_text: true,
    is_readable: true,
  };
  const render = (books: Row[]) =>
    (
      gutenbergBrowsePopular.format!({
        requestedLimit: 32,
        appliedLimit: 32,
        books,
        totalInCatalog: books.length,
      })[0] as { text: string }
    ).text;

  /** The list a reader should get, written from the raw values instead of from format(). */
  function wantList(books: Row[]): string {
    const items = books.map((book) => {
      const authors = book.authors.map((a) => `${a.name} (${a.birth_year ?? '?'}–${a.death_year})`);
      return `[${book.id}] ${book.title} — ${authors.join(', ') || 'Unknown'}\nLang: ${book.languages.join(', ')} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()} | Plain text: Yes | Readable: Yes`;
    });
    return `Top ${books.length} of ${books.length} books in catalog\n\nRequested limit: 32 | Applied limit: 32\n\n${items.join('\n')}`;
  }

  const active = { name: ACTIVE_MARKDOWN, birth_year: 1775, death_year: 1817 };

  /** Each case holds syntax in one slot only, so a failure names that slot's missing escape. */
  it.each<[string, Partial<Row>]>([
    ['the title', { title: ACTIVE_MARKDOWN }],
    ['an author name', { authors: [row.authors[0]!, active] }],
    ['a language', { languages: ['en', ACTIVE_MARKDOWN] }],
  ])('reads %s back unchanged', (_slot, change) => {
    const books = [{ ...row, ...change }, row];
    expect(readBack(render(books)).text).toBe(wantList(books));
  });

  /** Titles from the 2026-10-30 catalog harvest, 30121 abridged. */
  it.each([
    [38430, 'The philosophy of Mr. B*rtr*nd R*ss*ll'],
    [30121, 'The Art of Confectionary: ... Figs, Grapes, &amp;c., Flowers and Herbs; ...'],
  ])('reads the title of %i back through the wire contract', async (id, title) => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [{ ...makeBook(id), title }],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergBrowsePopular, {});
    expect((result.structuredContent as BrowseOutput).books[0]?.title).toBe(title);
    expect(readBack(contentText(result)).blocks[2]).toEqual({
      container: 'list',
      kind: 'paragraph',
      text: `[${id}] ${title} — Author ${id} (1800–1900)\nLang: en | Downloads in the last 30 days (source snapshot): ${(10000 - id).toLocaleString()} | Plain text: Yes | Readable: Yes`,
    });
  });

  it('leaves a value with nothing to encode byte-identical', () => {
    expect(render([row])).toContain(
      '1. **[1342]** Pride and Prejudice — Austen, Jane (1775–1817)\n   Lang: en | Downloads',
    );
  });

  it('reads any row back through the assembled list, past nine items', () => {
    const person = fc.record({
      name: hostileLine,
      birth_year: fc.constantFrom(null, 1775),
      death_year: fc.constant(1817),
    });
    const generated = fc.record({
      title: hostileLine,
      authors: fc.array(person, { maxLength: 2 }),
      languages: fc.array(hostileLine, { minLength: 1, maxLength: 2 }),
    });
    fc.assert(
      fc.property(fc.array(generated, { minLength: 1, maxLength: 11 }), (rows) => {
        const books = rows.map((fields) => ({ ...row, ...fields }));
        expect(readBack(render(books)).text).toBe(wantList(books));
      }),
      { ...PROPERTY_RUNS, numRuns: 200 },
    );
  });

  describe('criteria and continuation trailers', () => {
    const matches = (count: number) => ({
      books: Array.from({ length: 2 }, (_, i) => makeBook(i + 1)),
      totalCount: count,
      hasMore: false,
      page: 1,
    });
    const paragraphOf = (markdown: string, start: string) =>
      readBack(markdown).blocks.find((block) => block.text.startsWith(start))?.text;

    it.each<[string, string, string]>([
      [
        'a quoted phrase',
        '"Terra Nova"',
        String.raw`{"topic":"\"Terra Nova\"","sort":"popular","page":1}`,
      ],
      ['emphasis', '*war*', '{"topic":"*war*","sort":"popular","page":1}'],
      ['a lone backtick', 'a`b', '{"topic":"a`b","sort":"popular","page":1}'],
      ['a line break', 'a\nb', String.raw`{"topic":"a\nb","sort":"popular","page":1}`],
      ['accents', 'Édouard', '{"topic":"Édouard","sort":"popular","page":1}'],
    ])('holds %s in a code span on the criteria line', async (_case, topic, json) => {
      mockGutendexService.searchBooks.mockResolvedValue(matches(2));
      const result = await runToolContract(gutenbergBrowsePopular, { topic });
      const doc = readBack(contentText(result));
      const { effectiveCriteria } = result.structuredContent as { effectiveCriteria: unknown };

      expect(doc.codeSpans).toEqual([json]);
      expect(JSON.parse(doc.codeSpans[0]!)).toEqual(effectiveCriteria);
      expect(paragraphOf(contentText(result), 'Browse criteria: ')).toContain(
        `Browse criteria: ${json}\n`,
      );
    });

    it('parses the continuation span back to the executable arguments', async () => {
      mockGutendexService.searchBooks.mockResolvedValue(matches(5));
      const result = await runToolContract(gutenbergBrowsePopular, {
        topic: '"Terra Nova"',
        limit: 1,
      });
      const { continuation } = result.structuredContent as {
        continuation: { tool: string; arguments: Record<string, unknown> };
      };
      const json = String.raw`{"topic":"\"Terra Nova\"","sort":"popular","page":1}`;

      expect(continuation).toEqual({
        tool: 'gutenberg_search_books',
        arguments: { topic: '"Terra Nova"', sort: 'popular', page: 1 },
      });
      const doc = readBack(contentText(result));
      expect(doc.codeSpans).toEqual([json, json]);
      expect(JSON.parse(doc.codeSpans[1]!)).toEqual(continuation.arguments);
      expect(paragraphOf(contentText(result), 'Browse criteria: ')).toContain(
        `\nContinue with gutenberg_search_books ${json}. Page 1 repeats the first page when the browse cap leaves unseen books on it.\n`,
      );
    });

    it('holds any caller text in spans that parse back to both structured values', async () => {
      mockGutendexService.searchBooks.mockResolvedValue(matches(5));
      await fc.assert(
        fc.asyncProperty(hostileText, hostileLine, async (topic, mime_type) => {
          const result = await runToolContract(gutenbergBrowsePopular, {
            topic,
            mime_type,
            limit: 1,
          });
          const { effectiveCriteria, continuation } = result.structuredContent as {
            continuation: { arguments: unknown };
            effectiveCriteria: unknown;
          };
          const { codeSpans } = readBack(contentText(result));
          expect(codeSpans).toEqual([
            JSON.stringify(effectiveCriteria),
            JSON.stringify(continuation.arguments),
          ]);
          expect(JSON.parse(codeSpans[0]!)).toEqual(effectiveCriteria);
          expect(JSON.parse(codeSpans[1]!)).toEqual(continuation.arguments);
        }),
        { ...PROPERTY_RUNS, numRuns: 200 },
      );
    });

    it('keeps the criteria line and notice on an empty result', async () => {
      mockGutendexService.searchBooks.mockResolvedValue({
        books: [],
        totalCount: 0,
        hasMore: false,
        page: 1,
      });
      const result = await runToolContract(gutenbergBrowsePopular, {
        topic: '*war*',
        languages: ['eng'],
      });
      const { notice } = result.structuredContent as { notice: string };

      expect(notice).toContain('English is "en", not "eng".');
      const doc = readBack(contentText(result));
      expect(doc.codeSpans).toEqual([
        '{"languages":["eng"],"topic":"*war*","sort":"popular","page":1}',
      ]);
      expect(doc.blocks).toContainEqual({ container: 'quote', kind: 'paragraph', text: notice });
    });
  });
});

// ── Catalog outage contract (#12) ────────────────────────────────────────────

describe('gutenbergBrowsePopular — catalog_unavailable', () => {
  it('surfaces the declared reason and recovery hint on both client surfaces', async () => {
    mockGutendexService.searchBooks.mockImplementation((_params: unknown, ctx: Context) =>
      Promise.reject(
        serviceUnavailable('The Project Gutenberg catalog did not respond.', {
          reason: 'catalog_unavailable',
          ...ctx.recoveryFor('catalog_unavailable'),
        }),
      ),
    );

    const result = await runToolContract(gutenbergBrowsePopular, {});
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
