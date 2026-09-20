/**
 * @fileoverview Tool for fetching complete metadata for a single Project Gutenberg book
 * by its numeric ID, including the full formats map needed before fetching text.
 * @module mcp-server/tools/definitions/gutenberg-get-book
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';

/**
 * Render a person list for `content[]`, stating an empty list explicitly so a
 * content[]-only client can tell "no editors" from "editors not reported".
 */
function renderPeople(
  people: readonly { name: string; birth_year: number | null; death_year: number | null }[],
): string {
  if (people.length === 0) return 'None';
  return people
    .map((p) => {
      const years =
        p.birth_year != null || p.death_year != null
          ? ` (${p.birth_year ?? '?'}–${p.death_year ?? '?'})`
          : '';
      return `${p.name}${years}`;
    })
    .join(', ');
}

export const gutenbergGetBook = tool('gutenberg_get_book', {
  title: 'Get Gutenberg Book',
  description:
    'Fetch complete metadata for a Project Gutenberg book by ID — title, authors (with birth/death years), translators, editors, subjects, bookshelves, languages, copyright status, and the full formats map with download URLs for each available format (plain text, HTML, EPUB, cover image, etc.). Use this before gutenberg_get_text to confirm a plain-text format is available and to get the direct download URL.',
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
    subjects: z.array(z.string()).describe('Library of Congress subject headings.'),
    bookshelves: z
      .array(z.string())
      .describe(
        'Project Gutenberg bookshelf categories (e.g., "Best Books Ever Listings", "Category: Classics of Literature").',
      ),
    languages: z.array(z.string()).describe('Two-character language codes for this edition.'),
    copyright: z
      .boolean()
      .nullable()
      .describe(
        'Copyright status: false = public domain in the USA, true = under copyright, null = unknown.',
      ),
    media_type: z
      .string()
      .describe(
        '"Text" for readable books, "Sound" for audio books. Only "Text" books have plain-text content available for gutenberg_get_text.',
      ),
    download_count: z.number().describe('Total downloads — popularity signal.'),
    summary: z
      .string()
      .nullable()
      .describe(
        'First entry of summaries — the primary auto-generated summary of the work, or null when Gutendex has none.',
      ),
    summaries: z
      .array(z.string())
      .describe(
        'Every summary Gutendex holds for this work, in upstream order. Usually one; some records carry a long and a short variant. Empty when there are none.',
      ),
    formats: z
      .record(z.string(), z.string())
      .describe(
        'Map of MIME type to download URL. Key types: "text/plain; charset=utf-8" (preferred for gutenberg_get_text), "text/html", "application/epub+zip", "image/jpeg" (cover). Not every format is present for every book.',
      ),
    has_plain_text: z
      .boolean()
      .describe(
        'True if media_type is "Text" AND a UTF-8 text/plain format ("text/plain; charset=utf-8") is present in formats — prerequisite for gutenberg_get_text.',
      ),
  }),

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
      when: 'The Project Gutenberg catalog did not answer within the time this server allows for one lookup.',
      recovery:
        'The catalog is unreachable or too slow right now. Retry in a few seconds; if it keeps failing, the catalog service itself is degraded and another ID will fail the same way.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching book metadata', { id: input.id });

    const book = await getGutendexService()
      .getBook(input.id, ctx)
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

    return {
      id: book.id,
      title: book.title,
      authors: book.authors,
      translators: book.translators,
      editors: book.editors,
      subjects: book.subjects,
      bookshelves: book.bookshelves,
      languages: book.languages,
      copyright: book.copyright,
      media_type: book.media_type,
      download_count: book.download_count,
      summary: book.summary,
      summaries: book.summaries,
      formats: book.formats,
      has_plain_text: book.has_plain_text,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`# ${result.title}`);
    lines.push(
      `**ID:** ${result.id} | **Media:** ${result.media_type} | **Downloads:** ${result.download_count.toLocaleString()}`,
    );

    lines.push(`**Authors:** ${renderPeople(result.authors)}`);
    lines.push(`**Translators:** ${renderPeople(result.translators)}`);
    lines.push(`**Editors:** ${renderPeople(result.editors)}`);

    lines.push(
      `**Languages:** ${result.languages.join(', ')} | **Copyright:** ${result.copyright === false ? 'Public Domain (USA)' : result.copyright === true ? 'Under Copyright' : 'Unknown'}`,
    );

    lines.push(`**Subjects:** ${result.subjects.length > 0 ? result.subjects.join('; ') : 'None'}`);
    lines.push(
      `**Bookshelves:** ${result.bookshelves.length > 0 ? result.bookshelves.join('; ') : 'None'}`,
    );

    lines.push('');
    lines.push(`**Summary:** ${result.summary ?? 'Not available'}`);

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
        lines.push(`  ${idx + 1}. ${summary}`);
      }
    } else {
      lines.push('**Additional summaries:** None');
    }

    lines.push('');
    lines.push(
      `**Plain text available:** ${result.has_plain_text ? 'Yes — use gutenberg_get_text' : 'No'}`,
    );

    lines.push('');
    lines.push('**Formats:**');
    for (const [mime, url] of Object.entries(result.formats)) {
      lines.push(`  - \`${mime}\`: ${url}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
