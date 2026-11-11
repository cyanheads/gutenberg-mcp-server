/**
 * @fileoverview Server-specific configuration schema for gutenberg-mcp-server.
 * Parses optional URL overrides for the Gutendex catalog API and Gutenberg file
 * servers, plus the local catalog-mirror database location and refresh schedule.
 * @module config/server-config
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Per-user mirror location, `$XDG_DATA_HOME/gutenberg-mcp-server/gutenberg-catalog.sqlite`.
 * Absolute so every launch directory — a bundle host, a plugin's `npx`, a terminal
 * running `mirror init` — reads the same file. Per the XDG Base Directory spec an unset
 * or empty `XDG_DATA_HOME` means `~/.local/share`, and a relative one is invalid and
 * ignored.
 */
function defaultMirrorPath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome =
    xdgDataHome !== undefined && isAbsolute(xdgDataHome)
      ? xdgDataHome
      : join(homedir(), '.local', 'share');
  return join(dataHome, 'gutenberg-mcp-server', 'gutenberg-catalog.sqlite');
}

const ServerConfigSchema = z.object({
  gutendexBaseUrl: z
    .string()
    .url()
    .default('https://gutendex.com/books/')
    .describe(
      'Base URL for the Gutendex catalog API, which answers searches and popularity browse when the local catalog mirror cannot. Override for self-hosted instances.',
    ),
  gutenbergTextBaseUrl: z
    .string()
    .url()
    .default('https://gutenberg.pglaf.org')
    .describe(
      'Base URL for a Project Gutenberg content mirror serving the /cache/epub file tree. Defaults to gutenberg.pglaf.org, a mirror that permits automated access. Override to use a different mirror. The bulk RDF archive the catalog mirror ingests is fetched from this same tree, and book lookups the catalog mirror cannot answer read the per-book RDF record from it.',
    ),
  /**
   * A function default runs at parse time, after `parseEnvConfig` has read a blank or
   * unsubstituted `GUTENBERG_MIRROR_PATH` as unset. The server and the `mirror` commands
   * both parse after the framework config has loaded `.env`, so an `XDG_DATA_HOME` set
   * there counts too.
   */
  mirrorPath: z
    .string()
    .min(1)
    .default(defaultMirrorPath)
    .describe(
      'Filesystem path to the local catalog-mirror SQLite database, created on first sync. Defaults to $XDG_DATA_HOME/gutenberg-mcp-server/gutenberg-catalog.sqlite (~/.local/share when XDG_DATA_HOME is unset, empty, or relative). Point it at a persistent volume in containerized deployments so a restart does not discard the mirror.',
    ),
  mirrorRefreshCron: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Cron expression for an in-process catalog-mirror refresh (e.g. "0 4 * * *"). Unset by default: a refresh is a full re-harvest of the bulk RDF archive, so most deployments should run `gutenberg-mcp-server mirror refresh` from a host scheduler instead.',
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
