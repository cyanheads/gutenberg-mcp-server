# gutenberg-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `gutenberg_search_books` | Search the Project Gutenberg catalog by title/author, topic, translator, language, author lifespan, ID list, format, or copyright status | `query`, `topic`, `translator`, `languages`, `author_year_start`, `author_year_end`, `sort`, `ids`, `page`, `mime_type`, `copyright` | `readOnlyHint: true` |
| `gutenberg_get_book` | Fetch full metadata for a single book by Gutenberg ID | `id` | `readOnlyHint: true`, `idempotentHint: true` |
| `gutenberg_get_text` | Retrieve the plain-text content of a book, stripped of the license boilerplate, with offset/limit chunking, or a `find` jump to a passage | `id`, `offset`, `limit`, `find` | `readOnlyHint: true`, `idempotentHint: true` |
| `gutenberg_browse_popular` | Return the most-downloaded books, optionally filtered by language, topic, format, or copyright status | `languages`, `topic`, `mime_type`, `copyright`, `limit` | `readOnlyHint: true` |

### Resources

None. The tool surface is self-sufficient for tool-only agents. A `gutenberg://books/{id}` resource could expose metadata as injectable context, but since all clients have `gutenberg_get_book`, adding a resource would duplicate without adding capability.

### Prompts

None. This is a data-access server without recurring agent interaction patterns that warrant a reusable prompt template.

---

## Overview

An MCP server wrapping Project Gutenberg's 78,000+ public-domain ebook corpus. Catalog discovery uses the ready local RDF mirror, with the keyless Gutendex API as fallback; metadata uses the mirror when it holds the requested ID. Full book text comes from Gutenberg's content mirror. `gutenberg_get_text` fetches, strips boilerplate, and returns the literary content of a work in context-budget-safe chunks. No API key required.

**Audience:** Readers, students, literature researchers, writers, and AI agents doing textual analysis, quote-finding, or close reading of classic works.

---

## Requirements

- No authentication — Gutendex is fully public and keyless
- Gutendex base URL: `https://gutendex.com/books/` (the `/books` path redirects 301 → `/books/`; implementation must use trailing slash or follow redirects)
- Catalog returns up to 32 results per page; `next` and `previous` are full URLs, not cursor tokens
- Plain-text files are served from a Project Gutenberg content mirror (default `https://gutenberg.pglaf.org`, overridable via `GUTENBERG_TEXT_BASE_URL`) — never from the main site (`www.gutenberg.org`), whose Terms of Use prohibit automated access. Fetch URLs are built from the book ID, never from Gutendex's raw format URLs (which point at the main site):
  - `text/plain; charset=utf-8` → `/cache/epub/N/pgN.txt` on the mirror (same cache-path shape the main site uses; only the host changes)
  - `text/html` (fallback, when no UTF-8 format exists) → `/cache/epub/N/pgN-images.html` on the mirror
  - `text/plain; charset=us-ascii` has no compliant mirror path — these books resolve to `no_text_format` rather than ever fetching the main site
- UTF-8 files begin with a UTF-8 BOM (`\xEF\xBB\xBF`) — strip it.
- Files have `[header block] *** START OF ... *** [content] *** END OF ... *** [license footer]` structure; the regex-based extraction also tolerates files with no preceding header block (older catalog entries).
- Files use CRLF (`\r\n`) line endings throughout. The CRLF normalization step (step 6) handles this.
- Strip everything outside the `*** START ***` / `*** END ***` markers; keep a one-line provenance note in response metadata (the provenance citation still links to `www.gutenberg.org` — a human-facing reference, never fetched)
- Prefer `text/plain; charset=utf-8` from the formats map; fall back to `text/html` when no UTF-8 format exists; return `no_text_format` when neither is available
- Audio books (`media_type === "Sound"`) have no literary plain text — they may have a `text/plain` format in their formats map, but it is a readme/index file for the audio recording, not the literary work. Return a clear error for any `media_type === "Sound"` book regardless of format availability.
- Normalize all fetched text to UTF-8 before serving
- No rate-limit headers observed on Gutendex; apply conservative client-side throttling (e.g., 4 concurrent requests max)
- Cache catalog GET responses (TTL: 1 hour) and full-text file fetches (TTL: 24 hours) — the public-domain corpus changes rarely

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CatalogMirrorService` | Local SQLite catalog harvested from Gutenberg's bulk RDF archive | Catalog discovery and metadata through `GutendexService` |
| `GutendexService` | Local catalog mirror with Gutendex API fallback (`gutendex.com/books/`) | All four tools; `gutenberg_get_text` uses it for metadata |
| `GutenbergTextService` | Project Gutenberg content mirror (`gutenberg.pglaf.org` by default) | `gutenberg_get_text` |

The catalog mirror persists across restarts; live catalog and text responses use tenant-scoped caching. Each upstream call runs its retry ladder under a shared wall-clock budget (`src/services/upstream-deadline.ts`), which also owns the single place where an exhausted budget becomes a declared `ServiceUnavailable` reason and a caller cancel passes through untouched.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `GUTENDEX_BASE_URL` | No | Override Gutendex base URL (default: `https://gutendex.com/books/`). Gutendex is self-hostable — useful for private instances. |
| `GUTENBERG_TEXT_BASE_URL` | No | Override the Project Gutenberg content mirror (default: `https://gutenberg.pglaf.org`, a mirror that permits automated access — see Design Decisions). |
| `GUTENBERG_MIRROR_PATH` | No | Persistent SQLite catalog path shared by the server and lifecycle commands (default: `./.mirror/gutenberg-catalog.sqlite`). |
| `GUTENBERG_MIRROR_REFRESH_CRON` | No | Optional in-process refresh schedule; a host scheduler running `mirror:refresh` is preferred. |

No API keys. URL overrides support self-hosted Gutendex instances and Gutenberg mirrors.

---

## Implementation Order

