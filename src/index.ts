#!/usr/bin/env node
/**
 * @fileoverview gutenberg-mcp-server MCP server entry point. Registers all tool
 * definitions and initializes the Gutendex catalog and Gutenberg text services.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { gutenbergBrowsePopular } from './mcp-server/tools/definitions/gutenberg-browse-popular.tool.js';
import { gutenbergGetBook } from './mcp-server/tools/definitions/gutenberg-get-book.tool.js';
import { gutenbergGetText } from './mcp-server/tools/definitions/gutenberg-get-text.tool.js';
import { gutenbergSearchBooks } from './mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import { initGutenbergTextService } from './services/gutenberg-text/gutenberg-text-service.js';
import { initGutendexService } from './services/gutendex/gutendex-service.js';

await createApp({
  name: 'gutenberg-mcp-server',
  title: 'gutenberg-mcp-server',
  tools: [gutenbergSearchBooks, gutenbergGetBook, gutenbergGetText, gutenbergBrowsePopular],
  resources: [],
  prompts: [],
  instructions:
    'Project Gutenberg MCP server. No API key required. ' +
    'Typical workflow: gutenberg_search_books → gutenberg_get_book → gutenberg_get_text. ' +
    'Use gutenberg_browse_popular for discovery. ' +
    'gutenberg_get_text supports offset/limit chunking for long works — novels routinely exceed 500KB. ' +
    'Only books with has_plain_text=true can be read with gutenberg_get_text.',
  setup(core) {
    const serverConfig = getServerConfig();
    initGutendexService(core.config, core.storage, serverConfig);
    initGutenbergTextService(core.config, core.storage, serverConfig);
  },
});
