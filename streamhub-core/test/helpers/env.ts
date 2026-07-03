/**
 * Global test env (harness). Wired via jest `setupFiles`, so it runs BEFORE the
 * test module graph (ConfigService / AppModule) is required and observes these
 * values. Only sets a key when it is not already provided, so a suite can still
 * override per-case before importing the code under test.
 *
 * Mirrors the "test .env" the spec asks for: dummy JWT secret, AUTHZ in log-only
 * mode, no OIDC, and empty LiveKit creds (so the LiveKit clients are never even
 * constructed at boot — health/stats just report unreachable).
 */
function def(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

def('NODE_ENV', 'test');
def('LOG_LEVEL', 'silent');

// Auth / authz — dummy secret, log-only enforcement, no OIDC.
def('STREAMHUB_JWT_SECRET', 'test-jwt-secret-do-not-use-in-prod');
def('STREAMHUB_AUTHZ_ENFORCE', 'log');
def('ADMIN_USER', '');
def('ADMIN_PASS', '');
// Open signup ON by default in tests (the signup-gate spec pins it off).
def('STREAMHUB_ALLOW_SIGNUP', '1');

// LiveKit — empty creds → no real clients built at boot.
def('LIVEKIT_URL', 'ws://127.0.0.1:7880');
def('LIVEKIT_API_KEY', '');
def('LIVEKIT_API_SECRET', '');
def('PUBLIC_WS_URL', '');
def('RTMP_PUBLIC_HOST', '');

// Redis — value is irrelevant (bullmq/ioredis are mocked) but keep it parseable.
def('REDIS_URL', 'redis://127.0.0.1:6379');
