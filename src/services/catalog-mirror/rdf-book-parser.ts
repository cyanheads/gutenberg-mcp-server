/**
 * @fileoverview Parses one Project Gutenberg per-book RDF/XML document into the
 * same normalized {@link Book} shape `GutendexService` produces from the Gutendex
 * JSON API, so a mirror-served record and a live-served record are interchangeable.
 *
 * The field mapping mirrors Gutendex's own RDF reader (`books/utils.py` +
 * `books/serializers.py` in garethbjohnson/gutendex), which is what populates the
 * live API this server falls back to. Every ordering, de-duplication, and default
 * below exists because Gutendex does the same thing — deviating would make the two
 * paths return different records for the same book.
 * @module services/catalog-mirror/rdf-book-parser
 */

import { XMLParser } from 'fast-xml-parser';
import { type Book, hasPlainText, type Person, type RawBook } from '@/services/gutendex/types.js';

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
  if (name === undefined) return null;
  return {
    name,
    birth_year: intOf(firstDescendant(element, 'pgterms:birthdate')),
    death_year: intOf(firstDescendant(element, 'pgterms:deathdate')),
  };
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
  const ebook = firstDescendant(parsed['rdf:RDF'], 'pgterms:ebook');
  if (ebook === undefined || typeof ebook !== 'object') return null;

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
  const raw: Required<RawBook> = {
    id,
    /** A record with no `dcterms:title` is rare; the empty string keeps the field a string. */
    title: title === undefined ? '' : fixSubtitles(title),
    authors: peopleOf(ebook, 'dcterms:creator'),
    editors: peopleOf(ebook, 'marcrel:edt'),
    translators: peopleOf(ebook, 'marcrel:trl'),
    subjects: sortedValues(
      descendants(ebook, 'dcterms:subject').filter(
        (subject) =>
          attrOf(firstDescendant(subject, 'dcam:memberOf'), 'rdf:resource') === LCSH_RESOURCE,
      ),
    ),
    bookshelves: sortedValues(descendants(ebook, 'pgterms:bookshelf')),
    languages,
    copyright: copyrightOf(ebook),
    media_type: rdfValue(firstDescendant(ebook, 'dcterms:type')) ?? DEFAULT_MEDIA_TYPE,
    download_count: intOf(firstDescendant(ebook, 'pgterms:downloads')) ?? 0,
    summaries,
    formats: formatsOf(ebook),
  };

  return { ...raw, summary: summaries[0] ?? null, has_plain_text: hasPlainText(raw) };
}
