/**
 * Unit spec — S3Service custom-endpoint SSRF guard (fix P0-1).
 *
 * A tenant-supplied custom S3 endpoint (MinIO/Wasabi field) makes the core
 * dial it with signed requests — an SSRF sink toward metadata/internal hosts.
 * Locks down:
 *   - upload/presignGet/delete/exists all REJECT a private/metadata endpoint
 *     before any SDK dial,
 *   - hostnames are DNS-checked (injected fake — never the network),
 *   - plain AWS configs (no endpoint) are untouched,
 *   - STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1 (default off) is the self-hosted
 *     MinIO escape, and it never bypasses the http(s) scheme allowlist.
 */
import { BadRequestException } from '@nestjs/common';

import { S3Service } from './s3.service';
import { ALLOW_PRIVATE_S3_ENDPOINT_ENV } from '../security/egress-url.guard';
import type { S3Config } from '../../shared/contracts';

function cfg(endpoint?: string): S3Config {
  return {
    provider: 'minio',
    bucket: 'vods',
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    prefix: '',
    accessKey: 'AKIA-TEST',
    secretKey: 'shhh',
  } as S3Config;
}

describe('S3Service — custom endpoint SSRF guard', () => {
  let svc: S3Service;
  const prevEscape = process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV];

  beforeEach(() => {
    svc = new S3Service();
    svc.hostResolver = async (hostname: string) => {
      if (hostname === 'minio.internal.lan') return ['10.1.2.3'];
      if (hostname === 's3.example.com') return ['93.184.216.34'];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    delete process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV];
  });

  afterEach(() => {
    svc.evict();
    if (prevEscape === undefined) delete process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV];
    else process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV] = prevEscape;
  });

  it.each([
    'http://169.254.169.254', // cloud metadata
    'http://127.0.0.1:9000', // loopback
    'http://192.168.1.50:9000', // RFC1918
    'http://[fc00::1]:9000', // v6 ULA
  ])('rejects the private endpoint %s on every operation', async (endpoint) => {
    const config = cfg(endpoint);
    await expect(svc.presignGet(config, 'k.mp4')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.upload(config, '/tmp/nope.mp4', 'k.mp4')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.delete(config, 'k.mp4')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.exists(config, 'k.mp4')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an endpoint hostname that RESOLVES to an RFC1918 address', async () => {
    await expect(
      svc.presignGet(cfg('http://minio.internal.lan:9000'), 'k.mp4'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a public custom endpoint (presign is offline)', async () => {
    const url = await svc.presignGet(cfg('https://s3.example.com'), 'k.mp4');
    expect(url).toContain('s3.example.com');
  });

  it('a plain AWS config (no endpoint) is not affected', async () => {
    const url = await svc.presignGet(cfg(undefined), 'k.mp4');
    expect(url).toContain('amazonaws.com');
  });

  it('STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1 admits a private MinIO endpoint', async () => {
    process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV] = '1';
    const url = await svc.presignGet(cfg('http://192.168.1.50:9000'), 'k.mp4');
    expect(url).toContain('192.168.1.50');
  });

  it('the escape hatch never admits a non-http(s) scheme', async () => {
    process.env[ALLOW_PRIVATE_S3_ENDPOINT_ENV] = '1';
    await expect(
      svc.presignGet(cfg('gopher://192.168.1.50:9000'), 'k.mp4'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
