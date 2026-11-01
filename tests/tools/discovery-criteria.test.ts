/**
 * @fileoverview Shared notice boundaries and ASCII hint CPU bounds.
 * @module tests/tools/discovery-criteria.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { gutenbergBrowsePopular } from '@/mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import { discoveryFilters, discoveryNotice } from '@/mcp-server/tools/discovery-criteria.js';

describe('shared discovery criteria', () => {
  it('preserves the advertised language item schema in all three copies', () => {
    const expected = { type: 'array', items: { type: 'string', minLength: 2, maxLength: 3 } };
    for (const schema of [
      discoveryFilters.languages,
      gutenbergSearchBooks.input.shape.languages,
      gutenbergBrowsePopular.input.shape.languages,
    ]) {
      const advertised = z.toJSONSchema(schema);
      expect(advertised).toMatchObject(expected);
      expect(advertised.items).toEqual(expected.items);
    }
  });

  it.each(['line ending newline', 'repeated line breaks'])(
    'bounds notice CPU for %s across a 64× span',
    async (shape) => {
      const ctx = createMockContext();
      const result = { books: [], source: 'live', page: 1, hasMore: false };
      const measure = async (size: number) => {
        const query =
          shape === 'line ending newline' ? `${'a'.repeat(size - 1)}\n` : '\n'.repeat(size);
        const start = process.threadCpuUsage();
        for (let index = 0; index < 32; index++) await discoveryNotice({ query }, result, ctx);
        const elapsed = process.threadCpuUsage(start);
        return elapsed.user + elapsed.system;
      };
      await measure(5000);
      const baseline = await measure(5000);
      expect(baseline).toBeGreaterThan(0);
      for (const size of [20000, 80000, 320000]) {
        const cpu = await measure(size);
        expect(cpu).toBeLessThan(2_000_000);
        expect(cpu / baseline).toBeLessThan(256);
      }
    },
  );
});
