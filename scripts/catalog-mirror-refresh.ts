/**
 * @fileoverview Incremental refresh of the local Project Gutenberg catalog mirror.
 *
 * Project Gutenberg rebuilds the bulk RDF archive daily and publishes no delta feed,
 * so a refresh compares the archive's `Last-Modified` against the stored checkpoint:
 * unchanged means no work, changed means a full re-harvest. The mirror stays queryable
 * throughout — readiness keys off the last completed sync, not the run in flight.
 *
 * @example
 * // bun run mirror:refresh
 */

import { finish, interruptSignal, openCatalogMirror, progressReporter } from './_mirror-context.js';

const service = openCatalogMirror();

const before = await service.status();
process.stdout.write(`Refreshing (checkpoint: ${before.checkpoint ?? 'none'})…\n`);

try {
  const result = await service.runSync({
    mode: 'refresh',
    signal: interruptSignal(),
    onProgress: progressReporter(),
  });
  const after = await service.status();
  if (result.pagesFetched === 0) {
    process.stdout.write('Archive unchanged since the last sync — nothing to harvest.\n');
  } else {
    process.stdout.write(
      `Done — ${result.recordsApplied.toLocaleString()} records applied, ` +
        `${result.tombstonesApplied.toLocaleString()} removed, ` +
        `${result.total.toLocaleString()} books in the mirror.\n`,
    );
  }
  process.stdout.write(`Checkpoint: ${after.checkpoint ?? 'none'}\n`);
  await finish(service);
} catch (error) {
  await finish(service, error);
}
