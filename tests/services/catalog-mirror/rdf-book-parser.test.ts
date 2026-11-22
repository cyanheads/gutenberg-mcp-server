/**
 * @fileoverview Tests for the per-book RDF parser against real Project Gutenberg
 * records pulled from the bulk archive. The fixtures are unedited upstream documents,
 * chosen for shape rather than tidiness: an editor credit, a translator credit, three
 * authors with BCE lifespans, a `Sound` recording, a record with no authors or
 * subjects at all, two summaries, a non-English work, and a title carrying an escaped
 * carriage return.
 *
 * The committed Gutendex JSON responses pin the other half of the contract: a record
 * parsed from RDF and the same record served live must agree field for field.
 * @module tests/services/catalog-mirror/rdf-book-parser.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBookRdf } from '@/services/catalog-mirror/rdf-book-parser.js';
import type { Book } from '@/services/gutendex/types.js';

const RDF_DIR = new URL('../../fixtures/catalog-mirror/rdf/', import.meta.url);
const GUTENDEX_DIR = new URL('../../fixtures/catalog-mirror/gutendex/', import.meta.url);

function readRdf(id: number): string {
  return readFileSync(new URL(`pg${id}.rdf`, RDF_DIR), 'utf8');
}

function parse(id: number): Book {
  const book = parseBookRdf(readRdf(id), id);
  if (book === null) throw new Error(`Fixture pg${id}.rdf carries no ebook element.`);
  return book;
}

describe('parseBookRdf — field mapping', () => {
  it('trims ordinary metadata and keeps legacy editor and translator credits separate', () => {
    const xml =
      '<rdf:RDF><pgterms:ebook><dcterms:title>  Edition  </dcterms:title><marcrel:edt><pgterms:agent><pgterms:name>  Editor  </pgterms:name></pgterms:agent></marcrel:edt><marcrel:trl><pgterms:agent><pgterms:name>Translator</pgterms:name></pgterms:agent></marcrel:trl></pgterms:ebook></rdf:RDF>';
    expect(parseBookRdf(xml, 1)).toMatchObject({
      title: 'Edition',
      editors: [{ name: 'Editor', birth_year: null, death_year: null }],
      translators: [{ name: 'Translator', birth_year: null, death_year: null }],
    });
  });

  it('reads edition metadata from the ebook and pairs names, aliases, and webpages within each agent', () => {
    const xml = `<rdf:RDF><pgterms:ebook>
      <dcterms:creator><pgterms:agent><pgterms:alias>Ignored</pgterms:alias></pgterms:agent></dcterms:creator>
      <dcterms:creator><pgterms:agent><pgterms:name>Twain, Mark</pgterms:name><pgterms:alias>Clemens, Samuel</pgterms:alias><pgterms:alias>Clemens, S.</pgterms:alias><pgterms:webpage rdf:resource="https://fr.wikipedia.org/wiki/Mark_Twain"/><pgterms:webpage rdf:resource="https://en.wikipedia.org/wiki/Mark_Twain"/></pgterms:agent></dcterms:creator>
      <dcterms:creator><pgterms:agent><pgterms:name>Second</pgterms:name></pgterms:agent></dcterms:creator>
      <dcterms:alternative>First alternate</dcterms:alternative>
      <dcterms:alternative>Second alternate</dcterms:alternative>
      <marcrel:ill><pgterms:agent><pgterms:name>Kemble, E. W.</pgterms:name></pgterms:agent></marcrel:ill>
      <marcrel:xyz><pgterms:agent><pgterms:name>Kemble, E. W.</pgterms:name></pgterms:agent></marcrel:xyz>
      <marcrel:xyz><pgterms:agent><pgterms:birthdate>1800</pgterms:birthdate></pgterms:agent></marcrel:xyz>
      <marcrel:trl><pgterms:agent><pgterms:name>Translator</pgterms:name></pgterms:agent></marcrel:trl>
      <marcrel:edt><pgterms:agent><pgterms:name>Editor</pgterms:name></pgterms:agent></marcrel:edt>
      <dcterms:hasFormat><pgterms:file><dcterms:issued>2000-01-02</dcterms:issued><dcterms:alternative>Nested title</dcterms:alternative><pgterms:marc908>Nested score</pgterms:marc908></pgterms:file></dcterms:hasFormat>
      <dcterms:tableOfContents>  A &amp; B&#13;
C  </dcterms:tableOfContents>
      <dcterms:issued>1999-03-01</dcterms:issued>
      <pgterms:marc908>Reading ease score: 65.0 (8th &amp; 9th grade).</pgterms:marc908>
      <pgterms:marc260>  $aUnited States :$bself-published, $c1926. Costs $5. </pgterms:marc260>
      <dcterms:subject><rdf:Description><dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCC"/><rdf:value>PS</rdf:value></rdf:Description></dcterms:subject>
      <dcterms:subject><rdf:Description><dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCSH"/><rdf:value>Fiction</rdf:value></rdf:Description></dcterms:subject>
      <dcterms:subject><rdf:Description><dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCC"/><rdf:value>QA76</rdf:value></rdf:Description></dcterms:subject>
      <dcterms:subject><rdf:Description><dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCC"/><rdf:value>PS</rdf:value></rdf:Description></dcterms:subject>
    </pgterms:ebook></rdf:RDF>`;
    expect(parseBookRdf(xml, 1)).toMatchObject({
      authors: [
        {
          name: 'Twain, Mark',
          aliases: ['Clemens, Samuel', 'Clemens, S.'],
          webpage: 'https://en.wikipedia.org/wiki/Mark_Twain',
        },
        { name: 'Second', aliases: [], webpage: null },
      ],
      alternative_titles: ['First alternate', 'Second alternate'],
      contributors: [
        { name: 'Kemble, E. W.', role: 'Illustrator', birth_year: null, death_year: null },
        { name: 'Kemble, E. W.', role: 'xyz', birth_year: null, death_year: null },
      ],
      contents: '  A & B\r\nC  ',
      release_date: '1999-03-01',
      reading_ease: 'Reading ease score: 65.0 (8th & 9th grade).',
      source_imprint: 'United States : self-published, 1926. Costs $5.',
      subjects: ['Fiction'],
      lcc: ['PS', 'QA76'],
    });
  });

  it.each([
    ['[S.l. : $b s.n.], $c 1853', '[S.l. : s.n.], 1853'],
    [
      '$United Kingdom :$bA. and C. Black Ltd.,$c1911.',
      'United Kingdom : A. and C. Black Ltd., 1911.',
    ],
    [
      'Boston&#13;\nLittle, Brown, And Company&#13;\n1906',
      'Boston Little, Brown, And Company 1906',
    ],
    [' $a  ', null],
  ])('normalizes the imprint %s', (value, expected) => {
    const xml = `<rdf:RDF><pgterms:ebook><pgterms:marc260>${value}</pgterms:marc260></pgterms:ebook></rdf:RDF>`;
    expect(parseBookRdf(xml, 1)?.source_imprint).toBe(expected);
  });

  it('preserves direct bibliographic notes and excludes nested file descriptions', () => {
    expect(parse(84)).toMatchObject({
      source_notes: expect.arrayContaining([
        expect.stringContaining('#41445 (1818 ed.) and #42324 (1831 ed.)'),
      ]),
    });
    expect(parse(84).source_notes).not.toContain('en.wikipedia');
    const xml =
      '<rdf:RDF><pgterms:ebook><dcterms:title>Notes</dcterms:title><dcterms:description>Édition 1831 — #42324</dcterms:description><dcterms:hasFormat><pgterms:file><dcterms:description>Nested noise</dcterms:description></pgterms:file></dcterms:hasFormat><dcterms:description>First edition #41445</dcterms:description></pgterms:ebook></rdf:RDF>';
    expect(parseBookRdf(xml, 1)?.source_notes).toEqual([
      'Édition 1831 — #42324',
      'First edition #41445',
    ]);
    expect(
      parseBookRdf(
        '<rdf:RDF><pgterms:ebook><dcterms:title>No notes</dcterms:title></pgterms:ebook></rdf:RDF>',
        2,
      )?.source_notes,
    ).toEqual([]);
  });

  it('maps a complete Text record (Frankenstein, 84)', () => {
    const book = parse(84);
    expect(book.id).toBe(84);
    expect(book.title).toBe('Frankenstein; or, the modern prometheus');
    expect(book.authors).toEqual([
      {
        name: 'Shelley, Mary Wollstonecraft',
        birth_year: 1797,
        death_year: 1851,
        aliases: ['Shelley, Mary Wollstonecraft Godwin', 'Shelley, Mary W.'],
        webpage: 'https://en.wikipedia.org/wiki/Mary_Wollstonecraft_Shelley',
      },
    ]);
    expect(book.editors).toEqual([]);
    expect(book.translators).toEqual([]);
    expect(book.languages).toEqual(['en']);
    expect(book.copyright).toBe(false);
    expect(book.media_type).toBe('Text');
    expect(book.download_count).toBe(58824);
    expect(book.has_plain_text).toBe(true);
    expect(book.reading_ease).toBe(
      'Reading ease score: 65.0 (8th & 9th grade). Neither easy nor difficult to read.',
    );
  });

  it('keeps only Library of Congress subject headings, sorted', () => {
    const book = parse(84);
    expect(book.subjects).toEqual([
      "Frankenstein's monster (Fictitious character) -- Fiction",
      'Frankenstein, Victor (Fictitious character) -- Fiction',
      'Gothic fiction',
      'Horror tales',
      'Monsters -- Fiction',
      'Science fiction',
      'Scientists -- Fiction',
    ]);
    /** The record also carries an LCC classification (`PR`); only LCSH values are subjects. */
    expect(book.subjects).not.toContain('PR');
    expect(readRdf(84)).toContain('LCC');
    expect(book.lcc).toEqual(['PR']);
  });

  it('sorts bookshelves', () => {
    const book = parse(84);
    expect(book.bookshelves).toEqual([...book.bookshelves].sort());
    expect(book.bookshelves).toContain('Gothic Fiction');
  });

  it('keeps the first file of each MIME type, so the illustrated edition wins', () => {
    const book = parse(84);
    /** The record lists two `text/html` files; the `.html.images` one comes first. */
    expect(book.formats['text/html']).toBe('https://www.gutenberg.org/ebooks/84.html.images');
    expect(book.formats['application/epub+zip']).toBe(
      'https://www.gutenberg.org/ebooks/84.epub3.images',
    );
    expect(book.formats['text/plain; charset=utf-8']).toBe(
      'https://www.gutenberg.org/ebooks/84.txt.utf-8',
    );
  });

  it('carries every summary and exposes the first as the singular field', () => {
    const book = parse(1399);
    expect(book.summaries).toHaveLength(2);
    expect(book.summaries).toEqual([...book.summaries].sort());
    expect(book.summary).toBe(book.summaries[0]);
  });

  it('reads editor credits (marcrel:edt)', () => {
    expect(parse(45304).editors).toEqual([
      { name: 'Dods, Marcus', birth_year: 1834, death_year: 1909 },
    ]);
  });

  it('reads translator credits (marcrel:trl)', () => {
    expect(parse(10001).translators).toEqual([
      { name: 'Rouse, W. H. D. (William Henry Denham)', birth_year: 1863, death_year: 1950 },
    ]);
  });

  it('reads several authors in document order, including BCE lifespans and unknown years', () => {
    expect(parse(10056).authors).toEqual([
      {
        name: 'Confucius',
        birth_year: -551,
        death_year: -479,
        aliases: ['孔子'],
        webpage: 'https://en.wikipedia.org/wiki/Confucius',
      },
      {
        name: 'Faxian',
        birth_year: null,
        death_year: null,
        aliases: ['Fa-hsien', '法顯'],
        webpage: 'https://en.wikipedia.org/wiki/Faxian',
      },
      {
        name: 'Mencius',
        birth_year: -385,
        death_year: -289,
        aliases: ['孟子', 'Mengzi'],
        webpage: 'https://en.wikipedia.org/wiki/Mencius',
      },
    ]);
  });

  it('marks a Sound recording unreadable as plain text', () => {
    const book = parse(10137);
    expect(book.media_type).toBe('Sound');
    expect(book.has_plain_text).toBe(false);
    expect(book.formats['audio/mpeg']).toMatch(/^https:\/\//);
  });

  it('folds an escaped carriage return in a title into a subtitle separator', () => {
    /** Upstream writes the break as `&#13;` followed by a newline; both are one break. */
    expect(readRdf(10137)).toContain('&#13;');
    expect(parse(10137).title).toBe(
      'Mary Had a Little Lamb: Recording taken from Movietone Production news film',
    );
  });

  it('leaves an empty record empty rather than inventing values', () => {
    const book = parse(1073);
    expect(book.authors).toEqual([]);
    expect(book.subjects).toEqual([]);
    expect(book.bookshelves).toEqual([]);
    expect(book.summaries).toEqual([]);
    expect(book.summary).toBeNull();
    expect(book.has_plain_text).toBe(false);
    expect(book.download_count).toBe(47);
    expect(book).toMatchObject({
      alternative_titles: [],
      contributors: [],
      contents: null,
      lcc: [],
      reading_ease: null,
      source_imprint: null,
    });
  });

  it('preserves non-ASCII text and a non-English language code', () => {
    const book = parse(1000);
    expect(book.languages).toEqual(['it']);
    expect(book.authors[0]?.name).toBe('Dante Alighieri');
  });

  it('files the record under the caller-supplied ID, not the document', () => {
    /** The archive path is authoritative — a record can never land under another ID. */
    expect(parseBookRdf(readRdf(84), 4242)?.id).toBe(4242);
  });
});

