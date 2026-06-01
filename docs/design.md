# gutenberg-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `gutenberg_search_books` | Search the Project Gutenberg catalog by title/author, topic, language, author lifespan, or ID list | `query`, `topic`, `languages`, `author_year_start`, `author_year_end`, `sort`, `ids`, `page` | `readOnlyHint: true` |
| `gutenberg_get_book` | Fetch full metadata for a single book by Gutenberg ID | `id` | `readOnlyHint: true`, `idempotentHint: true` |
| `gutenberg_get_text` | Retrieve the plain-text content of a book, stripped of the license boilerplate, with offset/limit chunking | `id`, `offset`, `limit` | `readOnlyHint: true`, `idempotentHint: true` |
| `gutenberg_browse_popular` | Return the most-downloaded books, optionally filtered by language or topic | `languages`, `topic`, `limit` | `readOnlyHint: true` |

### Resources

None. The tool surface is self-sufficient for tool-only agents. A `gutenberg://books/{id}` resource could expose metadata as injectable context, but since all clients have `gutenberg_get_book`, adding a resource would duplicate without adding capability.

### Prompts

None. This is a data-access server without recurring agent interaction patterns that warrant a reusable prompt template.

---

## Overview

An MCP server wrapping Project Gutenberg's 78,000+ public-domain ebook corpus. Catalog search and metadata come from the Gutendex API (keyless JSON); full book text comes from Gutenberg's plain-text file servers. The distinguishing capability — absent from every book-metadata server — is `gutenberg_get_text`: it fetches, strips boilerplate, and returns the actual literary content of a work in context-budget-safe chunks. No API key required.

**Audience:** Readers, students, literature researchers, writers, and AI agents doing textual analysis, quote-finding, or close reading of classic works.

---

## Requirements

- No authentication — Gutendex is fully public and keyless
- Gutendex base URL: `https://gutendex.com/books/` (the `/books` path redirects 301 → `/books/`; implementation must use trailing slash or follow redirects)
- Catalog returns up to 32 results per page; `next` and `previous` are full URLs, not cursor tokens
- Plain-text files served from `https://www.gutenberg.org/`; two URL patterns exist depending on the format key:
  - `text/plain; charset=utf-8` format URLs use `/ebooks/N.txt.utf-8`, which issues an HTTP 302 to `http://www.gutenberg.org/cache/epub/N/pgN.txt` (HTTP, not HTTPS). Modern runtimes (Node.js undici, native fetch) do not follow HTTPS→HTTP redirects by default. **Implementation must rewrite the URL directly to `https://www.gutenberg.org/cache/epub/N/pgN.txt` — same host, same path, HTTPS — rather than following the redirect.**
  - `text/plain; charset=us-ascii` format URLs use `/files/N/N-0.txt` directly (no redirect; HTTPS 200)
- UTF-8 files begin with a UTF-8 BOM (`\xEF\xBB\xBF`) — strip it. US-ASCII files do not have a BOM.
- UTF-8 files have `[header block] *** START OF ... *** [content] *** END OF ... *** [license footer]` structure. US-ASCII files (older catalog entries) start directly with `*** START OF ... ***` — no preceding header block. Both formats use the same `*** START/END ***` regex for extraction.
- Both file types use CRLF (`\r\n`) line endings throughout. The CRLF normalization step (step 6) handles this.
- Strip everything outside the `*** START ***` / `*** END ***` markers; keep a one-line provenance note in response metadata
- Prefer `text/plain; charset=utf-8` from the formats map; fall back to `text/plain; charset=us-ascii`; fall back to HTML→text when no plain-text format exists
- Audio books (`media_type === "Sound"`) have no literary plain text — they may have a `text/plain` format in their formats map, but it is a readme/index file for the audio recording, not the literary work. Return a clear error for any `media_type === "Sound"` book regardless of format availability.
- Normalize all fetched text to UTF-8 before serving
- No rate-limit headers observed on Gutendex; apply conservative client-side throttling (e.g., 4 concurrent requests max)
- Cache catalog GET responses (TTL: 1 hour) and full-text file fetches (TTL: 24 hours) — the public-domain corpus changes rarely

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `GutendexService` | Gutendex catalog API (`gutendex.com/books/`) | `gutenberg_search_books`, `gutenberg_get_book`, `gutenberg_browse_popular` |
| `GutenbergTextService` | Project Gutenberg plain-text file servers (`www.gutenberg.org`) | `gutenberg_get_text` |

