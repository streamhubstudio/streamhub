/**
 * Unit specs for NotifierService — the notifier fan-out (Vision-Edge §H).
 *
 * Locks the fan-out matrix:
 *  - channel selection from global env defaults AND per-app `notifications:`
 *    config overrides (discord/telegram/email/callback);
 *  - the 300s per-(app,channel,key) rate limit suppresses duplicates;
 *  - a failing channel never breaks the others (isolation) and notify never
 *    throws;
 *  - the event filter gates by event name and the master switch turns it off;
 *  - each notify is recorded through the per-app rotated log.
 *
 * Discord/Telegram HTTP is exercised via a mocked global.fetch (no network).
 */
import * as fs from 'fs';
import * as path from 'path';

import { NotifierService } from './notifier.service';
import { AppLogService } from '../logs/app-log.service';
import { EmailService } from '../email/email.service';
import { makeTestConfig, mockCallbacksService } from '../../../test/helpers';

const APP = 'live';
const WEBHOOK = 'https://discord.com/api/webhooks/1/token';
const ENV_WEBHOOK = 'https://discord.com/api/webhooks/env/token';

const NOTIFY_ENV_KEYS = [
  'STREAMHUB_NOTIFY_DISCORD_WEBHOOK',
  'STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN',
  'STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID',
];

describe('NotifierService', () => {
  const dataDirs: string[] = [];
  let fetchMock: jest.Mock;
  const origFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
    for (const key of NOTIFY_ENV_KEYS) delete process.env[key];
    while (dataDirs.length) {
      fs.rmSync(dataDirs.pop() as string, { recursive: true, force: true });
    }
  });

  /** Build a NotifierService with the given env + optional per-app config.yaml. */
  function makeSvc(
    env: Record<string, string> = {},
    appConfigYaml?: string,
  ): {
    svc: NotifierService;
    callbacks: ReturnType<typeof mockCallbacksService>;
    email: { send: jest.Mock };
    appLog: { appLog: jest.Mock };
  } {
    // Always pin the three notify env keys so a prior test never bleeds in.
    const { config, dataDir } = makeTestConfig({
      STREAMHUB_NOTIFY_DISCORD_WEBHOOK: '',
      STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN: '',
      STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID: '',
      ...env,
    });
    dataDirs.push(dataDir);
    if (appConfigYaml !== undefined) {
      const dir = path.join(dataDir, 'apps', APP);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.yaml'), appConfigYaml);
    }
    const callbacks = mockCallbacksService();
    const email = { send: jest.fn(async () => ({ ok: true })) };
    const appLog = { appLog: jest.fn() };
    const svc = new NotifierService(
      config,
      appLog as unknown as AppLogService,
      email as unknown as EmailService,
      callbacks,
    );
    return { svc, callbacks, email, appLog };
  }

  /** URLs fetch was POSTed to. */
  const fetchUrls = (): string[] =>
    fetchMock.mock.calls.map((c) => String(c[0]));

  it('fans out to callback + discord + telegram from global env defaults', async () => {
    const { svc, callbacks } = makeSvc({
      STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK,
      STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN: '123:abc',
      STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID: '999',
    });

    await svc.notify(APP, 'node.offline', { node: 'edge-1' });

    expect(callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'node.offline',
      { node: 'edge-1' },
    );
    const urls = fetchUrls();
    expect(urls).toContain(ENV_WEBHOOK);
    expect(urls.some((u) => u.includes('api.telegram.org/bot123:abc/sendMessage'))).toBe(
      true,
    );
  });

  it('per-app config overrides the global discord webhook and enables email', async () => {
    const yaml = [
      'notifications:',
      '  discord:',
      `    webhook: ${WEBHOOK}`,
      '  email:',
      '    enabled: true',
      '    to: ops@example.com',
    ].join('\n');
    const { svc, email } = makeSvc(
      { STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK },
      yaml,
    );

    await svc.notify(APP, 'network.threshold_exceeded', { app: APP });

    // Per-app webhook wins over the env default.
    expect(fetchUrls()).toContain(WEBHOOK);
    expect(fetchUrls()).not.toContain(ENV_WEBHOOK);
    // Email fires because the app configured a recipient.
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0]).toMatchObject({ to: 'ops@example.com' });
    // Owner item 29: the app is passed as SMTP-resolution context, so a
    // per-app SMTP override (if configured) is used ahead of the global default.
    expect(email.send.mock.calls[0][1]).toEqual({ app: APP });
  });

  it('rate-limits duplicates within the window (per app/channel/key)', async () => {
    const { svc, callbacks } = makeSvc({
      STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK,
    });

    await svc.notify(APP, 'node.offline', { node: 'e1' });
    await svc.notify(APP, 'node.offline', { node: 'e1' });

    // Second call is suppressed on every channel.
    expect(callbacks.dispatch).toHaveBeenCalledTimes(1);
    expect(fetchUrls()).toHaveLength(1);

    // A different rateKey is NOT suppressed.
    await svc.notify(APP, 'node.offline', { node: 'e2' }, { rateKey: 'e2' });
    expect(callbacks.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a failing channel never breaks the others and notify never throws', async () => {
    fetchMock.mockRejectedValue(new Error('discord down'));
    const yaml = [
      'notifications:',
      '  email:',
      '    enabled: true',
      '    to: ops@example.com',
    ].join('\n');
    const { svc, callbacks, email } = makeSvc(
      { STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK },
      yaml,
    );

    await expect(
      svc.notify(APP, 'node.offline', { node: 'e1' }),
    ).resolves.toBeUndefined();

    // Discord threw, but callback + email still fired.
    expect(callbacks.dispatch).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('honors the event filter and the master switch', async () => {
    const filtered = [
      'notifications:',
      '  events: [node.online]',
    ].join('\n');
    const { svc: s1, callbacks: c1 } = makeSvc(
      { STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK },
      filtered,
    );
    await s1.notify(APP, 'node.offline', {}); // not in the filter
    expect(c1.dispatch).not.toHaveBeenCalled();
    expect(fetchUrls()).toHaveLength(0);

    const off = ['notifications:', '  enabled: false'].join('\n');
    const { svc: s2, callbacks: c2 } = makeSvc(
      { STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK },
      off,
    );
    await s2.notify(APP, 'node.offline', {});
    expect(c2.dispatch).not.toHaveBeenCalled();
  });

  it('records each notify through the per-app rotated log', async () => {
    const { svc, appLog } = makeSvc({
      STREAMHUB_NOTIFY_DISCORD_WEBHOOK: ENV_WEBHOOK,
    });
    await svc.notify(APP, 'node.offline', { node: 'e1' });
    expect(appLog.appLog).toHaveBeenCalledTimes(1);
    const [app, record] = appLog.appLog.mock.calls[0];
    expect(app).toBe(APP);
    expect(record).toMatchObject({ source: 'notify', event: 'node.offline' });
    expect((record as { sent: string[] }).sent).toEqual(
      expect.arrayContaining(['callback', 'discord']),
    );
  });
});
