/**
 * @fileoverview Shared discovery criteria for filter echo and executable continuation.
 * @module mcp-server/tools/discovery-criteria
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Filters shared by search, browse, criteria echo and continuation arguments. */
export const discoveryFilters = {
  languages: z
    .array(z.string().min(2).max(2))
    .optional()
    .describe('Any listed two-character ISO 639-1 language code; empty means all languages.'),
  topic: z
    .string()
    .optional()
    .describe('Case-insensitive phrase in a subject or bookshelf; blank means unset.'),
  mime_type: z
    .string()
    .optional()
    .describe(
      'Literal prefix of a format MIME key, such as "text/plain" or "text/html". Blank means unset.',
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
      'Every nonblank word must occur in the title or an author name, case-insensitively, as a literal substring. More than four words require the local mirror; live fallback rejects longer queries. Whitespace separates words.',
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
      'At least one author has a birth or death year on or after this year (CE positive, BCE negative).',
    ),
  author_year_end: z
    .number()
    .int()
    .optional()
    .describe(
      'At least one author has a birth or death year on or before this year (CE positive, BCE negative).',
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