Both services are thin HTTP clients with retry, timeout, and response-parse logic. No shared state beyond an optional in-process response cache.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `GUTENDEX_BASE_URL` | No | Override Gutendex base URL (default: `https://gutendex.com/books/`). Gutendex is self-hostable — useful for private instances. |
| `GUTENBERG_TEXT_BASE_URL` | No | Override Gutenberg content base URL (default: `https://www.gutenberg.org`). For mirrors or caching proxies. |

No API keys. Both overrides exist to support self-hosted Gutendex instances and Gutenberg mirrors, which the project explicitly encourages.

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

**Upstream call:** `GET https://gutendex.com/books/?search=...&topic=...&languages=...&sort=...&page=...`

```ts
tool('gutenberg_search_books', {
  description: 'Search the Project Gutenberg catalog of 78,000+ public-domain books. Matches title and author name with query words; filters by topic (subject or bookshelf keyword), language, author lifespan, or a specific list of Gutenberg IDs. Results are ordered by popularity (download count) by default. Returns book ID, title, authors, languages, subjects, and download count — use gutenberg_get_book for the full formats map before fetching text.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().optional()
      .describe('Words to match against book titles and author names (case-insensitive, space-separated). Example: "dickens expectations" matches Great Expectations by Charles Dickens.'),
    topic: z.string().optional()
      .describe('Case-insensitive phrase to match against subjects and bookshelves. Example: "detective" returns books on the "Detective and Mystery Stories" bookshelf and with subject "Detective and mystery stories". Separate from query — topic searches categorization metadata, not title/author.'),
    languages: z.array(z.string().min(2).max(2)).optional()
      .describe('Filter to books in any of these two-character ISO 639-1 language codes. Example: ["en"] for English, ["fr", "de"] for French or German. The catalog spans 60+ languages; English is by far the largest set.'),
    author_year_start: z.number().int().optional()
      .describe('Include only books with at least one author alive on or after this year (positive = CE, negative = BCE). Example: 1800 limits to authors alive from 1800 onward. Combine with author_year_end for a range.'),
    author_year_end: z.number().int().optional()
      .describe('Include only books with at least one author alive on or before this year. Example: author_year_start=1800 with author_year_end=1899 returns books with 19th-century authors.'),
    sort: z.enum(['popular', 'ascending', 'descending']).default('popular')
      .describe('Result ordering. "popular" (default) sorts by download count descending — most-read classics first. "ascending" and "descending" sort by Gutenberg ID number, which correlates roughly with upload recency (lower IDs are older uploads).'),
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
      languages: z.array(z.string()).describe('Two-character language codes for this edition.'),
      subjects: z.array(z.string()).describe('Library of Congress subject headings for the work.'),
      download_count: z.number().describe('Total downloads from Project Gutenberg — a real popularity signal reflecting actual reader interest.'),
      has_plain_text: z.boolean().describe('True if the book has media_type "Text" AND a text/plain format available — both conditions required as audio books (media_type "Sound") can also have text/plain entries that are readme files, not literary content. Use this as the prerequisite check for gutenberg_get_text.'),
    })).describe('Matching books, ordered by the sort parameter.'),
    totalCount: z.number().describe('Total number of books matching the query across all pages.'),
    page: z.number().describe('Current page number.'),
    hasMore: z.boolean().describe('True if there are additional pages of results.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query matched no books in the catalog.',
      recovery: 'Broaden the search — try fewer or different query words, remove language filters, or check the topic spelling.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A language code is not a valid two-character ISO 639-1 code.',
      recovery: 'Use two-character language codes such as "en", "fr", "de", "es", "it", "pt", "nl", "fi", "ru".',
    },
  ],
})
```

