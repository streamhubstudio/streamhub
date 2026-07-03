/**
 * Unit specs for S3Service (module recording-s3-vods).
 *
 * The AWS SDK (@aws-sdk/client-s3) and the presigner are mocked so nothing
 * touches the network: `S3Client.send` is a single jest.fn (`mockS3Send`) whose
 * resolved/rejected value the tests drive, and each command constructor is a
 * jest.fn that echoes its input so we can assert Bucket/Key/ContentType/… .
 *
 * Focus: key assembly (prefix dedup, leading-slash), the public (canonical) URL
 * builder across providers, TTL clamping for presigned GETs, content-type
 * guessing, idempotent delete, exists, and config validation.
 */
import { InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { S3Config } from '../../shared/contracts';

// Partial fs mock: everything real EXCEPT createReadStream, which we replace
// with a benign in-memory stream. The service streams the upload body but the
// mocked SDK send never consumes it, so a real ReadStream would leak an async
// file open that races with per-test dir cleanup (ENOENT). Only fs.stat (size
// validation) needs to hit disk.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const { Readable } = jest.requireActual('stream');
  return {
    ...actual,
    createReadStream: jest.fn(() => {
      const r = Readable.from([Buffer.from('x')]);
      r.destroy = () => undefined;
      return r;
    }),
  };
});

// ---- AWS SDK mocks (hoisted; only `mock*`-prefixed refs allowed inside) -----
const mockS3Send = jest.fn();
const mockS3Destroy = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockS3Send,
    destroy: mockS3Destroy,
  })),
  PutObjectCommand: jest.fn((input: unknown) => ({ __cmd: 'Put', input })),
  GetObjectCommand: jest.fn((input: unknown) => ({ __cmd: 'Get', input })),
  HeadObjectCommand: jest.fn((input: unknown) => ({ __cmd: 'Head', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ __cmd: 'Delete', input })),
}));

const mockGetSignedUrl = jest.fn(
  async (_client: unknown, cmd: { input: { Key: string } }, opts: { expiresIn: number }) =>
    `https://presigned.test/${cmd.input.Key}?exp=${opts.expiresIn}`,
);
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...a: unknown[]) => mockGetSignedUrl(...(a as [unknown, { input: { Key: string } }, { expiresIn: number }])),
}));

// Import AFTER the mocks are registered.
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Service } from './s3.service';

function baseCfg(overrides: Partial<S3Config> = {}): S3Config {
  return {
    provider: 'aws',
    bucket: 'my-bucket',
    region: 'us-east-1',
    forcePathStyle: false,
    prefix: 'streamhub/live',
    accessKey: 'AKIA_TEST',
    secretKey: 'secret_test',
    ...overrides,
  };
}

