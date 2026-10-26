/**
 * Unit — email/EmailSmtpTestController (owner item 29: POST /apps/:app/smtp/test).
 */
import { NotFoundException } from '@nestjs/common';
import { mockAppsService } from '../../../test/helpers';
import { EmailSmtpTestController } from './email-smtp-test.controller';
import { EmailService } from './email.service';

function makeController(opts: {
  appExists?: boolean;
  testAppSmtp?: jest.Mock;
}) {
  const apps = mockAppsService({
    get: jest.fn(async () =>
      opts.appExists === false
        ? null
        : ({ id: 1, name: 'live' } as never),
    ),
  });
  const email = {
    testAppSmtp: opts.testAppSmtp ?? jest.fn(async () => ({ ok: true, messageId: '<id>' })),
  } as unknown as EmailService;
  const controller = new EmailSmtpTestController(email, apps);
  return { controller, apps, email };
}

describe('email/EmailSmtpTestController', () => {
  it('404s for an unknown app (never calls EmailService)', async () => {
    const { controller, email } = makeController({ appExists: false });
    await expect(
      controller.test('ghost', { to: 'ops@example.com' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((email as unknown as { testAppSmtp: jest.Mock }).testAppSmtp).not.toHaveBeenCalled();
  });

  it('delegates to EmailService.testAppSmtp(app, to) and returns the result', async () => {
    const testAppSmtp = jest.fn(async () => ({ ok: true, messageId: '<abc>' }));
    const { controller } = makeController({ testAppSmtp });
    const res = await controller.test('live', { to: 'ops@example.com' });
    expect(testAppSmtp).toHaveBeenCalledWith('live', 'ops@example.com');
    expect(res).toEqual({ data: { ok: true, messageId: '<abc>' }, error: null });
  });

  it('surfaces a failed/skipped send as ok:false (never throws)', async () => {
    const testAppSmtp = jest.fn(async () => ({
      ok: false,
      skipped: true,
      error: 'smtp_not_configured',
    }));
    const { controller } = makeController({ testAppSmtp });
    const res = await controller.test('live', { to: 'ops@example.com' });
    expect(res.data).toMatchObject({ ok: false, skipped: true });
  });
});
