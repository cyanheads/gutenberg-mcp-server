/**
 * @fileoverview Tool for searching the Project Gutenberg catalog by title, author,
 * topic, language, translator, author lifespan, or a specific list of IDs.
 * @module mcp-server/tools/definitions/gutenberg-search-books
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';
import { normalizeSearchParams } from '@/services/gutendex/types.js';
import {
  discoveryCriteria,
  discoveryFilters,
  withLanguageCodeHint,
} from '../discovery-criteria.js';

export const gutenbergSearchBooks = tool('gutenberg_search_books', {
  title: 'Search Gutenberg Books',
  description:
    'Search the Project Gutenberg catalog of 78,000+ books. Every query word matches a title or author substring; filter by topic, language, translator, author lifespan, IDs, MIME prefix or copyright status. More than four query words, and the translator filter, require the local mirror. Empty matches succeed with criteria and a notice. Default popularity uses downloads in the last 30 days at the source snapshot. Returns IDs, titles, authors, languages, subjects, counts, and is_readable — use gutenberg_get_book for full metadata.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    mime_type: discoveryFilters.mime_type,
    copyright: discoveryFilters.copyright,
    query: z
      .string()
      .optional()
      .describe(
        'Every nonblank whitespace-separated word must match title or author name as a case-insensitive literal substring. More than four words require the local mirror; live fallback rejects longer queries. Example: "dickens expectations" matches Great Expectations.',
      ),
    topic: z
      .string()
      .optional()
      .describe(
        'Case-insensitive phrase to match against subjects and bookshelves. Example: "detective" returns books on the "Detective and Mystery Stories" bookshelf. Separate from query — topic searches categorization metadata, not title/author.',
      ),
    translator: z
      .string()
      .optional()
      .describe(
        'Every nonblank whitespace-separated word must match a translator name as a case-insensitive literal substring; words can land on different translators of one book, and accents must match. Requires the local mirror. Example: "maude" finds the Aylmer and Louise Maude translations. Result rows omit translators; gutenberg_get_book reports them.',
      ),
    languages: z
      .array(z.string().min(2).max(3))
      .optional()
      .describe(
        'Filter to books in any of these catalog language codes, exactly as results report them ("en", not "eng"). Example: ["en"] for English, ["fr", "de"] for French or German, ["enm"] for Middle English.',
      ),
    author_year_start: z
      .number()
      .int()
      .optional()
      .describe(
        'Include only books with an author who has a known birth or death year on or after this year (positive = CE, negative = BCE). With author_year_end, one author must meet both bounds.',
      ),
    author_year_end: z
      .number()
      .int()
      .optional()
      .describe(
        'Include only books with an author who has a known birth or death year on or before this year. With author_year_start, one author must meet both bounds. Example: author_year_start=1800 with author_year_end=1899 returns books with 19th-century authors.',
      ),
    sort: z
      .enum(['popular', 'ascending', 'descending'])
      .default('popular')
      .describe(
        'Result ordering. "popular" (default) sorts by downloads in the last 30 days at the source snapshot, descending. "ascending" and "descending" sort by Gutenberg ID number.',
      ),
    ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Narrow results to these Gutenberg IDs, intersected with other filters. An empty list selects nothing; omit for unrestricted IDs. Use gutenberg_get_book for full single-ID metadata.',
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
            languages: z.array(z.string()).describe('Catalog language codes for this edition.'),
            subjects: z.array(z.string()).describe('Library of Congress subject headings.'),
            download_count: z
              .number()
              .describe('Downloads in the last 30 days at the source snapshot.'),
            has_plain_text: z
              .boolean()
              .describe(
                'True for Text records with UTF-8 plain text; HTML-only editions can still have is_readable=true.',
              ),
            is_readable: z
              .boolean()
              .describe(
                'True for non-Sound records with UTF-8 plain text or HTML supported by gutenberg_get_text.',
              ),
          })
          .describe('Book entry.'),
      )
      .describe('Matching books, ordered by the sort parameter.'),
    totalCount: z.number().describe('Total number of books matching the query across all pages.'),
    page: z.number().describe('Current page number.'),
    hasMore: z.boolean().describe('True if there are additional pages of results.'),
  }),

  enrichment: {
    effectiveCriteria: discoveryCriteria.describe(
      'Normalized search criteria, including sort and page defaults.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Actionable guidance for an empty selection, or a caveat that the live catalog checked author_year_start and author_year_end separately. The caveat can accompany results.',
      ),
  },
  enrichmentTrailer: {
    effectiveCriteria: {
      render: (value) =>
        markdown().text('Search criteria: ').inlineCode(JSON.stringify(value)).build(),
    },
  },

  errors: [
    {
      reason: 'translator_requires_mirror',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A translator filter was supplied while the local mirror could not answer.',
      recovery:
        'Remove the translator filter and read translators from gutenberg_get_book, or ask the server operator to initialize or repair the local catalog mirror.',
      thrownBy: 'service',
    },
    {
      reason: 'query_requires_mirror',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than four query words were supplied while the local mirror could not answer.',
      recovery:
        'Shorten the query to at most four words, or ask the server operator to initialize or repair the local catalog mirror.',
      thrownBy: 'service',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested page number is past the last page of results for this query.',
      recovery:
        'Request a page within the available range, or restart at page 1. The first page reports totalCount — divide it by the page size (32) to find the last page.',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer within the time this server allows for one search.',
      recovery:
        'The catalog is unreachable or too slow right now. Retry in a few seconds; if it keeps failing, the catalog service itself is degraded and a different query will not help.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.signal.throwIfAborted();
    const criteria = normalizeSearchParams(input);
    ctx.enrich({ effectiveCriteria: discoveryCriteria.parse(criteria) });
    ctx.log.info('Searching Gutenberg catalog', {
      query: input.query,
      topic: input.topic,
      translator: input.translator,
      languages: input.languages,
      page: input.page,
    });

    const result = await (input.ids?.length === 0
      ? Promise.resolve({
          books: [],
          totalCount: 0,
          hasMore: false,
          page: input.page,
          source: 'none' as const,
        })
      : getGutendexService().searchBooks(criteria, ctx)
    ).catch((err: unknown) => {
      // The service tags a page-beyond-range 404 with reason 'page_out_of_range';
      // surface it as a tool-level failure with recovery instead of the raw
      // upstream fetch error. Any other error bubbles unchanged.
      if (
        err instanceof McpError &&
        typeof err.data === 'object' &&
        err.data !== null &&
        (err.data as { reason?: unknown }).reason === 'page_out_of_range'
      ) {
        throw ctx.fail(
          'page_out_of_range',
          `Page ${input.page} is beyond the available results for this search.`,
          { ...ctx.recoveryFor('page_out_of_range') },
        );
      }
      throw err;
    });

    /** `notice` holds one value and the last write wins, so this call composes every sentence. */
    const notices: string[] = [];
    if (
      result.source === 'live' &&
      criteria.author_year_start !== undefined &&
      criteria.author_year_end !== undefined
    ) {
      notices.push(
        'The live catalog answered, so author_year_start and author_year_end were checked separately: one author can satisfy each bound.',
      );
    }
    if (result.books.length === 0) {
      notices.push(
        input.ids?.length === 0
          ? 'The empty ID selection selects no books. Supply one or more IDs, or omit ids to search the catalog.'
          : withLanguageCodeHint(
              'No books matched these criteria. Try fewer query words, a broader topic, or remove a filter.',
              criteria.languages,
            ),
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      books: result.books.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        languages: b.languages,
        subjects: b.subjects,
        download_count: b.download_count,
        has_plain_text: b.has_plain_text,
        is_readable: b.is_readable,
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
                return `${escapeMarkdownInline(a.name)}${years}`;
              })
              .join(', ')
          : 'Unknown';
      lines.push(`**[${book.id}]** ${escapeMarkdownInline(book.title)}`);
      lines.push(
        `  Authors: ${authorStr} | Lang: ${book.languages.map(escapeMarkdownInline).join(', ')} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()} | Plain text: ${book.has_plain_text ? 'Yes' : 'No'} | Readable: ${book.is_readable ? 'Yes' : 'No'}`,
      );
      // Unconditional: structuredContent carries `subjects: []` verbatim, so a
      // content[]-only client needs the empty case stated, not the line dropped.
      lines.push(
        `  Subjects: ${book.subjects.length > 0 ? escapeMarkdownInline(book.subjects.join('; ')) : 'None'}`,
      );
    }
    if (result.hasMore) {
      lines.push('');
      lines.push(`_More results available — use page=${result.page + 1} for the next page._`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
