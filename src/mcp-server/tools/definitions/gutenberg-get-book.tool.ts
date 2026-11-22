/**
 * @fileoverview Tool for fetching complete metadata for a single Project Gutenberg book
 * by its numeric ID, including the full formats map needed before fetching text.
 * @module mcp-server/tools/definitions/gutenberg-get-book
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';
import type { Person } from '@/services/gutendex/types.js';
import {
  catalogAsOfSchema,
  catalogProvenanceTrailer,
  lccSchema,
  renderCatalogList,
} from '../catalog-output.js';

/** Render a credited person's name and both lifespan bounds. */
function renderPerson(person: Person): string {
  const name = escapeMarkdownInline(person.name);
  return person.birth_year === null && person.death_year === null
    ? name
    : `${name} (${person.birth_year ?? '?'}–${person.death_year ?? '?'})`;
}

/**
 * Render a person list for `content[]`, stating an empty list explicitly so a
 * content[]-only client can tell "no editors" from "editors not reported".
 */
function renderPeople(people: readonly Person[]): string {
  return people.length ? people.map(renderPerson).join(', ') : 'None';
}

export const gutenbergGetBook = tool('gutenberg_get_book', {
  title: 'Get Gutenberg Book',
  description:
    'Fetch Project Gutenberg metadata by book ID: titles, author names and aliases, translators, editors, contributor credits, edition notes, release date, imprint, reading ease, table of contents, subjects, classification, and available formats. Use is_readable before gutenberg_get_text.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .number()
      .int()
      .positive()
      .describe(
        'Project Gutenberg book ID. Visible in Gutenberg URLs (e.g., gutenberg.org/ebooks/1342) and returned by gutenberg_search_books and gutenberg_browse_popular. Example: 1342 for Pride and Prejudice, 2600 for War and Peace.',
      ),
  }),

  output: z.object({
    id: z.number().describe('Gutenberg ID.'),
    title: z.string().describe('Book title.'),
    alternative_titles: z
      .array(z.string())
      .nullable()
      .describe(
        'Alternative titles in catalog order. [] means none in the RDF; null means unavailable.',
      ),
    authors: z
      .array(
        z
          .object({
            name: z.string().describe('Author name in "Last, First" format.'),
            birth_year: z.number().nullable().describe('Birth year, or null if unknown.'),
            death_year: z
              .number()
              .nullable()
              .describe('Death year, or null if unknown or still living.'),
            aliases: z
              .array(z.string())
              .nullable()
              .describe(
                'Catalog aliases in order. [] means none in the RDF; null means unavailable.',
              ),
            webpage: z
              .string()
              .nullable()
              .describe('English Wikipedia page supplied by the catalog, or null.'),
          })
          .describe('Author entry.'),
      )
      .describe('Primary author(s).'),
    translators: z
      .array(
        z
          .object({
            name: z.string().describe('Translator name.'),
            birth_year: z.number().nullable().describe('Birth year, or null if unknown.'),
            death_year: z.number().nullable().describe('Death year, or null if unknown.'),
          })
          .describe('Translator entry.'),
      )
      .describe('Translators, if this is a translated work.'),
    editors: z
      .array(
        z
          .object({
            name: z.string().describe('Editor name.'),
            birth_year: z.number().nullable().describe('Birth year, or null if unknown.'),
            death_year: z.number().nullable().describe('Death year, or null if unknown.'),
          })
          .describe('Editor entry.'),
      )
      .describe('Editors, if any.'),
    contributors: z
      .array(
        z
          .object({
            name: z.string().describe('Contributor name.'),
            role: z.string().describe('MARC relator label, or the catalog code when unmapped.'),
            birth_year: z.number().nullable().describe('Birth year, or null if unknown.'),
            death_year: z
              .number()
              .nullable()
              .describe('Death year, or null if unknown or still living.'),
          })
          .describe('Contributor credit.'),
      )
      .nullable()
      .describe(
        'Source credits beyond authors, editors and translators. [] means none in the RDF; null means unavailable.',
      ),
    subjects: z.array(z.string()).describe('Library of Congress subject headings.'),
    lcc: lccSchema,
    bookshelves: z
      .array(z.string())
      .describe(
        'Project Gutenberg bookshelf categories (e.g., "Best Books Ever Listings", "Category: Classics of Literature").',
      ),
    languages: z.array(z.string()).describe('Catalog language codes for this edition.'),
    copyright: z
      .boolean()
      .nullable()
      .describe(
        'Copyright status: false = public domain in the USA, true = under copyright, null = unknown.',
      ),
    media_type: z
      .string()
      .describe(
        'Source media type, such as "Text" or "Sound" (audio). Use is_readable to check reader support.',
      ),
    download_count: z
      .number()
      .describe(
        'Downloads in the last 30 days at the source snapshot, used for popularity ranking.',
      ),
    source_notes: z
      .array(z.string())
      .nullable()
      .describe(
        'Source-provided RDF bibliographic notes in document order, including explicit edition references. [] means inspected with no notes; null means unavailable from this source.',
      ),
    release_date: z
      .string()
      .nullable()
      .describe('Project Gutenberg ebook release date (YYYY-MM-DD), or null if unavailable.'),
    source_imprint: z
      .string()
      .nullable()
      .describe('Catalog imprint statement, or null if unavailable.'),
    reading_ease: z
      .string()
      .nullable()
      .describe('Catalog reading-ease note, or null if unavailable.'),
    contents: z
      .string()
      .nullable()
      .describe('Catalog table of contents with source line breaks, or null if unavailable.'),
    is_readable: z
      .boolean()
      .describe(
        'Eligible Text record with UTF-8 plain text, or HTML without audio formats. Does not guarantee the mirror file exists.',
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        'First entry of summaries, not necessarily primary, or null when the source has none.',
      ),
    summaries: z
      .array(z.string())
      .describe('Every source-provided summary, sorted. Empty when there are none.'),
    formats: z
      .record(z.string(), z.string())
      .describe(
        'Map of MIME type to download URL. Key types: "text/plain; charset=utf-8" (preferred for gutenberg_get_text), "text/html", "application/epub+zip", "image/jpeg" (cover). Not every format is present for every book.',
      ),
    has_plain_text: z
      .boolean()
      .describe(
        'True if media_type is "Text" and "text/plain; charset=utf-8" is present. HTML-only editions can still have is_readable=true.',
      ),
  }),

  enrichment: {
    catalogSource: z
      .enum(['mirror', 'rdf'])
      .describe('Catalog that answered: local mirror or per-book RDF.'),
    catalogAsOf: catalogAsOfSchema,
  },
  enrichmentTrailer: catalogProvenanceTrailer,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery:
        'Verify the ID with gutenberg_search_books. Gutenberg IDs are positive integers; this ID does not match any entry in the catalog.',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer, or returned an unreadable record, within the time this server allows for one lookup.',
      recovery:
        'The catalog is unreachable or too slow right now. Retry later; if it keeps failing, the catalog service itself is degraded and another ID will fail the same way.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'catalog_rejected',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The Project Gutenberg catalog refused the lookup outright rather than failing temporarily.',
      recovery:
        'Repeating the lookup will not help. If other IDs are refused the same way, ask the server operator to check the configured content mirror.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching book metadata', { id: input.id });

    const { book, source, catalogAsOf } = await getGutendexService()
      .getBookWithProvenance(input.id, ctx)
      .catch((err: unknown) => {
        // The service throws a raw NotFound for a missing ID; re-throw through
        // ctx.fail so the declared not_found recovery hint reaches both the
        // content[] text and structuredContent.error.data.recovery.hint.
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail('not_found', `No book found with Gutenberg ID ${input.id}.`, {
            ...ctx.recoveryFor('not_found'),
          });
        }
        throw err;
      });
    ctx.enrich({ catalogSource: source, catalogAsOf });

    return {
      id: book.id,
      title: book.title,
      alternative_titles: book.alternative_titles,
      authors: book.authors,
      translators: book.translators,
      editors: book.editors,
      contributors: book.contributors,
      subjects: book.subjects,
      lcc: book.lcc,
      bookshelves: book.bookshelves,
      languages: book.languages,
      copyright: book.copyright,
      media_type: book.media_type,
      download_count: book.download_count,
      summary: book.summary,
      summaries: book.summaries,
      formats: book.formats,
      has_plain_text: book.has_plain_text,
      is_readable: book.is_readable,
      source_notes: book.source_notes,
      release_date: book.release_date,
      source_imprint: book.source_imprint,
      reading_ease: book.reading_ease,
      contents: book.contents,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`# ${escapeMarkdownInline(result.title)}`);
    lines.push(
      `**ID:** ${result.id} | **Media:** ${escapeMarkdownInline(result.media_type)} | **Downloads in the last 30 days (source snapshot):** ${result.download_count.toLocaleString()}`,
    );

    lines.push(`**Authors:** ${renderPeople(result.authors)}`);
    for (const [index, author] of result.authors.entries()) {
      const webpage =
        author.webpage === null ? 'Not available' : markdownLink(author.webpage, author.webpage);
      lines.push(
        `**Author ${index + 1} aliases:** ${renderCatalogList(author.aliases)} | Webpage: ${webpage}`,
      );
    }
    lines.push(`**Translators:** ${renderPeople(result.translators)}`);
    lines.push(`**Editors:** ${renderPeople(result.editors)}`);
    if (result.contributors?.length) {
      lines.push('**Contributors:**');
      for (const contributor of result.contributors)
        lines.push(
          `  - ${renderPerson(contributor)} | Role: ${escapeMarkdownInline(contributor.role)}`,
        );
      lines.push('');
    } else {
      lines.push(`**Contributors:** ${result.contributors === null ? 'Not available' : 'None'}`);
    }
    lines.push(`**Alternative titles:** ${renderCatalogList(result.alternative_titles)}`);

    lines.push(
      `**Languages:** ${result.languages.map(escapeMarkdownInline).join(', ')} | **Copyright:** ${result.copyright === false ? 'Public Domain (USA)' : result.copyright === true ? 'Under Copyright' : 'Unknown'}`,
    );

    lines.push(`**Subjects:** ${renderCatalogList(result.subjects)}`);
    lines.push(`**LCC:** ${renderCatalogList(result.lcc)}`);
    lines.push(`**Bookshelves:** ${renderCatalogList(result.bookshelves)}`);
    lines.push(`**Release date:** ${escapeMarkdownInline(result.release_date ?? 'Not available')}`);
    lines.push(
      `**Source imprint:** ${escapeMarkdownInline(result.source_imprint ?? 'Not available')}`,
    );
    lines.push(`**Reading ease:** ${escapeMarkdownInline(result.reading_ease ?? 'Not available')}`);

    lines.push('');
    lines.push(
      `**Summary:** ${result.summary === null ? 'Not available' : escapeMarkdownInline(result.summary)}`,
    );
    /**
     * A fence rather than an escape: most notes hold a URL an agent may copy, and
     * escaping would put a backslash inside it on thousands of books.
     */
    if (result.source_notes?.length) {
      lines.push('**Source notes:**');
      lines.push(markdown().codeBlock(result.source_notes.join('\n'), 'text').build());
    } else {
      lines.push(`**Source notes:** ${result.source_notes ? 'None' : 'Not available'}`);
    }

    /**
     * `summary` is already the first entry of `summaries`; repeating it would
     * double a multi-hundred-character paragraph on the common single-summary
     * record. Listing only the remainder keeps content[] lossless against
     * structuredContent without that cost.
     */
    const additionalSummaries = result.summaries.filter((s) => s !== result.summary);
    if (additionalSummaries.length > 0) {
      lines.push(`**Additional summaries (${additionalSummaries.length}):**`);
      for (const [idx, summary] of additionalSummaries.entries()) {
        lines.push(`  ${idx + 1}. ${escapeMarkdownInline(summary)}`);
      }
    } else {
      lines.push('**Additional summaries:** None');
    }

    lines.push('');
    if (result.contents === null) {
      lines.push('**Contents:** Not available');
    } else {
      lines.push('**Contents:**');
      lines.push(markdown().codeBlock(result.contents.replace(/\r\n?/g, '\n'), 'text').build());
    }

    lines.push('');
    lines.push(
      `**Plain text available:** ${result.has_plain_text ? 'Yes' : 'No'} | Readable: ${result.is_readable ? 'Yes — use gutenberg_get_text' : 'No'}`,
    );

    lines.push('');
    const formats = Object.entries(result.formats);
    if (formats.length > 0) {
      lines.push('**Formats:**');
      for (const [mime, url] of formats) {
        lines.push(`  - ${markdownLink(mime, url)}`);
      }
    } else {
      lines.push('**Formats:** None');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
