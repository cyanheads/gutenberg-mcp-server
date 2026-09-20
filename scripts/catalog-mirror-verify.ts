/**
 * @fileoverview Health check for the local Project Gutenberg catalog mirror: row
 * count, sync state, and SQLite integrity. Exits non-zero when the integrity check
 * fails, so a scheduled run can page on a corrupt database.
 *
 * @example
 * // bun run mirror:verify
 */

import { finish, openCatalogMirror } from './_mirror-context.js';

const service = openCatalogMirror();

try {
  const { rows, status, cursor, integrity } = await service.verify();
  process.stdout.write(
    `${[
      `rows:        ${rows.toLocaleString()}`,
      `status:      ${status.status}`,
      `ready:       ${status.ready}`,
      `completedAt: ${status.completedAt ?? 'never'}`,
      `checkpoint:  ${status.checkpoint ?? 'none'}`,
      `cursor:      ${cursor ?? 'none'}`,
      `integrity:   ${integrity.ok ? 'ok' : integrity.results.join('; ')}`,
      ...(status.error === undefined ? [] : [`lastError:   ${status.error}`]),
    ].join('\n')}\n`,
  );
  await finish(service, integrity.ok ? undefined : new Error('Mirror integrity check failed.'));
} catch (error) {
  await finish(service, error);
}
