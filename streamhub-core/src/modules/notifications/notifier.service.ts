import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { ConfigService } from '../../shared/config/config.service';
import {
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
} from '../../shared/contracts';
import { EmailService } from '../email/email.service';
import { AppLogService } from '../logs/app-log.service';
import {
  NotifierContract,
  NotifyChannel,
  NotifyOptions,
} from './notifier.contract';

/** Per-(app,channel,key) rate-limit window (Vision One's Discord notifier: 300s). */
const RATE_LIMIT_MS = 300_000;
/** Timeout for a single Discord/Telegram HTTP call. */
const HTTP_TIMEOUT_MS = 5_000;
/** Prune the rate-limit map when it grows past this many entries. */
const RATE_MAP_PRUNE_AT = 5_000;

/** Resolved notifier config for one app (global defaults + per-app overrides). */
interface ResolvedNotify {
  /** Master switch (per-app `notifications.enabled`, default true). */
  enabled: boolean;
  /** Event filter: ['all'] (default) or explicit event names. */
  events: string[];
  /** callback+MQTT channel via CallbacksService.dispatch (self-gates on config). */
  callback: boolean;
  email: { enabled: boolean; to: string };
  discord: { enabled: boolean; webhook: string };
  telegram: { enabled: boolean; botToken: string; chatId: string };
}

/**
 * Notifier fan-out (Vision-Edge §H). Fans one event out to callback+MQTT, email,
 * Discord and Telegram — the channels enabled by the merge of global env
 * defaults (ConfigService) and the per-app `notifications:` config block. Every
 * channel is isolated (one failing channel never breaks the others), rate-limited
 * per (app, channel, key) for 300s, and each notify is recorded in the app's
 * rotated `app.log`. Never throws.
 */
