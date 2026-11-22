/**
 * @fileoverview Parses one Project Gutenberg per-book RDF/XML document into the
 * normalized {@link Book} shape used by the mirror and per-book RDF lookup.
 *
 * The field mapping mirrors Gutendex's own RDF reader (`books/utils.py` +
 * `books/serializers.py` in garethbjohnson/gutendex), which is what populates the
 * live discovery API. Shared fields retain Gutendex's defaults and normalization,
 * and RDF-only fields are added when the catalog supplies them.
 * @module services/catalog-mirror/rdf-book-parser
 */

import { XMLParser } from 'fast-xml-parser';
import {
  type Author,
  type Book,
  type Contributor,
  hasPlainText,
  isReadable,
  normalizeTitle,
  type Person,
  type RawBook,
} from '@/services/gutendex/types.js';

/**
 * Project Gutenberg's RDF generator emits fixed namespace prefixes, so elements
 * are matched by qualified name rather than by resolved namespace URI. Keeping the
 * prefixes (rather than `removeNSPrefix`) preserves the `dcterms:` / `pgterms:` /
 * `marcrel:` distinctions the mapping depends on.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  /** Every value is read as text and coerced explicitly — a numeric-looking title must stay a string. */
  parseTagValue: false,
  parseAttributeValue: false,
  /** Contents is a source literal. Preserve its whitespace while trimming other values. */
  trimValues: false,
  tagValueProcessor: (name, value) => (name === 'dcterms:tableOfContents' ? value : value.trim()),
  attributeValueProcessor: (_name, value) => value.trim(),
  /**
   * Decodes numeric character references. Titles carry `&#13;` where a line break was
   * folded into the record, and the subtitle transform below has to see the character,
   * not the escape — Gutendex's XML reader resolves them, so leaving them literal would
   * put `&#13;` in a title the live path returns clean. Named HTML entities beyond the
   * five XML defines cannot appear in a valid XML document, so nothing else is affected.
   */
  htmlEntities: true,
});

/** `dcam:memberOf` resource marking a subject as a Library of Congress Subject Heading. */
const LCSH_RESOURCE = 'http://purl.org/dc/terms/LCSH';
const LCC_RESOURCE = 'http://purl.org/dc/terms/LCC';
const ENGLISH_WIKIPEDIA = /^https?:\/\/en\.wikipedia\.org\//i;

/** Relator labels for Gutenberg's contributor credits, from the Library of Congress code list. */
const CONTRIBUTOR_ROLES = new Map([
  ['adp', 'Adapter'],
  ['aft', 'Author of afterword, colophon, etc.'],
  ['ann', 'Annotator'],
  ['arr', 'Arranger'],
  ['art', 'Artist'],
  ['aui', 'Author of introduction, etc.'],
  ['clb', 'Collaborator'],
  ['cmm', 'Commentator'],
  ['cmp', 'Composer'],
  ['cnd', 'Conductor'],
  ['com', 'Compiler'],
  ['ctb', 'Contributor'],
  ['dub', 'Dubious author'],
  ['egr', 'Engraver'],
  ['frg', 'Forger'],
  ['ill', 'Illustrator'],
  ['lbt', 'Librettist'],
  ['oth', 'Other'],
  ['pbl', 'Publisher'],
  ['pht', 'Photographer'],
  ['prf', 'Performer'],
  ['prt', 'Printer'],
  ['res', 'Researcher'],
  ['trc', 'Transcriber'],
  ['unk', 'Unknown'],
]);
/** Leading rights text Project Gutenberg uses for public-domain works. */
const PUBLIC_DOMAIN_PREFIX = 'Public domain in the USA.';
/** Leading rights text Project Gutenberg uses for works still under copyright. */
const COPYRIGHTED_PREFIX = 'Copyrighted.';
/** Media type assumed when a record carries no `dcterms:type`, matching Gutendex. */
const DEFAULT_MEDIA_TYPE = 'Text';
/** A run of line breaks plus the indentation around it, used to fold multi-line titles. */
const LINE_BREAK = /[ \t]*[\n\r]+[ \t]*/;
const LINE_BREAK_ALL = /[ \t]*[\n\r]+[ \t]*/g;

/** Parsed XML node — a plain object keyed by qualified element name. */
type XmlNode = Record<string, unknown>;

/** Wrap a parser value so single and repeated elements iterate the same way. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Every value registered under `tag` anywhere beneath `node`, in document order —
 * the equivalent of ElementTree's `.//tag` that Gutendex's reader uses throughout.
 */
function descendants(node: unknown, tag: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) descendants(item, tag, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag) out.push(...asArray(value));
    descendants(value, tag, out);
  }
  return out;
}