**`format()` rendering:** table of results with id, title, authors, language, download count, and `has_plain_text` flag; total count + page info; note if `hasMore`.

---

### `gutenberg_get_book`

**Purpose:** Fetch the complete metadata record for a single book by its Gutenberg ID, including the full formats map needed before fetching text.

**Upstream call:** `GET https://gutendex.com/books/{id}/`

```ts
tool('gutenberg_get_book', {
  description: 'Fetch complete metadata for a Project Gutenberg book by ID — title, authors (with birth/death years), translators, editors, subjects, bookshelves, languages, copyright status, and the full formats map with download URLs for each available format (plain text, HTML, EPUB, cover image, etc.). Use this before gutenberg_get_text to confirm a plain-text format is available and to get the direct download URL.',
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
    languages: z.array(z.string()).describe('Two-character language codes for this edition.'),
    copyright: z.boolean().nullable().describe('Copyright status: false = public domain in the USA, true = under copyright, null = unknown.'),
    media_type: z.string().describe('"Text" for readable books, "Sound" for audio books. Only "Text" books have plain-text content available for gutenberg_get_text.'),
    download_count: z.number().describe('Total downloads — popularity signal.'),
    summary: z.string().nullable().describe('Auto-generated summary of the work, when available. Absent on many older records.'),
    formats: z.record(z.string()).describe('Map of MIME type to download URL. Key types: "text/plain; charset=utf-8" (preferred for gutenberg_get_text), "text/html", "application/epub+zip", "image/jpeg" (cover). Not every format is present for every book.'),
    has_plain_text: z.boolean().describe('True if media_type is "Text" AND a text/plain format (UTF-8 or ASCII) is present in formats — prerequisite for gutenberg_get_text. Audio books (media_type "Sound") may have text/plain entries that are readme files; they return false here.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery: 'Verify the ID with gutenberg_search_books. Gutenberg IDs are positive integers; this ID does not match any entry in the catalog.',
    },
  ],
})
```

**`format()` rendering:** structured display of title, authors (with years), translators/editors if present, subjects, bookshelves, languages, copyright, download count, summary if present, and all formats as a readable key→URL list.

---

### `gutenberg_get_text`

**Purpose:** Retrieve the literary content of a book as plain text, stripped of the Gutenberg license boilerplate, with offset/limit chunking for context-budget management.

**Upstream calls:**
1. `GET https://gutendex.com/books/{id}/` — resolve the `text/plain; charset=utf-8` (or fallback) URL from the formats map
2. `GET https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt` — fetch the full plain-text file. For UTF-8 format: the formats map URL (`/ebooks/N.txt.utf-8`) redirects via HTTP 302 to an HTTP URL; instead, rewrite directly to the HTTPS `/cache/epub/N/pgN.txt` path. For US-ASCII format: use the `/files/N/N-0.txt` URL from the formats map directly (no redirect).

**This is the core design challenge.** Full notes in the Design Decisions section below.

