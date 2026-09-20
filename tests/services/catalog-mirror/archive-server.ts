/**
 * @fileoverview Local stand-in for a Project Gutenberg content mirror, serving a real
 * (small) `rdf-files.tar.bz2` off the loopback interface. The ingester is exercised end
 * to end — HTTP, bzip2, tar, XML, SQLite — rather than against a stubbed stream, so the
 * decompression and untar wiring is covered by the same tests as the parsing.
 * @module tests/services/catalog-mirror/archive-server
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const FIXTURE_DIR = new URL('../../fixtures/catalog-mirror/', import.meta.url);

/** Archive path a Project Gutenberg content mirror serves. */
const ARCHIVE_PATH = '/cache/epub/feeds/rdf-files.tar.bz2';

/** A loopback mirror whose archive contents and timestamp a test can swap mid-run. */
export interface ArchiveServer {
  /** Value for `GUTENBERG_TEXT_BASE_URL`. */
  baseUrl: string;
  close(): Promise<void>;
  /** Reject every request with this status until cleared. */
  failWith(status: number | null): void;
  /** GET requests served so far — how a test tells a re-harvest from a short-circuit. */
  gets: number;
  /** Swap in a different fixture archive and timestamp, as a daily rebuild would. */
  serve(fixture: string, lastModified: Date): void;
  /** Dribble the body out in 64-byte chunks so a mid-download abort is observable. */
  throttle(on: boolean): void;
}

/** Start a loopback mirror serving one of the committed fixture archives. */
export async function startArchiveServer(
  fixture: string,
  lastModified: Date,
): Promise<ArchiveServer> {
  let body = readFileSync(new URL(fixture, FIXTURE_DIR));
  let stamp = lastModified;
  let failure: number | null = null;
  let throttled = false;

  const server: Server = createServer((req, res) => {
    if (failure !== null) {
      res.writeHead(failure).end();
      return;
    }
    if (req.url !== ARCHIVE_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/x-bzip2');
    res.setHeader('Content-Length', String(body.byteLength));
    res.setHeader('Last-Modified', stamp.toUTCString());
    if (req.method === 'HEAD') {
      res.writeHead(200).end();
      return;
    }
    control.gets += 1;
    res.writeHead(200);
    if (!throttled) {
      res.end(body);
      return;
    }
    let offset = 0;
    const tick = setInterval(() => {
      if (res.destroyed) {
        clearInterval(tick);
        return;
      }
      res.write(body.subarray(offset, offset + 64));
      offset += 64;
      if (offset >= body.byteLength) {
        clearInterval(tick);
        res.end();
      }
    }, 5);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const control: ArchiveServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    gets: 0,
    serve(next, nextStamp) {
      body = readFileSync(new URL(next, FIXTURE_DIR));
      stamp = nextStamp;
    },
    failWith(status) {
      failure = status;
    },
    throttle(on) {
      throttled = on;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  return control;
}
