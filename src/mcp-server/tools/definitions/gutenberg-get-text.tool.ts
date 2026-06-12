/**
 * @fileoverview Tool for retrieving the plain-text content of a Project Gutenberg book,
 * stripped of license boilerplate, with offset/limit chunking for context-budget management.
 * @module mcp-server/tools/definitions/gutenberg-get-text
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getGutenbergTextService } from '@/services/gutenberg-text/gutenberg-text-service.js';
import { getGutendexService } from '@/services/gutendex/gutendex-service.js';

export const gutenbergGetText = tool('gutenberg_get_text', {
  title: 'Get Gutenberg Book Text',
  description:
    'Retrieve the plain-text content of a Project Gutenberg book, stripped of the standard ' +
    'license header and footer so the response contains only the literary work. For long works ' +
    '— novels routinely run 500KB–2MB — use offset and limit to read in chunks rather than ' +
    'fetching the whole book at once. The response reports totalChars and remainingChars so ' +
    'the caller can page through without guessing. Prefers UTF-8 plain text; falls back to ' +
    'ASCII plain text; refuses audio books (media_type "Sound") with a clear error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z
      .number()
      .int()
      .positive()
      .describe(
        'Project Gutenberg book ID. Use gutenberg_search_books or gutenberg_get_book to find IDs. Example: 1342 for Pride and Prejudice, 2600 for War and Peace, 84 for Frankenstein.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the stripped literary text at which to start reading. 0 returns the beginning of the work. To read subsequent chunks, use offset = prior_offset + prior_length (the length field from the previous response — NOT offset + limit, because the actual returned length may be slightly less than limit due to paragraph-boundary trimming).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .default(20000)
      .describe(
        'Maximum number of characters to return in this chunk. Default 20,000 (~4–5 pages of prose). Increase toward 50,000 for large context windows. The actual returned length may be slightly less than limit when a natural paragraph boundary is found within 500 characters of the limit — check the length field in the response for the actual character count returned.',
      ),
  }),

  output: z.object({
    id: z.number().describe('Gutenberg book ID.'),
    title: z.string().describe('Book title, from the catalog record.'),
    text: z
      .string()
      .describe(
        'The requested chunk of literary text, stripped of Gutenberg license boilerplate. Encoding: UTF-8. Line endings: normalized to LF.',
      ),
    offset: z.number().describe('Character offset where this chunk begins.'),
    length: z.number().describe('Number of characters in this chunk.'),
    totalChars: z
      .number()
      .describe(
        'Total characters in the stripped literary text. Use with offset and length to determine progress and plan subsequent calls.',
      ),
    remainingChars: z
      .number()
      .describe(
        'Characters remaining after this chunk (totalChars - offset - length). 0 means this chunk includes the end of the book.',
      ),
    hasMore: z
      .boolean()
      .describe(
        'True if there is more text after this chunk. When true, call again with offset = offset + length.',
      ),
    provenance: z
      .string()
      .describe('One-line source note with Project Gutenberg ID, title, and license URL.'),
    sourceFormat: z
      .enum(['text/plain; charset=utf-8', 'text/plain; charset=us-ascii', 'text/html'])
      .describe(
        'The format that was fetched. "text/html" indicates HTML-to-text conversion was applied because no plain-text format was available.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery:
        'Verify the ID with gutenberg_search_books. The ID must be a positive integer matching a catalog entry.',
    },
    {
      reason: 'audio_book',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The book is an audio recording (media_type "Sound"), not a text book — no literary plain text is available.',
      recovery:
        'This Gutenberg entry is an audio book. Use gutenberg_search_books or gutenberg_get_book to find a text edition of the same work, then call gutenberg_get_text on that ID.',
    },
    {
      reason: 'no_text_format',
      code: JsonRpcErrorCode.NotFound,
      when: 'The book record exists but has no plain-text or HTML format in its formats map.',
      recovery:
        'Call gutenberg_get_book to inspect the available formats. The book may only be available as EPUB or other formats that this server does not convert.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The offset is greater than or equal to totalChars (past the end of the book).',
      recovery:
        "Use an offset less than totalChars. A prior response's remainingChars field shows how much text is left.",
    },
    {
      reason: 'text_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Gutenberg file server returned an error or did not respond within the timeout.',
      recovery:
        'Project Gutenberg file servers are sometimes slow. Retry after a short delay. If the error persists, the file may be temporarily unavailable.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching book text', { id: input.id, offset: input.offset, limit: input.limit });

    // Step 1: Fetch book metadata to validate media_type and resolve format URL
    const book = await getGutendexService()
      .getBook(input.id, ctx)
      .catch((err: unknown) => {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail('not_found', `No book found with Gutenberg ID ${input.id}.`, {
            ...ctx.recoveryFor('not_found'),
          });
        }
        throw err;
      });

    // Guard: refuse audio books
    if (book.media_type === 'Sound') {
      throw ctx.fail(
        'audio_book',
        `Book ${input.id} is an audio recording (media_type "Sound") — no literary text is available.`,
        { ...ctx.recoveryFor('audio_book') },
      );
    }

    // Guard: ensure at least one readable format exists
    const hasText =
      'text/plain; charset=utf-8' in book.formats ||
      'text/plain; charset=us-ascii' in book.formats ||
      'text/html' in book.formats;
    if (!hasText) {
      throw ctx.fail(
        'no_text_format',
        `Book ${input.id} has no plain-text or HTML format available.`,
        { ...ctx.recoveryFor('no_text_format') },
      );
    }

    // Step 2: Fetch and cache the full stripped text (or retrieve from cache)
    const cached = await getGutenbergTextService().fetchAndCacheText(book, input.id, ctx);

    // Guard: offset past end of book
    if (input.offset >= cached.text.length) {
      throw ctx.fail(
        'offset_out_of_range',
        `Offset ${input.offset} is past the end of the book (totalChars: ${cached.text.length}).`,
        { ...ctx.recoveryFor('offset_out_of_range') },
      );
    }

    // Step 3: Chunk the text
    const chunk = getGutenbergTextService().chunkText(cached, input.offset, input.limit);

    const provenance = `Project Gutenberg eBook #${input.id}: ${book.title} — https://www.gutenberg.org/ebooks/${input.id} — License: www.gutenberg.org/license`;

    return {
      id: input.id,
      title: book.title,
      text: chunk.text,
      offset: chunk.offset,
      length: chunk.length,
      totalChars: chunk.totalChars,
      remainingChars: chunk.remainingChars,
      hasMore: chunk.hasMore,
      provenance,
      sourceFormat: chunk.sourceFormat,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`_${result.provenance}_`);
    lines.push('');
    lines.push(`**[${result.id}] ${result.title}**`);
    lines.push('');

    const end = result.offset + result.length;
    lines.push(
      `**Characters ${result.offset.toLocaleString()}–${(end - 1).toLocaleString()} of ${result.totalChars.toLocaleString()}** | Length: ${result.length.toLocaleString()} chars | ${result.remainingChars.toLocaleString()} remaining | hasMore: ${result.hasMore} | Format: ${result.sourceFormat}`,
    );
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(result.text);
    lines.push('');
    lines.push('---');

    if (result.hasMore) {
      lines.push('');
      lines.push(
        `_Call \`gutenberg_get_text\` again with id=${result.id}, offset=${end} to read the next chunk._`,
      );
    } else {
      lines.push('');
      lines.push('_End of book._');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
