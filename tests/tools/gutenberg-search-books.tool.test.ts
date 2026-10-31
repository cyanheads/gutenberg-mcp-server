/**
 * @fileoverview Tests for the gutenberg_search_books tool.
 * @module tests/tools/gutenberg-search-books.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import {
  ACTIVE_MARKDOWN,
  contentText,
  hostileLine,
  hostileText,
  PROPERTY_RUNS,
  readBack,
} from './markdown-read-back.js';

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
  is_readable: true,
};

const mockGutendexService = {
  searchBooks: vi.fn(),
  getBook: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergSearchBooks', () => {
  it('echoes normalized filters and returns empty success on both surfaces', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [],
      totalCount: 0,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergSearchBooks, {
      query: '  austen   ',
      topic: ' ',
      languages: [],
      ids: [],
      mime_type: 'text/plain',
      copyright: ['null'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      books: [],
      totalCount: 0,
      effectiveCriteria: {
        query: 'austen',
        sort: 'popular',
        page: 1,
        ids: [],
        mime_type: 'text/plain',
        copyright: ['null'],
      },
      notice: expect.any(String),
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('austen');
    expect(text).toContain('empty ID selection');
    expect(mockGutendexService.searchBooks).not.toHaveBeenCalled();
  });
  it('carries HTML readability and the snapshot popularity window on both surfaces', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [{ ...mockBook, is_readable: true, has_plain_text: false }],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergSearchBooks, {});
    expect(result.structuredContent).toMatchObject({
      books: [{ is_readable: true, has_plain_text: false, download_count: 75000 }],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Readable: Yes');
    expect(text).toContain('last 30 days');
    expect(text).toContain('source snapshot');
  });
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
    expect(result.books[0]?.id).toBe(1342);
    expect(result.books[0]?.title).toBe('Pride and Prejudice');
    expect(result.books[0]?.has_plain_text).toBe(true);
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

  it('returns an empty collection when service returns empty books', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [],
      totalCount: 0,
      hasMore: false,
      page: 1,
    });
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'zzznomatch' });

    await expect(gutenbergSearchBooks.handler(input, ctx)).resolves.toMatchObject({
      books: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  it('adds the live-catalog caveat to a non-empty result only for both bounds on the live source', async () => {
    const caveat =
      'The live catalog answered, so author_year_start and author_year_end were checked separately: one author can satisfy each bound.';
    const page = { books: [mockBook], totalCount: 1, hasMore: false, page: 1 };
    mockGutendexService.searchBooks.mockResolvedValue({ ...page, source: 'live' });
    const both = { author_year_start: 1800, author_year_end: 1899 };
    const live = await runToolContract(gutenbergSearchBooks, both);
    expect(live.structuredContent).toMatchObject({ totalCount: 1, notice: caveat });
    expect(live.structuredContent).not.toHaveProperty('source');
    expect(contentText(live)).toContain(caveat);

    const oneBound = await runToolContract(gutenbergSearchBooks, { author_year_start: 1800 });
    expect(oneBound.structuredContent).not.toHaveProperty('notice');

    mockGutendexService.searchBooks.mockResolvedValue({ ...page, source: 'mirror' });
    const mirrored = await runToolContract(gutenbergSearchBooks, both);
    expect(mirrored.structuredContent).not.toHaveProperty('notice');
  });

  it('passes the normalized translator to the service and echoes it', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [mockBook],
      totalCount: 1,
      hasMore: false,
      page: 1,
      source: 'mirror',
    });
    const result = await runToolContract(gutenbergSearchBooks, {
      translator: '  Maude \t Louise ',
    });
    expect(mockGutendexService.searchBooks).toHaveBeenCalledWith(
      expect.objectContaining({ translator: 'Maude Louise' }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      effectiveCriteria: { translator: 'Maude Louise' },
    });
  });

  it('declares translator_requires_mirror with an actionable recovery', () => {
    const declared = gutenbergSearchBooks.errors?.find(
      (entry) => entry.reason === 'translator_requires_mirror',
    );
    expect(declared).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(declared?.recovery).toContain('gutenberg_get_book');
  });

  it('propagates service errors', async () => {
    mockGutendexService.searchBooks.mockRejectedValue(new Error('Network error'));
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'anything' });

    await expect(gutenbergSearchBooks.handler(input, ctx)).rejects.toThrow('Network error');
  });

  it('translates a page_out_of_range service error into ctx.fail with recovery', async () => {
    // The service tags a Gutendex "Invalid page." 404 as reason page_out_of_range;
    // the handler must re-throw it as a ValidationError carrying recovery guidance
    // rather than leaking the raw upstream fetch error.
    mockGutendexService.searchBooks.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'The requested page is beyond the available result range.',
        { reason: 'page_out_of_range' },
      ),
    );
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'pride prejudice', page: 2 });

    await expect(gutenbergSearchBooks.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'page_out_of_range',
        recovery: { hint: expect.stringContaining('within the available range') },
      },
    });
  });

  it('does not misclassify a generic NotFound as page_out_of_range', async () => {
    // A NotFound without the page_out_of_range reason must bubble unchanged —
    // the translation keys on the reason tag, not the code alone.
    mockGutendexService.searchBooks.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Some other not-found condition.'),
    );
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const input = gutenbergSearchBooks.input.parse({ query: 'anything', page: 2 });

    const err = await Promise.resolve(gutenbergSearchBooks.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data?.reason).toBeUndefined();
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

    expect(result.books[0]?.authors[0]?.birth_year).toBeNull();
    expect(result.books[0]?.authors[0]?.death_year).toBeNull();
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
            is_readable: true,
          },
        ],
        totalCount: 1,
        page: 1,
        hasMore: false,
      };
      const blocks = gutenbergSearchBooks.format!(output);
      expect(blocks[0]?.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('1342');
      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('Austen, Jane');
      expect(text).toContain('en');
      expect(text).toContain('75');
      expect(text).toContain('Yes');
    });

    it('renders the full subject list — no 3-item slice, no ellipsis', () => {
      const subjects = [
        'Courtship -- Fiction',
        'Domestic fiction',
        'England -- Fiction',
        'Love stories',
        'Sisters -- Fiction',
        'Social classes -- Fiction',
        'Young women -- Fiction',
      ];
      const output = {
        books: [
          {
            id: 1342,
            title: 'Pride and Prejudice',
            authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
            languages: ['en'],
            subjects,
            download_count: 75000,
            has_plain_text: true,
            is_readable: true,
          },
        ],
        totalCount: 1,
        page: 1,
        hasMore: false,
      };
      const blocks = gutenbergSearchBooks.format!(output);
      const text = (blocks[0] as { text: string }).text;

      for (const subject of subjects) {
        expect(text).toContain(subject);
      }
      expect(text).not.toContain('…');
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
            is_readable: false,
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

    it('renders an explicit subjects line for a book with no subject headings', () => {
      // structuredContent carries `subjects: []`; without a line, a content[]-only
      // client cannot tell "no subject headings" from "subjects not reported".
      const output = {
        books: [
          {
            id: 12345,
            title: 'Unclassified Work',
            authors: [{ name: 'Anonymous', birth_year: null, death_year: null }],
            languages: ['en'],
            subjects: [],
            download_count: 12,
            has_plain_text: true,
            is_readable: true,
          },
        ],
        totalCount: 1,
        page: 1,
        hasMore: false,
      };
      const text = (gutenbergSearchBooks.format!(output)[0] as { text: string }).text;
      expect(text).toContain('Subjects: None');
    });

    it('renders a subjects line for every book when only some have subjects', () => {
      const output = {
        books: [
          {
            id: 1,
            title: 'Classified',
            authors: [],
            languages: ['en'],
            subjects: ['Fiction'],
            download_count: 5,
            has_plain_text: true,
            is_readable: true,
          },
          {
            id: 2,
            title: 'Unclassified',
            authors: [],
            languages: ['en'],
            subjects: [],
            download_count: 4,
            has_plain_text: true,
            is_readable: true,
          },
        ],
        totalCount: 2,
        page: 1,
        hasMore: false,
      };
      const text = (gutenbergSearchBooks.format!(output)[0] as { text: string }).text;

      expect(text.match(/Subjects:/g)).toHaveLength(2);
      expect(text).toContain('Subjects: Fiction');
      expect(text).toContain('Subjects: None');
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
            is_readable: false,
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

// ── Empty subjects on both surfaces (#13) ────────────────────────────

describe('gutenbergSearchBooks — subject-free results', () => {
  it('reports the empty subjects array on content[] as well as structuredContent', async () => {
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [{ ...mockBook, id: 12345, title: 'Unclassified Work', subjects: [] }],
      totalCount: 1,
      hasMore: false,
      page: 1,
    });

    const result = await runToolContract(gutenbergSearchBooks, { query: 'unclassified' });
    const structured = result.structuredContent as { books: { subjects: string[] }[] };
    const [firstBlock] = result.content ?? [];
    const text = (firstBlock as { text: string }).text;

    expect(result.isError).toBeFalsy();
    expect(structured.books[0]?.subjects).toEqual([]);
    expect(text).toContain('Subjects: None');
  });
});

// ── Catalog outage contract (#12) ────────────────────────────────────────────

// ── CommonMark read-back (#31, #37) ──────────────────────────────────────────
//
// Every assertion here reads a real parse of content[] against the raw value.
// format-parity's sentinels never reach an escape, so the lint proves nothing here.

describe('gutenbergSearchBooks — content[] reads back as structuredContent', () => {
  type SearchOutput = Parameters<NonNullable<typeof gutenbergSearchBooks.format>>[0];
  type Row = SearchOutput['books'][number];

  const row: Row = {
    id: 1342,
    title: 'Pride and Prejudice',
    authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
    languages: ['en'],
    subjects: ['Love stories -- Fiction'],
    download_count: 75000,
    has_plain_text: true,
    is_readable: true,
  };
  const page = (books: Row[]): SearchOutput => ({
    books,
    totalCount: books.length,
    page: 1,
    hasMore: false,
  });
  const render = (books: Row[]) =>
    (gutenbergSearchBooks.format!(page(books))[0] as { text: string }).text;

  /** The rows a reader should get, written from the raw values instead of from format(). */
  function wantRows(books: Row[]): string {
    const lines = books.flatMap((book) => {
      const authors = book.authors.map((a) => `${a.name} (${a.birth_year ?? '?'}–${a.death_year})`);
      return [
        `[${book.id}] ${book.title}`,
        `Authors: ${authors.join(', ') || 'Unknown'} | Lang: ${book.languages.join(', ')} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()} | Plain text: Yes | Readable: Yes`,
        `Subjects: ${book.subjects.join('; ') || 'None'}`,
      ];
    });
    return `${books.length} books found (page 1)\n\n${lines.join('\n')}`;
  }

  const active = { name: ACTIVE_MARKDOWN, birth_year: 1775, death_year: 1817 };

  /** Each case holds syntax in one slot only, so a failure names that slot's missing escape. */
  it.each<[string, Partial<Row>]>([
    ['the title', { title: ACTIVE_MARKDOWN }],
    ['an author name', { authors: [row.authors[0]!, active] }],
    ['a language', { languages: ['en', ACTIVE_MARKDOWN] }],
    ['a subject', { subjects: ['Fiction', ACTIVE_MARKDOWN] }],
  ])('reads %s back unchanged', (_slot, change) => {
    const books = [{ ...row, ...change }, row];
    expect(readBack(render(books)).text).toBe(wantRows(books));
  });

  /** Titles from the 2026-10-30 catalog harvest: 38430 lost asterisks, 30121 (abridged) an entity. */
  it('reads catalog titles back through the wire contract', async () => {
    const [philosophy, confectionary] = [
      'The philosophy of Mr. B*rtr*nd R*ss*ll',
      'The Art of Confectionary: ... Figs, Grapes, &amp;c., Flowers and Herbs; ...',
    ];
    mockGutendexService.searchBooks.mockResolvedValue({
      books: [
        { ...mockBook, id: 38430, title: philosophy },
        { ...mockBook, id: 30121, title: confectionary },
      ],
      totalCount: 2,
      hasMore: false,
      page: 1,
    });
    const result = await runToolContract(gutenbergSearchBooks, { ids: [38430, 30121] });
    expect((result.structuredContent as SearchOutput).books.map((b) => b.title)).toEqual([
      philosophy,
      confectionary,
    ]);
    const { text } = readBack(contentText(result));
    expect(text).toContain(`[38430] ${philosophy}\nAuthors: Austen, Jane (1775–1817)`);
    expect(text).toContain(`[30121] ${confectionary}\nAuthors: Austen, Jane (1775–1817)`);
  });

  it('leaves a value with nothing to encode byte-identical', () => {
    const text = render([{ ...row, subjects: ['Love stories -- Fiction'] }]);
    expect(text).toContain('**[1342]** Pride and Prejudice');
    expect(text).toContain('  Authors: Austen, Jane (1775–1817) | Lang: en | Downloads');
    expect(text).toContain('  Subjects: Love stories -- Fiction');
  });

  it('completes no entity from the subject separator', () => {
    const books = [{ ...row, subjects: ['AT&amp', '&#35', 'tail'] }];
    expect(readBack(render(books)).text).toBe(wantRows(books));
  });

  it('reads any row back through the assembled page, joins included', () => {
    const person = fc.record({
      name: hostileLine,
      birth_year: fc.constantFrom(null, 1775),
      death_year: fc.constant(1817),
    });
    const generated = fc.record({
      title: hostileLine,
      authors: fc.array(person, { maxLength: 2 }),
      languages: fc.array(hostileLine, { minLength: 1, maxLength: 2 }),
      subjects: fc.array(hostileLine, { maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(generated, { minLength: 1, maxLength: 3 }), (rows) => {
        const books = rows.map((fields) => ({ ...row, ...fields }));
        expect(readBack(render(books)).text).toBe(wantRows(books));
      }),
      PROPERTY_RUNS,
    );
  });

  describe('criteria trailer', () => {
    const empty = { books: [], totalCount: 0, hasMore: false, page: 1, source: 'mirror' };

    it.each<[string, Record<string, unknown>, string]>([
      ['emphasis', { query: '*war*' }, '{"query":"*war*","sort":"popular","page":1}'],
      ['underscores', { query: '_war_' }, '{"query":"_war_","sort":"popular","page":1}'],
      [
        'a quoted phrase',
        { query: '"war and peace"' },
        String.raw`{"query":"\"war and peace\"","sort":"popular","page":1}`,
      ],
      ['a lone backtick', { query: 'a`b' }, '{"query":"a`b","sort":"popular","page":1}'],
      ['paired backticks', { query: '`a`' }, '{"query":"`a`","sort":"popular","page":1}'],
      ['a backslash', { query: 'a\\*b' }, String.raw`{"query":"a\\*b","sort":"popular","page":1}`],
      ['an entity', { query: '&amp;' }, '{"query":"&amp;","sort":"popular","page":1}'],
      ['a link', { query: '[a](b)' }, '{"query":"[a](b)","sort":"popular","page":1}'],
      [
        'a query line break',
        { query: 'war\npeace' },
        '{"query":"war peace","sort":"popular","page":1}',
      ],
      [
        'a topic line break',
        { topic: 'war\npeace' },
        String.raw`{"topic":"war\npeace","sort":"popular","page":1}`,
      ],
      ['accents', { topic: 'Édouard' }, '{"topic":"Édouard","sort":"popular","page":1}'],
      [
        'a translator',
        { translator: '*Maude*' },
        '{"translator":"*Maude*","sort":"popular","page":1}',
      ],
    ])('parses %s to one span holding the JSON text', async (_case, input, json) => {
      mockGutendexService.searchBooks.mockResolvedValue(empty);
      const result = await runToolContract(gutenbergSearchBooks, input);
      const doc = readBack(contentText(result));

      expect(doc.codeSpans).toEqual([json]);
      expect(doc.blocks).toContainEqual({
        container: undefined,
        kind: 'paragraph',
        text: `Search criteria: ${json}`,
      });
      const { effectiveCriteria } = result.structuredContent as { effectiveCriteria: unknown };
      expect(JSON.parse(doc.codeSpans[0]!)).toEqual(effectiveCriteria);
      expect(doc.codeSpans[0]).toBe(JSON.stringify(effectiveCriteria));
    });

    it('holds any caller text in one span that parses back to the criteria', async () => {
      mockGutendexService.searchBooks.mockResolvedValue(empty);
      const input = fc.record({
        query: hostileText,
        topic: hostileText,
        mime_type: hostileLine,
        translator: hostileLine,
      });
      await fc.assert(
        fc.asyncProperty(input, async (generated) => {
          const result = await runToolContract(gutenbergSearchBooks, generated);
          const { effectiveCriteria } = result.structuredContent as { effectiveCriteria: unknown };
          const { codeSpans } = readBack(contentText(result));
          expect(codeSpans).toEqual([JSON.stringify(effectiveCriteria)]);
          expect(JSON.parse(codeSpans[0]!)).toEqual(effectiveCriteria);
        }),
        { ...PROPERTY_RUNS, numRuns: 200 },
      );
    });

    it('keeps the criteria line and notice on an empty result, the structured echo unchanged', async () => {
      mockGutendexService.searchBooks.mockResolvedValue(empty);
      const result = await runToolContract(gutenbergSearchBooks, { query: '*war*' });
      expect(result.structuredContent).toMatchObject({
        books: [],
        effectiveCriteria: { query: '*war*', sort: 'popular', page: 1 },
        notice:
          'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.',
      });
      expect(readBack(contentText(result)).blocks.map((block) => block.text)).toEqual([
        '0 books found (page 1)',
        'Search criteria: {"query":"*war*","sort":"popular","page":1}',
        'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.',
      ]);
    });
  });

  describe('notice', () => {
    /** A notice is static text the framework quotes: it must read back as structuredContent has it. */
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) => ({
      read: readBack(contentText(result)).blocks.filter((block) => block.container === 'quote'),
      structured: (result.structuredContent as { notice: string }).notice,
    });

    it('reads the language-code hint back from an empty three-letter-code result', async () => {
      mockGutendexService.searchBooks.mockResolvedValue({
        books: [],
        totalCount: 0,
        hasMore: false,
        page: 1,
        source: 'mirror',
      });
      const { read, structured } = noticeOf(
        await runToolContract(gutenbergSearchBooks, { languages: ['eng'] }),
      );
      expect(structured).toContain('English is "en", not "eng".');
      expect(read).toEqual([{ container: 'quote', kind: 'paragraph', text: structured }]);
    });

    it('reads the live-catalog caveat back from a live-fallback result', async () => {
      mockGutendexService.searchBooks.mockResolvedValue({
        books: [mockBook],
        totalCount: 1,
        hasMore: false,
        page: 1,
        source: 'live',
      });
      const { read, structured } = noticeOf(
        await runToolContract(gutenbergSearchBooks, {
          author_year_start: 1800,
          author_year_end: 1899,
        }),
      );
      expect(structured).toContain('checked separately');
      expect(read).toEqual([{ container: 'quote', kind: 'paragraph', text: structured }]);
    });

    it('reads both sentences back when an empty live result carries them together', async () => {
      mockGutendexService.searchBooks.mockResolvedValue({
        books: [],
        totalCount: 0,
        hasMore: false,
        page: 1,
        source: 'live',
      });
      const { read, structured } = noticeOf(
        await runToolContract(gutenbergSearchBooks, {
          languages: ['eng'],
          author_year_start: 1800,
          author_year_end: 1899,
        }),
      );
      expect(structured).toContain('checked separately');
      expect(structured).toContain('English is "en", not "eng".');
      expect(read).toEqual([{ container: 'quote', kind: 'paragraph', text: structured }]);
    });
  });
});

describe('gutenbergSearchBooks — catalog_unavailable', () => {
  /**
   * The service resolves the hint through `ctx.recoveryFor`, which only answers
   * for a reason the calling tool declares — so this fails unless the contract
   * carries the entry, and it fails on both surfaces a client might read.
   */
  it('surfaces the declared reason and recovery hint on both client surfaces', async () => {
    mockGutendexService.searchBooks.mockImplementation((_params: unknown, ctx: Context) =>
      Promise.reject(
        serviceUnavailable('The Project Gutenberg catalog did not respond.', {
          reason: 'catalog_unavailable',
          ...ctx.recoveryFor('catalog_unavailable'),
        }),
      ),
    );

    const result = await runToolContract(gutenbergSearchBooks, { query: 'austen' });
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
