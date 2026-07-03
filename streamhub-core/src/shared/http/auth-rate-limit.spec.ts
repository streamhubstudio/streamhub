/**
 * Unit — shared/http/auth-rate-limit (Fase-0 M6 brute-force limiting).
 *
 * Verifies the limiter blocks (429) after N attempts on a sensitive auth path,
 * and leaves normal routes untouched. Mounted on a throwaway express app so the
 * limiter config is tested directly (main.ts wires the same factory).
 */
import express from 'express';
import request from 'supertest';

import { AUTH_RATE_LIMIT_PATHS, createAuthRateLimiter } from './auth-rate-limit';

function appWithLimit(limit: number): express.Express {
  const app = express();
  const limiter = createAuthRateLimiter({ limit, windowMs: 60_000 });
  // Only the sensitive path is behind the limiter (like main.ts).
  app.use('/api/v1/auth/login', limiter);
  app.post('/api/v1/auth/login', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('shared/http/auth-rate-limit (M6)', () => {
  it('returns 429 once the limit is exceeded on /auth/login', async () => {
    const app = appWithLimit(3);
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/v1/auth/login').expect(200);
    }
    const res = await request(app).post('/api/v1/auth/login').expect(429);
    expect(res.body?.error?.code).toBe('rate_limited');
  });

  it('does NOT rate-limit a normal route (dashboard poll safe)', async () => {
    const app = appWithLimit(2);
    for (let i = 0; i < 12; i++) {
      await request(app).get('/api/v1/health').expect(200);
    }
  });

  it('limits ONLY the documented sensitive auth paths (login/magic-link/reset)', () => {
    expect([...AUTH_RATE_LIMIT_PATHS]).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/magic-link',
      '/api/v1/auth/magic/verify',
      '/api/v1/auth/reset-request',
      '/api/v1/auth/reset',
    ]);
    // never the whole API surface
    expect(AUTH_RATE_LIMIT_PATHS).not.toContain('/api/v1');
  });
});
