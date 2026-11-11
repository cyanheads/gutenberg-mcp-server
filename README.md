<div align="center">
  <h1>@cyanheads/gutenberg-mcp-server</h1>
  <p><b>Search, browse, and read 78,000+ public-domain books from Project Gutenberg with full plain-text retrieval and offset/limit chunking via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gutenberg-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gutenberg-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gutenberg-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/gutenberg-mcp-server/releases/latest/download/gutenberg-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gutenberg-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ3V0ZW5iZXJnLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22gutenberg-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgutenberg-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://gutenberg.caseyjhand.com/mcp](https://gutenberg.caseyjhand.com/mcp)

</div>

---

## Overview

Project Gutenberg's library of 78,000+ public-domain books. Search by title, author, topic, or language, fetch full book metadata, and read supported UTF-8 plain-text and HTML editions in manageable chunks.

### Tools

| Tool | Description |
|:-----|:------------|
| `gutenberg_search_books` | Search the catalog by title, author, topic, translator, language, or author lifespan, with pagination and popularity sorting |
| `gutenberg_get_book` | Fetch complete metadata for a book by ID — authors, translators, editors, full formats map, subjects, copyright status |
| `gutenberg_get_text` | Retrieve a book's plain-text content stripped of license boilerplate, with offset/limit chunking or a `find` jump to a passage |
| `gutenberg_browse_popular` | Browse the most-downloaded books, optionally filtered by language or topic |

The published [gutenberg-guide](./skills/gutenberg-guide/SKILL.md) skill covers deciding whether a book can be read, ruling out search blind spots before calling a book missing, finding openings and chapters past front matter, paging long texts, and ranking editions. Plugin installs include it; MCP clients can discover it through the Skills extension and its skill resource.

---

## Capability reference

### `gutenberg_search_books` <sub>tool</sub>

- Filters: `query` (title/author words), `topic`, `translator`, `languages` (catalog codes exactly as results report them, two or three letters: `en`, not `eng`), `author_year_start`/`author_year_end`, `ids`, `mime_type`, and `copyright` (`"true"`, `"false"`, `"null"`; false means public domain in the USA). Live fallback rejects queries over four words and the `translator` filter
- With both author-year bounds, one author must meet both. The live fallback checks the bounds separately and says so in a notice
- `sort` is `popular` (default) or `ascending`/`descending` by Gutenberg ID. Up to 32 books per page; use `totalCount` and `hasMore` to page
- Each result carries `is_readable` (eligible Text formats; mirror file availability is not guaranteed) and `has_plain_text`. The local mirror ignores case and accents in query, translator and topic matching; live matching is upstream-defined. Result rows omit translators; `gutenberg_get_book` reports them. Fails with `translator_requires_mirror`, `query_requires_mirror`, `page_out_of_range`, `catalog_rejected`, or `catalog_unavailable`

---

### `gutenberg_get_book` <sub>tool</sub>

- Returns the full `formats` map (MIME type → download URL) and authors, translators, and editors with birth/death years
- Also carries `is_readable`, `has_plain_text`, `summary`, `source_notes`, and `download_count` (downloads in the last 30 days, not lifetime)
- Reads the local mirror, then the book's own record on the content mirror. Fails with `not_found`, `catalog_rejected`, or `catalog_unavailable`

---

### `gutenberg_get_text` <sub>tool</sub>

- Reads a book in `offset`/`limit` chunks (default `limit` 20,000, capped at 50,000), with the Gutenberg license header and footer stripped. `requestedLimit` and `appliedLimit` report both
- Prefers UTF-8 plain text and falls back to HTML converted to text; `sourceFormat` says which. Returns `totalChars`, `length`, `remainingChars`, `hasMore`, and `provenance` (ID, title, license URL). Use `length`, not `limit`, to compute the next `offset`
- `find` jumps to a passage instead of paging to it: the chunk starts at the first match at or after `offset`, and `match` reports its `offset`, `length`, and `laterMatches`. Matching ignores letter case and whitespace runs, and treats straight and curly quotes alike; accents and punctuation must match
- Converted HTML editions blank every line that holds no visible character, keep each table row on one line with tab-separated cells, and keep a verse line break as one newline
- Files over 8 MiB are read as four parallel byte ranges when the mirror supports them; a file over 40 MiB fails with `text_too_large`
- Fails with `not_found`, `audio_book` (`media_type "Sound"`), `no_text_format`, `offset_out_of_range`, `passage_not_found`, `text_file_not_found`, `text_fetch_rejected`, `text_too_large`, `invalid_text_response`, `text_fetch_failed`, `catalog_rejected`, or `catalog_unavailable`

