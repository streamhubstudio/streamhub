/**
 * Unit spec — generic egress SSRF guard (egress-url.guard.ts, fix P0-1).
 *
 * The guard is the single primitive behind the three tenant-controlled egress
 * sinks (callback URL, custom S3 endpoint, MQTT broker URL). Pins:
 *   1. scheme allowlists per sink (file:, gopher:, data:… always 400);
 *   2. DENY path: the cloud metadata endpoint (169.254.169.254), RFC1918
 *      hosts, loopback, IPv6 loopback/ULA/link-local and 0.0.0.0 — as IP
 *      literals AND as hostnames resolving there;
 *   3. multi-answer DNS: ANY private answer rejects (partial poison);
 *   4. escape hatches: `allowPrivate` skips only the private check (schemes
 *      still enforced); `allowlist` exempts exact hostnames and IP/CIDRs;
 *   5. the sync variant (assertSafeEgressUrlSync) blocks IP literals with no
 *      DNS at all.
 *
 * DNS is an injected fake resolver — nothing dials the network.
 */
import { BadRequestException } from '@nestjs/common';

import {
  assertSafeEgressUrl,
  assertSafeEgressUrlSync,
  envFlag,
  HTTP_SCHEMES,
  MQTT_SCHEMES,
  parseAllowlistEnv,
  parseEgressUrl,
} from './egress-url.guard';

/** Resolver fake: a fixed hostname→addresses map; unknown hosts throw. */
function resolverOf(map: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => {
    const found = map[hostname];
    if (!found) throw new Error(`ENOTFOUND ${hostname}`);
    return found;
  };
}

const neverResolve = resolverOf({});
const http = { allowedSchemes: HTTP_SCHEMES, label: 'callback URL' };

