/**
 * @fileoverview Shared output fields and rendering for catalog tool responses.
 * @module mcp-server/tools/catalog-output
 */
import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { Person } from '@/services/gutendex/types.js';

/** Local harvest checkpoint. Live discovery and per-book RDF have no bulk checkpoint. */
export const catalogAsOfSchema = z
  .string()
  .nullable()
  .describe('Last recorded bulk RDF archive checkpoint, or null when unavailable or inapplicable.');

/** Text rendering shared by all three catalog provenance trailers. */
export const catalogProvenanceTrailer = {
  catalogSource: {
    render: (value: string | undefined) => (value === undefined ? '' : `Catalog source: ${value}`),
  },
  catalogAsOf: {
    render: (value: string | null | undefined) =>
      value === undefined ? '' : `Catalog as of: ${value ?? 'null'}`,
  },
};

/** Classification codes from Project Gutenberg's RDF. */
export const lccSchema = z
  .array(z.string())
  .nullable()
  .describe(
    'Library of Congress Classification codes. [] means none in the RDF; null means unavailable.',
  );

/** Represent a nullable list on the text surface, retaining both missing states. */
export function renderCatalogList(values: readonly string[] | null): string {
  if (values === null) return 'Not available';
  return values.length ? escapeMarkdownInline(values.join('; ')) : 'None';
}

/** Keep detail-only author metadata out of search and browse rows. */
export function discoveryAuthors(authors: readonly Person[]): Person[] {
  return authors.map(({ name, birth_year, death_year }) => ({ name, birth_year, death_year }));
}
