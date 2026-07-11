/**
 * @fileoverview Server-specific configuration schema for gutenberg-mcp-server.
 * Parses optional URL overrides for the Gutendex catalog API and Gutenberg file servers.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  gutendexBaseUrl: z
    .string()
    .url()
    .default('https://gutendex.com/books/')
    .describe('Base URL for the Gutendex catalog API. Override for self-hosted instances.'),
  gutenbergTextBaseUrl: z
    .string()
    .url()
    .default('https://gutenberg.pglaf.org')
    .describe(
      'Base URL for a Project Gutenberg content mirror serving the /cache/epub file tree. Defaults to gutenberg.pglaf.org, a mirror that permits automated access. Override to use a different mirror.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    gutendexBaseUrl: 'GUTENDEX_BASE_URL',
    gutenbergTextBaseUrl: 'GUTENBERG_TEXT_BASE_URL',
  });
  return _config;
}