1. Config (`src/config/server-config.ts`) — base URL overrides
2. `GutendexService` — catalog search/get with retry + response cache
3. `GutenbergTextService` — text fetch, BOM strip, `*** START ***/*** END ***` extraction, encoding normalization, chunking
4. `gutenberg_search_books` — catalog search tool
5. `gutenberg_get_book` — single-book metadata tool
6. `gutenberg_browse_popular` — popularity-ranked list tool
7. `gutenberg_get_text` — full-text retrieval tool (most complex — implement last when text service is verified)

Each step is independently testable. The text service can be unit-tested with a synthetic fixture that exercises BOM stripping, marker extraction, and chunking without hitting the network.

---

## Tool Specifications

### `gutenberg_search_books`

**Purpose:** Search and filter the Project Gutenberg catalog. Entry point for finding books.

**Source:** the ready local RDF mirror; cold/unreadable mirrors fall back to `GET https://gutendex.com/books/?search=...&topic=...&languages=...&sort=...&page=...&mime_type=...&copyright=...`. Parameterized SQLite predicates apply before both totals and page selection, with ID tie-breaks for popular ordering. Empty results remain local answers. Metadata retains its per-ID fallback.

Every nonblank whitespace-separated query word must occur in a title or author name as a case-insensitive literal substring. Unicode-folded title and JSON author/category columns are populated at ingest; schema v3 backfills existing rows in bounded batches without harvesting. FTS token semantics would narrow substring matches, so discovery uses `instr` on folded values, preserving literal percent/underscore punctuation. Live fallback rejects more than four words with `query_requires_mirror`, before any request, rather than silently dropping constraints.

`translator` follows the same word rule against a folded JSON column of translator names: every nonblank word must occur in a translator name as a case-insensitive literal substring, and different words may land on different translators of one book. Gutendex has no translator parameter, so the filter is mirror-only; with the mirror unable to answer it fails with `translator_requires_mirror` rather than dropping the constraint. Schema v4 adds the column and backfills it in bounded batches, writing only rows that list a translator (a null column matches no translator filter), so a first open of an existing mirror pays one pass over those rows and no harvest. Result rows omit translators; `gutenberg_get_book` reports them.

`author_year_start` and `author_year_end` match an author with a known birth or death year on or after the start and on or before the end. Alone, each bound reads the stored per-book extremes. Together, the mirror also requires one author to meet both bounds, so an author whose only known year falls outside the range is dropped even when another author of the book falls inside. Gutendex checks the bounds separately; when the live fallback answers a two-bound search, a notice says so.

The service reports which source answered (mirror, live, or none for an empty `ids`) so the tool can compose that notice; `source` is not part of the tool output. An empty result for a three-letter `languages` code carries a notice that codes match exactly (`en`, not `eng`).

Both discovery tools accept `mime_type` (literal format-key prefix) and `copyright` (`"true"`, `"false"`, `"null"`, OR). False is the source's public-domain-in-the-USA classification; null remains unknown. Blank optional strings and empty language/copyright lists are unset. An explicit `ids: []` selects nothing without catalog I/O. Both tools declare typed `effectiveCriteria` and `notice` enrichment for full text and structured output; empty first-page matches are successful empty collections, while exhausted pages retain `page_out_of_range`.

```ts
tool('gutenberg_search_books', {
  description: 'Search the Project Gutenberg catalog of 78,000+ public-domain books by title, author, topic, translator, language, author lifespan, or IDs. Popularity uses downloads in the last 30 days at the source snapshot. Use is_readable to select an edition for gutenberg_get_text.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    mime_type: z.string().optional().describe('Literal format MIME prefix; blank means unset.'),
    copyright: z.array(z.enum(['true', 'false', 'null'])).optional().describe('Any selected copyright status: false means public domain in the USA, null means unknown; empty means all.'),
    query: z.string().optional()
      .describe('Every nonblank query word matches a case-insensitive literal title/author substring. More than four words require the local mirror.'),
    topic: z.string().optional()
      .describe('Case-insensitive phrase to match against subjects and bookshelves. Example: "detective" returns books on the "Detective and Mystery Stories" bookshelf and with subject "Detective and mystery stories". Separate from query — topic searches categorization metadata, not title/author.'),
    translator: z.string().optional()
      .describe('Every nonblank whitespace-separated word must match a translator name as a case-insensitive literal substring; words can land on different translators of one book, and accents must match. Requires the local mirror. Example: "maude" finds the Aylmer and Louise Maude translations. Result rows omit translators; gutenberg_get_book reports them.'),
    languages: z.array(z.string().min(2).max(3)).optional()
      .describe('Filter to books in any of these catalog language codes, exactly as results report them ("en", not "eng"). Example: ["en"] for English, ["fr", "de"] for French or German, ["enm"] for Middle English. The catalog spans 60+ languages; English is by far the largest set.'),
    author_year_start: z.number().int().optional()
      .describe('Include only books with an author who has a known birth or death year on or after this year (positive = CE, negative = BCE). With author_year_end, one author must meet both bounds.'),
    author_year_end: z.number().int().optional()
      .describe('Include only books with an author who has a known birth or death year on or before this year. With author_year_start, one author must meet both bounds. Example: author_year_start=1800 with author_year_end=1899 returns books with 19th-century authors.'),
    sort: z.enum(['popular', 'ascending', 'descending']).default('popular')
      .describe('Result ordering. "popular" (default) sorts by downloads in the last 30 days at the source snapshot, descending. "ascending" and "descending" sort by Gutenberg ID number.'),
    ids: z.array(z.number().int().positive()).optional()
      .describe('Narrow results to specific Gutenberg ID numbers. Other filters (search, topic, languages) still apply when ids is provided — a conflicting language filter will reduce or empty the result. Serialized as comma-separated values in the query string (e.g., ids=84,1342). Use gutenberg_get_book for single-ID lookups; this parameter suits batch pre-fetching of known IDs.'),
    page: z.number().int().positive().default(1)
      .describe('Page number for paginated results (1-indexed). Each page returns up to 32 books. The response includes totalCount so the caller knows how many pages exist.'),
  }),

  output: z.object({
    books: z.array(z.object({
      id: z.number().describe('Gutenberg ID — pass to gutenberg_get_book for the full record or gutenberg_get_text to read the book.'),
      title: z.string().describe('Book title.'),
      authors: z.array(z.object({
        name: z.string().describe('Author name in "Last, First" format.'),
        birth_year: z.number().nullable().describe('Author birth year, or null if unknown.'),
        death_year: z.number().nullable().describe('Author death year, or null if unknown or still living.'),
      })).describe('Author(s) of the work. Translators and editors are excluded from this field — see gutenberg_get_book for full contributor lists.'),
      languages: z.array(z.string()).describe('Catalog language codes for this edition.'),
      subjects: z.array(z.string()).describe('Library of Congress subject headings for the work.'),
      download_count: z.number().describe('Downloads in the last 30 days at the source snapshot.'),
      has_plain_text: z.boolean().describe('True for Text records with UTF-8 plain text; use is_readable for reader support.'),
      is_readable: z.boolean().describe('True for non-Sound records with supported UTF-8 plain text or HTML.'),
    })).describe('Matching books, ordered by the sort parameter.'),
    totalCount: z.number().describe('Total number of books matching the query across all pages.'),
    page: z.number().describe('Current page number.'),
    hasMore: z.boolean().describe('True if there are additional pages of results.'),
    notice: z.string().optional().describe('Actionable guidance for an empty selection, or a caveat that the live catalog checked author_year_start and author_year_end separately. The caveat can accompany results.'),
  }),

  errors: [
    {
      reason: 'translator_requires_mirror',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A translator filter was supplied while the local mirror could not answer.',
      recovery: 'Remove the translator filter and read translators from gutenberg_get_book, or ask the server operator to initialize or repair the local catalog mirror.',
      thrownBy: 'service',
    },
    {
      reason: 'query_requires_mirror',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than four query words were supplied while the local mirror could not answer.',
      recovery: 'Shorten the query to at most four words, or ask the operator to initialize or repair the local mirror.',
      thrownBy: 'service',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested page number is past the last page of results for this query.',
      recovery: 'Request a page within the available range, or restart at page 1. The first page reports totalCount — divide it by the page size (32) to find the last page.',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer within the time this server allows for one search.',
      recovery: 'The catalog is unreachable or too slow right now. Retry in a few seconds; if it keeps failing, the catalog service itself is degraded and a different query will not help.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
})
```

