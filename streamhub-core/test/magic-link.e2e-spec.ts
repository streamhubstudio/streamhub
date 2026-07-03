/**
 * E2E — passwordless magic-link over the real AppModule (supertest).
 *
 * Boots the full app (global auth guard wired) against an isolated temp DB. The
 * EmailService is overridden with a capturing fake so we can (a) keep SMTP out
 * of the process and (b) recover the plaintext token from the URL it "sent" —
 * the same token a real user would click — and drive verify() end-to-end over
 * HTTP into a session JWT.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { EmailService } from '../src/modules/email/email.service';
import { verifyJwt } from '../src/shared/auth';

const P = '/api/v1';
const SECRET = 'test-jwt-secret-do-not-use-in-prod';

/** Capturing EmailService double: records (email,url) instead of sending. */
class CapturingEmail {
  readonly sent: Array<{ email: string; url: string }> = [];
  get isConfigured(): boolean {
    return true;
  }
  async sendMagicLink(email: string, url: string) {
    this.sent.push({ email, url });
    return { ok: true, messageId: '<captured>' };
  }
  async send() {
    return { ok: true, messageId: '<captured>' };
  }
  /** Plaintext token from the most recent captured link. */
  lastToken(): string {
    const url = this.sent[this.sent.length - 1]?.url ?? '';
    return new URL(url).searchParams.get('token') ?? '';
  }
}

describe('magic-link (e2e)', () => {
  let app: TestApp;
  const email = new CapturingEmail();

  beforeAll(async () => {
    app = await bootstrapTestApp({
      overrides: (b) =>
        b.overrideProvider(EmailService).useValue(email),
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('POST /auth/magic-link is PUBLIC and returns a generic 200 (no token needed)', async () => {
    const res = await app
      .request()
      .post(`${P}/auth/magic-link`)
      .send({ email: 'newbie@example.com' })
      .expect(200);
    expect(res.body?.data?.message).toMatch(/sign-in link/i);
    // A link was actually dispatched to the (captured) email, at the public app.
    expect(email.sent.at(-1)?.email).toBe('newbie@example.com');
    expect(email.sent.at(-1)?.url).toContain(
      'https://app.streamhub.studio/auth/magic?token=',
    );
  });

  it('returns the SAME generic 200 for two different emails (no enumeration)', async () => {
    const a = await app
      .request()
      .post(`${P}/auth/magic-link`)
      .send({ email: 'ghost@example.com' })
      .expect(200);
    const b = await app
      .request()
      .post(`${P}/auth/magic-link`)
      .send({ email: 'whoever@nowhere.test' })
      .expect(200);
    expect(a.body).toEqual(b.body);
  });

  it('rejects a malformed email at the ValidationPipe (400)', async () => {
    await app
      .request()
      .post(`${P}/auth/magic-link`)
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  it('POST /auth/magic/verify is PUBLIC; an unknown token is rejected (401)', async () => {
    await app
      .request()
      .post(`${P}/auth/magic/verify`)
      .send({ token: 'this-token-was-never-issued' })
      .expect(401);
  });

  it('rejects a missing token at the ValidationPipe (400)', async () => {
    await app.request().post(`${P}/auth/magic/verify`).send({}).expect(400);
  });

  it('end-to-end: request a link, then verify it into a session JWT (200)', async () => {
    await app
      .request()
      .post(`${P}/auth/magic-link`)
      .send({ email: 'e2e@example.com' })
      .expect(200);
    const token = email.lastToken();
    expect(token.length).toBeGreaterThan(20);

    const res = await app
      .request()
      .post(`${P}/auth/magic/verify`)
      .send({ token })
      .expect(200);
    const jwt = res.body?.data?.token as string;
    expect(jwt).toMatch(/\..+\./);
    expect(verifyJwt(jwt, SECRET).sub).toMatch(/^usr_/);

    // The session JWT is a real credential: GET /auth/me resolves the principal.
    const me = await app
      .request()
      .get(`${P}/auth/me`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(me.body?.data).toMatchObject({ via: 'user_jwt', role: 'owner' });

    // Single-use: replaying the same token now fails (401).
    await app
      .request()
      .post(`${P}/auth/magic/verify`)
      .send({ token })
      .expect(401);
  });
});
