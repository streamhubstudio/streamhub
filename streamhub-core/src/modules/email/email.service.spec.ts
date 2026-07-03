/**
 * Unit — email/EmailService (nodemailer SMTP wrapper).
 *
 * nodemailer is mocked so no SMTP connection is ever opened. Verifies:
 *   - config resolution from env (host/port/user/from + secure by port),
 *   - the PASS gate: no PASS → send is SKIPPED, never dialed,
 *   - sendMagicLink builds a From-stamped mail with the URL in body,
 *   - ROBUSTNESS: a throwing transport is swallowed into { ok:false } (no throw).
 */
import * as nodemailer from 'nodemailer';
import { ConfigService } from '../../shared/config/config.service';
import { EmailService } from './email.service';

jest.mock('nodemailer');

const mockedNodemailer = nodemailer as jest.Mocked<typeof nodemailer>;

/**
 * Build an EmailService with a pinned env. EmailService reads SMTP env (via
 * ConfigService.env → live process.env) in its CONSTRUCTOR, so we set env,
 * construct BOTH, then restore — the resolved settings are cached in the ctor.
 */
function makeEmail(env: Record<string, string> = {}): EmailService {
  const saved = { ...process.env };
  // Neutralise any ambient SMTP env from other suites so defaults are stable.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('STREAMHUB_SMTP_')) delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const svc = new EmailService(new ConfigService());
  process.env = saved;
  return svc;
}

describe('email/EmailService', () => {
  let sendMail: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: '<abc@streamhub>' });
    mockedNodemailer.createTransport.mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
  });

  it('is not configured when STREAMHUB_SMTP_PASS is empty', () => {
    const svc = makeEmail(({ STREAMHUB_SMTP_PASS: '' }));
    expect(svc.isConfigured).toBe(false);
  });

  it('is configured once host + pass are present, with sensible defaults', () => {
    const svc = makeEmail(({ STREAMHUB_SMTP_PASS: 's3cret' }));
    expect(svc.isConfigured).toBe(true);
    expect(svc.fromAddress).toBe('StreamHub <no-reply@streamhub.studio>');
  });

  it('SKIPS the send (never dials SMTP) when PASS is not configured', async () => {
    const svc = makeEmail(({ STREAMHUB_SMTP_PASS: '' }));
    const res = await svc.sendMagicLink('a@b.com', 'https://x/y');
    expect(res).toMatchObject({ ok: false, skipped: true });
    expect(mockedNodemailer.createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('uses STARTTLS (secure:false, requireTLS) on port 587', async () => {
    const svc = makeEmail({
      STREAMHUB_SMTP_PASS: 's3cret',
      STREAMHUB_SMTP_PORT: '587',
    });
    await svc.sendMagicLink('a@b.com', 'https://x/y');
    expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it('uses implicit TLS (secure:true) on port 465', async () => {
    const svc = makeEmail({
      STREAMHUB_SMTP_PASS: 's3cret',
      STREAMHUB_SMTP_PORT: '465',
    });
    await svc.send({ to: 'a@b.com', subject: 's', text: 't' });
    expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );
  });

  it('sends the magic link with From, To, subject and the URL in the body', async () => {
    const svc = makeEmail({
      STREAMHUB_SMTP_PASS: 's3cret',
      STREAMHUB_SMTP_HOST: 'mail.wipermax.online',
      STREAMHUB_SMTP_USER: 'no-reply@streamhub.studio',
    });
    const url = 'https://app.streamhub.studio/auth/magic?token=deadbeef';
    const res = await svc.sendMagicLink('alice@example.com', url);

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('<abc@streamhub>');
    expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'mail.wipermax.online',
        auth: { user: 'no-reply@streamhub.studio', pass: 's3cret' },
      }),
    );
    const sent = sendMail.mock.calls[0][0];
    expect(sent.from).toBe('StreamHub <no-reply@streamhub.studio>');
    expect(sent.to).toBe('alice@example.com');
    expect(sent.subject).toMatch(/sign-in/i);
    expect(sent.text).toContain(url);
    expect(sent.html).toContain(url);
  });

  it('caches the transport across sends', async () => {
    const svc = makeEmail(({ STREAMHUB_SMTP_PASS: 's3cret' }));
    await svc.send({ to: 'a@b.com', subject: 's', text: 't' });
    await svc.send({ to: 'c@d.com', subject: 's', text: 't' });
    expect(mockedNodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('NEVER throws when the transport fails — returns { ok:false, error }', async () => {
    sendMail.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = makeEmail(({ STREAMHUB_SMTP_PASS: 's3cret' }));
    const res = await svc.sendMagicLink('a@b.com', 'https://x/y');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });
});