```ts
tool('gutenberg_get_text', {
  description: 'Retrieve the plain-text content of a Project Gutenberg book, stripped of the standard license header and footer so the response contains only the literary work. For long works — novels routinely run 500KB–2MB — use offset and limit to read in chunks rather than fetching the whole book at once. The response reports totalChars and remainingChars so the caller can page through without guessing. Prefers UTF-8 plain text; falls back to ASCII plain text; refuses audio books (media_type "Sound") with a clear error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    id: z.number().int().positive()
      .describe('Project Gutenberg book ID. Use gutenberg_search_books or gutenberg_get_book to find IDs. Example: 1342 for Pride and Prejudice, 2600 for War and Peace, 84 for Frankenstein.'),
    offset: z.number().int().min(0).default(0)
      .describe('Character offset into the stripped literary text (after boilerplate removal) at which to start reading. 0 returns the beginning of the work. Use the remainingChars field from a prior response to determine whether to continue paging. Offsets are byte-stable within a release — re-fetching the same offset always returns the same content.'),
    limit: z.number().int().min(1).max(50000).default(20000)
      .describe('Maximum number of characters to return in this chunk. Default 20,000 characters (~4–5 pages of prose) is a safe starting size for most context windows. Increase toward 50,000 for large context windows; decrease if the response is too large for downstream processing. The actual returned length may be slightly less than limit when a natural paragraph boundary is found within 500 characters of the requested limit — this prevents mid-sentence cuts.'),
  }),

  output: z.object({
    id: z.number().describe('Gutenberg book ID.'),
    title: z.string().describe('Book title, from the catalog record.'),
    text: z.string().describe('The requested chunk of literary text, stripped of Gutenberg license boilerplate. Encoding: UTF-8. Line endings: normalized to LF.'),
    offset: z.number().describe('Character offset where this chunk begins.'),
    length: z.number().describe('Number of characters in this chunk.'),
    totalChars: z.number().describe('Total characters in the stripped literary text. Use with offset and length to determine progress and plan subsequent calls.'),
    remainingChars: z.number().describe('Characters remaining after this chunk (totalChars - offset - length). 0 means this chunk includes the end of the book.'),
    hasMore: z.boolean().describe('True if there is more text after this chunk. When true, call again with offset = offset + length.'),
    provenance: z.string().describe('One-line source note: Project Gutenberg ID, title, and license URL. Always "Project Gutenberg eBook #{id}: {title} — https://www.gutenberg.org/ebooks/{id} — License: www.gutenberg.org/license".'),
    sourceFormat: z.enum(['text/plain; charset=utf-8', 'text/plain; charset=us-ascii', 'text/html'])
      .describe('The format that was fetched. "text/html" indicates HTML-to-text conversion was applied because no plain-text format was available.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No book exists with the given ID.',
      recovery: 'Verify the ID with gutenberg_search_books. The ID must be a positive integer matching a catalog entry.',
    },
    {
      reason: 'audio_book',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The book is an audio recording (media_type "Sound"), not a text book — no literary plain text is available.',
      recovery: 'This Gutenberg entry is an audio book. Use gutenberg_search_books or gutenberg_get_book to find a text edition of the same work, then call gutenberg_get_text on that ID.',
    },
    {
      reason: 'no_text_format',
      code: JsonRpcErrorCode.NotFound,
      when: 'The book record exists but has no plain-text or HTML format in its formats map — rare for very old or incomplete entries.',
      recovery: 'Call gutenberg_get_book to inspect the available formats. The book may only be available as EPUB or other formats that this server does not convert.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The offset is greater than or equal to totalChars (past the end of the book).',
      recovery: 'Use an offset less than totalChars. A prior response\'s remainingChars field shows how much text is left.',
    },
    {
      reason: 'text_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Gutenberg file server returned an error or did not respond within the timeout.',
      recovery: 'Project Gutenberg file servers are sometimes slow. Retry after a short delay. If the error persists, the file may be temporarily unavailable.',
      retryable: true,
    },
  ],
})
```

**`format()` rendering:** provenance line, chunk position summary ("Characters 0–19,999 of 772,389 — 752,389 remaining"), then the text content. When `hasMore` is true, append a clear call-to-action: "Call gutenberg_get_text again with id={id}, offset={offset+length} to read the next chunk."

---

### `gutenberg_browse_popular`

**Purpose:** Return the most-downloaded public-domain books, with optional language or topic filters. Entry point for discovery ("what are the most-read classics?").

**Upstream call:** `GET https://gutendex.com/books/?sort=popular&languages=...&topic=...` (first page only, up to 32 results)

