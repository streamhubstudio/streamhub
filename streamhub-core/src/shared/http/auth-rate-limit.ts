import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Network-security hook: the security module registers a reporter here so a
 * 429 on the sensitive auth paths counts as an offense for the in-app
 * auto-ban (modules/security). A plain module-level slot (not DI) because the
 * limiter is built in main.ts before the Nest container exists. Fire-and-forget:
 * reporter errors NEVER break the 429 response.
 */
type RateLimitOffenseReporter = (ip: string) => void;
let offenseReporter: RateLimitOffenseReporter | null = null;

export function setRateLimitOffenseReporter(
  fn: RateLimitOffenseReporter | null,
): void {
  offenseReporter = fn;
}

/**
 * Fase-0 M6 — brute-force rate limiting for the SENSITIVE auth endpoints only.
 *
 * We deliberately DO NOT throttle the whole API (that would break the dashboard's
 * background polling). Only the credential-guessing surfaces are limited: login
 * and magic-link request/verify. Paths are the full request paths (the API
 * global prefix `/api/v1` is part of the URL that `app.use(path, ...)` matches
 * in main.ts).
 *
 * Limits (per client IP, per window) — override via env, documented in ENV.md:
 *   - AUTH_RATE_LIMIT_MAX        (default 10)
 *   - AUTH_RATE_LIMIT_WINDOW_MS  (default 900000 = 15 min)
 *
 * A 429 with the standard `RateLimit-*` headers is returned once the window is
 * exhausted. Requires `app.set('trust proxy', 1)` behind the reverse proxy so the
 * limiter keys on the real client IP rather than the proxy's.
 */
export const AUTH_RATE_LIMIT_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/magic/verify',
] as const;

export interface AuthRateLimitOptions {
  /** Rolling window in ms. Default env AUTH_RATE_LIMIT_WINDOW_MS or 15 min. */
  windowMs?: number;
  /** Max requests per IP per window. Default env AUTH_RATE_LIMIT_MAX or 10. */
  limit?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n <= 0 ? fallback : n;
}

/** Build the express-rate-limit middleware used on the sensitive auth paths. */
export function createAuthRateLimiter(
  opts: AuthRateLimitOptions = {},
): RateLimitRequestHandler {
  const windowMs = opts.windowMs ?? envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
  const limit = opts.limit ?? envInt('AUTH_RATE_LIMIT_MAX', 10);
  const message = {
    data: null,
    error: {
      code: 'rate_limited',
      message: 'Too many attempts. Please retry later.',
    },
  };
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message,
    // Same 429 body as the default handler, plus the offense report so the
    // security module's auto-ban sees brute-force pressure on these paths.
    handler: (req: Request, res) => {
      try {
        const ip = req.ip || req.socket?.remoteAddress || '';
        if (ip) offenseReporter?.(ip);
      } catch {
        /* never break the 429 path on a reporter failure */
      }
      res.status(429).json(message);
    },
  });
}
