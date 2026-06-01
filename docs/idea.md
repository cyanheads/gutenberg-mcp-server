# gutenberg-mcp-server — idea

Project Gutenberg's 75,000+ public-domain ebooks — searchable by author, title, subject, or language, with retrieval of the **actual full text**. The catalog comes from the keyless Gutendex API; the readable content from Gutenberg's plain-text files.

Where book-metadata sources return editions, ISBNs, and covers, this returns the complete works of out-of-copyright literature — ready for an agent to read, quote, or analyze. "Get me the full text of *Pride and Prejudice*" is the target capability.

**Audience:** Readers, students, literature researchers, writers, and agents doing textual analysis, quote-finding, or close reading of classic works — anyone who needs the words, not just the catalog record.

## User Goals

- Find public-domain books by author, title, subject, or language
- Get a book's metadata and available formats/download links
- Retrieve the full plain text of a book (or a section of it)
- Discover the most-downloaded / most-popular titles
- Confirm a work is in the public domain and available

## API Surface

Gutendex (keyless JSON over the Project Gutenberg catalog) for search/metadata; Gutenberg's file servers for content. Books are keyed by integer Gutenberg ID (e.g. `1342` = *Pride and Prejudice*).

| Endpoint | Purpose | Notes |
|:---------|:--------|:------|
| `gutendex.com/books` | Search/filter the catalog | `search`, `topic`, `languages`, `author_year_start/end`, `sort`, `ids` |
| `gutendex.com/books/{id}` | One book's record | Title, authors, subjects, bookshelves, languages, download_count, `formats` map |
| `formats[...]` URLs | Content files | `text/plain`, `text/html`, `application/epub+zip`, etc. — full text lives here |

Each record's `formats` map points at the actual files (plain text, HTML, EPUB). The plain-text URL is what `gutenberg_get_text` fetches and returns.

## Tool Surface (sketch)

```
gutenberg_search_books  — search/filter the catalog. query (title/author), topic
                          (subject/bookshelf), languages, author birth/death-year range,
                          sort (popular | ascending | descending by id). Returns books
                          with Gutenberg id, title, authors (+ life years), subjects,
                          language, and download_count. Discovery entry point.

gutenberg_get_book      — full record for a Gutenberg id: title, authors, subjects,
                          bookshelves, languages, download_count, and the formats map
                          (plain text / HTML / EPUB download URLs). The hub before
                          reading or linking.

gutenberg_get_text      — retrieve the full plain-text content of a book by id. Resolves
                          the text/plain format, strips the Gutenberg license header/
                          footer, and returns the work — with length-aware chunking
                          (offset/limit or chapter-ish slicing) and "…N more" so a long
                          novel doesn't blow the context budget. The standout capability.

gutenberg_browse_popular — top books by download_count, optionally by language/topic.
                          "What are the most-read classics?" A heartbeat/discovery tool.
```

## Design Notes

- Low complexity — clean keyless REST + plain-text fetch. The only real design work is **full-text handling**: novels are large, so `gutenberg_get_text` needs offset/limit (and ideally chapter-aware) chunking with clear "more remaining" signals, never a silent truncation.
- **Strip the boilerplate.** Gutenberg files carry a standard license header/footer; remove it so the agent gets the work, not the legal preamble — but keep a one-line provenance + license note in the response metadata.
- Prefer `text/plain; charset=utf-8` formats; fall back to HTML→text when a title lacks a plain-text file. Some very old entries have quirky encodings — normalize to UTF-8.
- `download_count` is a genuine popularity signal (real metric, not fabricated) — good for `sort=popular` and `browse_popular`.
- Catalog is **English-heavy but multilingual** (60+ languages) — expose the `languages` filter prominently.
- Fully keyless and cache-friendly (the public-domain corpus barely changes) — cache catalog lookups and text aggressively.
- Composes with book-metadata servers like `openlibrary` (match a Gutenberg book to its ISBN/editions/cover), and with `wikidata`/`wikipedia` (author context and work background). The pairing with `openlibrary` is the strongest: metadata there, full text here.
- Moonshot: a "read-and-analyze" workflow — resolve a title, stream the text in chunks, and support search-within-book (find a passage/quote) so agents can do close reading without holding the whole novel in context.

**README one-liner:** "75,000+ public-domain books with full text — search the classics and actually read them."