**`format()` rendering:** IDs, titles, authors, languages, subjects, downloads in the last 30 days at the source snapshot, `has_plain_text`, and `is_readable`; total count, page, and continuation. Catalog text (titles, author names, languages, subjects) is Markdown-escaped. The criteria trailer carries the JSON in a code span.

---

### `gutenberg_get_book`

**Purpose:** Fetch the complete metadata record for a single book by its Gutenberg ID, including the full formats map needed before fetching text.

**Upstream call:** `GET https://gutendex.com/books/{id}/`

```ts
tool('gutenberg_get_book', {
  description: 'Fetch full metadata by Gutenberg ID, including contributors, subjects, formats, source bibliographic notes, and is_readable for selecting UTF-8 plain-text or HTML editions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z.number().int().positive()
      .describe('Project Gutenberg book ID. Visible in Gutenberg URLs (e.g., gutenberg.org/ebooks/1342) and returned by gutenberg_search_books and gutenberg_browse_popular. Example: 1342 for Pride and Prejudice, 2600 for War and Peace.'),
  }),

  output: z.object({
    id: z.number().describe('Gutenberg ID.'),
    title: z.string().describe('Book title.'),
    authors: z.array(z.object({
      name: z.string().describe('Author name in "Last, First" format.'),
      birth_year: z.number().nullable().describe('Birth year, or null if unknown.'),
      death_year: z.number().nullable().describe('Death year, or null if unknown or still living.'),
    })).describe('Primary author(s).'),
    translators: z.array(z.object({
      name: z.string(),
      birth_year: z.number().nullable(),
      death_year: z.number().nullable(),
    })).describe('Translators, if this is a translated work.'),
    editors: z.array(z.object({
      name: z.string(),
      birth_year: z.number().nullable(),
      death_year: z.number().nullable(),
    })).describe('Editors, if any.'),
    subjects: z.array(z.string()).describe('Library of Congress subject headings.'),
    bookshelves: z.array(z.string()).describe('Project Gutenberg bookshelf categories (e.g., "Best Books Ever Listings", "Category: Classics of Literature").'),
    languages: z.array(z.string()).describe('Catalog language codes for this edition.'),
    copyright: z.boolean().nullable().describe('Copyright status: false = public domain in the USA, true = under copyright, null = unknown.'),
    media_type: z.string().describe('Source media type; use is_readable for reader support.'),
    download_count: z.number().describe('Downloads in the last 30 days at the source snapshot.'),
    source_notes: z.array(z.string()).nullable().describe('Direct RDF bibliographic notes, in order. [] means inspected empty; null means unavailable.'),
    is_readable: z.boolean().describe('True for non-Sound records with supported UTF-8 plain text or HTML.'),
    summary: z.string().nullable().describe('First entry of summaries — the primary auto-generated summary of the work, or null when Gutendex has none.'),
    summaries: z.array(z.string()).describe('Every summary Gutendex holds for this work, in upstream order. Usually one; some records carry a long and a short variant. Empty when there are none.'),
    formats: z.record(z.string(), z.string()).describe('Map of MIME type to download URL. Key types: "text/plain; charset=utf-8" (preferred for gutenberg_get_text), "text/html", "application/epub+zip", "image/jpeg" (cover). Not every format is present for every book.'),
    has_plain_text: z.boolean().describe('True for Text records with UTF-8 plain text; HTML-only editions may have is_readable=true.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery: 'Verify the ID with gutenberg_search_books. Gutenberg IDs are positive integers; this ID does not match any entry in the catalog.',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Project Gutenberg catalog did not answer within the time this server allows for one lookup.',
      recovery: 'The catalog is unreachable or too slow right now. Retry in a few seconds; if it keeps failing, the catalog service itself is degraded and another ID will fail the same way.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
})
```

