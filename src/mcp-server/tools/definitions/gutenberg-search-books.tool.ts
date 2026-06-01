/**
 * @fileoverview Tool for searching the Project Gutenberg catalog by title, author,
 * topic, language, author lifespan, or a specific list of IDs.
 * @module mcp-server/tools/definitions/gutenberg-search-books
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';

export const gutenbergSearchBooks = tool('gutenberg_search_books', {
  title: 'Search Gutenberg Books',
  description:
    'Search the Project Gutenberg catalog of 78,000+ public-domain books. Matches title and ' +
    'author name with query words; filters by topic (subject or bookshelf keyword), language, ' +
    'author lifespan, or a specific list of Gutenberg IDs. Results are ordered by popularity ' +
    '(download count) by default. Returns book ID, title, authors, languages, subjects, and ' +
    'download count — use gutenberg_get_book for the full formats map before fetching text.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Words to match against book titles and author names (case-insensitive, space-separated). Example: "dickens expectations" matches Great Expectations by Charles Dickens.',
      ),
    topic: z
      .string()
      .optional()
      .describe(
        'Case-insensitive phrase to match against subjects and bookshelves. Example: "detective" returns books on the "Detective and Mystery Stories" bookshelf. Separate from query — topic searches categorization metadata, not title/author.',
      ),
    languages: z
      .array(z.string().min(2).max(2))
      .optional()
      .describe(
        'Filter to books in any of these two-character ISO 639-1 language codes. Example: ["en"] for English, ["fr", "de"] for French or German.',
      ),
    author_year_start: z
      .number()
      .int()
      .optional()
      .describe(
        'Include only books with at least one author alive on or after this year (positive = CE, negative = BCE). Combine with author_year_end for a range.',
      ),
    author_year_end: z
      .number()
      .int()
      .optional()
      .describe(
        'Include only books with at least one author alive on or before this year. Example: author_year_start=1800 with author_year_end=1899 returns books with 19th-century authors.',
      ),
    sort: z
      .enum(['popular', 'ascending', 'descending'])
      .default('popular')
      .describe(
        'Result ordering. "popular" (default) sorts by download count descending. "ascending" and "descending" sort by Gutenberg ID number.',
      ),
    ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Narrow results to specific Gutenberg ID numbers. Other filters still apply. Useful for batch pre-fetching known IDs; use gutenberg_get_book for single-ID lookups.',
      ),
    page: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe(
        'Page number for paginated results (1-indexed). Each page returns up to 32 books. Use totalCount to determine total pages.',
      ),
  }),

  output: z.object({
    books: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe(
                'Gutenberg ID — pass to gutenberg_get_book for the full record or gutenberg_get_text to read the book.',
              ),
            title: z.string().describe('Book title.'),
            authors: z
              .array(
                z
                  .object({
                    name: z.string().describe('Author name in "Last, First" format.'),
                    birth_year: z
                      .number()
                      .nullable()
                      .describe('Author birth year, or null if unknown.'),
                    death_year: z
                      .number()
                      .nullable()
                      .describe('Author death year, or null if unknown or still living.'),
                  })
                  .describe('Author entry.'),
              )
              .describe('Author(s) of the work.'),
            languages: z
              .array(z.string())
              .describe('Two-character language codes for this edition.'),
            subjects: z.array(z.string()).describe('Library of Congress subject headings.'),
            download_count: z
              .number()
              .describe(
                'Total downloads from Project Gutenberg — a real popularity signal reflecting actual reader interest.',
              ),
            has_plain_text: z
              .boolean()
              .describe(
                'True if the book has media_type "Text" AND a text/plain format available — prerequisite for gutenberg_get_text.',
              ),
          })
          .describe('Book entry.'),
      )
      .describe('Matching books, ordered by the sort parameter.'),
    totalCount: z.number().describe('Total number of books matching the query across all pages.'),
    page: z.number().describe('Current page number.'),
    hasMore: z.boolean().describe('True if there are additional pages of results.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query matched no books in the catalog.',
      recovery:
        'Broaden the search — try fewer or different query words, remove language filters, or check the topic spelling.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Searching Gutenberg catalog', {
      query: input.query,
      topic: input.topic,
      languages: input.languages,
      page: input.page,
    });

    const result = await getGutendexService().searchBooks(
      {
        query: input.query,
        topic: input.topic,
        languages: input.languages?.length ? input.languages : undefined,
        author_year_start: input.author_year_start,
        author_year_end: input.author_year_end,
        sort: input.sort,
        ids: input.ids?.length ? input.ids : undefined,
        page: input.page,
      },
      ctx,
    );

    if (result.books.length === 0) {
      throw ctx.fail('no_results', 'No books matched the search criteria.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    return {
      books: result.books.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        languages: b.languages,
        subjects: b.subjects,
        download_count: b.download_count,
        has_plain_text: b.has_plain_text,
      })),
      totalCount: result.totalCount,
      page: result.page,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**${result.totalCount.toLocaleString()} books found** (page ${result.page}${result.hasMore ? ', more available' : ''})`,
    );
    lines.push('');
    for (const book of result.books) {
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
      lines.push(`**[${book.id}]** ${book.title}`);
      lines.push(
        `  Authors: ${authorStr} | Lang: ${book.languages.join(', ')} | Downloads: ${book.download_count.toLocaleString()} | Text: ${book.has_plain_text ? 'Yes' : 'No'}`,
      );
      if (book.subjects.length > 0) {
        lines.push(
          `  Subjects: ${book.subjects.slice(0, 3).join('; ')}${book.subjects.length > 3 ? '…' : ''}`,
        );
      }
    }
    if (result.hasMore) {
      lines.push('');
      lines.push(`_More results available — use page=${result.page + 1} for the next page._`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
