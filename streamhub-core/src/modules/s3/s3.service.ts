import {
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import {
  S3Config,
  S3PresignOptions,
  S3ServiceContract,
  S3UploadResult,
} from '../../shared/contracts';
import { MetricsService } from '../metrics/metrics.service';

/** Default presigned-GET lifetime (seconds) when caller doesn't specify. */
const DEFAULT_PRESIGN_TTL = 3600;
/** Hard cap for presigned URLs (SigV4 max = 7 days). */
const MAX_PRESIGN_TTL = 7 * 24 * 3600;

/**
 * Multi-provider S3 abstraction (AWS / Wasabi / MinIO) via @aws-sdk/client-s3.
 * SPEC §5 s3.
 *
 * Each method receives a fully-resolved {@link S3Config} (credentials already
 * dereferenced from the secret store by the apps module — never read from the
 * yaml in clear). The service builds/caches one S3Client per distinct config
 * (endpoint + forcePathStyle + region + credentials all configurable) and
 * never logs secret material.
 *
 * Errors are wrapped in controlled Nest exceptions; nothing here throws raw or
 * crashes the process.
 */
@Injectable()
export class S3Service implements S3ServiceContract {
  /** Cache of S3Client instances keyed by a non-secret-leaking fingerprint. */
  private readonly clients = new Map<string, S3Client>();

  constructor(@Optional() private readonly metrics?: MetricsService) {}

  /**
   * Upload a local file to `key` (prefixed with `config.prefix`) in the app's
   * bucket. Streams the file (no full buffer in memory) and sets ContentLength
   * so providers like MinIO/Wasabi accept the stream.
   */
  async upload(
    config: S3Config,
    localPath: string,
    key: string,
    contentType?: string,
  ): Promise<S3UploadResult> {
    this.assertConfig(config);
    const objectKey = this.resolveKey(config, key);

    let sizeBytes: number;
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isFile()) {
        throw new InternalServerErrorException(
          `S3 upload source is not a file: ${localPath}`,
        );
      }
      sizeBytes = stat.size;
    } catch (err) {
      throw this.wrap(err, `S3 upload: cannot read local file ${localPath}`);
    }

    const body = createReadStream(localPath);
    try {
      const client = this.clientFor(config);
      const out = await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          Body: body,
          ContentLength: sizeBytes,
          ContentType: contentType ?? this.guessContentType(objectKey),
        }),
      );
      this.metrics?.s3Upload(config.provider, true, sizeBytes);
      return {
        key: objectKey,
        bucket: config.bucket,
        url: this.publicUrlFor(config, key),
        sizeBytes,
        etag: out.ETag ? out.ETag.replace(/"/g, '') : undefined,
      };
    } catch (err) {
      this.metrics?.s3Upload(config.provider, false);
      throw this.wrap(err, `S3 upload failed for key ${objectKey}`);
    } finally {
      body.destroy();
    }
  }

  /**
   * Presigned GET URL valid for `expiresInSeconds` (default 1h, max 7d).
   * `options` may set the `response-content-disposition` / `response-content-type`
   * S3 params so the object downloads as an attachment with a friendly filename.
   */
  async presignGet(
    config: S3Config,
    key: string,
    expiresInSeconds?: number,
    options?: S3PresignOptions,
  ): Promise<string> {
    this.assertConfig(config);
    const objectKey = this.resolveKey(config, key);
    const ttl = this.clampTtl(expiresInSeconds);
    try {
      const client = this.clientFor(config);
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          ResponseContentDisposition: options?.responseContentDisposition,
          ResponseContentType: options?.responseContentType,
        }),
        { expiresIn: ttl },
      );
    } catch (err) {
      throw this.wrap(err, `S3 presignGet failed for key ${objectKey}`);
    }
  }

  /** Delete an object. No-op if it doesn't exist (S3 delete is idempotent). */
  async delete(config: S3Config, key: string): Promise<void> {
    this.assertConfig(config);
    const objectKey = this.resolveKey(config, key);
    try {
      const client = this.clientFor(config);
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      );
    } catch (err) {
      if (this.isNotFound(err)) return;
      throw this.wrap(err, `S3 delete failed for key ${objectKey}`);
    }
  }

  /** Whether the object exists. */
  async exists(config: S3Config, key: string): Promise<boolean> {
    this.assertConfig(config);
    const objectKey = this.resolveKey(config, key);
    try {
      const client = this.clientFor(config);
      await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      );
      return true;
    } catch (err) {
      if (this.isNotFound(err)) return false;
      throw this.wrap(err, `S3 exists check failed for key ${objectKey}`);
    }
  }

  /**
   * Canonical (non-presigned) object URL for `key`. Useful for buckets/objects
   * served publicly. Not guaranteed to be accessible if the bucket is private —
   * use {@link presignGet} for those. Bonus helper requested by the s3 spec.
   */
  publicUrlFor(config: S3Config, key: string): string {
    const objectKey = this.resolveKey(config, key);
    const encoded = objectKey
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');

    // MinIO / any path-style endpoint: <endpoint>/<bucket>/<key>.
    if (config.endpoint) {
      const base = config.endpoint.replace(/\/+$/, '');
      if (config.forcePathStyle) {
        return `${base}/${config.bucket}/${encoded}`;
      }
      // Virtual-host style against a custom endpoint (e.g. Wasabi):
      // <scheme>://<bucket>.<host>/<key>.
      try {
        const u = new URL(base);
        return `${u.protocol}//${config.bucket}.${u.host}${u.pathname.replace(
          /\/+$/,
          '',
        )}/${encoded}`;
      } catch {
        return `${base}/${config.bucket}/${encoded}`;
      }
    }

    // Plain AWS S3 virtual-host style.
    return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encoded}`;
  }

  /**
   * Drop cached S3Client(s) so they are rebuilt on next use (wave-4 §1/§2 hot
   * reload). With a `config` it evicts just that app's client (by fingerprint);
   * without one it clears the whole cache. Destroys the dropped clients to free
   * their sockets. Never throws.
   */
  evict(config?: S3Config): void {
    if (config) {
      const fp = this.fingerprint(config);
      const client = this.clients.get(fp);
      if (client) {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
        this.clients.delete(fp);
      }
      return;
    }
    for (const client of this.clients.values()) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  // ----------------------------------------------------------------------
  // internals
  // ----------------------------------------------------------------------

  /** Build (or reuse) an S3Client for a given resolved config. */
  private clientFor(config: S3Config): S3Client {
    const fp = this.fingerprint(config);
    const existing = this.clients.get(fp);
    if (existing) return existing;

    const client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint && config.endpoint.trim() !== ''
        ? config.endpoint
        : undefined,
      forcePathStyle: !!config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.clients.set(fp, client);
    return client;
  }

  /**
   * Cache key for a client. Mixes credentials in (so a rotated key gets a fresh
   * client) but is only ever used as a Map key — never logged.
   */
  private fingerprint(config: S3Config): string {
    return [
      config.provider,
      config.region,
      config.endpoint ?? '',
      config.forcePathStyle ? '1' : '0',
      config.accessKey,
      // length only of secret, to vary on rotation without holding it readable
      String(config.secretKey?.length ?? 0),
    ].join('|');
  }

  /** Prepend the configured prefix unless the key already carries it. */
  private resolveKey(config: S3Config, key: string): string {
    const cleanKey = String(key ?? '').replace(/^\/+/, '');
    const prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (!prefix) return cleanKey;
    if (cleanKey === prefix || cleanKey.startsWith(`${prefix}/`)) {
      return cleanKey;
    }
    return `${prefix}/${cleanKey}`;
  }

  private clampTtl(ttl?: number): number {
    if (ttl === undefined || !Number.isFinite(ttl) || ttl <= 0) {
      return DEFAULT_PRESIGN_TTL;
    }
    return Math.min(Math.floor(ttl), MAX_PRESIGN_TTL);
  }

  /** Minimal content-type guess from extension; defaults to octet-stream. */
  private guessContentType(key: string): string {
    const ext = path.extname(key).toLowerCase();
    const map: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.mov': 'video/quicktime',
      '.ts': 'video/mp2t',
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.mp3': 'audio/mpeg',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.json': 'application/json',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  /** Validate the resolved config has the essentials before hitting the SDK. */
  private assertConfig(config: S3Config): void {
    if (!config) {
      throw new InternalServerErrorException('S3 config missing');
    }
    if (!config.bucket) {
      throw new InternalServerErrorException('S3 config: bucket is required');
    }
    if (!config.accessKey || !config.secretKey) {
      throw new InternalServerErrorException(
        'S3 config: credentials unresolved (check secret store / *_env refs)',
      );
    }
  }

  /** Recognize 404 / NoSuchKey / NotFound across providers. */
  private isNotFound(err: unknown): boolean {
    const e = err as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (e?.$metadata?.httpStatusCode === 404) return true;
    const code = e?.name ?? e?.Code ?? '';
    return code === 'NotFound' || code === 'NoSuchKey';
  }

  /** Wrap any SDK/fs error in a controlled Nest exception (no secret leak). */
  private wrap(err: unknown, message: string): InternalServerErrorException {
    const reason = err instanceof Error ? err.message : String(err);
    return new InternalServerErrorException(`${message}: ${reason}`);
  }
}
