---
name: gutenberg-guide
description: Gates and workflows for the gutenberg_* tools over Project Gutenberg. Covers deciding whether a book can be read, why a title, accent, or translator search comes back empty, finding a novel's opening or a chapter inside a book, jumping to a known passage or paging long works, ranking reading lists by downloads, and comparing editions and translations. Use when finding, reading, quoting, or recommending books from Project Gutenberg.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

Project Gutenberg's catalog and book text, keyless. Most records are public domain in the USA; the catalog also holds copyrighted editions and audio recordings. Catalog search matches titles and author names, not the words inside books, so there is no corpus-wide full-text or quotation search. A passage is found inside a known book: gutenberg_get_text jumps to it with `find`, or you page the book and scan the chunks yourself.

## Identifiers

| Identifier | Comes from | Notes |
|:--|:--|:--|
| Gutenberg ID | gutenberg_search_books, gutenberg_browse_popular, or a `gutenberg.org/ebooks/<id>` URL | One ID is one edition, volume, part, translation, or recording, never a whole work (see Workflows) |
| Character offset | `offset` + `length` of the previous gutenberg_get_text response | A position in the server's stripped text, not in the source file; `match.offset` from `find` uses the same coordinates |
| MIME prefix | the `formats` keys from gutenberg_get_book | Selects records that list a format, nothing more (see Gates) |

## Gates

**Decide readability from `is_readable` alone.** Every search, browse, and get_book row carries it. Three look-alikes mislead:
- The `formats` map: audio record 26471 (*Spoon River Anthology*, `media_type` "Sound") lists `text/html` and is not readable; gutenberg_get_text refuses it with `audio_book`.
- The `mime_type` filter: `"text/html"` returns 26471 too.
- `has_plain_text`: false with `is_readable` true means an HTML-only edition (79044, 49965). It reads fine with `sourceFormat` "text/html", but the text is converted from markup: table rows sit on one line with tab-separated cells, and layout artifacts are possible.

`is_readable` is a result field, not a search argument; passing it to gutenberg_search_books fails with `invalid_arguments`. Popularity-sorted results mix audio records in with texts (26471 appears in 19th-century American searches), so drop `is_readable: false` rows before recommending anything to read. Records with no UTF-8 text or HTML edition (40, an ASCII-only entry) fail with `no_text_format`.

**Before reporting that Gutenberg lacks a book, rule out the search's blind spots.** `query` matches each word as a literal substring of the title or an author name:
- Accents must match: `miserables` returns only a Spanish *Los miserables* and nothing in French, while `misérables` returns the five French tomes (17489, 17493, 17494, 17518, 17519) plus English editions; `emile zola` misses most of the books `émile zola` finds.
- `query` does not search translators: `maude` does not return *War and Peace* (2600, translated by Aylmer and Louise Maude). Use the `translator` filter instead (`maude` there finds the Maude translations). Every word must match a translator name, accents must match, and it needs the local mirror: a server on the live catalog fails with `translator_requires_mirror`, and then you read translators from gutenberg_get_book.
- Translations carry their own-language title: `war peace tolstoy` finds 2600 but not *La guerre et la paix* (17949) or *Sota ja rauha* (45271). Search the author's surname, with `languages` or `topic` to narrow.
- Language codes match exactly as results report them: `en`, not `eng`. Some real codes are three letters (`ang`, `enm`), but `eng` is not one: it returns nothing, with a notice saying so.

**`catalog_unavailable` is not an empty result.** On a server answering from the live catalog, a search can time out and then succeed on an identical retry; retry before concluding anything. Lookups by known ID (gutenberg_get_book, gutenberg_get_text) can time out the same way; retry them once as well. The same server rejects queries over four words with `query_requires_mirror` (and the `translator` filter with `translator_requires_mirror`): shorten to the most distinctive words, such as the surname plus one title word.

