/**
 * @fileoverview Shared bootstrap for the catalog-mirror lifecycle scripts
 * (`mirror:init`, `mirror:refresh`, `mirror:verify`). Opens the mirror against the
 * server's own configuration and wires interrupts to an abort signal, so Ctrl-C during
 * a multi-minute harvest persists the resume cursor instead of discarding it.
 * @module scripts/_mirror-context
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from '@/config/server-config.js';
import {
  type CatalogMirrorService,
  initCatalogMirrorService,
} from '@/services/catalog-mirror/catalog-mirror-service.js';

/**
 * Initialize the mirror service from the same env the server reads.
 *
 * Touching the framework config proxy first is what loads `.env` — the server-config
 * schema reads `process.env` directly, and outside a `bun run` (which loads `.env`
 * itself) nothing else would have populated it.
 */
export function openCatalogMirror(): CatalogMirrorService {
  void config.environment;
  const serverConfig = getServerConfig();
  process.stdout.write(`mirror path: ${serverConfig.mirrorPath}\n`);
  return initCatalogMirrorService(serverConfig);
}

/**
 * Abort signal fired by SIGINT or SIGTERM. The sync runner persists its state before
 * unwinding, so an interrupted harvest resumes from the last completed page.
 */
export function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const abort = (signalName: string) => {
    process.stdout.write(`\n${signalName} received — stopping after the current page.\n`);
    controller.abort(new Error(`Interrupted by ${signalName}`));
  };
  process.once('SIGINT', () => abort('SIGINT'));
  process.once('SIGTERM', () => abort('SIGTERM'));
  return controller.signal;
}

/** Print harvest progress on a fixed page interval so a long run shows movement. */
export function progressReporter(everyPages = 5) {
  const startedAt = Date.now();
  return (info: { pages: number; records: number; cursor?: string | undefined }): void => {
    if (info.pages % everyPages !== 0) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(
      `  ${info.records.toLocaleString()} records · ${info.pages} pages · ${elapsed}s · at ${info.cursor ?? '—'}\n`,
    );
  };
}

/** Close the mirror and exit, reporting a failure without a stack-trace dump. */
export async function finish(service: CatalogMirrorService, error?: unknown): Promise<never> {
  await service.close().catch(() => undefined);
  if (error !== undefined) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