describe('S3Service', () => {
  let svc: S3Service;
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({ ETag: '"deadbeef"' });
    svc = new S3Service();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-spec-'));
    tmpFile = path.join(tmpDir, 'clip.mp4');
    fs.writeFileSync(tmpFile, Buffer.from('hello-mp4-bytes'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  const putInput = (call = 0): Record<string, unknown> =>
    (PutObjectCommand as unknown as jest.Mock).mock.calls[call][0];

  // ---- upload / key assembly -------------------------------------------
  describe('upload + key assembly', () => {
    it('prepends the configured prefix to the object key', async () => {
      const res = await svc.upload(baseCfg(), tmpFile, 'clip.mp4', 'video/mp4');
      expect(res.key).toBe('streamhub/live/clip.mp4');
      expect(putInput().Key).toBe('streamhub/live/clip.mp4');
      expect(putInput().Bucket).toBe('my-bucket');
      expect(putInput().ContentType).toBe('video/mp4');
    });

    it('does NOT double-prefix a key that already carries the prefix', async () => {
      const res = await svc.upload(
        baseCfg(),
        tmpFile,
        'streamhub/live/clip.mp4',
        'video/mp4',
      );
      expect(res.key).toBe('streamhub/live/clip.mp4');
    });

    it('does not treat a prefix look-alike as already-prefixed (slash boundary)', async () => {
      const res = await svc.upload(
        baseCfg({ prefix: 'streamhub/live' }),
        tmpFile,
        'streamhub/live-extra/clip.mp4',
        'video/mp4',
      );
      expect(res.key).toBe('streamhub/live/streamhub/live-extra/clip.mp4');
    });

    it('strips leading slashes and applies no prefix when prefix is empty', async () => {
      const res = await svc.upload(
        baseCfg({ prefix: '' }),
        tmpFile,
        '/clip.mp4',
        'video/mp4',
      );
      expect(res.key).toBe('clip.mp4');
    });

    it('returns size, canonical url and a quote-stripped etag', async () => {
      const size = fs.statSync(tmpFile).size;
      const res = await svc.upload(baseCfg(), tmpFile, 'clip.mp4', 'video/mp4');
      expect(res.sizeBytes).toBe(size);
      expect(res.etag).toBe('deadbeef');
      expect(res.bucket).toBe('my-bucket');
      // canonical URL == publicUrlFor(cfg, key)
      expect(res.url).toBe(
        'https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4',
      );
      expect(putInput().ContentLength).toBe(size);
    });

    it('guesses the content-type from the extension when none is passed', async () => {
      const jpg = path.join(tmpDir, 'thumb.jpg');
      fs.writeFileSync(jpg, Buffer.from('x'));
      await svc.upload(baseCfg(), jpg, 'thumb.jpg');
      expect(putInput().ContentType).toBe('image/jpeg');
    });

    it('wraps a missing local file in an InternalServerErrorException', async () => {
      await expect(
        svc.upload(baseCfg(), path.join(tmpDir, 'nope.mp4'), 'x.mp4'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('rejects when the source path is a directory (not a file)', async () => {
      await expect(
        svc.upload(baseCfg(), tmpDir, 'x.mp4'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('wraps an SDK send failure (no secret leak, controlled exception)', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('boom-network'));
      await expect(
        svc.upload(baseCfg(), tmpFile, 'clip.mp4'),
      ).rejects.toThrow(/S3 upload failed for key streamhub\/live\/clip\.mp4/);
    });
  });

  // ---- assertConfig -----------------------------------------------------
  describe('config validation', () => {
    it('throws when bucket is missing', async () => {
      await expect(
        svc.upload(baseCfg({ bucket: '' }), tmpFile, 'k'),
      ).rejects.toThrow(/bucket is required/);
    });

    it('throws when credentials are unresolved', async () => {
      await expect(
        svc.upload(baseCfg({ secretKey: '' }), tmpFile, 'k'),
      ).rejects.toThrow(/credentials unresolved/);
    });
  });

  // ---- presignGet / TTL clamping ---------------------------------------
  describe('presignGet', () => {
    beforeEach(() => mockGetSignedUrl.mockClear());

    it('applies the prefix to the signed key and honours a valid ttl', async () => {
      const url = await svc.presignGet(baseCfg(), 'clip.mp4', 1800);
      expect(url).toContain('streamhub/live/clip.mp4');
      expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 1800 });
    });

    it('defaults to 1h when ttl is undefined', async () => {
      await svc.presignGet(baseCfg(), 'clip.mp4');
      expect(mockGetSignedUrl.mock.calls[0][2].expiresIn).toBe(3600);
    });

    it('defaults to 1h for non-positive / non-finite ttl', async () => {
      await svc.presignGet(baseCfg(), 'clip.mp4', 0);
      await svc.presignGet(baseCfg(), 'clip.mp4', -5);
      expect(mockGetSignedUrl.mock.calls[0][2].expiresIn).toBe(3600);
      expect(mockGetSignedUrl.mock.calls[1][2].expiresIn).toBe(3600);
    });

    it('caps ttl at the SigV4 maximum of 7 days', async () => {
      await svc.presignGet(baseCfg(), 'clip.mp4', 30 * 24 * 3600);
      expect(mockGetSignedUrl.mock.calls[0][2].expiresIn).toBe(7 * 24 * 3600);
    });

    it('floors fractional ttl seconds', async () => {
      await svc.presignGet(baseCfg(), 'clip.mp4', 100.9);
      expect(mockGetSignedUrl.mock.calls[0][2].expiresIn).toBe(100);
    });
  });

  // ---- delete (idempotent) / exists ------------------------------------
  describe('delete', () => {
    it('swallows a NotFound error (delete is idempotent)', async () => {
      mockS3Send.mockRejectedValueOnce({ name: 'NotFound' });
      await expect(svc.delete(baseCfg(), 'clip.mp4')).resolves.toBeUndefined();
    });

    it('swallows a 404 (via $metadata.httpStatusCode)', async () => {
      mockS3Send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
      await expect(svc.delete(baseCfg(), 'clip.mp4')).resolves.toBeUndefined();
    });

    it('re-throws a non-404 error', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('access denied'));
      await expect(svc.delete(baseCfg(), 'clip.mp4')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('exists', () => {
    it('returns true when HEAD succeeds', async () => {
      mockS3Send.mockResolvedValueOnce({});
      await expect(svc.exists(baseCfg(), 'clip.mp4')).resolves.toBe(true);
    });

    it('returns false when the object is not found', async () => {
      mockS3Send.mockRejectedValueOnce({ name: 'NotFound' });
      await expect(svc.exists(baseCfg(), 'clip.mp4')).resolves.toBe(false);
    });

    it('re-throws unexpected errors', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('kaput'));
      await expect(svc.exists(baseCfg(), 'clip.mp4')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  // ---- publicUrlFor across providers -----------------------------------
  describe('publicUrlFor', () => {
    it('AWS virtual-host style', () => {
      expect(svc.publicUrlFor(baseCfg(), 'clip.mp4')).toBe(
        'https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4',
      );
    });

    it('MinIO path-style (endpoint + forcePathStyle)', () => {
      const cfg = baseCfg({
        provider: 'minio',
        endpoint: 'http://minio.local:9000/',
        forcePathStyle: true,
      });
      expect(svc.publicUrlFor(cfg, 'clip.mp4')).toBe(
        'http://minio.local:9000/my-bucket/streamhub/live/clip.mp4',
      );
    });

    it('Wasabi custom-endpoint virtual-host style', () => {
      const cfg = baseCfg({
        provider: 'wasabi',
        endpoint: 'https://s3.wasabisys.com',
        forcePathStyle: false,
      });
      expect(svc.publicUrlFor(cfg, 'clip.mp4')).toBe(
        'https://my-bucket.s3.wasabisys.com/streamhub/live/clip.mp4',
      );
    });

    it('URL-encodes each path segment (spaces, unicode)', () => {
      const url = svc.publicUrlFor(baseCfg({ prefix: '' }), 'my clip.mp4');
      expect(url).toBe(
        'https://my-bucket.s3.us-east-1.amazonaws.com/my%20clip.mp4',
      );
    });
  });
});
