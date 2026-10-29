#!/usr/bin/env node
/**
 * @fileoverview gutenberg-mcp-server MCP server entry point. Registers all tool
 * definitions and initializes the local catalog mirror plus the Gutendex catalog and
 * Gutenberg text services.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { gutenbergBrowsePopular } from './mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';
import { gutenbergGetBook } from './mcp-server/tools/definitions/gutenberg-get-book.tool.js';
import { gutenbergGetText } from './mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import { gutenbergSearchBooks } from './mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import {
  getCatalogMirrorService,
  initCatalogMirrorService,
  startCatalogMirrorRefresh,
  stopCatalogMirrorRefresh,
} from './services/catalog-mirror/catalog-mirror-service.js';
import { initGutenbergTextService } from './services/gutenberg-text/gutenberg-text-service.js';
import { initGutendexService } from './services/gutendex/gutendex-service.js';

await createApp({
  name: 'gutenberg-mcp-server',
  title: 'gutenberg-mcp-server',
  tools: [gutenbergSearchBooks, gutenbergGetBook, gutenbergGetText, gutenbergBrowsePopular],
  resources: [],
  prompts: [],
  instructions:
    'Project Gutenberg MCP server. No API key required. Typical workflow: gutenberg_search_books → gutenberg_get_book → gutenberg_get_text; search rows already carry is_readable, so gutenberg_get_book is needed only for formats, translators, or source notes. Use gutenberg_browse_popular for discovery. gutenberg_get_text supports offset/limit chunking for long works — novels routinely exceed 500KB. Check is_readable on each result row: true means gutenberg_get_text can read a UTF-8 plain-text or HTML edition; has_plain_text reports UTF-8 plain-text availability only. Popularity uses downloads in the last 30 days at the source snapshot. The gutenberg-guide skill (skill://gutenberg-guide/SKILL.md) carries the gates for readability, empty searches (accents, translators, translated titles), front matter, chapters, paging, and ranking editions.',
  skills: 'skills',
  /**
   * No tool here gates on `ctx.requestInput`, so nothing needs a session to
   * answer into. Declaring it in `src/` rather than leaving it to a deployment's
   * `MCP_SESSION_MODE` is what makes it durable; the env var still wins when it
   * carries a meaningful value.
   */
  sessionMode: 'stateless',
  async setup(core) {
    const serverConfig = getServerConfig();
    initGutendexService(core.config, core.storage, serverConfig);
    initGutenbergTextService(core.config, core.storage, serverConfig);
    /**
     * The mirror opens its database lazily on first use, so this costs nothing at
     * startup and nothing at all until a read path or a lifecycle script touches it.
     * A full harvest runs out-of-band via `mirror:init`, never here.
     */
    initCatalogMirrorService(serverConfig);
    await startCatalogMirrorRefresh(serverConfig);
  },
  /**
   * The mirror holds a SQLite connection the framework cannot see, and the
   * optional refresh cron holds a ref'd timer. Release both here, cron first, so
   * no tick can reopen the database the next statement closes.
   */
  async teardown() {
    stopCatalogMirrorRefresh();
    await getCatalogMirrorService().close();
  },
});
