import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  CallbackEvent,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  MQTT_SERVICE,
  MqttServiceContract,
} from '../../shared/contracts';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Envelope POSTed to an app's callback URL (wave-3 §4):
 * `{ event, app, room, ts, data }`. `id`/`timestamp` are kept as additive
 * fields for delivery tracing/back-compat.
 */
interface CallbackEnvelope {
  /** Unique delivery id (also sent as X-StreamHub-Delivery). */
  id: string;
  event: CallbackEvent;
  app: string;
  /** Room the event relates to (from `data.room`), or null. */
  room: string | null;
  /** ISO-8601 emission timestamp (spec field). */
  ts: string;
  /** Alias of `ts` (back-compat). */
  timestamp: string;
  data: Record<string, unknown>;
}

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

/**
 * Outbound per-app webhook dispatcher (SPEC §5 callbacks). On stream/vod events
 * (stream_started/ended, vod_ready, recording_failed) POSTs a signed JSON
 * payload to the app's configured callback URL.
 *
 * Signature: `X-StreamHub-Signature: sha256=<hex>` = HMAC-SHA256(secret, body).
 * Best-effort with bounded retries; never throws (callbacks must not break the
 * caller's flow).
 */
@Injectable()
export class CallbacksService implements CallbacksServiceContract {
  constructor(
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    @Inject(MQTT_SERVICE)
    private readonly mqtt?: MqttServiceContract,
  ) {}

  async dispatch(
    appName: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // MQTT fan-out tap (per-app MQTT publishing). dispatch() is the single
    // funnel every outbound event flows through, so tapping here mirrors the
    // WHOLE taxonomy to MQTT without duplicated emit sites. Independent of the
    // webhook URL (an app may use MQTT only), fire-and-forget, never throws.
    if (this.mqtt) {
      void this.mqtt.publishEvent(appName, event, payload).catch(() => undefined);
    }

    let config: AppConfig;
    try {
      config = await this.apps.getConfig(appName);
    } catch (err) {
      this.logs.write(
        'warn',
        'callbacks',
        `skipped "${event}" — could not load config for app "${appName}"`,
        { error: this.errMsg(err) },
      );
      return;
    }

    const url = config.callbacks?.url?.trim();
    if (!url) {
      this.logs.write(
        'debug',
        'callbacks',
        `no callback URL for app "${appName}" — skipping "${event}"`,
      );
      this.metrics?.callbackResult(appName, event, 'dropped');
      return;
    }

    const now = new Date().toISOString();
    const room =
      typeof payload?.room === 'string' ? (payload.room as string) : null;
    const envelope: CallbackEnvelope = {
      id: randomUUID(),
      event,
      app: appName,
      room,
      ts: now,
      timestamp: now,
      data: payload ?? {},
    };

    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch (err) {
      this.logs.write(
        'error',
        'callbacks',
        `failed to serialize "${event}" payload for app "${appName}"`,
        { error: this.errMsg(err) },
      );
      return;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'streamhub-core/callbacks',
      'x-streamhub-event': event,
      'x-streamhub-delivery': envelope.id,
      'x-streamhub-timestamp': envelope.timestamp,
    };

    const secret = config.callbacks?.secret;
    if (secret) {
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      headers['x-streamhub-signature'] = `sha256=${signature}`;
    }

    await this.post(appName, event, url, body, headers, envelope.id);
  }

  /** POST with bounded retries + exponential backoff. Never throws. */
  private async post(
    appName: string,
    event: CallbackEvent,
    url: string,
    body: string,
    headers: Record<string, string>,
    deliveryId: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        if (res.ok) {
          this.logs.write('info', 'callbacks', `delivered "${event}"`, {
            app: appName,
            url,
            status: res.status,
            delivery: deliveryId,
            attempt,
          });
          this.metrics?.callbackResult(appName, event, 'delivered');
          return;
        }

        // 4xx (except 408/429) are not retryable — the endpoint rejected it.
        const retryable =
          res.status >= 500 || res.status === 408 || res.status === 429;
        this.logs.write(
          retryable ? 'warn' : 'error',
          'callbacks',
          `"${event}" returned HTTP ${res.status}`,
          { app: appName, url, delivery: deliveryId, attempt, retryable },
        );
        if (!retryable) {
          this.metrics?.callbackResult(appName, event, 'failed');
          return;
        }
      } catch (err) {
        this.logs.write('warn', 'callbacks', `"${event}" delivery error`, {
          app: appName,
          url,
          delivery: deliveryId,
          attempt,
          error: this.errMsg(err),
        });
      } finally {
        clearTimeout(timer);
      }

      if (attempt < MAX_ATTEMPTS) {
        await this.delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }

    this.logs.write(
      'error',
      'callbacks',
      `gave up delivering "${event}" after ${MAX_ATTEMPTS} attempts`,
      { app: appName, url, delivery: deliveryId },
    );
    this.metrics?.callbackResult(appName, event, 'failed');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errMsg(err: unknown): string {
    if (err instanceof HttpException) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
