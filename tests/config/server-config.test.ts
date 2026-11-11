/**
 * @fileoverview Tests for the server configuration: the per-user catalog-mirror
 * default, and blank or unsubstituted packaging values (an MCPB or plugin host
 * forwarding an option the user left empty) reading as unset.
 * @module tests/config/server-config.test
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const CATALOG_VARS = [
  'GUTENDEX_BASE_URL',
  'GUTENBERG_TEXT_BASE_URL',
  'GUTENBERG_MIRROR_PATH',
  'GUTENBERG_MIRROR_REFRESH_CRON',
] as const;

/**
 * The XDG fallback under this user's home. Nothing is written there: the config only
 * names the path. (Bun's `os.homedir()` reads `HOME` at startup and ignores a later
 * change, so a stubbed `HOME` cannot stand in for it.)
 */
const HOME_DEFAULT = join(
  homedir(),
  '.local',
  'share',
  'gutenberg-mcp-server',
  'gutenberg-catalog.sqlite',
);

/**
 * Parse the config from exactly `env` over a clean slate. `getServerConfig()` caches
 * its first parse, so each case loads a fresh module.
 */
async function parseWith(env: Record<string, string>) {
  vi.resetModules();
  for (const name of [...CATALOG_VARS, 'XDG_DATA_HOME']) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

/** Loads the framework once, outside any case's timeout; later imports reuse it. */
beforeAll(async () => {
  await import('@/config/server-config.js');
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig — defaults', () => {
  it('resolves every default with nothing set', async () => {
    expect(await parseWith({})).toEqual({
      gutendexBaseUrl: 'https://gutendex.com/books/',
      gutenbergTextBaseUrl: 'https://gutenberg.pglaf.org',
      mirrorPath: HOME_DEFAULT,
    });
  });

  it.each([
    ['blank', () => ''],
    ['whitespace', () => '  '],
    ['an unsubstituted placeholder', (name: string) => `\${user_config.${name}}`],
  ])('reads each catalog variable set to %s as unset', async (_label, valueFor) => {
    const env = Object.fromEntries(CATALOG_VARS.map((name) => [name, valueFor(name)]));
    expect(await parseWith(env)).toEqual({
      gutendexBaseUrl: 'https://gutendex.com/books/',
      gutenbergTextBaseUrl: 'https://gutenberg.pglaf.org',
      mirrorPath: HOME_DEFAULT,
    });
  });

  it('passes explicit values through', async () => {
    expect(
      await parseWith({
        GUTENDEX_BASE_URL: 'http://127.0.0.1:9/books/',
        GUTENBERG_TEXT_BASE_URL: 'http://127.0.0.1:9',
        GUTENBERG_MIRROR_PATH: '/srv/catalog.sqlite',
        GUTENBERG_MIRROR_REFRESH_CRON: '0 4 * * *',
      }),
    ).toEqual({
      gutendexBaseUrl: 'http://127.0.0.1:9/books/',
      gutenbergTextBaseUrl: 'http://127.0.0.1:9',
      mirrorPath: '/srv/catalog.sqlite',
      mirrorRefreshCron: '0 4 * * *',
    });
  });

  it('fails naming the variable when a URL does not parse', async () => {
    await expect(parseWith({ GUTENDEX_BASE_URL: 'not-a-url' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('GUTENDEX_BASE_URL'),
    });
  });
});

describe('getServerConfig — catalog mirror path', () => {
  it('places the default under an absolute XDG_DATA_HOME', async () => {
    const config = await parseWith({ XDG_DATA_HOME: '/var/lib/reader-data' });
    expect(config.mirrorPath).toBe(
      '/var/lib/reader-data/gutenberg-mcp-server/gutenberg-catalog.sqlite',
    );
  });

  /** The XDG Base Directory spec: unset or empty means the default, relative is invalid. */
  it.each([
    ['empty', ''],
    ['relative', 'relative/data'],
    ['dot-relative', './data'],
  ])('falls back to ~/.local/share when XDG_DATA_HOME is %s', async (_label, xdg) => {
    const config = await parseWith({ XDG_DATA_HOME: xdg });
    expect(config.mirrorPath).toBe(HOME_DEFAULT);
  });

  it('lets GUTENBERG_MIRROR_PATH win over the per-user default', async () => {
    const config = await parseWith({
      XDG_DATA_HOME: '/var/lib/reader-data',
      GUTENBERG_MIRROR_PATH: './.mirror/gutenberg-catalog.sqlite',
    });
    expect(config.mirrorPath).toBe('./.mirror/gutenberg-catalog.sqlite');
  });

  it('uses the per-user default when GUTENBERG_MIRROR_PATH is blank', async () => {
    const config = await parseWith({
      XDG_DATA_HOME: '/var/lib/reader-data',
      GUTENBERG_MIRROR_PATH: '',
    });
    expect(config.mirrorPath).toBe(
      '/var/lib/reader-data/gutenberg-mcp-server/gutenberg-catalog.sqlite',
    );
  });
});