**`format()` rendering:** title, contributors (with years), subjects, bookshelves, languages, copyright, downloads in the last 30 days at the source snapshot, summaries, source notes, readability flags, and all formats. Empty collections read `None`; unavailable nullable fields read `Not available`. Catalog text is Markdown-escaped. Source notes sit in a fenced `text` block instead, because most hold a URL an agent may copy and escaping would put a backslash inside it. Each format renders as a Markdown link (`[mime](url)`); a record with no formats reads `**Formats:** None`.

---

### `gutenberg_get_text`

**Purpose:** Retrieve the literary content of a book as plain text, stripped of the Gutenberg license boilerplate, with offset/limit chunking for context-budget management.

**Upstream calls:**
1. `GET https://gutendex.com/books/{id}/` — resolve which format (`text/plain; charset=utf-8` or `text/html`) the book has, from the formats map
2. `GET https://gutenberg.pglaf.org/cache/epub/{id}/pg{id}.txt` (or `pg{id}-images.html` for the HTML fallback) — fetch the full file from the configured Project Gutenberg content mirror. The URL is built directly from the book ID, never from Gutendex's raw format URL — the formats map's URLs point at the main site (`www.gutenberg.org`), which the fetch path must never touch (see Design Decisions).

**This is the core design challenge.** Full notes in the Design Decisions section below.

```ts
tool('gutenberg_get_text', {
  description: 'Retrieve the plain-text content of a Project Gutenberg book, stripped of the standard license header and footer. Front matter such as producer credits, the title page, contents, and prefaces stays in the text. For long works — novels routinely run 500KB–2MB — use offset and limit to read in chunks rather than fetching the whole book at once, or pass find to jump to a known passage without paging. The response reports totalChars and remainingChars so the caller can page through without guessing. Prefers UTF-8 plain text; falls back to an HTML edition converted to text; refuses audio books (media_type "Sound") with a clear error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z.number().int().positive()
      .describe('Project Gutenberg book ID. Use gutenberg_search_books or gutenberg_get_book to find IDs. Example: 1342 for Pride and Prejudice, 2600 for War and Peace, 84 for Frankenstein.'),
    offset: z.number().int().min(0).default(0)
      .describe('Character offset into the stripped literary text (after boilerplate removal). 0 returns the beginning. Continue at the prior offset + length; the upstream work can change after the cached text expires. With find, the search starts here and the returned chunk starts at the match.'),
    limit: z.number().int().min(1).default(20000)
      .describe('Requested character limit, capped locally at 50,000. Paragraph trimming may return less; continue at offset + length. Trimming never cuts before a find match ends.'),
    find: z.string().trim().optional()
      .describe('A passage to locate instead of paging to it: the response starts at the first occurrence at or after offset and adds match, and an absent passage fails with passage_not_found rather than returning other text. Matching ignores letter case and whitespace around find. Any run of spaces, tabs, or line breaks matches any other such run, so a hard-wrapped line still matches. Straight and curly quotes match each other. Accents count: "cafe" does not match "café". Everything else is literal, with no wildcards or patterns, so an italic word stored as _word_ needs its underscores. A blank find is an ordinary read.'),
  }),

  output: z.object({
    id: z.number().describe('Gutenberg book ID.'),
    title: z.string().describe('Book title, from the catalog record.'),
    text: z.string().describe('The requested chunk of literary text, stripped of Gutenberg license boilerplate. Encoding: UTF-8. Line endings: normalized to LF.'),
    offset: z.number().describe('Character offset where this chunk begins: the match start when find matched.'),
    length: z.number().describe('Number of characters in this chunk.'),
    requestedLimit: z.number().describe('Character limit requested before capping.'),
    appliedLimit: z.number().describe('Character limit applied, at most 50,000.'),
    totalChars: z.number().describe('Total characters in the stripped literary text. Use with offset and length to determine progress and plan subsequent calls.'),
    remainingChars: z.number().describe('Characters remaining after this chunk (totalChars - offset - length). 0 means this chunk includes the end of the book.'),
    hasMore: z.boolean().describe('True if there is more text after this chunk. When true, call again with offset = offset + length and no find.'),
    provenance: z.string().describe('One-line source note: Project Gutenberg ID, title, and license URL. Always "Project Gutenberg eBook #{id}: {title} — https://www.gutenberg.org/ebooks/{id} — License: www.gutenberg.org/license".'),
    sourceFormat: z.enum(['text/plain; charset=utf-8', 'text/plain; charset=us-ascii', 'text/html'])
      .describe('The format that was fetched. "text/html" indicates HTML-to-text conversion was applied because no plain-text format was available.'),
    match: z.object({
      offset: z.number().describe('Start of the match, in the same coordinates as offset and totalChars.'),
      length: z.number().describe('Characters the match spans in the stored text. Can differ from the length of find, since a whitespace run matches a run of any length.'),
      laterMatches: z.number().describe('Non-overlapping occurrences after this one. While above 0, repeat the same find with offset = match.offset + match.length for the next.'),
    }).optional().describe('Where find matched. Absent on a read without find.'),
  }),

  errors: [
    {
      reason: 'text_file_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The catalog entry exists but its mirror text file returned HTTP 404.',
      recovery: 'Inspect gutenberg_get_book for another readable edition; this mirror file is missing.',
      thrownBy: 'service',
    },
    {
      reason: 'text_fetch_rejected',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The mirror permanently rejected this text request.',
      recovery: 'Inspect gutenberg_get_book for another edition. Repeating the same request will not resolve a permanent mirror rejection.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_text_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The mirror returned an empty document, HTML on a plain-text path, or recognizable server failure document.',
      recovery: 'Try another readable edition from gutenberg_search_books; the mirror did not supply a valid text document.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery: 'Verify the ID with gutenberg_search_books. The ID must be a positive integer matching a catalog entry.',
    },
    {
      reason: 'audio_book',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The book is an audio recording (media_type "Sound"), not a text book — no literary plain text is available.',
      recovery: 'This Gutenberg entry is an audio book. Use gutenberg_search_books or gutenberg_get_book to find a text edition of the same work, then call gutenberg_get_text on that ID.',
    },
    {
      reason: 'no_text_format',
      code: JsonRpcErrorCode.NotFound,
      when: 'The book has no UTF-8 plain-text or HTML edition available to read (for example an older ASCII-only entry).',
      recovery: 'Call gutenberg_get_book to inspect the available formats. The book may only exist as EPUB, ASCII-only, or other formats this server cannot read as text.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The offset is greater than or equal to totalChars (past the end of the book).',
      recovery: 'Use an offset less than totalChars. A prior response\'s remainingChars field shows how much text is left.',
    },
    {
      reason: 'passage_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'find has no occurrence at or after offset.',
      recovery: 'Try a shorter phrase, or a lower offset if the passage may sit earlier in the book. Matching ignores letter case, treats any whitespace run as one space, and treats straight and curly quotes alike; accents, dashes, and underscores around italic words must match the text exactly.',
    },
    {
      reason: 'text_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Gutenberg mirror had a transient failure or did not respond within the request budget.',
      recovery: 'Project Gutenberg file servers are sometimes slow. Retry after a short delay. If the error persists, the file may be temporarily unavailable.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The catalog lookup that precedes reading a book did not answer within the time this server allows.',
      recovery: 'This failed before any text was requested — the catalog, not the file server, is unreachable. Retry in a few seconds, or call gutenberg_get_book to confirm the catalog is answering again.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
})
```