**Author-year filters mean "alive at some point in the range", and drop authors with no known years.** `author_year_start` 1800 with `author_year_end` 1899 keeps David Garnett (1892–1981) and Thomas Garnett (1766–1802), and drops an author whose birth and death years are both unknown, or whose only known year falls outside the range. With both bounds, one author must meet both: a book whose two authors each meet one bound does not match. The live catalog cannot check that and says so in a `notice`. There is no nationality field. `topic` is a substring over subjects and bookshelves, so `american` also pulls in *Ulysses* (4300) through its "Banned Books List from the American Library Association" shelf. Use the most specific phrase that names the shelf or subject you mean.

**`copyright: true` does not mean unavailable.** It marks the edition, often a modern translation: *Metamorphosis* (5200, translated by David Wyllie) is copyrighted and readable. Filter `copyright` to `["false"]` only when the user needs US public domain.

**Read text only through gutenberg_get_text, never the `formats` URLs.** Those point at www.gutenberg.org; gutenberg_get_text returns the book with the license header and footer removed and offsets for paging.

## Workflows

**Quote an opening.** gutenberg_get_text strips the license header and footer but keeps the front matter: producer credits, title page, contents, illustration lists, prefaces. *Pride and Prejudice* (1342) opens with a long preface and an illustration list, so its first sentence starts at character 34,237 of 728,264; *Frankenstein* (84) and *Les Misérables* (17489) open with a contents list. Read from offset 0 at `limit` 50000 (the cap) and find where the narrative starts before quoting. If you already know the first words, pass them as `find` to land past the front matter in one call, and check the match is the opening, not a later quotation. Plain-text editions are hard-wrapped near 70 columns: join single line breaks inside a paragraph (paragraphs are separated by a blank line), and read `_underscores_` as italics. Cite with the response's `provenance` line.

**Pull a chapter.** There is no chapter index, and heading styles vary even within one book: 1342 has "Chapter I." inside an illustration caption and "CHAPTER III." on its own line. Use `find` with the heading: it ignores letter case and line wrapping, so it also matches mid-sentence mentions. The first hit is usually the contents or an illustration list near the start (84 lists "Chapter 3" in its contents; 1342 lists "Heading to Chapter I."). While `match.laterMatches` is above 0, repeat the same `find` with `offset` = `match.offset` + `match.length` until a hit is followed by prose, and end the chapter at the next heading. Multi-volume works restart numbering: each Livre of 17489 has its own "Chapitre I", so pin the volume and book before counting.

**Page a long text.** Use `find` instead when you know a phrase or heading: it returns the chunk starting at the match, where paging a novel takes many calls. Page when you don't know what you're looking for. Continue at `offset + length`, never `offset + limit`. Trimming to the last paragraph break can return far less than requested (`limit` 300 returned 118 characters), and an arbitrary offset can start mid-word. Stop when `hasMore` is false; an offset at or past `totalChars` fails with `offset_out_of_range`. A novel is many calls (1342 takes about 15 at the cap), so scan or `find` what you need rather than reading the whole book into context. A `find` that matches nothing fails with `passage_not_found`; shorten the phrase, or lower `offset`, since the search only looks forward from it. Accents, dashes, and `_underscores_` around italics must match the text exactly.

**Rank a reading list.** gutenberg_browse_popular has no author-year filter; use gutenberg_search_books with the default `sort` "popular" and page by 32. `download_count` covers the last 30 days and counts each edition separately:
- One work spreads across IDs: *Little Women* is 514 and 37106; *Tom Sawyer* is 74 plus parts 7193–7200. Merge editions before ranking works.
- Recent additions (the highest IDs) can outrank long-standing classics while they are new. Treat the order as recent demand, not lasting standing.

**Compare editions and translations.** Find candidates by author surname plus `languages`, or by `translator` when you know who translated (search rows omit translators). gutenberg_get_book gives `translators` and `source_notes`; a note can name another edition ("This title is also available as eBook #42671" on 1342). `source_notes: null` means the server answered from the live catalog, which carries no notes, not that the edition has none. To check several candidate IDs at once, pass them as `ids` to gutenberg_search_books: one call returns each one's `languages`, `download_count`, and `is_readable`, ordered by `sort` rather than input order, and other filters still apply (`ids` [1342, 17489] with `languages` ["fr"] returns only 17489).
