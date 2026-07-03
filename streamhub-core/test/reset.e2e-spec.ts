/**
 * E2E — password-reset over the real AppModule (supertest).
 *
 * Boots the full app (global auth guard wired) against an isolated temp DB with
 * a capturing EmailService double (keeps SMTP out of the process and recovers
 * the plaintext reset token from the emailed URL). Drives the whole flow over
 * HTTP: signup → reset-request → reset → login with the NEW password.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { EmailService } from '../src/modules/email/email.service';
import { verifyJwt } from '../src/shared/auth';

const P = '/api/v1';
const SECRET = 'test-jwt-secret-do-not-use-in-prod';

/** Capturing EmailService double: records (email,url) instead of sending. */
class CapturingEmail {
  readonly resets: Array<{ email: string; url: string }> = [];
  get isConfigured(): boolean {
    return true;
  }
  async sendMagicLink() {
    return { ok: true, messageId: '<captured>' };
  }
  async sendPasswordReset(email: string, url: string) {
    this.resets.push({ email, url });
    return { ok: true, messageId: '<captured>' };
  }
  async send() {
    return { ok: true, messageId: '<captured>' };
  }
  lastToken(): string {
    const url = this.resets[this.resets.length - 1]?.url ?? '';
    return new URL(url).searchParams.get('token') ?? '';
  }
}

describe('password-reset (e2e)', () => {
  let app: TestApp;
  const email = new CapturingEmail();

  beforeAll(async () => {
    app = await bootstrapTestApp({
      overrides: (b) => b.overrideProvider(EmailService).useValue(email),
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('POST /auth/reset-request is PUBLIC and returns a generic 200', async () => {
    await app
      .request()
      .post(`${P}/auth/signup`)
      .send({ email: 'reset-me@example.com', password: 'orig-passw0rd' })
      .expect(201);

    const res = await app
      .request()
      .post(`${P}/auth/reset-request`)
      .send({ email: 'reset-me@example.com' })
      .expect(200);
    expect(res.body?.data?.message).toMatch(/reset/i);
    expect(email.resets.at(-1)?.email).toBe('reset-me@example.com');
    expect(email.resets.at(-1)?.url).toContain(
      'https://app.streamhub.studio/auth/reset?token=',
    );
  });

  it('returns the SAME generic 200 for an unknown email (no enumeration)', async () => {
    const before = email.resets.length;
    const known = await app
      .request()
      .post(`${P}/auth/reset-request`)
      .send({ email: 'reset-me@example.com' })
      .expect(200);
    const unknown = await app
      .request()
      .post(`${P}/auth/reset-request`)
      .send({ email: 'ghost@nowhere.test' })
      .expect(200);
    expect(known.body).toEqual(unknown.body);
    // Only the KNOWN account actually triggered an email.
    expect(email.resets.length).toBe(before + 1);
  });

  it('rejects a malformed email at the ValidationPipe (400)', async () => {
    await app
      .request()
      .post(`${P}/auth/reset-request`)
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  it('POST /auth/reset is PUBLIC; an unknown token is rejected (401)', async () => {
    await app
      .request()
      .post(`${P}/auth/reset`)
      .send({ token: 'never-issued-token', password: 'brand-new-pass' })
      .expect(401);
  });

  it('rejects a short password at the ValidationPipe (400)', async () => {
    await app
      .request()
      .post(`${P}/auth/reset`)
      .send({ token: 'some-long-enough-token', password: 'short' })
      .expect(400);
  });

  it('end-to-end: request, reset, and log in with the NEW password', async () => {
    await app
      .request()
      .post(`${P}/auth/signup`)
      .send({ email: 'e2e-reset@example.com', password: 'orig-passw0rd' })
      .expect(201);

    await app
      .request()
      .post(`${P}/auth/reset-request`)
      .send({ email: 'e2e-reset@example.com' })
      .expect(200);
    const token = email.lastToken();
    expect(token.length).toBeGreaterThan(20);

    const res = await app
      .request()
      .post(`${P}/auth/reset`)
      .send({ token, password: 'my-new-passw0rd' })
      .expect(200);
    const jwt = res.body?.data?.token as string;
    expect(verifyJwt(jwt, SECRET).sub).toMatch(/^usr_/);

    // Old password no longer works; new one does.
    await app
      .request()
      .post(`${P}/auth/login`)
      .send({ user: 'e2e-reset@example.com', password: 'orig-passw0rd' })
      .expect(401);
    await app
      .request()
      .post(`${P}/auth/login`)
      .send({ user: 'e2e-reset@example.com', password: 'my-new-passw0rd' })
      .expect(200);

    // Single-use: replaying the same token now fails (401).
    await app
      .request()
      .post(`${P}/auth/reset`)
      .send({ token, password: 'another-pass' })
      .expect(401);
  });
});
