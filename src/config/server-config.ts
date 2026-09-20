/**
 * @fileoverview Server-specific configuration schema for gutenberg-mcp-server.
 * Parses optional URL overrides for the Gutendex catalog API and Gutenberg file
 * servers, plus the local catalog-mirror database location and refresh schedule.
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
      'Base URL for a Project Gutenberg content mirror serving the /cache/epub file tree. Defaults to gutenberg.pglaf.org, a mirror that permits automated access. Override to use a different mirror. The bulk RDF archive the catalog mirror ingests is fetched from this same tree.',
    ),
  mirrorPath: z
    .string()
    .min(1)
    .default('./.mirror/gutenberg-catalog.sqlite')
    .describe(
      'Filesystem path to the local catalog-mirror SQLite database, created on first sync. Point it at a persistent volume in containerized deployments so a restart does not discard the mirror.',
    ),
  mirrorRefreshCron: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Cron expression for an in-process catalog-mirror refresh (e.g. "0 4 * * *"). Unset by default: a refresh is a full re-harvest of the bulk RDF archive, so most deployments should run the mirror:refresh script from a host scheduler instead.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    gutendexBaseUrl: 'GUTENDEX_BASE_URL',
    gutenbergTextBaseUrl: 'GUTENBERG_TEXT_BASE_URL',
    mirrorPath: 'GUTENBERG_MIRROR_PATH',
    mirrorRefreshCron: 'GUTENBERG_MIRROR_REFRESH_CRON',
  });
  return _config;
}
