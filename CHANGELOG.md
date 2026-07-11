# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-11

Sources gutenberg_get_text exclusively from the PG-sanctioned mirror gutenberg.pglaf.org instead of the ToS-restricted www.gutenberg.org, drops the us-ascii plain-text fallback, and aligns has_plain_text so it no longer advertises those books as readable.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-07-11

Fixes gutenberg_search_books/browse_popular/get_book content[] and error-recovery gaps (full subject lists, out-of-range pages, truncation metadata, not_found hints); adopts mcp-ts-core ^0.10.14 with a Socket supply-chain scanner and clears 9 transitive advisories (hono, vite, js-yaml, esbuild) via bun audit.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-20

Maintenance: @cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9 (fresh-scaffold devcheck guards, ctx.content, SQL gate classification), new dependency-specifier + plugin-manifest devcheck steps, @types/node ^26

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-15

Public hosted endpoint at https://gutenberg.caseyjhand.com/mcp

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6 — truncation enrichment on browse, machine-name identity, packaging hardening

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-01 · 🛡️ Security

Initial public release — search, browse, and read 75,000+ Project Gutenberg books via MCP

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-31

Initial scaffold — @cyanheads/mcp-ts-core foundation
