<div align="center">
  <h1>@cyanheads/gutenberg-mcp-server</h1>
  <p><b>Search, browse, and read 75,000+ public-domain books from Project Gutenberg with full plain-text retrieval and offset/limit chunking via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gutenberg-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gutenberg-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gutenberg-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/gutenberg-mcp-server/releases/latest/download/gutenberg-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gutenberg-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ3V0ZW5iZXJnLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22gutenberg-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgutenberg-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://gutenberg.caseyjhand.com/mcp](https://gutenberg.caseyjhand.com/mcp)

</div>

---

## Tools

Four tools for searching and reading Project Gutenberg's public-domain library:

| Tool | Description |
|:-----|:------------|
| `gutenberg_search_books` | Search the Gutenberg catalog by title, author, topic, language, or author lifespan — returns popularity-ordered results with IDs ready for follow-up calls |
| `gutenberg_get_book` | Fetch complete metadata for a book by ID — full formats map, translators, editors, subjects, bookshelves, copyright status, and the `has_plain_text` flag |
| `gutenberg_get_text` | Retrieve the plain-text content of a book, stripped of license boilerplate, with offset/limit chunking for context-budget management |
| `gutenberg_browse_popular` | Browse the most-downloaded books, optionally filtered by language or topic — useful as a discovery entry point |

### `gutenberg_search_books`

Search the Project Gutenberg catalog of 78,000+ public-domain books.

- Full-text search against titles and author names (space-separated words, case-insensitive)
- Topic filter matches subject headings and bookshelf categories
- Language filter by ISO 639-1 two-character codes (e.g., `["en"]`, `["fr", "de"]`)
- Author lifespan range filter via `author_year_start` / `author_year_end`
- Sort by popularity (download count), or by Gutenberg ID ascending/descending
- Batch lookup by known ID list via `ids` parameter
- Paginated — up to 32 books per page; use `totalCount` to determine total pages
- Each result includes `has_plain_text` to indicate whether `gutenberg_get_text` will work

---

### `gutenberg_get_book`

Fetch complete metadata for a single Project Gutenberg book.

- Returns the full formats map (MIME type → download URL) including plain text, HTML, EPUB, and cover image
- Includes translators and editors alongside authors, each with birth/death years
- `has_plain_text` flag confirms whether a UTF-8 or ASCII plain-text format is available
- `media_type` distinguishes readable text books from audio recordings
- Use this before `gutenberg_get_text` to confirm text availability and inspect the formats map

---

### `gutenberg_get_text`

Retrieve the plain-text content of a Project Gutenberg book, stripped of license boilerplate.

- Strips the standard Gutenberg license header and footer — response contains only the literary work
- Offset/limit chunking for long works: novels routinely run 500 KB–2 MB; read in manageable chunks without loading the whole file
- Response includes `totalChars`, `offset`, `length`, and `remainingChars` for precise pagination
- Paragraph-boundary trimming: actual returned length may be slightly less than `limit` — use `length` (not `limit`) to compute the next offset
- Prefers UTF-8 plain text; falls back to ASCII plain text; converts HTML as a last resort
- Refuses audio books (`media_type "Sound"`) with a clear recovery hint
- `provenance` field carries the Gutenberg ID, title, and license URL for attribution

---

### `gutenberg_browse_popular`

Browse the most-downloaded Project Gutenberg books.

- Returns up to 32 titles ordered by download count (most popular first)
- Optionally filter by language (ISO 639-1 codes) and/or topic keyword
- Useful as a discovery entry point: "what are the most popular classics in French?"
- `totalInCatalog` provides full context — "top 20 of 60,000"

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats with recovery hints
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Project Gutenberg integration:

- Catalog search and metadata via [Gutendex](https://gutendex.com/) — an unofficial but stable JSON API over the Gutenberg dataset
- Full plain-text retrieval directly from Project Gutenberg file servers with transparent UTF-8/ASCII/HTML fallback chain
- In-session text caching: book text is fetched once per session and served from cache for subsequent chunk reads
- No API key required — Project Gutenberg data is freely available; no registration needed

Agent-friendly output:

- `has_plain_text` flag on every search/browse result so agents can pre-filter before attempting text retrieval
- Precise chunking contract: `offset`, `length`, `totalChars`, `remainingChars`, `hasMore` on every `gutenberg_get_text` response for reliable sequential reads
- `provenance` field on every text response for attribution
- Discriminated `sourceFormat` field (`text/plain; charset=utf-8`, `text/plain; charset=us-ascii`, `text/html`) so agents know the fidelity of the text

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `GUTENBERG_TEXT_BASE_URL` | Base URL for Project Gutenberg file servers. Override for mirrors. | `https://www.gutenberg.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
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

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/server-config.ts` | Server-specific environment variable parsing (Gutendex and file-server URL overrides). |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/gutendex/` | Gutendex catalog API client — search and book metadata. |
| `src/services/gutenberg-text/` | Full plain-text retrieval, boilerplate stripping, in-session caching, and chunking. |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

Data from [Project Gutenberg](https://www.gutenberg.org/) is in the public domain. Catalog metadata sourced from [Gutendex](https://gutendex.com/) (MIT license).
