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
    'Browse Project Gutenberg books ordered by downloads in the last 30 days at the source snapshot. Returns up to 32 titles with IDs, authors, languages, download counts, and is_readable. Optionally filter by language or topic. Use this for discovery — "what are the most popular classics in French?" — or to check that the catalog is reachable.',
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
      .default(20)
      .describe(
        'Requested number of books. Default 20; requests above 32 are capped locally at 32.',
      ),
  }),

  output: z.object({
    requestedLimit: z.number().describe('Positive integral book limit requested before capping.'),
    appliedLimit: z.number().describe('Book limit applied locally, at most 32.'),
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
              .describe(
                'Downloads in the last 30 days at the source snapshot — the popularity ranking basis.',
              ),
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
      .describe(
        'Top books by downloads in the last 30 days at the source snapshot, most popular first.',
      ),
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
        'Downloads in the last 30 days at the source snapshot for the least-popular book shown; omitted books have at most this count.',
      ),
  },

  // Presentation for the enrichment block's content[] trailer. Without these,
  // the four scalar fields render as a disconnected `**key:** value` dump and the
  // retrieval pointer (routed through the undeclared `notice` field) is stripped
  // before it reaches content[]. Per-field renders compose a readable disclosure
  // that content[]-only clients (e.g. Claude Desktop) see alongside format().
  enrichmentTrailer: {
    truncated: {
      // The framework renders a trailer line for every key present in the
      // enrichment store, so this fires on complete results too — branch on the
      // value rather than always claiming truncation.
      render: (value) =>
        value
          ? 'Truncated — the catalog holds more matching books than are shown here.'
          : 'Complete — every matching book in the catalog is shown here.',
    },
    shown: {
      render: (value) =>
        `Returned the top ${value} by downloads in the last 30 days (source snapshot).`,
    },
    cap: {
      render: (value) => `Applied cap: ${value} (max 32 per call).`,
    },
    truncationCeiling: {
      render: (value) =>
        value === undefined
          ? ''
          : `The least-popular book shown has ${value.toLocaleString()} downloads in the last 30 days (source snapshot); omitted books have at most this count. ` +
            'To page through the full result set, call gutenberg_search_books with the same language/topic ' +
            'filters, sort="popular", and successive page values.',
    },
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No books match the language/topic filter combination.',
      recovery:
        'Try a broader topic phrase or remove the language filter. The catalog is large but topic matching is phrase-based — "detective fiction" may miss books shelved under "Mystery".',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer within the time this server allows for one browse.',
      recovery:
        'The catalog is unreachable or too slow right now. Retry in a few seconds; if it keeps failing, the catalog service itself is degraded and a narrower filter will not help.',
      retryable: true,
      thrownBy: 'service',
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
      throw ctx.fail('no_results', 'No books matched the filter criteria.');
    }

    const appliedLimit = Math.min(input.limit, 32);
    const limited = result.books.slice(0, appliedLimit);

    if (result.totalCount > limited.length) {
      const ceiling = limited.at(-1)?.download_count;
      ctx.enrich.truncated({
        shown: limited.length,
        cap: appliedLimit,
        ...(ceiling !== undefined && { ceiling }),
        guidance:
          'The catalog holds more matches than shown. Raise limit (max 32) for a longer list, or use gutenberg_search_books to page through all results.',
      });
    } else {
      // `truncated`, `shown`, and `cap` are required enrichment fields, and
      // `ctx.enrich.truncated(...)` writes `truncated: true` unconditionally — so
      // the complete case has to populate them through the loose call, or the
      // effective-output parse rejects an otherwise-valid response.
      ctx.enrich({ truncated: false, shown: limited.length, cap: appliedLimit });
    }

    return {
      requestedLimit: input.limit,
      appliedLimit,
      books: limited.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        languages: b.languages,
        download_count: b.download_count,
        has_plain_text: b.has_plain_text,
        is_readable: b.is_readable,
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

    lines.push(
      `Requested limit: ${result.requestedLimit.toLocaleString()} | Applied limit: ${result.appliedLimit.toLocaleString()}`,
    );

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
        `   Lang: ${book.languages.join(', ')} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()} | Plain text: ${book.has_plain_text ? 'Yes' : 'No'} | Readable: ${book.is_readable ? 'Yes' : 'No'}`,
      );
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
