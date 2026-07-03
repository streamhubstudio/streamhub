import { ConnectionOptions } from 'bullmq';

/**
 * BullMQ ioredis connection options derived from a REDIS_URL. Passing options
 * (not an instance) lets BullMQ own the connection lifecycle and avoids the
 * dual-ioredis type clash. `maxRetriesPerRequest: null` is required by BullMQ.
 * Shared by the recording upload queue and the VOD transcode queue.
 */
export function bullConnectionOptions(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  const db = u.pathname && u.pathname.length > 1 ? u.pathname.slice(1) : '';
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number.parseInt(u.port, 10) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: db ? Number.parseInt(db, 10) || 0 : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
