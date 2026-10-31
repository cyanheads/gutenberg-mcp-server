/**
 * @fileoverview Tests for the gutenberg_get_book tool.
 * @module tests/tools/gutenberg-get-book.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gutenbergGetBook } from '@/mcp-server/tools/definitions/gutenberg-get-book.tool.js';
import {
  ACTIVE_MARKDOWN,
  contentText,
  hostileLine,
  hostileText,
  lf,
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
  is_readable: true,
  source_notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gutenbergGetBook', () => {
  it.each([null, [], ['See #41445 (1818 ed.) and #42324 (1831 ed.).']])(
    'preserves source notes %j on both surfaces',
    async (source_notes) => {
      mockGutendexService.getBook.mockResolvedValue({
        ...mockBook,
        source_notes,
        is_readable: true,
        has_plain_text: false,
        formats: { 'text/html': 'https://example/book.html' },
      });
      const result = await runToolContract(gutenbergGetBook, { id: 84 });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        source_notes,
        is_readable: true,
        has_plain_text: false,
        download_count: 75000,
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('Readable:');
      expect(text).toContain('last 30 days');
      expect(text).toContain('source snapshot');
      expect(text).toContain(
        source_notes === null
          ? 'Source notes:** Not available'
          : source_notes.length === 0
            ? 'Source notes:** None'
            : source_notes[0],
      );
    },
  );
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
      is_readable: true,
      source_notes: null,
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

// ── CommonMark read-back (#37) ───────────────────────────────────────────────
//
// Every assertion here reads a real parse of content[] against the raw catalog
// string. format-parity's sentinels are alphanumeric, so the lint is clean with or
// without an escape; these are the tests that notice a missing one.

describe('gutenbergGetBook — content[] reads back as structuredContent', () => {
  type BookOutput = Parameters<NonNullable<typeof gutenbergGetBook.format>>[0];
  type Person = BookOutput['authors'][number];

  const render = (book: BookOutput) => (gutenbergGetBook.format!(book)[0] as { text: string }).text;
  const read = (book: BookOutput) => readBack(render(book));

  const person = (p: Person) =>
    p.birth_year != null || p.death_year != null
      ? `${p.name} (${p.birth_year ?? '?'}–${p.death_year ?? '?'})`
      : p.name;
  const people = (list: Person[]) => (list.length > 0 ? list.map(person).join(', ') : 'None');

  /** The page a reader should get, written from the raw values instead of from format(). */
  function wantPage(book: BookOutput): string {
    const list = (values: string[]) => (values.length > 0 ? values.join('; ') : 'None');
    const summary = `Summary: ${lf(book.summary ?? 'Not available')}`;
    const additional = book.summaries.filter((s) => s !== book.summary);
    const additionalLine =
      additional.length > 0
        ? `Additional summaries (${additional.length}):`
        : 'Additional summaries: None';
    const notes = book.source_notes;
    const mimes = Object.keys(book.formats);
    return [
      book.title,
      [
        `ID: ${book.id} | Media: ${book.media_type} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()}`,
        `Authors: ${people(book.authors)}`,
        `Translators: ${people(book.translators)}`,
        `Editors: ${people(book.editors)}`,
        `Languages: ${book.languages.join(', ')} | Copyright: Public Domain (USA)`,
        `Subjects: ${list(book.subjects)}`,
        `Bookshelves: ${list(book.bookshelves)}`,
      ].join('\n'),
      ...(notes?.length
        ? [`${summary}\nSource notes:`, lf(notes.join('\n')), additionalLine]
        : [`${summary}\nSource notes: ${notes ? 'None' : 'Not available'}\n${additionalLine}`]),
      ...(additional.length > 0 ? [lf(additional.join('\n'))] : []),
      'Plain text available: Yes | Readable: Yes — use gutenberg_get_text',
      ...(mimes.length > 0 ? ['Formats:', mimes.join('\n')] : ['Formats: None']),
    ].join('\n\n');
  }

  const austen = { name: 'Austen, Jane', birth_year: 1775, death_year: 1817 };
  const active: Person = { name: ACTIVE_MARKDOWN, birth_year: 1775, death_year: 1817 };

  /** Each case holds syntax in one slot only, so a failure names that slot's missing escape. */
  it.each<[string, Partial<BookOutput>]>([
    ['the title', { title: ACTIVE_MARKDOWN }],
    ['the media type', { media_type: ACTIVE_MARKDOWN }],
    ['an author name', { authors: [austen, active] }],
    ['a translator name', { translators: [austen, active] }],
    ['an editor name', { editors: [austen, active] }],
    ['a language', { languages: ['en', ACTIVE_MARKDOWN] }],
    ['a subject', { subjects: ['Fiction', ACTIVE_MARKDOWN] }],
    ['a bookshelf', { bookshelves: ['Fiction', ACTIVE_MARKDOWN] }],
    ['the summary', { summary: ACTIVE_MARKDOWN, summaries: [ACTIVE_MARKDOWN] }],
    ['an additional summary', { summary: 'First.', summaries: ['First.', ACTIVE_MARKDOWN] }],
  ])('reads %s back unchanged', (_slot, change) => {
    const book = { ...mockBook, ...change };
    expect(read(book).text).toBe(wantPage(book));
  });

  /** Catalog strings from the 2026-10-30 harvest, each a value Markdown used to rewrite. */
  it.each<[number, string, Partial<BookOutput>]>([
    [38430, 'the title', { title: 'The philosophy of Mr. B*rtr*nd R*ss*ll' }],
    [
      30121,
      'the title',
      { title: 'The Art of Confectionary: ... Figs, Grapes, &amp;c., Flowers and Herbs; ...' },
    ],
    [
      117,
      'the source notes',
      {
        source_notes: [
          'Wikipedia page about this book: https://en.wikipedia.org/wiki/Symphony_No._5_(Beethoven)',
          'Music file',
        ],
      },
    ],
    [
      9204,
      'the summary',
      {
        summary: "... part of Hawthorne's collection *Twice-Told Tales*. The collection ...",
        summaries: ["... part of Hawthorne's collection *Twice-Told Tales*. The collection ..."],
      },
    ],
  ])('book %i: %s reads back through the wire contract', async (id, _slot, change) => {
    const book = { ...mockBook, id, ...change };
    mockGutendexService.getBook.mockResolvedValue(book);
    const result = await runToolContract(gutenbergGetBook, { id });
    expect(result.structuredContent).toMatchObject(change);
    expect(readBack(contentText(result)).text).toBe(wantPage(book));
  });

  it('leaves a value with nothing to encode byte-identical', () => {
    const text = render({
      ...mockBook,
      authors: [austen],
      subjects: ['Love stories -- Fiction'],
      bookshelves: [],
      summary: null,
      summaries: [],
    });
    expect(text).toContain('**Authors:** Austen, Jane (1775–1817)');
    expect(text).toContain('**Subjects:** Love stories -- Fiction');
    expect(text).toContain('**Bookshelves:** None');
    expect(text).toContain('**Source notes:** Not available');
    expect(text).toContain('**Summary:** Not available');
  });

  describe('source_notes', () => {
    const wikipedia =
      'Wikipedia page about this book: https://en.wikipedia.org/wiki/Symphony_No._5_(Beethoven)';

    it('keeps a note URL verbatim in the raw text (117)', () => {
      expect(render({ ...mockBook, source_notes: [wikipedia] })).toContain(
        'https://en.wikipedia.org/wiki/Symphony_No._5_(Beethoven)',
      );
    });

    it('renders every note as one code block, with CRLF read back as LF (1)', () => {
      const declaration =
        "Project Gutenberg has three editions of this work:\r\n\r\n#1 is the original Project Gutenberg edition, and the world's first eBook.\r\n\r\nSee also #300, which is substantially the same.";
      const notes = [
        'Wikipedia page about this book: https://en.wikipedia.org/wiki/United_States_Declaration_of_Independence',
        declaration,
      ];
      const code = read({ ...mockBook, source_notes: notes }).blocks.filter(
        (block) => block.kind === 'code',
      );
      expect(code).toEqual([
        {
          container: undefined,
          kind: 'code',
          text: `${notes[0]}\n${declaration.replaceAll('\r\n', '\n')}`,
        },
      ]);
    });

    it('holds a backtick run and a tilde fence inside the block', () => {
      const notes = ['```\ninside\n```', '~~~', '````` *five*'];
      const doc = read({ ...mockBook, source_notes: notes });
      expect(doc.blocks.filter((block) => block.kind === 'code').map((b) => b.text)).toEqual([
        notes.join('\n'),
      ]);
      expect(doc.emphasis).toEqual([]);
    });
  });

  describe('multi-line summaries', () => {
    /** Book 503 carries this as its only summary; a blank line used to split the paragraph. */
    const withBlankLine =
      '"The Blue Fairy Book" by Andrew Lang is a collection of fairy tales published in 1889.\n\nThis groundbreaking volume launched a revolutionary series.';

    it('holds a blank line in one paragraph (503)', () => {
      const doc = read({ ...mockBook, summary: withBlankLine, summaries: [withBlankLine] });
      expect(doc.blocks).toContainEqual({
        container: undefined,
        kind: 'paragraph',
        text: `Summary: ${withBlankLine}\nSource notes: Not available\nAdditional summaries: None`,
      });
    });

    it('keeps a blank line inside its list item as an additional summary', () => {
      const doc = read({
        ...mockBook,
        summary: 'First.',
        summaries: ['First.', withBlankLine, 'Last.'],
        formats: {},
      });
      expect(doc.blocks.filter((block) => block.container === 'list')).toEqual([
        { container: 'list', kind: 'paragraph', text: withBlankLine },
        { container: 'list', kind: 'paragraph', text: 'Last.' },
      ]);
    });

    it('keeps lines that read as block syntax inside the list item past the first break', () => {
      const blocky = 'one\n\n2. two\n- three\n> four\n# five\n    six\n```\n---\n\n\nseven';
      const doc = read({
        ...mockBook,
        summary: 'First.',
        summaries: ['First.', blocky, 'Last.'],
        formats: {},
      });
      expect(doc.blocks.filter((block) => block.container === 'list')).toEqual([
        { container: 'list', kind: 'paragraph', text: blocky },
        { container: 'list', kind: 'paragraph', text: 'Last.' },
      ]);
      expect(doc.blocks.filter((block) => block.kind === 'code')).toEqual([]);
    });
  });

  describe('formats', () => {
    it('parses each entry to a link: the MIME key as text, the URL as destination', () => {
      expect(read(mockBook).links).toEqual([
        {
          href: 'https://www.gutenberg.org/ebooks/1342.txt.utf-8',
          label: 'text/plain; charset=utf-8',
        },
        { href: 'https://www.gutenberg.org/ebooks/1342.html', label: 'text/html' },
        {
          href: 'https://www.gutenberg.org/ebooks/1342.epub.noimages',
          label: 'application/epub+zip',
        },
      ]);
    });

    it('keeps a URL holding spaces and parentheses as one destination', () => {
      const url = 'https://www.gutenberg.org/files/1/a b (c).pdf';
      expect(read({ ...mockBook, formats: { 'application/pdf': url } }).links).toEqual([
        { href: url, label: 'application/pdf' },
      ]);
    });

    it.each(['javascript:alert(1)', 'data:text/html,x', '/files/1.txt', 'not a url'])(
      'renders %s as literal text with no link',
      (url) => {
        const doc = read({ ...mockBook, formats: { 'text/html': url } });
        expect(doc.links).toEqual([]);
        expect(doc.blocks).toContainEqual({
          container: 'list',
          kind: 'paragraph',
          text: `text/html (${url})`,
        });
      },
    );

    it('states an empty map like every other empty collection (69279)', () => {
      const text = render({ ...mockBook, formats: {} });
      expect(text).toContain('**Formats:** None');
      expect(text.trimEnd().endsWith('**Formats:** None')).toBe(true);
    });
  });

  it('reads any metadata back through the assembled page, joins included', () => {
    const name = fc.record({
      name: hostileLine,
      birth_year: fc.constantFrom(null, 1775),
      death_year: fc.constantFrom(null, 1817),
    });
    /** A final lone CR joins the LF the fence adds into one CRLF, so it reads back as nothing. */
    const note = hostileText.filter((text) => !text.endsWith('\r'));
    const book = fc
      .record({
        title: hostileLine,
        media_type: hostileLine,
        authors: fc.array(name, { maxLength: 2 }),
        translators: fc.array(name, { maxLength: 2 }),
        editors: fc.array(name, { maxLength: 2 }),
        languages: fc.array(hostileLine, { maxLength: 2 }),
        subjects: fc.array(hostileLine, { maxLength: 3 }),
        bookshelves: fc.array(hostileLine, { maxLength: 3 }),
        summaries: fc.array(hostileText, { maxLength: 3 }),
        source_notes: fc.option(fc.array(note, { maxLength: 3 }), { nil: null }),
      })
      .map((fields) => ({ ...mockBook, ...fields, summary: fields.summaries[0] ?? null }));
    fc.assert(
      fc.property(book, (generated) => {
        expect(read(generated).text).toBe(wantPage(generated));
      }),
      PROPERTY_RUNS,
    );
  });

  it('reads any MIME key and http(s) URL back as a link', () => {
    fc.assert(
      fc.property(hostileLine, hostileLine, (mime, path) => {
        const url = `https://x.test/${path}`;
        expect(read({ ...mockBook, formats: { [mime]: url } }).links).toEqual([
          { href: url, label: mime },
        ]);
      }),
      PROPERTY_RUNS,
    );
  });

  it('leaves a multi-value list with nothing to encode byte-identical', () => {
    const text = render({
      ...mockBook,
      subjects: ['Love stories -- Fiction', 'England -- Fiction'],
    });
    expect(text).toContain('**Subjects:** Love stories -- Fiction; England -- Fiction');
  });

  /** The `; ` separator is escaped with its values, so an unterminated entity cannot complete there. */
  it.each<[string, string[]]>([
    ['a named entity', ['AT&amp', 'b']],
    ['a decimal reference', ['&#35', 'b']],
    ['a hexadecimal reference', ['&#x23', 'b']],
    ['consecutive entities', ['&lt', '&gt', '&amp']],
    ['entities among plain values', ['AT&amp', '&#35', 'tail']],
    ['an ampersand before the separator', ['a&', 'b']],
    ['a value that already holds a reference', ['&amp;&amp', 'b']],
    ['a trailing backslash', ['a\\', 'b']],
    ['a trailing space', ['a ', 'b']],
    ['a trailing hash', ['a #', 'b']],
    ['a trailing line break', ['a\n', 'b']],
    ['syntax only the separator closes', ['*a', 'b*']],
    ['a value of whitespace', [' ', 'b']],
    ['edge whitespace on the last value', ['a', 'b  ']],
  ])('reads %s back through the subject and bookshelf separator', (_case, values) => {
    const book = { ...mockBook, subjects: values, bookshelves: values };
    expect(read(book).text).toBe(wantPage(book));
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