**`format()` rendering:** provenance and title (Markdown-escaped), chunk position, requested/applied limits, then literary text in a fence longer than any embedded backtick run. Structured text and offsets remain unchanged. A `find` read adds a `**Match:**` line with the match offset, length, and later-match count before the text. When `hasMore` is true, continue with `offset + length`, and a `find` read's closing line says to drop `find`, because keeping it jumps to the next occurrence or fails with `passage_not_found`. When `match.laterMatches` is above 0, a closing line gives the offset for the next occurrence with the same `find`.

**Passage search (`find`):** one scan over the text the server already stores, from `offset`, with no index. The scan compares one key per UTF-16 code unit: case-folded, every whitespace unit collapsed into one key (and a run of them read as one), straight and curly quotes sharing a key. A unit whose case fold changes length compares as itself, so match offsets stay in stored-text coordinates. The first match sets `match`, the returned chunk starts there, and the same scan counts non-overlapping later matches. The caller's signal is checked before the scan, since nothing can abort it once it holds the event loop. `limit` still applies from the match start: trimming to a paragraph break never cuts before the match end, and a `limit` below the match length cuts the match short.

---

### `gutenberg_browse_popular`

**Purpose:** Return the most-downloaded books, with optional language, topic, MIME-prefix or copyright filters. Entry point for discovery ("what are the most-read classics?").

**Source:** the same mirror-first search path, first page only (up to 32), with popular sorting and language/topic/MIME/copyright filters. Truncated responses carry a typed `continuation` with tool `gutenberg_search_books` and executable `arguments` preserving all filters. When the local cap cuts a page, continuation repeats page 1; a fully shown page advances to page 2. Empty results preserve requested/applied caps, `shown: 0`, `truncated: false`, criteria and a notice, with no continuation.

```ts
tool('gutenberg_browse_popular', {
  description: 'Browse up to 32 Gutenberg books ordered by downloads in the last 30 days at the source snapshot, optionally filtered by language, topic, MIME prefix or copyright status. Returns IDs, titles, authors, languages, counts, and readability flags.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    mime_type: z.string().optional().describe('Literal format MIME prefix; blank means unset.'),
    copyright: z.array(z.enum(['true', 'false', 'null'])).optional().describe('Any selected copyright status: false means public domain in the USA, null means unknown; empty means all.'),
    languages: z.array(z.string().min(2).max(3)).optional()
      .describe('Restrict to books in these catalog language codes, exactly as results report them ("en", not "eng"). Example: ["en"] for English only, ["de", "fr"] for German or French, ["ang"] for Old English. Omit for all languages.'),
    topic: z.string().optional()
      .describe('Filter by a subject or bookshelf keyword (case-insensitive phrase match). Example: "science fiction", "adventure", "detective". Applies on top of the language filter.'),
    limit: z.number().int().min(1).default(20)
      .describe('Requested book limit, capped locally at 32. Default 20.'),
  }),

  output: z.object({
    books: z.array(z.object({
      id: z.number().describe('Gutenberg ID.'),
      title: z.string().describe('Book title.'),
      authors: z.array(z.object({
        name: z.string(),
        birth_year: z.number().nullable(),
        death_year: z.number().nullable(),
      })).describe('Author(s).'),
      languages: z.array(z.string()).describe('Language codes.'),
      download_count: z.number().describe('Downloads in the last 30 days at the source snapshot — the popularity ranking basis.'),
      has_plain_text: z.boolean().describe('True if media_type is "Text" AND a UTF-8 text/plain format is available via gutenberg_get_text.'),
      is_readable: z.boolean().describe('True for non-Sound records with supported UTF-8 plain text or HTML.'),
    })).describe('Top books by downloads in the last 30 days at the source snapshot, most popular first.'),
    totalInCatalog: z.number().describe('Total books matching the filter in the full catalog (useful for context — "top 20 of 60,000").'),
    requestedLimit: z.number().describe('Book limit requested before capping.'),
    appliedLimit: z.number().describe('Book limit applied locally, at most 32.'),
  }),

  errors: [{
    reason: 'catalog_unavailable', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The catalog did not respond within its budget.',
    recovery: 'Retry in a few seconds; changing filters does not resolve an upstream outage.',
    retryable: true, thrownBy: 'service',
  }],
})
```

