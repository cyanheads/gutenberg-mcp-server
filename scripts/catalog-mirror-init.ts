/**
 * @fileoverview Full harvest of the Project Gutenberg catalog into the local mirror.
 * Downloads the bulk RDF archive, parses every per-book document, and writes the rows.
 *
 * Idempotent and resumable: an interrupted run persists its cursor, and re-running
 * continues from the last completed page rather than starting over.
 *
 * @example
 * // bun run mirror:init
 */

import { finish, interruptSignal, openCatalogMirror, progressReporter } from './_mirror-context.js';

const service = openCatalogMirror();

process.stdout.write('Harvesting the Project Gutenberg catalog (full init)…\n');

try {
  const result = await service.runSync({
    mode: 'init',
    signal: interruptSignal(),
    onProgress: progressReporter(),
  });
  process.stdout.write(
    `Done — ${result.recordsApplied.toLocaleString()} records applied, ` +
      `${result.tombstonesApplied.toLocaleString()} removed, ` +
      `${result.total.toLocaleString()} books in the mirror.\n`,
  );
  await finish(service);
} catch (error) {
  const cursor = await service.cursor().catch(() => undefined);
  if (cursor !== undefined) {
    process.stderr.write(`Run stopped at ${cursor} — re-run mirror:init to resume.\n`);
  }
  await finish(service, error);
}