describe('catalog title normalization', () => {
  it.each([
    ['Peter Pan : $b [Peter and Wendy]', 'Peter Pan: [Peter and Wendy]'],
    ['Title ; $b subtitle', 'Title; subtitle'],
    ['Title = $b parallel', 'Title = parallel'],
    ['Title $b: subtitle', 'Title: subtitle'],
    ['Title : $ subtitle', 'Title: subtitle'],
    ['Title $b subtitle $c contributor $v volume', 'Title: subtitle: contributor: volume'],
    ['Title\n$b subtitle', 'Title: subtitle'],
  ])('normalizes reserved markers in %s', (title, expected) => {
    expect(
      parseBookRdf(
        `<rdf:RDF><pgterms:ebook><dcterms:title>${title}</dcterms:title></pgterms:ebook></rdf:RDF>`,
        1,
      )?.title,
    ).toBe(expected);
  });
  it.each(['The $30,000 Bequest, and Other Stories', 'A $ price', 'Costs $5 and $10'])(
    'preserves literal dollars in %s',
    (title) => {
      expect(
        parseBookRdf(
          `<rdf:RDF><pgterms:ebook><dcterms:title>${title}</dcterms:title></pgterms:ebook></rdf:RDF>`,
          1,
        )?.title,
      ).toBe(title);
    },
  );
});

