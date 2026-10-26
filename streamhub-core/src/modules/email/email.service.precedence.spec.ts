/**
 * Unit — email/EmailService SMTP precedence (owner item 29: per-app + per-user
 * SMTP). nodemailer is mocked so no SMTP connection is ever opened.
 *
 * Locks down the resolution order for every send method:
 *   per-user override > per-app override > the global env default,
 * with graceful fall-through at every tier (disabled block, missing
 * host/pass, decrypt failure, unknown app/user) — never a thrown error, and
 * the existing global-only behaviour is preserved when no context is given.
 * Also covers the `testAppSmtp`/`testUserSmtp` probe methods (bypass the
 * `enabled` gate; never fall back to a different tier).
 */
import * as nodemailer from 'nodemailer';
import { ConfigService } from '../../shared/config/config.service';
import { encryptUserSmtpSecret } from '../auth/secret-cipher.util';
import { EmailService } from './email.service';
import { mockAppsService } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import type { TenancyService } from '../tenancy/tenancy.service';

jest.mock('nodemailer');

const mockedNodemailer = nodemailer as jest.Mocked<typeof nodemailer>;
const MASTER = 'test-jwt-secret-1234567890';

/** Minimal fake — EmailService only ever calls `getUserSmtp`. */
function fakeTenancy(
  row: ReturnType<TenancyService['getUserSmtp']>,
): TenancyService {
  return { getUserSmtp: jest.fn(() => row) } as unknown as TenancyService;
}

function makeAppConfig(smtp?: Partial<AppConfig['smtp']>): AppConfig {
  return {
    name: 'live',
    displayName: 'Live',
    roomPrefix: 'live',
    recording: {
      enabled: true,
      mode: 'room-composite',
      layout: 'grid',
      localDir: 'recordings',
      deleteLocalAfterUpload: true,
      splitMinutes: 0,
      snapshotSeconds: 0,
    },
    s3: {
      provider: 'aws',
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'streamhub/live',
      accessKey: '',
      secretKey: '',
    },
    webrtc: { adaptive: true, layers: [], transcodeMaxHeight: 720 },
    rtmp: { enabled: true, transcode: true },
    callbacks: { url: '', secret: '' },
    features: {
      rtmpPassword: false,
      viewerCounter: false,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
      publicPlayback: true,
    },
    smtp: {
      enabled: false,
      host: '',
      port: 587,
      user: '',
      from: '',
      pass: '',
      ...smtp,
    },
  };
}

/** Build an EmailService with a pinned env + fake apps/tenancy collaborators. */
function makeEmail(opts: {
  env?: Record<string, string>;
  apps?: ReturnType<typeof mockAppsService>;
  tenancy?: TenancyService;
} = {}): EmailService {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('STREAMHUB_SMTP_')) delete process.env[k];
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const svc = new EmailService(
    new ConfigService(),
    opts.apps as never,
    opts.tenancy,
  );
  process.env = saved;
  return svc;
}