```ts
tool('gutenberg_browse_popular', {
  description: 'Browse the most-downloaded Project Gutenberg books, ordered by popularity. Returns up to 32 titles with their Gutenberg IDs, authors, languages, and download counts. Optionally filter by language or topic. Use this as a discovery entry point — "what are the most popular classics in French?" — or as a heartbeat check that the catalog is reachable.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    languages: z.array(z.string().min(2).max(2)).optional()
      .describe('Restrict to books in these languages (two-character ISO 639-1 codes). Example: ["en"] for English only, ["de", "fr"] for German or French. Omit for all languages.'),
    topic: z.string().optional()
      .describe('Filter by a subject or bookshelf keyword (case-insensitive phrase match). Example: "science fiction", "adventure", "detective". Applies on top of the language filter.'),
    limit: z.number().int().min(1).max(32).default(20)
      .describe('Number of books to return (1–32). Default 20 gives a useful overview without overwhelming context.'),
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
      download_count: z.number().describe('Total downloads — the basis for the popularity ranking.'),
      has_plain_text: z.boolean().describe('True if media_type is "Text" AND a text/plain format is available via gutenberg_get_text.'),
    })).describe('Top books by download count, most popular first.'),
    totalInCatalog: z.number().describe('Total books matching the filter in the full catalog (useful for context — "top 20 of 60,000").'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No books match the language/topic filter combination.',
      recovery: 'Try a broader topic phrase or remove the language filter. The catalog is large but topic matching is phrase-based — "detective fiction" may miss books shelved under "Mystery".',
    },
  ],
})
```

**`format()` rendering:** ranked list with rank number, title, author(s), language(s), download count, and plain-text availability flag; total count note at top.

---

## Full-Text Handling — Detailed Design

This section specifies `gutenberg_get_text`'s text-processing pipeline. It is the primary engineering surface in this server.

### Pipeline

```
1. Resolve format URL         — from formats map: prefer "text/plain; charset=utf-8",
                                fall back to "text/plain; charset=us-ascii",
                                fall back to "text/html"
2. Fetch file                 — for utf-8 format: rewrite URL to
                                https://www.gutenberg.org/cache/epub/N/pgN.txt
                                (avoids HTTPS→HTTP redirect that modern runtimes reject);
                                for us-ascii format: fetch /files/N/N-0.txt directly;
                                30s timeout
3. Strip BOM                  — remove leading \xEF\xBB\xBF if present (utf-8 files only)
4. Normalize encoding         — if fetched as us-ascii, re-encode to UTF-8 via TextDecoder
5. Extract literary content   — find "*** START OF THE PROJECT GUTENBERG EBOOK … ***"
                                and "*** END OF THE PROJECT GUTENBERG EBOOK … ***";
                                extract everything between them (exclusive);
                                throw no_text_format if neither marker is found
6. Normalize whitespace       — all Gutenberg plain-text files use CRLF line endings;
                                normalize CRLF→LF first; then collapse 3+ consecutive
                                blank lines to 2
7. HTML→text if needed        — when sourceFormat is text/html: strip tags, decode
                                HTML entities, preserve paragraph breaks as double-newlines
8. Apply offset/limit         — slice the resulting string at [offset : offset + limit];
                                trim the trailing cut to the last paragraph break within
                                500 chars of the limit to avoid mid-paragraph cuts
                                (may return slightly fewer chars than limit)
9. Compute metadata           — totalChars, remainingChars, hasMore, provenance string
```

### Boilerplate boundaries (verified live)

The `*** START ***` marker appears at line 27 for Pride and Prejudice (UTF-8 files), but line number varies. US-ASCII files (older entries) start at line 1 with the `*** START ***` marker — no preceding header block. The regex handles both:

```
/^\*{3} START OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m
/^\*{3} END OF THE PROJECT GUTENBERG EBOOK .+? \*{3}$/m
```

Files use CRLF (`\r\n`) line endings, so marker lines end with `\r` before `\n`. JavaScript multiline `$` matches before `\n` (after consuming the `\r` into `.+?`). The `\r` at the end of the captured title text is harmless; the extraction uses only the match's index position for the split point. Strip CRLF→LF before any further processing (step 6).

The header above `*** START ***` in UTF-8 files contains: title, author, release date, most-recently-updated date, language, credits — all already in the catalog record. The footer below `*** END ***` is the full Project Gutenberg license (verified: ~350 lines for Pride and Prejudice). Strip it entirely. The provenance note in the response covers the legal attribution obligation.

### Soft line-break trimming