/** First descendant value under `tag`, or `undefined`. */
function firstDescendant(node: unknown, tag: string): unknown {
  return descendants(node, tag)[0];
}

/**
 * Text content of an element value. A leaf with no attributes parses to a bare
 * string; one carrying attributes (`rdf:datatype`, `rdf:resource`) parses to an
 * object whose text sits under `#text`.
 */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as XmlNode)['#text'];
  return typeof text === 'string' ? text : undefined;
}

/** Value of an attribute on an element. */
function attrOf(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const attr = (value as XmlNode)[`@_${name}`];
  return typeof attr === 'string' ? attr : undefined;
}

/** Text of the first `rdf:value` beneath `node`. */
function rdfValue(node: unknown): string | undefined {
  return textOf(firstDescendant(node, 'rdf:value'));
}

/** Parse an integer-typed RDF literal, tolerating a leading sign and surrounding space. */
function intOf(value: unknown): number | null {
  const text = textOf(value)?.trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Fold a multi-line title into one line: the first break becomes a colon, the rest
 * semicolons. Gutendex applies the same transform, so a title with subtitles reads
 * identically on both paths.
 */
function fixSubtitles(title: string): string {
  return title.replace(LINE_BREAK, ': ').replace(LINE_BREAK_ALL, '; ');
}

/**
 * Read one agent element (`dcterms:creator`, `marcrel:edt`, `marcrel:trl`) into a
 * person. Returns null when the element carries no `pgterms:name`, which is what
 * Gutendex does — an unnamed agent is dropped rather than recorded blank.
 */
function personOf(element: unknown): Person | null {
  const name = textOf(firstDescendant(element, 'pgterms:name'));
  if (!name) return null;
  return {
    name,
    birth_year: intOf(firstDescendant(element, 'pgterms:birthdate')),
    death_year: intOf(firstDescendant(element, 'pgterms:deathdate')),
  };
}

/** Nonempty direct literal texts in document order. */
function directTexts(value: unknown): string[] {
  return asArray(value)
    .map(textOf)
    .filter((text): text is string => Boolean(text));
}

/** Keep all creator metadata on the same named agent. */
function authorsOf(ebook: XmlNode): Author[] {
  const authors: Author[] = [];
  for (const creator of asArray(ebook['dcterms:creator'])) {
    for (const agent of descendants(creator, 'pgterms:agent') as XmlNode[]) {
      const person = personOf(agent);
      if (person === null) continue;
      const webpage = asArray(agent['pgterms:webpage'])
        .map((value) => attrOf(value, 'rdf:resource'))
        .find((url) => url !== undefined && ENGLISH_WIKIPEDIA.test(url));
      authors.push({
        ...person,
        aliases: directTexts(agent['pgterms:alias']),
        webpage: webpage ?? null,
      });
    }
  }
  return authors;
}

/** Named direct MARC credits not covered by the editor and translator fields. */
function contributorsOf(ebook: XmlNode): Contributor[] {
  const contributors: Contributor[] = [];
  for (const tag in ebook) {
    if (!tag.startsWith('marcrel:') || tag === 'marcrel:trl' || tag === 'marcrel:edt') continue;
    const code = tag.slice('marcrel:'.length);
    const role = CONTRIBUTOR_ROLES.get(code) ?? code;
    for (const credit of asArray(ebook[tag])) {
      for (const agent of descendants(credit, 'pgterms:agent')) {
        const person = personOf(agent);
        if (person !== null) contributors.push({ ...person, role });
      }
    }
  }
  return contributors;
}

/** Remove subfield boundaries and a missing designator before an uppercase value. */
function sourceImprint(value: string | undefined): string | null {
  return (
    value
      ?.replace(/\$[a-z]|\$(?=\p{Lu})/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim() || null
  );
}

/** Every named agent under the given element tag, in document order. */
function peopleOf(ebook: unknown, tag: string): Person[] {
  const people: Person[] = [];
  for (const element of descendants(ebook, tag)) {
    const person = personOf(element);
    if (person !== null) people.push(person);
  }
  return people;
}

/**
 * Sorted unique `rdf:value` texts under the given element tag. Gutendex de-duplicates
 * subjects and bookshelves into a set and its serializer sorts them, so a mirror row
 * that skipped either step would order results differently from the live API.
 */
function sortedValues(elements: unknown[]): string[] {
  const values = new Set<string>();
  for (const element of elements) {
    const value = rdfValue(element);
    if (value !== undefined) values.add(value);
  }
  return [...values].sort();
}

/** Separate classification codes from subject headings as each subject is read. */
function subjectValues(ebook: XmlNode): { subjects: string[]; lcc: string[] } {
  const headings = new Set<string>();
  const codes = new Set<string>();
  for (const subject of descendants(ebook, 'dcterms:subject')) {
    const resource = attrOf(firstDescendant(subject, 'dcam:memberOf'), 'rdf:resource');
    if (resource !== LCSH_RESOURCE && resource !== LCC_RESOURCE) continue;
    const value = rdfValue(subject);
    if (value === undefined) continue;
    (resource === LCC_RESOURCE ? codes : headings).add(value);
  }
  return { subjects: [...headings].sort(), lcc: [...codes].sort() };
}

/**
 * The formats map, keyed by MIME type. First file wins, except that an already-stored
 * `noimages` URL is replaced by any later candidate — Gutendex's preference for the
 * illustrated edition of a format.
 */
function formatsOf(ebook: unknown): Record<string, string> {
  const formats: Record<string, string> = {};
  for (const file of descendants(ebook, 'pgterms:file')) {
    const mimeType = rdfValue(firstDescendant(file, 'dcterms:format'));
    const url = attrOf(file, 'rdf:about');
    if (mimeType === undefined || url === undefined) continue;
    const existing = formats[mimeType];
    if (existing === undefined || existing.includes('noimages')) formats[mimeType] = url;
  }
  return formats;
}

/**
 * Copyright status from the rights statement. Anything that is neither an explicit
 * public-domain nor an explicit copyright notice stays unknown rather than being
 * forced to a boolean.
 */
function copyrightOf(ebook: unknown): boolean | null {
  const rights = textOf(firstDescendant(ebook, 'dcterms:rights'));
  if (rights === undefined) return null;
  if (rights.startsWith(PUBLIC_DOMAIN_PREFIX)) return false;
  if (rights.startsWith(COPYRIGHTED_PREFIX)) return true;
  return null;
}

/**
 * Parse a per-book RDF document into a normalized book record.
 *
 * @param xml - Contents of one `pg<id>.rdf` file.
 * @param id - Gutenberg ID, taken from the archive path rather than the document so a
 *   record can never be filed under an ID the mirror did not ask for.
 * @returns The normalized book, or null when the document carries no `pgterms:ebook`
 *   element (a placeholder or truncated entry, which is skipped rather than stored).
 */
export function parseBookRdf(xml: string, id: number): Book | null {
  const parsed = parser.parse(xml) as XmlNode;
  const ebook = firstDescendant(parsed['rdf:RDF'], 'pgterms:ebook') as XmlNode | undefined;
  if (!ebook || typeof ebook !== 'object') return null;

  const title = textOf(firstDescendant(ebook, 'dcterms:title'));
  const summaries = descendants(ebook, 'pgterms:marc520')
    .map((entry) => textOf(entry))
    .filter((text): text is string => text !== undefined)
    .sort();
  const languages = descendants(ebook, 'dcterms:language')
    .map((entry) => rdfValue(entry))
    .filter((code): code is string => code !== undefined)
    .sort();

  /**
   * Assembled as a `RawBook` first so `has_plain_text` is computed by the same
   * `hasPlainText` the live path uses — one definition of readability, not two.
   */
  const authors = authorsOf(ebook);
  const { subjects, lcc } = subjectValues(ebook);
  const contents = textOf(asArray(ebook['dcterms:tableOfContents'])[0]);
  const raw = {
    id,
    /** A record with no `dcterms:title` is rare; the empty string keeps the field a string. */
    title: title === undefined ? '' : normalizeTitle(fixSubtitles(title)),
    authors,
    editors: peopleOf(ebook, 'marcrel:edt'),
    translators: peopleOf(ebook, 'marcrel:trl'),
    subjects,
    bookshelves: sortedValues(descendants(ebook, 'pgterms:bookshelf')),
    languages,
    copyright: copyrightOf(ebook),
    media_type: rdfValue(firstDescendant(ebook, 'dcterms:type')) ?? DEFAULT_MEDIA_TYPE,
    download_count: intOf(firstDescendant(ebook, 'pgterms:downloads')) ?? 0,
    summaries,
    formats: formatsOf(ebook),
  } satisfies Required<RawBook>;

  const source_notes = asArray(ebook['dcterms:description'])
    .map(textOf)
    .filter((text): text is string => text !== undefined);
  return {
    ...raw,
    alternative_titles: directTexts(ebook['dcterms:alternative']),
    contributors: contributorsOf(ebook),
    contents: contents?.trim() ? contents : null,
    release_date: textOf(asArray(ebook['dcterms:issued'])[0]) || null,
    reading_ease: textOf(asArray(ebook['pgterms:marc908'])[0]) || null,
    source_imprint: sourceImprint(textOf(asArray(ebook['pgterms:marc260'])[0])),
    lcc,
    summary: summaries[0] ?? null,
    has_plain_text: hasPlainText(raw),
    is_readable: isReadable(raw),
    source_notes,
  };
}
