/**
 * Unit spec — HLS egress byte-counter middleware. No express/HTTP: a fake
 * req/res drives the write/end wrappers and the `finish` hook. Locks:
 *   - app parsing from both /hls/<app>/… and in-mount /<app>/… paths,
 *   - bytes tallied from write()+end() and recorded once on finish,
 *   - HEAD and non-app paths are pass-through (no recording),
 *   - a throwing recorder never escapes the finish hook.
 */
import { EventEmitter } from 'events';

import {
  makeHlsByteCounter,
  parseHlsApp,
} from './hls-byte-counter.middleware';
import type { NetMetricsServiceContract } from './net-metrics.contract';

describe('parseHlsApp', () => {
  it('parses the app from a public /hls path', () => {
    expect(parseHlsApp('/hls/live/room1/index.m3u8')).toBe('live');
    expect(parseHlsApp('/hls/my-app/r/seg_00042.ts?x=1')).toBe('my-app');
  });

  it('parses the app from an in-mount path (mount prefix stripped)', () => {
    expect(parseHlsApp('/live/room1/seg.ts')).toBe('live');
  });

  it('url-decodes the app segment', () => {
    expect(parseHlsApp('/hls/a%20b/r/f.ts')).toBe('a b');
  });

  it('returns null for non-app shapes', () => {
    expect(parseHlsApp('/hls/live')).toBeNull(); // no room/file
    expect(parseHlsApp('/hls/')).toBeNull();
    expect(parseHlsApp(undefined)).toBeNull();
    expect(parseHlsApp('')).toBeNull();
  });
});

interface FakeRes extends EventEmitter {
  write: (chunk?: unknown, ...rest: unknown[]) => boolean;
  end: (chunk?: unknown, ...rest: unknown[]) => FakeRes;
}

function fakeRes(): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.write = () => true;
  res.end = () => res;
  return res;
}

function recorder(): {
  calls: [string, string, string, number][];
  svc: NetMetricsServiceContract;
} {
  const calls: [string, string, string, number][] = [];
  return {
    calls,
    svc: { recordBytes: (a, d, s, b) => calls.push([a, d, s, b]) },
  };
}

describe('makeHlsByteCounter', () => {
  it('records the summed write()+end() bytes on finish', () => {
    const { calls, svc } = recorder();
    const mw = makeHlsByteCounter(svc);
    const req = { method: 'GET', originalUrl: '/hls/live/r/seg.ts' } as never;
    const res = fakeRes();
    let nexted = false;

    mw(req, res as never, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);

    res.write(Buffer.alloc(1000));
    res.write('hello'); // 5 utf8 bytes
    res.end(Buffer.alloc(24));
    res.emit('finish');

    expect(calls).toEqual([['live', 'out', 'hls', 1029]]);
  });

  it('does not record for a HEAD request', () => {
    const { calls, svc } = recorder();
    const mw = makeHlsByteCounter(svc);
    const res = fakeRes();
    mw(
      { method: 'HEAD', originalUrl: '/hls/live/r/seg.ts' } as never,
      res as never,
      () => undefined,
    );
    res.emit('finish');
    expect(calls).toEqual([]);
  });

  it('does not record for a non-app path', () => {
    const { calls, svc } = recorder();
    const mw = makeHlsByteCounter(svc);
    const res = fakeRes();
    mw(
      { method: 'GET', originalUrl: '/hls/favicon.ico' } as never,
      res as never,
      () => undefined,
    );
    res.write(Buffer.alloc(50));
    res.emit('finish');
    expect(calls).toEqual([]);
  });

  it('records nothing when zero bytes were written', () => {
    const { calls, svc } = recorder();
    const mw = makeHlsByteCounter(svc);
    const res = fakeRes();
    mw(
      { method: 'GET', originalUrl: '/hls/live/r/seg.ts' } as never,
      res as never,
      () => undefined,
    );
    res.emit('finish'); // 304 / empty body
    expect(calls).toEqual([]);
  });

  it('swallows a throwing recorder', () => {
    const mw = makeHlsByteCounter({
      recordBytes: () => {
        throw new Error('boom');
      },
    });
    const res = fakeRes();
    mw(
      { method: 'GET', originalUrl: '/hls/live/r/seg.ts' } as never,
      res as never,
      () => undefined,
    );
    res.write(Buffer.alloc(10));
    expect(() => res.emit('finish')).not.toThrow();
  });
});
