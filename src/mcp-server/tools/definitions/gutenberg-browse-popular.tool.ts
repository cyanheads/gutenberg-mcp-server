/**
 * @fileoverview Tool for browsing the most-downloaded Project Gutenberg books,
 * optionally filtered by language or topic.
 * @module mcp-server/tools/definitions/gutenberg-browse-popular
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';

export const gutenbergBrowsePopular = tool('gutenberg_browse_popular', {
  title: 'Browse Popular Gutenberg Books',
  description:
    'Browse the most-downloaded Project Gutenberg books, ordered by popularity. Returns up to ' +
    '32 titles with their Gutenberg IDs, authors, languages, and download counts. Optionally ' +
    'filter by language or topic. Use this as a discovery entry point — "what are the most ' +
    'popular classics in French?" — or as a heartbeat check that the catalog is reachable.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    languages: z
      .array(z.string().min(2).max(2))
      .optional()
      .describe(
        'Restrict to books in these languages (two-character ISO 639-1 codes). Example: ["en"] for English only, ["de", "fr"] for German or French. Omit for all languages.',
      ),
    topic: z
      .string()
      .optional()
      .describe(
        'Filter by a subject or bookshelf keyword (case-insensitive phrase match). Example: "science fiction", "adventure", "detective". Applies on top of the language filter.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(20)
      .describe(
        'Number of books to return (1–32). Default 20 gives a useful overview without overwhelming context.',
      ),
  }),

  output: z.object({
    books: z
      .array(
        z
          .object({
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
              .describe('Author(s).'),
            languages: z.array(z.string()).describe('Language codes.'),
            download_count: z
              .number()
              .describe('Total downloads — the basis for the popularity ranking.'),
            has_plain_text: z
              .boolean()
              .describe(
                'True if media_type is "Text" AND a text/plain format is available via gutenberg_get_text.',
              ),
          })
          .describe('Book entry.'),
      )
      .describe('Top books by download count, most popular first.'),
    totalInCatalog: z
      .number()
      .describe(
        'Total books matching the filter in the full catalog (useful for context — "top 20 of 60,000").',
      ),
  }),

  enrichment: {
    truncated: z.boolean().describe('True when the catalog held more matches than were returned.'),
    shown: z.number().describe('Number of books returned in this response.'),
    cap: z.number().describe('The limit that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Download count of the least-popular book shown — omitted books have at most this many downloads.',
      ),
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No books match the language/topic filter combination.',
      recovery:
        'Try a broader topic phrase or remove the language filter. The catalog is large but topic matching is phrase-based — "detective fiction" may miss books shelved under "Mystery".',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Browsing popular Gutenberg books', {
      languages: input.languages,
      topic: input.topic,
      limit: input.limit,
    });

    const result = await getGutendexService().searchBooks(
      {
        sort: 'popular',
        languages: input.languages?.length ? input.languages : undefined,
        topic: input.topic,
      },
      ctx,
    );

    if (result.books.length === 0) {
      throw ctx.fail('no_results', 'No books matched the filter criteria.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    const limited = result.books.slice(0, input.limit);

    if (result.totalCount > limited.length) {
      const ceiling = limited.at(-1)?.download_count;
      ctx.enrich.truncated({
        shown: limited.length,
        cap: input.limit,
        ...(ceiling !== undefined && { ceiling }),
        guidance:
          'The catalog holds more matches than shown. Raise limit (max 32) for a longer list, or use gutenberg_search_books to page through all results.',
      });
    }

    return {
      books: limited.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        languages: b.languages,
        download_count: b.download_count,
        has_plain_text: b.has_plain_text,
      })),
      totalInCatalog: result.totalCount,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Top ${result.books.length} of ${result.totalInCatalog.toLocaleString()} books in catalog**`,
    );
    lines.push('');

    result.books.forEach((book, idx) => {
      const authorStr =
        book.authors.length > 0
          ? book.authors
              .map((a) => {
                const years =
                  a.birth_year != null || a.death_year != null
                    ? ` (${a.birth_year ?? '?'}–${a.death_year ?? '?'})`
                    : '';
                return `${a.name}${years}`;
              })
              .join(', ')
          : 'Unknown';
      lines.push(`${idx + 1}. **[${book.id}]** ${book.title} — ${authorStr}`);
      lines.push(
        `   Lang: ${book.languages.join(', ')} | Downloads: ${book.download_count.toLocaleString()} | Text: ${book.has_plain_text ? 'Yes' : 'No'}`,
      );
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
