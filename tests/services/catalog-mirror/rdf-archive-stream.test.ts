/**
 * @fileoverview Tests for the bulk-archive reader: URL derivation, the `Last-Modified`
 * probe that decides whether a refresh has work to do, and the download → bzip2 → tar
 * pipeline that feeds the ingester.
 * @module tests/services/catalog-mirror/rdf-archive-stream.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ArchiveEntry,
  catalogArchiveUrl,
  readArchiveTimestamp,
  streamCatalogArchive,
} from '@/services/catalog-mirror/rdf-archive-stream.js';
import { type ArchiveServer, startArchiveServer } from './archive-server.js';

const STAMP = new Date('2026-08-21T14:40:50Z');
/** Books in the fixture archive, by ID. */
const FIXTURE_IDS = [84, 1000, 1073, 1399, 10001, 10056, 10137, 45304];

let mirror: ArchiveServer | undefined;

afterEach(async () => {
  await mirror?.close();
  mirror = undefined;
});

async function collect(url: string, skip?: number): Promise<ArchiveEntry[]> {
  return collect2(url, AbortSignal.timeout(30_000), skip);
}

async function collect2(url: string, signal: AbortSignal, skip?: number): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  for await (const entry of streamCatalogArchive(url, signal, skip)) entries.push(entry);
  return entries;
}

describe('catalogArchiveUrl', () => {
  it('hangs the feeds path off the configured content mirror', () => {
    expect(catalogArchiveUrl('https://gutenberg.pglaf.org')).toBe(
      'https://gutenberg.pglaf.org/cache/epub/feeds/rdf-files.tar.bz2',
    );
  });

  it('does not double the separator when the base URL ends in a slash', () => {
    expect(catalogArchiveUrl('https://mirror.test/')).toBe(
      'https://mirror.test/cache/epub/feeds/rdf-files.tar.bz2',
    );
  });
});

describe('readArchiveTimestamp', () => {
  it('reads Last-Modified as an ISO 8601 timestamp', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    await expect(
      readArchiveTimestamp(catalogArchiveUrl(mirror.baseUrl), AbortSignal.timeout(10_000)),
    ).resolves.toBe(STAMP.toISOString());
  });

  it('reports an unreachable mirror as a service failure, not a missing timestamp', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    mirror.failWith(503);
    await expect(
      readArchiveTimestamp(catalogArchiveUrl(mirror.baseUrl), AbortSignal.timeout(10_000)),
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe('streamCatalogArchive', () => {
  it('yields every per-book document in the archive', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    const entries = await collect(catalogArchiveUrl(mirror.baseUrl));
    expect(entries.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(FIXTURE_IDS);
    expect(entries.map((entry) => entry.index)).toEqual(FIXTURE_IDS.map((_, i) => i));
    for (const entry of entries) expect(entry.xml).toContain('<pgterms:ebook');
  });

  it('skips directory entries without spending a position on them', async () => {
    /** The archive carries a directory entry per book; only files take an index. */
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    const entries = await collect(catalogArchiveUrl(mirror.baseUrl));
    expect(entries).toHaveLength(FIXTURE_IDS.length);
  });

  it('resumes at a position, leaving the earlier entries unread', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    const url = catalogArchiveUrl(mirror.baseUrl);
    const all = await collect(url);
    const tail = await collect(url, 3);
    expect(tail).toHaveLength(all.length - 3);
    expect(tail[0]?.index).toBe(3);
    expect(tail.map((entry) => entry.id)).toEqual(all.slice(3).map((entry) => entry.id));
  });

  it('yields nothing when the resume position is past the end', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    await expect(collect(catalogArchiveUrl(mirror.baseUrl), 500)).resolves.toEqual([]);
  });

  it('reports a non-OK mirror response as a service failure', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    mirror.failWith(503);
    await expect(collect(catalogArchiveUrl(mirror.baseUrl))).rejects.toBeInstanceOf(McpError);
  });

  it('rejects when the caller has already aborted', async () => {
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    await expect(collect(catalogArchiveUrl(mirror.baseUrl), 0)).resolves.toHaveLength(8);
    await expect(
      collect2(catalogArchiveUrl(mirror.baseUrl), AbortSignal.abort()),
    ).rejects.toThrow();
  });

  it('surfaces a download cut short mid-stream instead of ending quietly', async () => {
    /**
     * `pipe` does not forward errors, so without the explicit forwarding in the reader a
     * broken download stalls the loop rather than throwing out of it. The dribbled body
     * is what makes the abort land mid-download instead of after the last byte.
     */
    mirror = await startArchiveServer('catalog-sample.tar.bz2', STAMP);
    mirror.throttle(true);
    const controller = new AbortController();
    const url = catalogArchiveUrl(mirror.baseUrl);
    setTimeout(() => controller.abort(), 20);
    await expect(collect2(url, controller.signal)).rejects.toThrow();
  });
});