**`format()` rendering:** ranked list with IDs, titles, contributors, languages, downloads in the last 30 days at the source snapshot, readability flags, and requested/applied limits. Enrichment discloses actual truncation and a count ceiling using the same window, with a same-filter popular-search continuation. Catalog text is Markdown-escaped; the criteria and continuation arguments render as JSON in code spans.

---

## Full-Text Handling — Detailed Design

This section specifies `gutenberg_get_text`'s text-processing pipeline. It is the primary engineering surface in this server.

### Pipeline

```
1. Resolve format             — from formats map: prefer "text/plain; charset=utf-8",
                                fall back to "text/html"; us-ascii-only books have no
                                compliant mirror path and go straight to no_text_format
2. Fetch file                  — URL is built from the book ID against the configured PG
                                mirror (default gutenberg.pglaf.org), never from Gutendex's
                                raw format URL: .../cache/epub/N/pgN.txt for utf-8,
                                .../cache/epub/N/pgN-images.html for the html fallback;
                                30s timeout
3. Decode as UTF-8             — the mirror serves generated UTF-8 bytes for both formats;
                                reject recognized invalid documents, not content headers alone
4. Strip BOM                  — remove a leading decoded UTF-8 BOM if present
5. HTML→text if needed        — tokenize once, decode character references once, exclude
                                metadata/template content, preserve block and table boundaries
                                (whitespace-only text between table, row, and cell tags is
                                dropped so a row stays on one line), then empty every line
                                holding no visible character; plain-text editions skip this
6. Normalize whitespace       — normalize CRLF→LF and collapse 3+ consecutive newlines to 2
7. Extract literary content   — extract between complete START/END marker lines when present;
                                otherwise retain the processed text; reject empty documents
                                and recognized whole-document failure templates before caching
8. Apply offset/limit         — slice the resulting string at [offset : offset + limit];
                                trim the trailing cut to the last paragraph break within
                                500 chars of the limit to avoid mid-paragraph cuts
                                (may return slightly fewer chars than limit); with find, the
                                slice starts at the first match instead of offset
9. Compute metadata           — totalChars, remainingChars, hasMore, provenance string
```

### Boilerplate boundaries (verified live)

The `*** START ***` marker appears at line 27 for Pride and Prejudice (UTF-8 files), but line number varies. Older-style files (e.g. the US-ASCII editions this server no longer fetches — see Design Decisions) start at line 1 with the `*** START ***` marker, no preceding header block. The regex handles both, so it stays tolerant of that layout wherever it shows up (e.g. inside an HTML-fallback source):

```
/^\*{3} START OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m
/^\*{3} END OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m
```

CRLF (`\r\n`) line endings are normalized to LF before matching marker lines (step 6), so extraction does not depend on carriage-return handling in the regular expressions.

The header above `*** START ***` in UTF-8 files contains: title, author, release date, most-recently-updated date, language, credits — all already in the catalog record. The footer below `*** END ***` is the full Project Gutenberg license (verified: ~350 lines for Pride and Prejudice). Strip it entirely. The provenance note in the response covers the legal attribution obligation.

### Soft line-break trimming

Rather than cutting at exactly `offset + limit` characters, find the last `\n\n` (paragraph break) within 500 characters before the limit. If found, cut there; otherwise retain the bounded slice even if it ends mid-paragraph. Continue at `offset + length` in either case.

### Caching

Cache the extracted (stripped, normalized) text through tenant-scoped storage at `gutenberg/text/v3/{id}`, with a 24-hour TTL. Chunking and passage search run after cache lookup. The version segment moves whenever the pipeline changes stored text, so offsets from an older key version do not carry over. Fetching and processing still buffer the whole book in memory; there is no document-size cap or synchronous parsing deadline.

### HTML fallback

A small minority of books lack a `text/plain; charset=utf-8` format and only have `text/html`. In this case:
- Fetch the mirror's `/cache/epub/N/pgN-images.html` (ID-derived, like the plain-text path — never Gutendex's raw `text/html` format URL, which points at the main site)
- Tokenize once with parse5-sax-parser, excluding title, script, style, and nested template content without building a document tree
- Decode character references once during parsing; retain Unicode and literal escaped references
- Preserve block breaks, table cell separators, and distinct rows, including optional closing tags. Whitespace-only text outside an open cell (between table, row, and cell tags) is source layout and is dropped, so it cannot break a row across lines; a nested table's cells never end the cell that holds it, and a row or the table closes a cell the tokenizer saw no end tag for
- Empty every line that holds no visible character: indentation nodes, `&nbsp;` spacers, and empty cells leave such lines. Plain-text editions keep theirs, since they are the source's own
- Apply the same `*** START ***/*** END ***` extraction if markers are present in the HTML source; otherwise strip all markup and return the full document body

The HTML fallback is less clean than plain text — formatting artifacts from markup are possible. Surface this via `sourceFormat: 'text/html'` in the response so callers know.

Validate media type and document shape before caching. Plain-text paths reject HTML documents; HTML paths reject narrowly recognized whole-document server templates, never error keywords inside prose or missing Gutenberg markers. Permanent mirror failures use `text_file_not_found` or `text_fetch_rejected`; invalid documents use `invalid_text_response`; transient failures retain `text_fetch_failed`. Cache keys include the processing version so prior cached extraction cannot bypass validation.

---

## Workflow Analysis

### `gutenberg_get_text` call flow

| # | Call | Purpose | Notes |
|:--|:-----|:--------|:------|
| 1 | Ready local mirror, else `GET gutendex.com/books/{id}/` | Resolve formats + verify media_type | Cached; throws `audio_book` or `no_text_format` early; live attempts consume the remaining 15s ladder budget |
| 2 | `GET <text URL>` (rewritten to HTTPS /cache/ path) | Fetch full file (no redirect required after URL rewrite) | Cached; ~500KB–3MB; 30s per attempt under a 35s ladder budget |
| — | In-process pipeline | BOM strip, HTML parsing when needed, marker extraction, normalize, chunk | CPU-only; depends on file size and format |