Rather than cutting at exactly `offset + limit` characters, find the last `\n\n` (paragraph break) within 500 characters before the limit. If found, cut there. This ensures the agent always receives complete paragraphs and can continue with the next `\n\n`-bounded unit at the next offset. Cap the backtrack at 500 characters to prevent pathological cases in poetry or dialogue where paragraphs are very short.

### Caching

Full-text files are static for months or years. Cache the extracted (stripped, normalized) text in-process keyed by Gutenberg ID, with a 24-hour TTL. The cache stores the full stripped text as a string; the chunking is applied per-request after cache lookup. Memory budget: War and Peace ~3MB uncompressed, typical novel ~500KB; 100 cached novels ≈ 50MB worst-case — acceptable for a process with no other significant state.

### HTML fallback

A small minority of books lack a `text/plain` format and only have `text/html`. In this case:
- Fetch the `text/html` URL
- Strip HTML tags (a regex or a lightweight parser — `node-html-markdown` or similar)
- Decode HTML entities
- Preserve `<p>`, `<br>`, `<h1>`–`<h6>`, `<hr>` as paragraph/heading breaks
- Apply the same `*** START ***/*** END ***` extraction if markers are present in the HTML source; otherwise strip all markup and return the full document body

The HTML fallback is less clean than plain text — formatting artifacts from markup are possible. Surface this via `sourceFormat: 'text/html'` in the response so callers know.

---

## Workflow Analysis

### `gutenberg_get_text` call flow

| # | Call | Purpose | Notes |
|:--|:-----|:--------|:------|
| 1 | `GET gutendex.com/books/{id}/` | Resolve format URL + verify media_type | Cached; throws `audio_book` or `no_text_format` early |
| 2 | `GET <text URL>` (rewritten to HTTPS /cache/ path) | Fetch full file (no redirect required after URL rewrite) | Cached; ~500KB–3MB; 30s timeout |
| — | In-process pipeline | BOM strip, marker extraction, normalize, chunk | CPU-only; ~1–5ms |

Two upstream calls total for a cache miss, one (or zero) for a cache hit. The catalog call and the text fetch are independent enough to parallelize — but since the text URL comes from the catalog record, they must be sequential on a cache miss. Parallelism only helps after the first call populates the catalog cache.

### Typical agent workflow

