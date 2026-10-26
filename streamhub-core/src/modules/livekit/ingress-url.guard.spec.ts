/**
 * Unit spec — SSRF guard for the URL-pull ingress (ingress-url.guard.ts).
 *
 * `POST /apps/:app/ingress` with `inputType: 'url'` makes the LiveKit ingress
 * FETCH a tenant-supplied URL — the guard is what keeps that from becoming an
 * SSRF sink. Pins:
 *   1. scheme allowlist (http/https/rtsp/rtsps/rtmp/rtmps/srt) — file:,
 *      gopher:, data:, ftp: etc are 400;
 *   2. DENY path: the cloud metadata endpoint (169.254.169.254), RFC1918
 *      hosts, loopback, IPv6 loopback/ULA and 0.0.0.0 are all rejected — as
 *      IP literals AND as hostnames resolving there;
 *   3. multi-answer DNS: ANY private answer rejects (partial-poison defence);
 *   4. public addresses pass; unresolvable hosts are 400.
 *
 * DNS is an injected fake resolver — nothing dials the network.
 */
import { BadRequestException } from '@nestjs/common';

import {
  assertSafePullUrl,
  parsePullUrl,
} from './ingress-url.guard';

/** Resolver fake: a fixed hostname→addresses map; unknown hosts throw. */
function resolverOf(map: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => {
    const found = map[hostname];
    if (!found) throw new Error(`ENOTFOUND ${hostname}`);
    return found;
  };
}

const neverResolve = resolverOf({});

describe('ingress-url.guard — scheme allowlist', () => {
  it.each([
    'http://cam.example.com/stream.m3u8',
    'https://cdn.example.com/vod.mp4',
    'rtsp://cam.example.com/live',
    'rtsps://cam.example.com/live',
    'rtmp://origin.example.com/app/key',
    'rtmps://origin.example.com/app/key',
    'srt://relay.example.com:9000',
  ])('accepts the scheme of %s', (url) => {
    expect(() => parsePullUrl(url)).not.toThrow();
  });

  it.each([
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_SET%20x%20y',
    'ftp://internal/backup.tar',
    'data:text/plain,hola',
    'ws://internal:3020/socket',
    'not a url at all',
  ])('rejects %s with 400', async (url) => {
    await expect(assertSafePullUrl(url, neverResolve)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('ingress-url.guard — deny path (private / metadata addresses)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/', // cloud metadata (link-local)
    'http://127.0.0.1:3020/api/v1/health', // loopback
    'rtsp://10.0.0.15/cam', // RFC1918 10/8
    'rtsp://172.16.4.2/cam', // RFC1918 172.16/12
    'http://192.168.1.10/stream', // RFC1918 192.168/16
    'http://0.0.0.0:8080/', // unspecified
    'http://[::1]:3020/', // v6 loopback
    'http://[fc00::1]/x', // v6 ULA
    'http://[fe80::1]/x', // v6 link-local
  ])('rejects the IP-literal %s', async (url) => {
    await expect(assertSafePullUrl(url, neverResolve)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a hostname that RESOLVES to the metadata address', async () => {
    const resolve = resolverOf({ 'metadata.evil.tld': ['169.254.169.254'] });
    await expect(
      assertSafePullUrl('http://metadata.evil.tld/creds', resolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a hostname that RESOLVES to an RFC1918 address', async () => {
    const resolve = resolverOf({ 'intranet.evil.tld': ['10.20.30.40'] });
    await expect(
      assertSafePullUrl('rtsp://intranet.evil.tld/cam', resolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when ANY of several DNS answers is private (partial poison)', async () => {
    const resolve = resolverOf({
      'dual.evil.tld': ['93.184.216.34', '192.168.0.10'],
    });
    await expect(
      assertSafePullUrl('http://dual.evil.tld/playlist.m3u8', resolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ingress-url.guard — srt:// pull (SRT is UDP but resolves like any host)', () => {
  it('allows srt:// to a public host (hostname resolving public)', async () => {
    const resolve = resolverOf({ 'relay.example.com': ['93.184.216.34'] });
    await expect(
      assertSafePullUrl('srt://relay.example.com:9000', resolve),
    ).resolves.toBeUndefined();
  });

  it('allows srt:// to a public IP literal', async () => {
    await expect(
      assertSafePullUrl('srt://93.184.216.34:9000', neverResolve),
    ).resolves.toBeUndefined();
  });

  it('rejects srt://127.0.0.1 (loopback SSRF)', async () => {
    await expect(
      assertSafePullUrl('srt://127.0.0.1:9000', neverResolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects srt://169.254.169.254 (cloud metadata SSRF)', async () => {
    await expect(
      assertSafePullUrl('srt://169.254.169.254:9000', neverResolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an srt:// hostname that RESOLVES to a private address', async () => {
    const resolve = resolverOf({ 'intranet.evil.tld': ['10.20.30.40'] });
    await expect(
      assertSafePullUrl('srt://intranet.evil.tld:9000', resolve),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ingress-url.guard — allow path', () => {
  it('accepts a public IP literal', async () => {
    await expect(
      assertSafePullUrl('rtsp://93.184.216.34/cam1', neverResolve),
    ).resolves.toBeUndefined();
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    const resolve = resolverOf({
      'cam.example.com': ['93.184.216.34', '2606:2800:220:1::1'],
    });
    await expect(
      assertSafePullUrl('rtsp://cam.example.com/live', resolve),
    ).resolves.toBeUndefined();
  });

  it('400s an unresolvable or empty-answer host', async () => {
    await expect(
      assertSafePullUrl('http://nope.invalid/x', neverResolve),
    ).rejects.toBeInstanceOf(BadRequestException);
    const empty = resolverOf({ 'empty.example.com': [] });
    await expect(
      assertSafePullUrl('http://empty.example.com/x', empty),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