---

### `gutenberg_browse_popular` <sub>tool</sub>

- Returns up to 32 titles (`limit`, default 20), most downloaded in the last 30 days first. `requestedLimit` and `appliedLimit` report the cap
- Optional `languages`, `topic`, `mime_type`, and `copyright` filters work as in search. `totalInCatalog` gives the full count
- Output reports truncation and carries a `continuation` pointing at `gutenberg_search_books`. Empty results succeed with a notice; fails with `catalog_rejected` or `catalog_unavailable`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Gutenberg-specific:

- Searches and lookups read a local SQLite+FTS5 catalog mirror. When the mirror is cold, searches fall back to [Gutendex](https://gutendex.com/); a book the mirror lacks is read from its per-book RDF record on the content mirror
- Full plain-text retrieval from a Project Gutenberg content mirror, with UTF-8/HTML fallback
- Book text is cached per tenant, so later chunk reads skip the fetch
- No API key required

Agent-friendly output:

- `is_readable` flags Text records with UTF-8 plain text, or HTML without audio formats; a missing mirror file still returns `text_file_not_found`
- `offset`, `length`, `totalChars`, `remainingChars`, and `hasMore` support reliable sequential reads
- `provenance` and `sourceFormat` on every text response cover attribution and fidelity

---

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http gutenberg-mcp-server https://gutenberg.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add gutenberg-mcp-server -- npx -y @cyanheads/gutenberg-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "gutenberg-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/gutenberg-mcp-server"]
    }
  }
}
```

No API key required. For Docker or a source build, see [Running the server](#running-the-server).

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GUTENDEX_BASE_URL` | Gutendex catalog API base URL, used for search and popularity browse when the local catalog mirror cannot answer. | `https://gutendex.com/books/` |
| `GUTENBERG_TEXT_BASE_URL` | Content mirror serving the `/cache/epub` file tree: book text, the bulk catalog archive, and per-book catalog records. | `https://gutenberg.pglaf.org` |
| `GUTENBERG_MIRROR_PATH` | SQLite catalog path; use a persistent volume in containers. | `$XDG_DATA_HOME/gutenberg-mcp-server/gutenberg-catalog.sqlite` (`~/.local/share` when `XDG_DATA_HOME` is unset, empty, or relative) |
| `GUTENBERG_MIRROR_REFRESH_CRON` | Cron schedule for in-process catalog refresh. | Unset |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. Overrides the `stateless` posture the server declares in `createApp()`. | `stateless` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

Build the local catalog with `npx -y @cyanheads/gutenberg-mcp-server mirror init` and check it with `mirror verify`; `mirror refresh` re-harvests when the archive has been rebuilt. Each runs under Node or Bun from any directory and prints `mirror path: <absolute path>` first. From a source checkout, `bun run mirror:init`, `mirror:verify`, and `mirror:refresh` run the built `dist/` (build first). The server never harvests on startup, and answers searches from Gutendex and book lookups from each book's RDF record until the first harvest completes. Keep the catalog up to date with `mirror refresh` on a host scheduler, or set `GUTENBERG_MIRROR_REFRESH_CRON`.

An existing `./.mirror/gutenberg-catalog.sqlite` is read only when `GUTENBERG_MIRROR_PATH` points at it. A blank or unsubstituted `${…}` value for any of these variables reads as unset.

---

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/gutenberg-mcp-server.git
  cd gutenberg-mcp-server && bun install
  cp .env.example .env   # optional overrides
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/gutenberg-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/gutenberg-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/gutenberg-mcp-server:latest"]`. To build locally, `docker build -t gutenberg-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/server-config.ts` | Server-specific environment variable parsing (Gutendex and content-mirror URLs, catalog mirror path and refresh schedule). |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/gutendex/` | Catalog service — mirror reads, live Gutendex search and browse, per-book RDF lookup. |
| `src/services/catalog-mirror/` | Local SQLite+FTS5 catalog mirror — RDF ingestion, read helpers, and the `mirror` CLI. |
| `src/services/gutenberg-text/` | Full plain-text retrieval, boilerplate stripping, tenant-scoped caching, and chunking. |
| `skills/gutenberg-guide/` | Published agent skill for reading and discovery workflows, also served over MCP. |
| `tests/` | Unit and integration tests mirroring `src/`. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the entry arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## Data attribution

Data from [Project Gutenberg](https://www.gutenberg.org/) is in the public domain. Catalog metadata comes from Project Gutenberg's RDF catalog and, for live searches, [Gutendex](https://gutendex.com/) (MIT license).

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
