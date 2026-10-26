/**
 * HLS egress byte counter (Wave 1C, design §J "HLS static middleware byte
 * counting per app").
 *
 * WIRING NOTE (flagged to the lead, NOT wired here): the live-HLS plane is a
 * RAW `app.use('/hls', …)` express mount registered in `main.ts` BEFORE
 * `app.listen()`, so it runs ahead of the Nest router and is TERMINAL (it ends
 * the response for a served segment and never calls `next()`). A NestModule
 * `configure()` middleware is applied during `app.init()` — i.e. AFTER that raw
 * mount — so it can never observe a served `.ts`/`.m3u8`. There is therefore no
 * additive seam from inside this module: counting HLS egress needs the factory
 * below wired at the FRONT of the `/hls` handler in `main.ts`. This file keeps
 * that wiring to a single, tested line the lead can drop in.
 *
 * The middleware is transparent: it wraps `res.write`/`res.end` to tally the
 * bytes actually streamed to the client (piping a file goes through `write`),
 * attributes them to the app parsed from the URL, and records on `finish`.
 * Never throws — a counter must never break playback.
 */
import type { Request, Response, NextFunction } from 'express';

import type { NetMetricsServiceContract } from './net-metrics.contract';

/**
 * Parse the app segment from an HLS request path. Accepts both the public form
 * `/hls/<app>/<room>/<file>` and the in-mount form `/<app>/<room>/<file>`
 * (inside `app.use('/hls', …)` express strips the mount prefix from `req.url`).
 * Returns null for anything that is not shaped like an app path.
 */
export function parseHlsApp(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  // Drop the query string, then an optional leading `/hls`.
  const path = rawUrl.split('?')[0].replace(/^\/hls(?=\/)/, '');
  const m = /^\/([^/]+)\/[^/]+\/.+$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Byte length of a write/end chunk (string → utf8 bytes, Buffer → length). */
function chunkBytes(chunk: unknown): number {
  if (!chunk) return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/**
 * Build the `/hls` egress byte-counting middleware bound to a recorder.
 * Placed BEFORE the static handler so its `write`/`end` wrappers see every byte.
 */
export function makeHlsByteCounter(
  recorder: NetMetricsServiceContract,
): (req: Request, res: Response, next: NextFunction) => void {
  return function hlsByteCounter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // HEAD carries a Content-Length but no body — never count it.
    if (req.method === 'HEAD') {
      next();
      return;
    }
    const app = parseHlsApp(req.originalUrl ?? req.url);
    if (!app) {
      next();
      return;
    }

    let counted = 0;
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
    res.write = ((chunk?: unknown, ...rest: unknown[]): boolean => {
      counted += chunkBytes(chunk);
      return origWrite(chunk, ...rest);
    }) as Response['write'];
    res.end = ((chunk?: unknown, ...rest: unknown[]): Response => {
      // `end()` may be called with (cb) or (encoding, cb) and no chunk.
      if (typeof chunk !== 'function') counted += chunkBytes(chunk);
      return origEnd(chunk, ...rest);
    }) as Response['end'];

    res.on('finish', () => {
      if (counted > 0) {
        try {
          recorder.recordBytes(app, 'out', 'hls', counted);
        } catch {
          /* never throw from a response hook */
        }
      }
    });

    next();
  };
}