describe('parseBookRdf — malformed input', () => {
  it('returns null for a document with no ebook element', () => {
    const empty =
      '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>';
    expect(parseBookRdf(empty, 1)).toBeNull();
  });

  it('returns null for an empty document', () => {
    expect(parseBookRdf('', 1)).toBeNull();
  });

  it('throws on input that is not XML', () => {
    expect(() => parseBookRdf('not xml at all <<<', 1)).toThrow();
  });

  it('throws when a document is truncated mid-element', () => {
    const xml = readRdf(84);
    expect(() => parseBookRdf(xml.slice(0, Math.floor(xml.length / 2)), 84)).toThrow();
  });
});

describe('parseBookRdf — parity with the live Gutendex record', () => {
  /**
   * Order is excluded deliberately. Gutendex serves people and formats in the order of
   * its own database rows — an artifact of when each person or format was first seen
   * across the whole catalog — so it does not reproduce from a single document and is
   * not part of the record's content. Everything that is content must match exactly.
   */
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sortDeep).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, inner]) => [key, sortDeep(inner)]),
      );
    }
    return value;
  };

  it.each([84, 10001, 10056, 45304])(
    'parses book %i identically to the Gutendex JSON for the same record',
    (id) => {
      const live = JSON.parse(readFileSync(new URL(`${id}.json`, GUTENDEX_DIR), 'utf8')) as Record<
        string,
        unknown
      >;
      const mine = parse(id) as unknown as Record<string, unknown>;
      for (const field of Object.keys(live)) {
        const expected =
          field === 'title' && id === 10056
            ? 'Chinese literature: Comprising the Analects of Confucius, the Sayings of Mencius, the Shi-King, the Travels of Fâ-Hien, and the Sorrows of Han'
            : live[field];
        const actual =
          field === 'authors'
            ? parse(id).authors.map(({ name, birth_year, death_year }) => ({
                name,
                birth_year,
                death_year,
              }))
            : mine[field];
        expect(sortDeep(actual), `field ${field}`).toEqual(sortDeep(expected));
      }
    },
  );

  it('adds computed fields and RDF-only bibliographic notes to the live shape', () => {
    const live = JSON.parse(readFileSync(new URL('84.json', GUTENDEX_DIR), 'utf8')) as object;
    const extra = Object.keys(parse(84)).filter((key) => !(key in live));
    expect(extra.sort()).toEqual([
      'alternative_titles',
      'contents',
      'contributors',
      'has_plain_text',
      'is_readable',
      'lcc',
      'reading_ease',
      'release_date',
      'source_imprint',
      'source_notes',
      'summary',
    ]);
  });
});
