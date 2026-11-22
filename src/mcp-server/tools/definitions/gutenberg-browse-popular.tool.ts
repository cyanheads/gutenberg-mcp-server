/**
 * @fileoverview Tool for browsing the most-downloaded Project Gutenberg books,
 * optionally filtered by language or topic.
 * @module mcp-server/tools/definitions/gutenberg-browse-popular
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';
import { normalizeSearchParams } from '@/services/gutendex/types.js';
import {
  catalogAsOfSchema,
  catalogProvenanceTrailer,
  discoveryAuthors,
  lccSchema,
  renderCatalogList,
} from '../catalog-output.js';
import {
  discoveryCriteria,
  discoveryFilters,
  discoveryNotice,
  LANGUAGE_CODE_MESSAGE,
} from '../discovery-criteria.js';

export const gutenbergBrowsePopular = tool('gutenberg_browse_popular', {
  title: 'Browse Popular Gutenberg Books',
  description:
    'Browse up to 32 Project Gutenberg books by downloads in the last 30 days at the source snapshot. Filter by language, topic, MIME prefix, copyright status, media type or Library of Congress Classification. Media type and classification filters require the local mirror. Truncated results include executable search continuation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    media_type: discoveryFilters.media_type,
    lcc: discoveryFilters.lcc,
    mime_type: discoveryFilters.mime_type,
    copyright: discoveryFilters.copyright,
    languages: z
      .array(z.string().min(2).max(3, LANGUAGE_CODE_MESSAGE))
      .optional()
      .describe(
        'Restrict to books in these catalog language codes, exactly as results report them ("en", not "eng"). Example: ["en"] for English only, ["de", "fr"] for German or French, ["ang"] for Old English. Omit for all languages.',
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
            media_type: z.string().describe('Catalog media type, such as "Text" or "Sound".'),
            lcc: lccSchema,
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
                'Eligible Text record with UTF-8 plain text, or HTML without audio formats. Does not guarantee the mirror file exists.',
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
    catalogSource: z.enum(['mirror', 'live']).describe('Catalog that answered.'),
    catalogAsOf: catalogAsOfSchema,
    effectiveCriteria: discoveryCriteria.describe(
      'Normalized browse criteria, including popular sort and first page.',
    ),
    notice: z.string().optional().describe('Guidance for empty or capped results.'),
    continuation: z
      .object({
        tool: z
          .literal('gutenberg_search_books')
          .describe('Tool to call for the remaining matching books.'),
        arguments: discoveryCriteria.describe(
          'Executable search arguments preserving all filters. Page 1 may repeat already shown books when the browse cap cuts a page.',
        ),
      })
      .optional()
      .describe('Present only when more matching books exist.'),
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

  /** Render criteria and executable continuation alongside the cap disclosure. */
  enrichmentTrailer: {
    ...catalogProvenanceTrailer,
    effectiveCriteria: {
      render: (value) =>
        markdown().text('Browse criteria: ').inlineCode(JSON.stringify(value)).build(),
    },
    continuation: {
      render: (value) =>
        value
          ? markdown()
              .text(`Continue with ${value.tool} `)
              .inlineCode(JSON.stringify(value.arguments))
              .text(
                '. Page 1 repeats the first page when the browse cap leaves unseen books on it.',
              )
              .build()
          : '',
    },
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
            'To page through the full result set, use the gutenberg_search_books continuation above.',
    },
  },

  errors: [
    {
      reason: 'filter_requires_mirror',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A media type or LCC filter was supplied while the local mirror could not answer.',
      recovery:
        'Remove the filter named in the error, or ask the server operator to initialize or repair the local catalog mirror.',
      thrownBy: 'service',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer, or returned an unreadable page, within the time this server allows for one browse.',
      recovery:
        'The catalog is unreachable or too slow right now. Retry later; if it keeps failing, the catalog service itself is degraded and a narrower filter will not help.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'catalog_rejected',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The live Project Gutenberg catalog refused the browse outright rather than failing temporarily.',
      recovery:
        'Repeating the browse will not help, and another filter is refused the same way. Ask the server operator to check the configured catalog address or initialize the local catalog mirror.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.signal.throwIfAborted();
    const criteria = normalizeSearchParams({
      languages: input.languages,
      topic: input.topic,
      mime_type: input.mime_type,
      copyright: input.copyright,
      media_type: input.media_type,
      lcc: input.lcc,
      sort: 'popular',
      page: 1,
    });
    ctx.enrich({ effectiveCriteria: discoveryCriteria.parse(criteria) });
    ctx.log.info('Browsing popular Gutenberg books', {
      languages: input.languages,
      topic: input.topic,
      limit: input.limit,
    });

    const result = await getGutendexService().searchBooks(criteria, ctx);
    if (result.source === 'mirror' || result.source === 'live')
      ctx.enrich({ catalogSource: result.source, catalogAsOf: result.catalogAsOf });

    const notice = await discoveryNotice(criteria, result, ctx);

    const appliedLimit = Math.min(input.limit, 32);
    const limited = result.books.slice(0, appliedLimit);

    if (result.totalCount > limited.length) {
      ctx.enrich({
        continuation: {
          tool: 'gutenberg_search_books',
          arguments: discoveryCriteria.parse({
            ...criteria,
            page: limited.length < result.books.length ? 1 : (result.page ?? 1) + 1,
          }),
        },
      });
      const ceiling = limited.at(-1)?.download_count;
      ctx.enrich.truncated({
        shown: limited.length,
        cap: appliedLimit,
        ...(ceiling !== undefined && { ceiling }),
        guidance: [
          notice,
          appliedLimit < 32
            ? 'The catalog holds more matches than shown. Raise limit (max 32) for a longer list, or use gutenberg_search_books to page through all results.'
            : 'The catalog holds more matches than shown. Use the gutenberg_search_books continuation to page through all results.',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else {
      // `truncated`, `shown`, and `cap` are required enrichment fields, and
      // `ctx.enrich.truncated(...)` writes `truncated: true` unconditionally — so
      // the complete case has to populate them through the loose call, or the
      // effective-output parse rejects an otherwise-valid response.
      ctx.enrich({ truncated: false, shown: limited.length, cap: appliedLimit });
      if (notice) ctx.enrich.notice(notice);
    }

    return {
      requestedLimit: input.limit,
      appliedLimit,
      books: limited.map((b) => ({
        id: b.id,
        title: b.title,
        authors: discoveryAuthors(b.authors),
        languages: b.languages,
        media_type: b.media_type,
        lcc: b.lcc,
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
                return `${escapeMarkdownInline(a.name)}${years}`;
              })
              .join(', ')
          : 'Unknown';
      lines.push(`${idx + 1}. **[${book.id}]** ${escapeMarkdownInline(book.title)} — ${authorStr}`);
      lines.push(
        `   Lang: ${book.languages.map(escapeMarkdownInline).join(', ')} | Downloads in the last 30 days (source snapshot): ${book.download_count.toLocaleString()} | Plain text: ${book.has_plain_text ? 'Yes' : 'No'} | Readable: ${book.is_readable ? 'Yes' : 'No'}`,
      );
      lines.push(
        `   Media: ${escapeMarkdownInline(book.media_type)} | LCC: ${renderCatalogList(book.lcc)}`,
      );
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