@Injectable()
export class NotifierService implements NotifierContract {
  /** `${app}::${channel}::${key}` → last-sent epoch ms. */
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly appLog: AppLogService,
    @Optional() private readonly email?: EmailService,
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
  ) {}

  async notify(
    app: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    let cfg: ResolvedNotify;
    try {
      cfg = this.resolve(app);
    } catch {
      return; // config unreadable → nothing to fan out
    }
    if (!cfg.enabled || !this.eventPasses(event, cfg.events)) return;

    const key = (opts?.rateKey || event).trim() || event;
    const wanted = opts?.channels;
    const want = (c: NotifyChannel): boolean => !wanted || wanted.includes(c);

    const sent: NotifyChannel[] = [];
    const suppressed: NotifyChannel[] = [];
    const tasks: Promise<void>[] = [];

    const consider = (
      channel: NotifyChannel,
      active: boolean,
      run: () => Promise<void>,
    ): void => {
      if (!active || !want(channel)) return;
      if (this.rateLimited(app, channel, key)) {
        suppressed.push(channel);
        return;
      }
      sent.push(channel);
      tasks.push(this.safe(channel, run));
    };

    consider('callback', cfg.callback && !!this.callbacks, () =>
      this.callbacks!.dispatch(app, event, payload),
    );
    consider('email', cfg.email.enabled && !!this.email, () =>
      this.sendEmail(app, cfg.email.to, event, payload, opts),
    );
    consider('discord', cfg.discord.enabled, () =>
      this.sendDiscord(cfg.discord.webhook, event, payload, opts),
    );
    consider('telegram', cfg.telegram.enabled, () =>
      this.sendTelegram(
        cfg.telegram.botToken,
        cfg.telegram.chatId,
        event,
        payload,
        opts,
      ),
    );

    // Record the notify in the app's rotated log (best-effort) before awaiting.
    if (sent.length || suppressed.length) {
      this.appLog.appLog(app, {
        source: 'notify',
        event,
        key,
        sent,
        suppressed,
      });
    }

    // Isolated fan-out: one channel's failure can never affect the others.
    await Promise.allSettled(tasks);
  }

  /**
   * GLOBAL (app-less) fan-out for cluster-scope events (node.online/offline…):
   * only the env-configured Discord/Telegram channels apply — callback/MQTT and
   * email targets are inherently per-app, so per-app delivery of the same event
   * goes through {@link notify} for each opted-in app (the edge notifier does
   * both). Same rate-limit + isolation semantics, keyed under the pseudo-app
   * '_cluster'.
   */
  async notifyGlobal(
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    const key = (opts?.rateKey || event).trim() || event;
    const wanted = opts?.channels;
    const want = (c: NotifyChannel): boolean => !wanted || wanted.includes(c);
    const tasks: Promise<void>[] = [];

    const consider = (
      channel: NotifyChannel,
      active: boolean,
      run: () => Promise<void>,
    ): void => {
      if (!active || !want(channel)) return;
      if (this.rateLimited('_cluster', channel, key)) return;
      tasks.push(this.safe(channel, run));
    };

    consider('discord', !!this.config.notifyDiscordWebhook, () =>
      this.sendDiscord(this.config.notifyDiscordWebhook, event, payload, opts),
    );
    consider(
      'telegram',
      !!this.config.notifyTelegramBotToken && !!this.config.notifyTelegramChatId,
      () =>
        this.sendTelegram(
          this.config.notifyTelegramBotToken,
          this.config.notifyTelegramChatId,
          event,
          payload,
          opts,
        ),
    );

    await Promise.allSettled(tasks);
  }

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------

  /**
   * `app` (owner item 29): app-scoped notifications resolve THIS app's SMTP
   * override when enabled, falling back to the global default — unless a
   * per-user override outranks it, but there's no user in a notify() call, so
   * only the app/global tiers apply here.
   */
  private async sendEmail(
    app: string,
    to: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    if (!this.email) return;
    const subject = opts?.title || `StreamHub: ${event}`;
    await this.email.send(
      {
        to,
        subject,
        text: `${subject}\n\n${NotifierService.summarize(payload)}`,
      },
      { app },
    );
  }

  private async sendDiscord(
    webhook: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    const title = opts?.title || `StreamHub: ${event}`;
    const content = `**${title}**\n${NotifierService.summarize(payload)}`;
    await NotifierService.postJson(webhook, { content });
  }

  private async sendTelegram(
    botToken: string,
    chatId: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    const title = opts?.title || `StreamHub: ${event}`;
    const text = `${title}\n${NotifierService.summarize(payload)}`;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await NotifierService.postJson(url, { chat_id: chatId, text });
  }

  /** POST a JSON body with a bounded timeout. Throws on network/timeout error. */
  private static async postJson(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run a channel send, swallowing any error (isolation). Never throws. */
  private async safe(_channel: NotifyChannel, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      /* a failing channel never breaks the others */
    }
  }

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  /**
   * Which fan-out channels resolve as ENABLED for an app — booleans ONLY, never
   * the underlying webhook/token/address. Feeds the pipeline diagram
   * (GET /apps/:app/pipeline) so it can show the notification fan-out without
   * exposing any secret. Best-effort: unreadable config → all channels off.
   */
  channelsFor(app: string): {
    email: boolean;
    discord: boolean;
    telegram: boolean;
  } {
    try {
      const cfg = this.resolve(app);
      const on = cfg.enabled;
      return {
        email: on && cfg.email.enabled,
        discord: on && cfg.discord.enabled,
        telegram: on && cfg.telegram.enabled,
      };
    } catch {
      return { email: false, discord: false, telegram: false };
    }
  }

  /** Merge global env defaults with the app's `notifications:` config block. */
  private resolve(app: string): ResolvedNotify {
    const block = this.readNotificationsBlock(app);

    const enabled = block.enabled !== false;
    const events = NotifierService.asStringArray(block.events);

    const discordCfg = NotifierService.asObject(block.discord);
    const discordWebhook =
      NotifierService.asString(discordCfg.webhook) ||
      this.config.notifyDiscordWebhook;

    const telegramCfg = NotifierService.asObject(block.telegram);
    const botToken =
      NotifierService.asString(telegramCfg.bot_token) ||
      this.config.notifyTelegramBotToken;
    const chatId =
      NotifierService.asString(telegramCfg.chat_id) ||
      this.config.notifyTelegramChatId;

    const emailCfg = NotifierService.asObject(block.email);
    const callbackCfg = NotifierService.asObject(block.callback);

    return {
      enabled,
      events: events.length ? events : ['all'],
      // callback+MQTT is on by default; CallbacksService.dispatch itself no-ops
      // when the app configured no callback URL / MQTT.
      callback: callbackCfg.enabled !== false,
      email: {
        enabled: emailCfg.enabled === true && !!NotifierService.asString(emailCfg.to),
        to: NotifierService.asString(emailCfg.to),
      },
      discord: {
        enabled: discordCfg.enabled !== false && !!discordWebhook,
        webhook: discordWebhook,
      },
      telegram: {
        enabled: telegramCfg.enabled !== false && !!botToken && !!chatId,
        botToken,
        chatId,
      },
    };
  }

  /**
   * Read the per-app `notifications:` block from config.yaml. Best-effort: a
   * missing/unparseable file → {} (fall back to global env defaults). Read from
   * the raw yaml (not the typed AppConfig) because `notifications:` is an
   * arbitrary block that only survives via the raw-config editor.
   */
  private readNotificationsBlock(app: string): Record<string, unknown> {
    try {
      const file = path.join(this.config.dataDir, 'apps', app, 'config.yaml');
      const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return NotifierService.asObject(
          (parsed as Record<string, unknown>).notifications,
        );
      }
    } catch {
      /* no config / parse error → global defaults only */
    }
    return {};
  }

  private eventPasses(event: string, events: string[]): boolean {
    if (!events.length || events.includes('all')) return true;
    return events.includes(event);
  }

  /** True when this (app,channel,key) fired within the rate-limit window. */
  private rateLimited(app: string, channel: NotifyChannel, key: string): boolean {
    const now = Date.now();
    if (this.lastSent.size > RATE_MAP_PRUNE_AT) this.prune(now);
    const k = `${app}::${channel}::${key}`;
    const last = this.lastSent.get(k);
    if (last !== undefined && now - last < RATE_LIMIT_MS) return true;
    this.lastSent.set(k, now);
    return false;
  }

  private prune(now: number): void {
    for (const [k, t] of this.lastSent) {
      if (now - t >= RATE_LIMIT_MS) this.lastSent.delete(k);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Compact one-line-ish summary of the payload for chat/email bodies. */
  private static summarize(payload: Record<string, unknown>): string {
    try {
      const json = JSON.stringify(payload ?? {});
      return json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
    } catch {
      return '{}';
    }
  }

  private static asObject(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  }

  private static asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
  }

  private static asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x).trim()).filter(Boolean);
  }
}