Two upstream calls total for a cache miss, one (or zero) for a cache hit. Worst case both hops exhaust their budgets: 50 seconds, inside the 60-second default MCP client request timeout, so the caller receives a real error instead of its own timeout. The catalog call and the text fetch are independent enough to parallelize — but since the text URL comes from the catalog record, they must be sequential on a cache miss. Parallelism only helps after the first call populates the catalog cache.

### Typical agent workflow

```
gutenberg_search_books(query="frankenstein")
  → id: 84, has_plain_text: true, is_readable: true

gutenberg_get_text(id=84, offset=0, limit=20000)
  → text: "Chapter 1. Letter 1…", totalChars: 448000, remainingChars: 428000

gutenberg_get_text(id=84, offset=20000, limit=20000)
  → text: "…", remainingChars: 408000
  ... (repeat until remainingChars === 0)
```

---

## Design Decisions

| Decision | Rationale |
|:---------|:----------|
| **4 tools, no resources or prompts** | The corpus is purely read-only; no resources add capability that tools don't already cover; no recurring interaction patterns warrant a prompt template. Lean surface reduces cognitive load. |
| **Separate `gutenberg_browse_popular` from `gutenberg_search_books`** | `browse_popular` has a distinct entry-point intent ("what should I read?") and simpler inputs. Merging it into `search_books` would bury its discovery affordance behind optional parameters. A separate tool also makes it usable as a heartbeat/health-check with zero required inputs. |
| **`gutenberg_get_book` is a separate tool from `search_books`** | The full formats map (needed before `get_text`) is not returned by search — agents need a dedicated lookup step after finding a candidate. Also allows direct ID-based access without a search round-trip when the ID is already known. |
| **Offset/limit chunking over streaming or pagination tokens** | Offset/limit is stateless (no server-side cursor), stable (within one cache key version, the same offset always returns the same content; a change to the text pipeline moves HTML offsets and bumps the key version), and safe for retry. Cursor-based pagination requires server-side state and complicates partial retries. Streaming is not supported by the MCP transport. |
| **Soft paragraph-boundary trimming on limit** | Cutting at exactly N characters mid-sentence degrades the LLM's context. A 500-character backtrack to the nearest paragraph break adds negligible overhead and produces much cleaner chunks. |
| **Prefer `text/plain; charset=utf-8` > `text/html`; no `text/plain; charset=us-ascii` fallback** | UTF-8 is the canonical modern encoding. US-ASCII-only entries (older catalog uploads) have no path on the PG-sanctioned mirror this server sources from — serving them would mean fetching the human-only main site (`www.gutenberg.org`), which its Terms of Use prohibit for automated access. Those books cleanly return `no_text_format` instead. HTML fallback is lossy but preferable to an outright error when no plain text exists. |
| **Strip boilerplate via `*** START ***/*** END ***` markers (regex, not line-number heuristic)** | Line numbers vary per file (verified: P&P has START at line 27). The markers are the canonical, stable boundary. Regex is robust to line-number drift. |
| **Cache stripped text, not raw file bytes** | The post-extraction text is what every request re-uses. Caching raw bytes wastes memory and requires re-running the extraction pipeline on every request. |
| **24-hour text cache TTL, 1-hour catalog TTL** | Text files are effectively immutable (updated at most a few times a year). Catalog metadata changes more often (download counts, new additions). Different TTLs reflect actual update frequency. |
| **No `author_year_start/end` in `browse_popular`** | `browse_popular` is a discovery shortcut, not a research tool. Year-range filtering on a popularity browse is a niche compound query that belongs in `search_books` where the fuller filter set is available. |
| **Separate `is_readable` and `has_plain_text`** | `is_readable` follows the existing reader boundary: non-Sound with UTF-8 plain text or HTML. `has_plain_text` keeps the narrower Text + UTF-8 meaning. Both are computed at hydration, so old mirror records gain readability without a harvest. |
| **Nullable source notes in the mirror** | Direct RDF book descriptions preserve explicit edition references without another fetch. An additive nullable column keeps existing rows readable with `null`; the next normal harvest distinguishes populated notes from inspected-empty `[]`. |
| **Positive requested limits with local output caps** | Text stays bounded at 50,000 characters and browse at 32 books without adding upstream work. Requested/applied limits are explicit; actual remaining text or catalog matches determine truncation. |
| **`ids` as comma-separated query string value** | The Gutendex API accepts ids as a single comma-separated value (`ids=84,1342`), not as repeated URL parameters (`ids=84&ids=1342` only returns the last value). Other filters still apply when ids is set — a conflicting language filter reduces results. The Zod input is `z.array(z.number())` and the service layer joins with commas. |
| **Fetch URLs are ID-derived, never taken from Gutendex** | Gutendex's format URLs point at the main site (`www.gutenberg.org/ebooks/N...`), which is off-limits to automated fetches (see the mirror-preference row above). The server instead builds the mirror cache path directly from the book ID (`/cache/epub/N/pgN.txt`, `/cache/epub/N/pgN-images.html`) — this also sidesteps the HTTPS→HTTP redirect that Gutendex's own `/ebooks/N.txt.utf-8` URL issues, which modern Node.js runtimes won't follow. |
| **MIME-prefix discovery filter** | Format-key prefixes select a corpus before counts and pagination; readability flags still describe each returned edition's reader support. |
| **Tri-state copyright discovery filter** | Corpus selection preserves copyrighted, public-domain-in-USA and unknown source classifications independently, without implying worldwide legal clearance. |
| **`summary` as nullable, with the full `summaries` array alongside** | The AI-generated `summaries` array is a recent Gutendex addition absent on many older records. `summary` stays a nullable string — the first element if present — so the common single-summary read needs no array handling; `summaries` carries the complete set for the records that hold more than one, which reducing to the first element silently dropped. `content[]` lists only the entries beyond `summary` rather than repeating a multi-hundred-character paragraph. |
| **`content[]` states absent fields rather than omitting them** | `structuredContent` carries `[]` and `null` verbatim, so a formatter that drops the line leaves a `content[]`-only client unable to distinguish a known-empty field from one the server never reported. Every collection and nullable in `gutenberg_get_book`, and the per-book subject list in `gutenberg_search_books`, therefore render unconditionally. Sentinel-based `format-parity` linting exercises one populated value per leaf and cannot catch value-dependent omission, so the empty states are covered by tests instead. |
| **Refuse audio books explicitly** | Audio books have `media_type: "Sound"` and no literary text. Returning a readme file or an error without a clear message would confuse agents. The `audio_book` error contract gives a specific reason and recovery path. |
| **Passage search is `find` on `gutenberg_get_text`, not a separate tool** | The scan runs over text the server already stores, adds no index, and a separate tool would repeat the fetch path. Callers jump to a quote or heading in one call instead of paging a novel in ~15. |
| **`find` is scanned by hand, not with a regex** | A regex built from caller text throws on long input, goes super-linear on periodic text, and can start a match inside a surrogate pair. A single linear pass over per-code-unit keys is bounded whatever the text or `find` holds, so `find` needs no length limit. |
| **Source notes are fenced, not escaped** | Most notes hold a URL an agent may copy; escaping would put a backslash inside it. A fenced `text` block carries them verbatim. |
| **`translator` is mirror-only and fails loudly without it** | Gutendex has no translator parameter. Dropping the filter on the live fallback would return an unfiltered list that looks like a match, so the call fails with `translator_requires_mirror` instead. |
| **Two author-year bounds require one author to meet both** | A book-level OR over the stored extremes lets one author satisfy the start and another the end, which matches neither author's lifespan. The mirror checks per author; the live catalog cannot, and says so in a notice. |
| **`languages` takes 2–3 letter catalog codes, with no off switch on the raised cap** | The catalog holds three-letter codes (`ang`, `enm`) the old two-character cap rejected. The raised cap only accepts input that was previously rejected and changes no existing call's result, so an off switch would add a mode with nothing to protect; exact matching stays, and a three-letter miss such as `eng` gets a notice that codes match exactly. |
| **One wall-clock budget per upstream ladder, composed with `ctx.signal`** | The composed signal bounds in-flight attempts as well as retry backoff; the helper also normalizes exhausted ladders and preserves caller cancellation. The catalog gets 15s and the text mirror 35s, inside the default 60s client timeout. |
| **Catalog attempts use the remaining 15s budget** | An uninterrupted slow response can succeed within the existing budget. Framework retry deadlines and attempt signals bound the ladder; fast failures still retry, cancellation stays cancellation, and the text mirror retains its 30s per-attempt ceiling and 35s total budget. |
| **Upstream outages are declared contract reasons, not bubbled fetch errors** | `catalog_unavailable` (all four tools) and `text_fetch_failed` (`gutenberg_get_text`) carry a recovery hint to both `structuredContent.error.data` and the mirrored `content[]` text. Their messages name the catalog or the book rather than the resolved request URL, which embeds an operator-configured, overridable base URL. The original error stays on `cause` for server-side logs. A caller cancel is never relabelled — it is not an upstream outage, and advertising a retry for it would be wrong. |
| **`GUTENDEX_BASE_URL` and `GUTENBERG_TEXT_BASE_URL` override env vars** | Gutendex is open-source and self-hostable; the project explicitly encourages it. Some deployers may also run Gutenberg mirrors. Overrides cost nothing to implement and unlock private/enterprise deployments. |

