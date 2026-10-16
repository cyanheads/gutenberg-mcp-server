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
    'Retrieve the plain-text content of a Project Gutenberg book, stripped of the standard license header and footer so the response contains only the literary work. For long works — novels routinely run 500KB–2MB — use offset and limit to read in chunks rather than fetching the whole book at once. The response reports totalChars and remainingChars for reliable pagination. Prefers UTF-8 plain text; falls back to an HTML edition converted to text; refuses audio books (media_type "Sound") with a clear error.',
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
      .default(20000)
      .describe(
        'Requested maximum characters. Default 20,000 (~4–5 pages of prose); requests above 50,000 are capped locally at 50,000. Paragraph-boundary trimming may return less than the applied limit — use length for continuation.',
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
    requestedLimit: z
      .number()
      .describe('Positive integral character limit requested by the caller, before capping.'),
    appliedLimit: z.number().describe('Character limit applied to this chunk, at most 50,000.'),
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
      reason: 'text_file_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The catalog entry exists but its mirror text file returned HTTP 404.',
      recovery:
        'Inspect gutenberg_get_book for another readable edition; this mirror file is missing.',
      thrownBy: 'service',
    },
    {
      reason: 'text_fetch_rejected',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The mirror permanently rejected this text request.',
      recovery:
        'Inspect gutenberg_get_book for another edition. Repeating the same request will not resolve a permanent mirror rejection.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_text_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The mirror returned an empty document, HTML on a plain-text path, or recognizable server failure document.',
      recovery:
        'Try another readable edition from gutenberg_search_books; the mirror did not supply a valid text document.',
      thrownBy: 'service',
    },
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
      when: 'The book has no UTF-8 plain-text or HTML edition available to read (for example an older ASCII-only entry).',
      recovery:
        'Call gutenberg_get_book to inspect the available formats. The book may only exist as EPUB, ASCII-only, or other formats this server cannot read as text.',
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
      when: 'The Gutenberg mirror had a transient failure or did not respond within the request budget.',
      recovery:
        'Project Gutenberg file servers are sometimes slow. Retry after a short delay. If the error persists, the file may be temporarily unavailable.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The catalog lookup that precedes reading a book did not answer within the time this server allows.',
      recovery:
        'This failed before any text was requested — the catalog, not the file server, is unreachable. Retry in a few seconds, or call gutenberg_get_book to confirm the catalog is answering again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching book text', { id: input.id, offset: input.offset, limit: input.limit });

    // Step 1: Fetch book metadata to validate media_type and resolve format URL
    const book = await getGutendexService()
      .getBook(input.id, ctx)
      .catch((err: unknown) => {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail('not_found', `No book found with Gutenberg ID ${input.id}.`);
        }
        throw err;
      });

    // Guard: refuse audio books
    if (book.media_type === 'Sound') {
      throw ctx.fail(
        'audio_book',
        `Book ${input.id} is an audio recording (media_type "Sound") — no literary text is available.`,
      );
    }

    // Guard: ensure at least one mirror-servable format exists. Mirrors
    // resolveTextUrl's own preference (utf-8, then html) — us-ascii has no
    // compliant mirror path, so it's intentionally excluded here too. This
    // lets an ASCII-only book fail fast with a full recovery hint instead of
    // falling through to the service's bare no_text_format throw.
    const hasText = 'text/plain; charset=utf-8' in book.formats || 'text/html' in book.formats;
    if (!hasText) {
      throw ctx.fail(
        'no_text_format',
        `Book ${input.id} has no UTF-8 plain-text or HTML format available.`,
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
      );
    }

    // Step 3: Chunk the text
    const appliedLimit = Math.min(input.limit, 50000);
    const chunk = getGutenbergTextService().chunkText(cached, input.offset, appliedLimit);

    const provenance = `Project Gutenberg eBook #${input.id}: ${book.title} — https://www.gutenberg.org/ebooks/${input.id} — License: www.gutenberg.org/license`;

    return {
      id: input.id,
      title: book.title,
      text: chunk.text,
      offset: chunk.offset,
      length: chunk.length,
      requestedLimit: input.limit,
      appliedLimit,
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
    lines.push(
      `Requested limit: ${result.requestedLimit.toLocaleString()} | Applied limit: ${result.appliedLimit.toLocaleString()}`,
    );
    lines.push('');
    let longestRun = 0;
    let run = 0;
    for (const character of result.text) {
      run = character === '`' ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    lines.push(`${fence}text\n${result.text}\n${fence}`);
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