describe('egress-url.guard — scheme allowlist', () => {
  it.each([
    'http://hook.example.com/cb',
    'https://hook.example.com/cb',
  ])('accepts the scheme of %s (http sinks)', (url) => {
    expect(() => parseEgressUrl(url, http)).not.toThrow();
  });

  it.each([
    'mqtt://broker.example.com:1883',
    'mqtts://broker.example.com:8883',
    'ws://broker.example.com/mqtt',
    'wss://broker.example.com/mqtt',
  ])('accepts the scheme of %s (mqtt sinks)', (url) => {
    expect(() =>
      parseEgressUrl(url, { allowedSchemes: MQTT_SCHEMES, label: 'MQTT broker URL' }),
    ).not.toThrow();
  });

  it.each([
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_SET%20x%20y',
    'ftp://internal/backup.tar',
    'data:text/plain,hola',
    'mqtt://broker.example.com:1883', // wrong sink: not an http scheme
    'not a url at all',
  ])('rejects %s for an http sink with 400', async (url) => {
    await expect(
      assertSafeEgressUrl(url, { ...http, resolveHost: neverResolve }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('egress-url.guard — deny path (private / metadata addresses)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/', // cloud metadata (link-local)
    'http://127.0.0.1:3020/api/v1/health', // loopback
    'http://10.0.0.15/hook', // RFC1918 10/8
    'http://172.16.4.2/hook', // RFC1918 172.16/12
    'http://192.168.1.10/hook', // RFC1918 192.168/16
    'http://0.0.0.0:8080/', // unspecified
    'http://[::1]:3020/', // v6 loopback
    'http://[fc00::1]/x', // v6 ULA
    'http://[fe80::1]/x', // v6 link-local
  ])('rejects the IP-literal %s', async (url) => {
    await expect(
      assertSafeEgressUrl(url, { ...http, resolveHost: neverResolve }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a hostname that RESOLVES to the metadata address', async () => {
    const resolve = resolverOf({ 'metadata.evil.tld': ['169.254.169.254'] });
    await expect(
      assertSafeEgressUrl('https://metadata.evil.tld/creds', {
        ...http,
        resolveHost: resolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a hostname that RESOLVES to an RFC1918 address', async () => {
    const resolve = resolverOf({ 'intranet.evil.tld': ['10.20.30.40'] });
    await expect(
      assertSafeEgressUrl('https://intranet.evil.tld/hook', {
        ...http,
        resolveHost: resolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when ANY of several DNS answers is private (partial poison)', async () => {
    const resolve = resolverOf({
      'dual.evil.tld': ['93.184.216.34', '192.168.0.10'],
    });
    await expect(
      assertSafeEgressUrl('https://dual.evil.tld/hook', {
        ...http,
        resolveHost: resolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s an unresolvable or empty-answer host', async () => {
    await expect(
      assertSafeEgressUrl('http://nope.invalid/x', {
        ...http,
        resolveHost: neverResolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const empty = resolverOf({ 'empty.example.com': [] });
    await expect(
      assertSafeEgressUrl('http://empty.example.com/x', {
        ...http,
        resolveHost: empty,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('egress-url.guard — allow path', () => {
  it('accepts a public IP literal', async () => {
    await expect(
      assertSafeEgressUrl('https://93.184.216.34/hook', {
        ...http,
        resolveHost: neverResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    const resolve = resolverOf({
      'hook.example.com': ['93.184.216.34', '2606:2800:220:1::1'],
    });
    await expect(
      assertSafeEgressUrl('https://hook.example.com/cb', {
        ...http,
        resolveHost: resolve,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('egress-url.guard — escape hatches (default deny)', () => {
  it('allowPrivate skips the private check but NOT the scheme allowlist', async () => {
    await expect(
      assertSafeEgressUrl('http://192.168.1.50:9000', {
        allowedSchemes: HTTP_SCHEMES,
        label: 'S3 endpoint',
        allowPrivate: true,
        resolveHost: neverResolve,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeEgressUrl('gopher://192.168.1.50:9000', {
        allowedSchemes: HTTP_SCHEMES,
        label: 'S3 endpoint',
        allowPrivate: true,
        resolveHost: neverResolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an allowlisted hostname passes without DNS resolution', async () => {
    await expect(
      assertSafeEgressUrl('https://Hooks.Internal.LAN/cb', {
        ...http,
        allowlist: ['hooks.internal.lan'],
        resolveHost: neverResolve, // would throw if consulted
      }),
    ).resolves.toBeUndefined();
  });

  it('an allowlisted CIDR admits a private IP literal / private answer', async () => {
    await expect(
      assertSafeEgressUrl('http://10.1.2.3/hook', {
        ...http,
        allowlist: ['10.1.2.0/24'],
        resolveHost: neverResolve,
      }),
    ).resolves.toBeUndefined();
    const resolve = resolverOf({ 'minio.lan': ['10.1.2.9'] });
    await expect(
      assertSafeEgressUrl('http://minio.lan/hook', {
        ...http,
        allowlist: ['10.1.2.0/24'],
        resolveHost: resolve,
      }),
    ).resolves.toBeUndefined();
  });

  it('the allowlist does NOT admit private addresses outside its entries', async () => {
    await expect(
      assertSafeEgressUrl('http://10.9.9.9/hook', {
        ...http,
        allowlist: ['10.1.2.0/24', 'other.host'],
        resolveHost: neverResolve,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('egress-url.guard — sync variant (no DNS)', () => {
  it('blocks private IP literals and forbidden schemes', () => {
    expect(() =>
      assertSafeEgressUrlSync('mqtt://169.254.169.254:1883', {
        allowedSchemes: MQTT_SCHEMES,
        label: 'MQTT broker URL',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertSafeEgressUrlSync('gopher://broker/x', {
        allowedSchemes: MQTT_SCHEMES,
        label: 'MQTT broker URL',
      }),
    ).toThrow(BadRequestException);
  });

  it('passes public literals and (unresolved) hostnames; honours allowPrivate', () => {
    expect(() =>
      assertSafeEgressUrlSync('mqtt://93.184.216.34:1883', {
        allowedSchemes: MQTT_SCHEMES,
        label: 'MQTT broker URL',
      }),
    ).not.toThrow();
    // Hostnames are left to the async config-layer guard.
    expect(() =>
      assertSafeEgressUrlSync('mqtt://broker.lan:1883', {
        allowedSchemes: MQTT_SCHEMES,
        label: 'MQTT broker URL',
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeEgressUrlSync('mqtt://127.0.0.1:1883', {
        allowedSchemes: MQTT_SCHEMES,
        label: 'MQTT broker URL',
        allowPrivate: true,
      }),
    ).not.toThrow();
  });
});

describe('egress-url.guard — env helpers', () => {
  it('envFlag accepts 1/true/yes/on only', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) expect(envFlag(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off', 'nope']) {
      expect(envFlag(v)).toBe(false);
    }
  });

  it('parseAllowlistEnv splits, trims and drops empties', () => {
    expect(parseAllowlistEnv(' a.example , 10.0.0.0/8 ,, ')).toEqual([
      'a.example',
      '10.0.0.0/8',
    ]);
    expect(parseAllowlistEnv(undefined)).toEqual([]);
  });
});
