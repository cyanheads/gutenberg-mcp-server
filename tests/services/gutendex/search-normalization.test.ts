/**
 * @fileoverview Literal query normalization and caller-sized whitespace CPU bounds.
 * @module tests/services/gutendex/search-normalization.test
 */
import { describe, expect, it } from 'vitest';
import { foldSearchText, normalizeSearchParams } from '@/services/gutendex/types.js';

describe('normalizeSearchParams', () => {
  it('removes upstream-ignored NULs and normalizes whitespace without spending live search slots on blanks', () => {
    expect(
      normalizeSearchParams({
        query: ' \t di\0ckens\n a\r\n tale  two ',
        topic: ' ',
        languages: [],
        mime_type: ' ',
        copyright: [],
        ids: [],
      }),
    ).toMatchObject({
      query: 'dickens a tale two',
      topic: undefined,
      languages: undefined,
      mime_type: undefined,
      copyright: undefined,
      ids: [],
      sort: 'popular',
      page: 1,
    });
  });

  it.each(['<', '<p', 'a\r\n\t', '\0 \n', '%_'])(
    'bounds normalization CPU over a 64× span of %j',
    (prefix) => {
      const measure = (size: number) => {
        const query = prefix.repeat(Math.ceil(size / prefix.length)).slice(0, size);
        const start = process.threadCpuUsage();
        for (let i = 0; i < 32; i++) {
          normalizeSearchParams({ query });
          foldSearchText(query);
        }
        const elapsed = process.threadCpuUsage(start);
        return elapsed.user + elapsed.system;
      };
      measure(5000);
      const baseline = measure(5000);
      expect(baseline).toBeGreaterThan(0);
      for (let size = 10000; size <= 320000; size *= 2) {
        const cpu = measure(size);
        expect(cpu).toBeLessThan(2_000_000);
        expect(cpu / baseline).toBeLessThan(256);
      }
    },
    15000,
  );
});