```
gutenberg_search_books(query="frankenstein")
  → id: 84, has_plain_text: true

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
| **Offset/limit chunking over streaming or pagination tokens** | Offset/limit is stateless (no server-side cursor), stable (same offset always returns same content), and safe for retry. Cursor-based pagination requires server-side state and complicates partial retries. Streaming is not supported by the MCP transport. |
| **Soft paragraph-boundary trimming on limit** | Cutting at exactly N characters mid-sentence degrades the LLM's context. A 500-character backtrack to the nearest paragraph break adds negligible overhead and produces much cleaner chunks. |
| **Prefer `text/plain; charset=utf-8` > `text/plain; charset=us-ascii` > `text/html`** | UTF-8 is the canonical modern encoding; the ASCII fallback handles a large swath of older entries. HTML fallback is lossy but preferable to an outright error when no plain text exists. |
| **Strip boilerplate via `*** START ***/*** END ***` markers (regex, not line-number heuristic)** | Line numbers vary per file (verified: P&P has START at line 27). The markers are the canonical, stable boundary. Regex is robust to line-number drift. |
| **Cache stripped text, not raw file bytes** | The post-extraction text is what every request re-uses. Caching raw bytes wastes memory and requires re-running the extraction pipeline on every request. |
| **24-hour text cache TTL, 1-hour catalog TTL** | Text files are effectively immutable (updated at most a few times a year). Catalog metadata changes more often (download counts, new additions). Different TTLs reflect actual update frequency. |
| **No `author_year_start/end` in `browse_popular`** | `browse_popular` is a discovery shortcut, not a research tool. Year-range filtering on a popularity browse is a niche compound query that belongs in `search_books` where the fuller filter set is available. |
| **`has_plain_text` computed field on search/browse results** | Saves agents an extra `get_book` call just to check format availability. Computed as `media_type === "Text" AND (formats has "text/plain; charset=utf-8" OR "text/plain; charset=us-ascii")`. The media_type guard is required: audio books (media_type "Sound") can have text/plain entries in their formats map, but those are readme/index files for the audio recording, not literary text. |
| **`ids` as comma-separated query string value** | The Gutendex API accepts ids as a single comma-separated value (`ids=84,1342`), not as repeated URL parameters (`ids=84&ids=1342` only returns the last value). Other filters still apply when ids is set — a conflicting language filter reduces results. The Zod input is `z.array(z.number())` and the service layer joins with commas. |
| **HTTPS→HTTP redirect on text file fetch** | The format URL for `text/plain; charset=utf-8` (`/ebooks/N.txt.utf-8`) redirects via HTTP 302 to `http://` (not `https://`). Modern Node.js runtimes do not follow HTTPS→HTTP redirects. Instead of following the redirect, rewrite the URL directly to the HTTPS cache path (`https://www.gutenberg.org/cache/epub/N/pgN.txt`). US-ASCII files (`/files/N/N-0.txt`) serve directly over HTTPS with no redirect. |
| **No `mime_type` filter parameter exposed** | The Gutendex `mime_type` filter exists but is low-value for agents: agents want "books with readable text" not "books with this exact MIME string". The `has_plain_text` computed field covers the practical need. |
| **`copyright` filter not exposed** | All Gutenberg books are public domain or public-domain-in-USA (copyright: false). The `true` and `null` buckets are edge cases not relevant to the server's stated purpose. Exposing the filter would add noise for no agent benefit. |
| **`summary` as nullable** | The AI-generated `summaries` array is a recent Gutendex addition absent on many older records. Expose as a nullable string (first element of the array if present, null otherwise) to avoid forcing agents to handle the array structure. |
| **Refuse audio books explicitly** | Audio books have `media_type: "Sound"` and no literary text. Returning a readme file or an error without a clear message would confuse agents. The `audio_book` error contract gives a specific reason and recovery path. |
| **No search-within-book tool (deferred)** | Passage/quote search within a book requires either full-text indexing (non-trivial service layer) or sequential scanning across chunks (many API calls). Deferred to a future enhancement. Agents can page through `get_text` chunks and apply their own search logic. |
| **`GUTENDEX_BASE_URL` and `GUTENBERG_TEXT_BASE_URL` override env vars** | Gutendex is open-source and self-hostable; the project explicitly encourages it. Some deployers may also run Gutenberg mirrors. Overrides cost nothing to implement and unlock private/enterprise deployments. |

---

## Known Limitations

| Limitation | Detail |
|:-----------|:-------|
| **Text-only corpus** | Only books with `media_type: "Text"` are servable. Audio books (over 1,000 entries) are accessible as metadata but not readable text. |
| **No chapter-aware chunking** | Chapter boundaries in Gutenberg plain-text files are not consistently marked across the catalog (headings vary — "Chapter I", "CHAPTER 1", "Part First", etc.). The design uses paragraph-boundary chunking, which is reliable and consistent. True chapter detection would require per-book parsing heuristics and is deferred. |
| **HTML fallback quality** | Books fetched via the HTML fallback may include formatting artifacts from markup conversion. The `sourceFormat` field signals this so agents can note the limitation. |
| **Gutendex page size capped at 32** | The Gutendex API returns at most 32 results per page with no `page_size` parameter. Agents needing more results must call `gutenberg_search_books` multiple times with incrementing `page` values. |
| **Very large books** | War and Peace is ~3MB of stripped text, over 150 20,000-character chunks. The in-process cache holds this fine, but complete ingestion by an agent would require many sequential calls. This is a corpus property, not a server limitation — the chunking design exists specifically to handle it. |
| **Gutenberg file server latency** | The Project Gutenberg file servers (`www.gutenberg.org`) can be slow, especially for less-popular books whose files are not in the CDN cache. The 30-second fetch timeout and 24-hour text cache mitigate repeated latency. |
| **Gutendex API availability** | Gutendex is a community-run service. The `GUTENDEX_BASE_URL` override exists to allow fallback to a private Gutendex instance if the public one is unavailable. |
