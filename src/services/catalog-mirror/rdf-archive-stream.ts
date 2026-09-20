/**
 * @fileoverview Streams Project Gutenberg's bulk per-book RDF archive
 * (`rdf-files.tar.bz2`, ~121 MB compressed / ~2 GB expanded) entry by entry, so the
 * catalog ingester never holds more than one book's XML in memory.
 *
 * The archive lives under the same `/cache/epub/` tree the text service already
 * fetches from, so its URL is derived from `GUTENBERG_TEXT_BASE_URL` rather than a
 * second mirror setting — an operator who repoints the mirror moves the text fetches
 * and the catalog sync together. The main site (`www.gutenberg.org`) answers this
 * path with 503 under its block on automated access; the content mirrors serve it.
 * @module services/catalog-mirror/rdf-archive-stream
 */

import { Readable } from 'node:stream';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { extract } from 'tar-stream';
import bz2 from 'unbzip2-stream';

/** Path of the bulk RDF archive beneath a Project Gutenberg content mirror. */
const ARCHIVE_PATH = '/cache/epub/feeds/rdf-files.tar.bz2';

/** Archive entry name for one book: `cache/epub/<id>/pg<id>.rdf`. */
const ENTRY_NAME = /^cache\/epub\/(\d+)\/pg\1\.rdf$/;

/** One book's RDF document, lifted out of the archive. */
export interface ArchiveEntry {
  /** Gutenberg ID, taken from the entry path. */
  id: number;
  /** Zero-based position of this entry in the archive. */
  index: number;
  /** The RDF/XML document. */
  xml: string;
}

/** Absolute URL of the bulk RDF archive on the configured content mirror. */
export function catalogArchiveUrl(textBaseUrl: string): string {
  const base = textBaseUrl.endsWith('/') ? textBaseUrl.slice(0, -1) : textBaseUrl;
  return `${base}${ARCHIVE_PATH}`;
}

/**
 * Read the archive's `Last-Modified` as an ISO 8601 timestamp without downloading it.
 * The value is the mirror's durable high-water mark: Project Gutenberg rebuilds the
 * archive daily, and an unchanged timestamp means a refresh has nothing to harvest.
 *
 * @returns The timestamp, or null when the mirror serves no usable `Last-Modified`.
 */
export async function readArchiveTimestamp(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(url, { method: 'HEAD', signal });
  if (!response.ok) {
    throw serviceUnavailable(
      `The Project Gutenberg content mirror answered ${response.status} for the catalog archive.`,
      { status: response.status },
    );
  }
  const lastModified = response.headers.get('last-modified');
  if (lastModified === null) return null;
  const parsed = new Date(lastModified);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Stream every per-book RDF document out of the archive, in archive order.
 *
 * Decompression and untarring run as a pipe chain rather than one buffered read: the
 * expanded archive is an order of magnitude larger than the download, so buffering it
 * would cost gigabytes of resident memory for no benefit.
 *
 * Entries are emitted in archive order, which is stable for a given rebuild but is
 * not sorted — Project Gutenberg's packer walks the id directories as a prefix tree,
 * so `10009` precedes `1000`. Position, not name, is therefore the only usable resume
 * key, and it is only meaningful against the same rebuild.
 *
 * @param url - Archive URL, from {@link catalogArchiveUrl}.
 * @param signal - Aborts the download and ends iteration.
 * @param skip - Number of leading entries to pass over without reading their contents.
 *   Resumes an interrupted run without re-parsing what already landed; the download
 *   itself cannot be resumed, because a bzip2 stream has no seekable index.
 */
export async function* streamCatalogArchive(
  url: string,
  signal: AbortSignal,
  skip = 0,
): AsyncGenerator<ArchiveEntry> {
  const response = await fetch(url, { signal });
  if (!response.ok || response.body === null) {
    throw serviceUnavailable(
      `The Project Gutenberg content mirror answered ${response.status} for the catalog archive.`,
      { status: response.status },
    );
  }

  const source = Readable.fromWeb(response.body);
  const entries = extract();
  /**
   * `pipe` does not forward errors downstream, so a failed download or a corrupt
   * bzip2 block would otherwise stall the loop instead of throwing out of it.
   */
  const fail = (error: Error) => entries.destroy(error);
  source.on('error', fail);
  const decompressed = source.pipe(bz2());
  decompressed.on('error', fail);
  decompressed.pipe(entries);

  let index = 0;
  try {
    for await (const entry of entries) {
      const match = ENTRY_NAME.exec(entry.header.name);
      if (match === null) {
        entry.resume();
        continue;
      }
      const position = index;
      index += 1;
      if (position < skip) {
        entry.resume();
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      yield { id: Number(match[1]), index: position, xml: Buffer.concat(chunks).toString('utf8') };
    }
  } finally {
    source.destroy();
  }
}
