/**
 * @fileoverview Shared discovery criteria for filter echo and executable continuation.
 * @module mcp-server/tools/discovery-criteria
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';
import type { SearchParams } from '@/services/gutendex/types.js';

/** Actionable item-length error without changing the advertised language schema. */
export const LANGUAGE_CODE_MESSAGE =
  'Use a catalog language code such as "en" or "fr". Pass several codes as separate items.';

/** Filters shared by search, browse, criteria echo and continuation arguments. */
export const discoveryFilters = {
  languages: z
    .array(z.string().min(2).max(3, LANGUAGE_CODE_MESSAGE))
    .optional()
    .describe('Any listed two- or three-letter catalog language code; empty means all languages.'),
  topic: z
    .string()
    .optional()
    .describe(
      'Phrase in a subject or bookshelf, ignoring case and, on the local mirror, accents; blank means unset.',
    ),
  mime_type: z
    .string()
    .optional()
    .describe(
      'Literal prefix of a format MIME key, such as "text/plain" or "application/pdf". Type and subtype casing is normalized; parameter suffixes retain literal case. Blank means unset.',
    ),
  copyright: z
    .array(z.enum(['true', 'false', 'null']))
    .optional()
    .describe(
      'Any selected source copyright status: "true" copyrighted, "false" public domain in the USA, "null" unknown. Empty means all statuses; this is not worldwide legal clearance.',
    ),
};

/** Effective catalog search arguments, including defaults. */
export const discoveryCriteria = z.object({
  ...discoveryFilters,
  query: z
    .string()
    .optional()
    .describe(
      'Every nonblank word must occur in the title or an author name as a literal substring. The local mirror ignores case and accents; live matching is upstream-defined. More than four words require the local mirror. Whitespace separates words.',
    ),
  translator: z
    .string()
    .optional()
    .describe(
      'Every nonblank word must occur in a translator name as a literal substring, ignoring case and accents. Requires the local mirror. Whitespace separates words.',
    ),
  ids: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Restrict to these Gutenberg IDs, intersected with other filters. An empty list selects nothing; omit for unrestricted IDs.',
    ),
  author_year_start: z
    .number()
    .int()
    .optional()
    .describe(
      'An author has a known birth or death year on or after this year (CE positive, BCE negative). With author_year_end, one author must meet both bounds.',
    ),
  author_year_end: z
    .number()
    .int()
    .optional()
    .describe(
      'An author has a known birth or death year on or before this year (CE positive, BCE negative). With author_year_start, one author must meet both bounds.',
    ),
  sort: z
    .enum(['popular', 'ascending', 'descending'])
    .default('popular')
    .describe(
      'Popular orders by source-snapshot downloads in the last 30 days, with ID tie-breaks locally; ascending and descending order by Gutenberg ID.',
    ),
  page: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe('One-indexed page of at most 32 matches. Pages beyond the result range are errors.'),
});

/** Compose discovery guidance once from the supplied criteria and the source that answered. */
export async function discoveryNotice(
  criteria: SearchParams,
  result: { books: { id: number }[]; source?: string; page: number; hasMore: boolean },
  ctx: Context,
): Promise<string | undefined> {
  if (criteria.ids?.length === 0)
    return 'The empty ID selection selects no books. Supply one or more IDs, or omit ids to search the catalog.';
  const notices: string[] = [];
  if (
    result.source === 'live' &&
    criteria.author_year_start !== undefined &&
    criteria.author_year_end !== undefined
  )
    notices.push(
      'The live catalog answered, so author_year_start and author_year_end were checked separately: one author can satisfy each bound.',
    );
  if (result.books.length === 0) {
    const filterKeys = [
      'query',
      'topic',
      'translator',
      'languages',
      'mime_type',
      'copyright',
      'author_year_start',
      'author_year_end',
      'ids',
    ] as const satisfies readonly (keyof SearchParams)[];
    const filters = filterKeys.filter((key) => criteria[key] !== undefined);
    notices.push(
      `No books matched these criteria.${filters.length ? ` Broaden or remove the supplied filters: ${filters.join(', ')}.` : ''}`,
    );
    if (criteria.mime_type)
      notices.push(
        'MIME filters match prefixes such as "application/pdf" or "text/plain", not file extensions.',
      );
    const codes = criteria.languages?.filter((code) => code.length === 3);
    if (
      codes?.length &&
      (result.source === 'live' ||
        (result.source === 'mirror' &&
          (await getGutendexService().hasMirrorLanguages(codes, ctx)) === false))
    )
      notices.push('Language codes match exactly: English is "en", not "eng".');
    if (result.source === 'live' && criteria.query && /^\p{ASCII}*$/u.test(criteria.query))
      notices.push(
        'The live catalog may require accents in title or author names; accent-insensitive matching requires the local mirror.',
      );
  }
  if (criteria.ids?.length && result.page === 1 && !result.hasMore) {
    const matched = new Set(result.books.map((book) => book.id));
    const unmatched = [...new Set(criteria.ids)].filter((id) => !matched.has(id));
    if (unmatched.length)
      notices.push(`IDs that matched nothing under these filters: ${unmatched.join(', ')}.`);
  }
  return notices.length ? notices.join(' ') : undefined;
}
