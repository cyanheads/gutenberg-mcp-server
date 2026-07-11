/**
 * @fileoverview Tests for GutendexService normalization logic — the has_plain_text
 * computed flag that gates gutenberg_get_text readability.
 * @module tests/services/gutendex/gutendex-service.test
 */

import { describe, expect, it } from 'vitest';
import { hasPlainText } from '@/services/gutendex/gutendex-service.js';
import type { RawBook } from '@/services/gutendex/types.js';

/** Build a minimal RawBook, overriding only the fields a case cares about. */
function makeRawBook(overrides: Partial<RawBook>): RawBook {
  return {
    id: 1,
    title: 'Test Book',
    authors: [],
    translators: [],
    subjects: [],
    bookshelves: [],
    languages: ['en'],
    copyright: false,
    media_type: 'Text',
    download_count: 0,
    formats: {},
    ...overrides,
  };
}

describe('hasPlainText', () => {
  it('is true for a Text book with a UTF-8 plain-text format', () => {
    const book = makeRawBook({
      formats: { 'text/plain; charset=utf-8': 'https://example/pg1.txt' },
    });
    expect(hasPlainText(book)).toBe(true);
  });

  it('is false for a Text book whose only plain-text format is us-ascii', () => {
    // Regression (#7): us-ascii-only entries are no longer served by
    // gutenberg_get_text (no sanctioned-mirror path), so the flag must not
    // advertise them as readable.
    const book = makeRawBook({
      formats: { 'text/plain; charset=us-ascii': 'https://example/1.txt' },
    });
    expect(hasPlainText(book)).toBe(false);
  });

  it('is true when both us-ascii and UTF-8 are present (UTF-8 is served)', () => {
    const book = makeRawBook({
      formats: {
        'text/plain; charset=us-ascii': 'https://example/1.txt',
        'text/plain; charset=utf-8': 'https://example/pg1.txt',
      },
    });
    expect(hasPlainText(book)).toBe(true);
  });

  it('is false for an HTML-only book (the flag tracks plain text, not HTML-fallback readability)', () => {
    const book = makeRawBook({ formats: { 'text/html': 'https://example/pg1.html' } });
    expect(hasPlainText(book)).toBe(false);
  });

  it('is false when media_type is not "Text" even with a UTF-8 text/plain format', () => {
    // Audio books can carry text/plain readme entries — the media_type guard
    // keeps them from being flagged as readable literary text.
    const book = makeRawBook({
      media_type: 'Sound',
      formats: { 'text/plain; charset=utf-8': 'https://example/readme.txt' },
    });
    expect(hasPlainText(book)).toBe(false);
  });
});
