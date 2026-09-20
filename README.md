<div align="center">
  <h1>@cyanheads/gutenberg-mcp-server</h1>
  <p><b>Search, browse, and read 75,000+ public-domain books from Project Gutenberg with full plain-text retrieval and offset/limit chunking via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.9-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gutenberg-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gutenberg-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gutenberg-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Project Gutenberg's library of 78,000+ public-domain books, cataloged through the Gutendex API and served from a Gutenberg content mirror. Search by title, author, topic, or language, fetch full book metadata, and retrieve plain-text content in offset/limit chunks for long works from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `gutenberg_search_books` | Search the catalog by title, author, topic, language, or author lifespan, with pagination and popularity sorting |
| `gutenberg_get_book` | Fetch complete metadata for a book by ID — authors, translators, editors, full formats map, subjects, copyright status |
| `gutenberg_get_text` | Retrieve a book's plain-text content stripped of license boilerplate, with offset/limit chunking |
| `gutenberg_browse_popular` | Browse the most-downloaded books, optionally filtered by language or topic |

---

## Capability reference

### `gutenberg_search_books` <sub>tool</sub>

- Free-text `query` matches titles and author names; `topic` matches subjects/bookshelves separately from `query`
- Filters: `languages` (ISO 639-1 codes), `author_year_start`/`author_year_end` lifespan range, `ids` for a batch lookup by known ID list
- `sort`: `popular` (default, by download count) or `ascending`/`descending` by Gutenberg ID
- Paginated — up to 32 books per page; `totalCount` and `hasMore` drive further pages
- Each result carries `has_plain_text` to pre-filter before calling `gutenberg_get_text`
- Typed failures: `no_results`, `page_out_of_range`, `catalog_unavailable`

---

### `gutenberg_get_book` <sub>tool</sub>

- Returns the full `formats` map (MIME type → download URL) — plain text, HTML, EPUB, cover image
- Authors, translators, and editors each carry birth/death years
- `has_plain_text` confirms a UTF-8 plain-text format exists; `media_type` distinguishes text books from audio (`"Sound"`)
- `summary` is the first entry of Gutendex's `summaries` array — both are `null`/empty when Gutendex has none
- Typed failures: `not_found`, `catalog_unavailable`

---

### `gutenberg_get_text` <sub>tool</sub>

- `offset`/`limit` chunking (limit 1–50,000, default 20,000) for works that routinely run 500KB–2MB
- Strips the standard Gutenberg license header and footer before chunking
- Prefers UTF-8 plain text; falls back to an HTML-to-text conversion (`sourceFormat` reports which)
- Response carries `totalChars`, `length`, `remainingChars`, `hasMore` — use `length`, not `limit`, to compute the next `offset`, since paragraph-boundary trimming can return slightly less than requested
- `provenance` carries the Gutenberg ID, title, and license URL for attribution
- Typed failures: `not_found`, `audio_book` (refuses `media_type "Sound"`), `no_text_format`, `offset_out_of_range`, `text_fetch_failed`, `catalog_unavailable`

---

### `gutenberg_browse_popular` <sub>tool</sub>

- Returns up to 32 titles (`limit`, default 20) ordered by download count, most popular first
- Optional `languages` and `topic` filters, applied together
- `totalInCatalog` gives full context (e.g. "top 20 of 60,000")
- Enrichment reports whether results were truncated and the download-count ceiling of the least-popular book shown, pointing to `gutenberg_search_books` to page through the rest
- Typed failures: `no_results`, `catalog_unavailable`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Gutenberg-specific:

- Catalog search and metadata via [Gutendex](https://gutendex.com/), an unofficial but stable JSON API over the Gutenberg dataset
- Single-book lookups (`gutenberg_get_book`, `gutenberg_get_text`) read from a local SQLite+FTS5 catalog mirror when it holds the record, falling back to the live Gutendex API otherwise
- Full plain-text retrieval from a Project Gutenberg content mirror that permits automated access, with transparent UTF-8/HTML fallback
- Tenant-scoped text caching — book text is fetched once per tenant and served from cache for subsequent chunk reads
- No API key required

Agent-friendly output:

- `has_plain_text` flag on every search/browse result lets agents pre-filter before attempting text retrieval
- Precise chunking contract on `gutenberg_get_text` — `offset`, `length`, `totalChars`, `remainingChars`, `hasMore` for reliable sequential reads
- `provenance` and discriminated `sourceFormat` fields on every text response, for attribution and fidelity awareness
- `gutenberg_browse_popular` enrichment reports truncation state and the download-count ceiling of omitted results

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://gutenberg.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "gutenberg-mcp-server": {
      "type": "streamable-http",
      "url": "https://gutenberg.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

No API key required. Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "gutenberg-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/gutenberg-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "gutenberg-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/gutenberg-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "gutenberg-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/gutenberg-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — Project Gutenberg data is freely available.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/gutenberg-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd gutenberg-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override any defaults
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GUTENDEX_BASE_URL` | Base URL for the Gutendex catalog API. Override for self-hosted instances. | `https://gutendex.com/books/` |
| `GUTENBERG_TEXT_BASE_URL` | Base URL for a Project Gutenberg content mirror serving the `/cache/epub` file tree. Override to use a different mirror. | `https://gutenberg.pglaf.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. Overrides the `stateless` posture the server declares in `createApp()`. | `stateless` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

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
docker build -t gutenberg-mcp-server .
docker run --rm -p 3010:3010 gutenberg-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/gutenberg-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/server-config.ts` | Server-specific environment variable parsing (Gutendex and file-server URL overrides). |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/gutendex/` | Gutendex catalog API client — search and book metadata. |
| `src/services/catalog-mirror/` | Local SQLite+FTS5 catalog mirror — RDF ingestion and read helpers. |
| `src/services/gutenberg-text/` | Full plain-text retrieval, boilerplate stripping, tenant-scoped caching, and chunking. |
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

Data from [Project Gutenberg](https://www.gutenberg.org/) is in the public domain. Catalog metadata sourced from [Gutendex](https://gutendex.com/) (MIT license).

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