describe('email/EmailService — SMTP precedence (owner item 29)', () => {
  let sendMail: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: '<abc@streamhub>' });
    mockedNodemailer.createTransport.mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
  });

  describe('no context → unchanged global-only behaviour', () => {
    it('still uses the global default when no ctx is given', async () => {
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' } });
      await svc.send({ to: 'a@b.com', subject: 's', text: 't' });
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });
  });

  describe('per-app override', () => {
    it("uses the APP's SMTP when enabled + fully configured", async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () =>
          makeAppConfig({
            enabled: true,
            host: 'smtp.app.test',
            port: 465,
            user: 'app-user',
            pass: 'app-pass',
            from: 'App <app@test.com>',
          }),
        ),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, apps });
      const res = await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { app: 'live' },
      );
      expect(res.ok).toBe(true);
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.app.test',
          port: 465,
          secure: true,
          auth: { user: 'app-user', pass: 'app-pass' },
        }),
      );
      expect(sendMail.mock.calls[0][0].from).toBe('App <app@test.com>');
    });

    it('falls back to global when the app SMTP block is disabled', async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () =>
          makeAppConfig({ enabled: false, host: 'smtp.app.test', pass: 'app-pass' }),
        ),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, apps });
      await svc.send({ to: 'a@b.com', subject: 's', text: 't' }, { app: 'live' });
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });

    it('falls back to global when the app SMTP is enabled but missing host/pass', async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () => makeAppConfig({ enabled: true })),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, apps });
      await svc.send({ to: 'a@b.com', subject: 's', text: 't' }, { app: 'live' });
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });

    it('falls back to global when the app lookup throws (unknown app)', async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () => {
          throw new Error('not found');
        }),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, apps });
      const res = await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { app: 'ghost' },
      );
      expect(res.ok).toBe(true);
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });

    it('skips (never dials) when NEITHER app nor global SMTP is configured', async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () => makeAppConfig({ enabled: false })),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: '' }, apps });
      const res = await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { app: 'live' },
      );
      expect(res).toMatchObject({ ok: false, skipped: true });
      expect(mockedNodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('per-user override', () => {
    it("uses the USER's SMTP when enabled + fully configured (wins over the app tier)", async () => {
      const passEnc = encryptUserSmtpSecret('user-pass', MASTER);
      const tenancy = fakeTenancy({
        enabled: true,
        host: 'smtp.user.test',
        port: 587,
        user: 'user-login',
        from: 'Me <me@test.com>',
        passEnc,
      });
      const apps = mockAppsService({
        getConfig: jest.fn(async () =>
          makeAppConfig({ enabled: true, host: 'smtp.app.test', pass: 'app-pass' }),
        ),
      });
      const svc = makeEmail({
        env: { STREAMHUB_SMTP_PASS: 'g', STREAMHUB_JWT_SECRET: MASTER },
        apps,
        tenancy,
      });
      const res = await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { userId: 'usr_1', app: 'live' },
      );
      expect(res.ok).toBe(true);
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.user.test',
          auth: { user: 'user-login', pass: 'user-pass' },
        }),
      );
      expect(sendMail.mock.calls[0][0].from).toBe('Me <me@test.com>');
    });

    it('falls through to the app tier when the user has no override enabled', async () => {
      const tenancy = fakeTenancy({
        enabled: false,
        host: '',
        port: null,
        user: '',
        from: '',
        passEnc: null,
      });
      const apps = mockAppsService({
        getConfig: jest.fn(async () =>
          makeAppConfig({ enabled: true, host: 'smtp.app.test', pass: 'app-pass' }),
        ),
      });
      const svc = makeEmail({
        env: { STREAMHUB_SMTP_PASS: 'g', STREAMHUB_JWT_SECRET: MASTER },
        apps,
        tenancy,
      });
      await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { userId: 'usr_1', app: 'live' },
      );
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.app.test' }),
      );
    });

    it('falls through to global when decryption fails (wrong/rotated master secret)', async () => {
      const passEnc = encryptUserSmtpSecret('user-pass', 'a-different-secret');
      const tenancy = fakeTenancy({
        enabled: true,
        host: 'smtp.user.test',
        port: 587,
        user: 'user-login',
        from: '',
        passEnc,
      });
      const svc = makeEmail({
        env: { STREAMHUB_SMTP_PASS: 'g', STREAMHUB_JWT_SECRET: MASTER },
        tenancy,
      });
      await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { userId: 'usr_1' },
      );
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });

    it('falls through to global for an unknown userId (tenancy returns null)', async () => {
      const tenancy = { getUserSmtp: jest.fn(() => null) } as unknown as TenancyService;
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, tenancy });
      await svc.send(
        { to: 'a@b.com', subject: 's', text: 't' },
        { userId: 'usr_ghost' },
      );
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'no-reply@streamhub.studio', pass: 'g' } }),
      );
    });
  });

  describe('sendMagicLink / sendInvite thread the context through', () => {
    it('sendMagicLink resolves the user override', async () => {
      const passEnc = encryptUserSmtpSecret('user-pass', MASTER);
      const tenancy = fakeTenancy({
        enabled: true,
        host: 'smtp.user.test',
        port: 587,
        user: 'user-login',
        from: '',
        passEnc,
      });
      const svc = makeEmail({
        env: { STREAMHUB_SMTP_PASS: 'g', STREAMHUB_JWT_SECRET: MASTER },
        tenancy,
      });
      await svc.sendMagicLink('a@b.com', 'https://x/y', { userId: 'usr_1' });
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.user.test' }),
      );
    });

    it('sendInvite resolves the (inviter) user override', async () => {
      const passEnc = encryptUserSmtpSecret('user-pass', MASTER);
      const tenancy = fakeTenancy({
        enabled: true,
        host: 'smtp.user.test',
        port: 587,
        user: 'user-login',
        from: '',
        passEnc,
      });
      const svc = makeEmail({
        env: { STREAMHUB_SMTP_PASS: 'g', STREAMHUB_JWT_SECRET: MASTER },
        tenancy,
      });
      await svc.sendInvite('a@b.com', 'https://x/y', {}, { userId: 'usr_1' });
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.user.test' }),
      );
    });
  });

  describe('testAppSmtp / testUserSmtp (probe — bypasses the enabled gate)', () => {
    it("testAppSmtp uses the app's OWN settings even when disabled", async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () =>
          makeAppConfig({
            enabled: false,
            host: 'smtp.app.test',
            pass: 'app-pass',
            from: 'App <app@test.com>',
          }),
        ),
      });
      const svc = makeEmail({ apps });
      const res = await svc.testAppSmtp('live', 'ops@example.com');
      expect(res.ok).toBe(true);
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.app.test' }),
      );
      expect(sendMail.mock.calls[0][0].to).toBe('ops@example.com');
    });

    it('testAppSmtp never falls back to global when the app has no host/pass', async () => {
      const apps = mockAppsService({
        getConfig: jest.fn(async () => makeAppConfig()),
      });
      const svc = makeEmail({ env: { STREAMHUB_SMTP_PASS: 'g' }, apps });
      const res = await svc.testAppSmtp('live', 'ops@example.com');
      expect(res).toMatchObject({ ok: false, skipped: true });
      expect(mockedNodemailer.createTransport).not.toHaveBeenCalled();
    });

    it("testUserSmtp uses the user's OWN settings even when disabled", async () => {
      const passEnc = encryptUserSmtpSecret('user-pass', MASTER);
      const tenancy = fakeTenancy({
        enabled: false,
        host: 'smtp.user.test',
        port: 587,
        user: 'user-login',
        from: '',
        passEnc,
      });
      const svc = makeEmail({ env: { STREAMHUB_JWT_SECRET: MASTER }, tenancy });
      const res = await svc.testUserSmtp('usr_1', 'me@example.com');
      expect(res.ok).toBe(true);
      expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.user.test' }),
      );
    });

    it('testUserSmtp reports skipped when the user has no host/pass configured', async () => {
      const tenancy = fakeTenancy({
        enabled: false,
        host: '',
        port: null,
        user: '',
        from: '',
        passEnc: null,
      });
      const svc = makeEmail({ tenancy });
      const res = await svc.testUserSmtp('usr_1', 'me@example.com');
      expect(res).toMatchObject({ ok: false, skipped: true });
    });
  });
});