---

## Known Limitations

| Limitation | Detail |
|:-----------|:-------|
| **Audio entries are metadata-only** | `media_type: "Sound"` records are rejected by the reader regardless of formats. Other media types follow the supported UTF-8 plain-text or HTML formats. |
| **ASCII-only entries are unreadable** | Older catalog entries whose only plain-text format is `text/plain; charset=us-ascii` have no path on the PG-sanctioned mirror this server sources from — serving them would require fetching the human-only main site, which its Terms of Use prohibit. These return `no_text_format` rather than falling back to the main site. |
| **No chapter-aware chunking** | Chapter boundaries in Gutenberg plain-text files are not consistently marked across the catalog (headings vary — "Chapter I", "CHAPTER 1", "Part First", etc.). The design uses paragraph-boundary chunking, which is reliable and consistent. True chapter detection would require per-book parsing heuristics and is deferred; `find` with the heading text jumps to a chapter start without it. |
| **HTML fallback quality** | Books fetched via the HTML fallback may include formatting artifacts from markup conversion. The `sourceFormat` field signals this so agents can note the limitation. |
| **Gutendex page size capped at 32** | The Gutendex API returns at most 32 results per page with no `page_size` parameter. Agents needing more results must call `gutenberg_search_books` multiple times with incrementing `page` values. |
| **Very large books** | War and Peace is ~3MB of stripped text, over 150 20,000-character chunks. The in-process cache holds this fine, but complete ingestion by an agent would require many sequential calls. This is a corpus property, not a server limitation — the chunking design exists specifically to handle it. |
| **Gutenberg mirror latency** | The configured Project Gutenberg content mirror (`gutenberg.pglaf.org` by default) can be slow, especially for less-popular books whose files are not in its cache. The 30-second fetch timeout and 24-hour text cache mitigate repeated latency. |
| **Gutendex API availability** | Gutendex is a community-run service, and cold queries routinely stall past its own gateway boundary. A ladder that exhausts its budget surfaces `catalog_unavailable` with a retry hint; the `GUTENDEX_BASE_URL` override exists to allow fallback to a private Gutendex instance if the public one is unavailable. |
