/**
 * Per-app network threshold monitor (Vision Edge design §J, Wave 1C).
 *
 * Mirrors {@link LatencyMonitorService}: every 5 min it compares each app's
 * rolling-24h ingress+egress bytes (from the `net_samples` table) against its
 * configured `network.threshold_gb_day` cap and drives a LATCHED state machine
 * with hysteresis so a value hovering at the limit cannot flap:
 *
 *   - usage >= threshold and not breached
 *       → emit `network.threshold_exceeded`, latch.
 *   - usage <  90% of threshold and breached
 *       → emit `network.threshold_recovered`, unlatch.
 *
 * Both events go through CALLBACKS_SERVICE — the single funnel — so they reach
 * the app webhook AND (via the callbacks MQTT tap) the app broker. The threshold
 * is read RAW from config.yaml (shared/contracts is frozen this wave); an app
 * with no threshold configured is skipped and any latched state is cleared.
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { NetMetricsService } from './net-metrics.service';
import { readNetworkConfig } from './net-config.util';
import { gbToBytes } from './net-bucket.util';

/** Monitor cadence (design §J: "every 5 min"). */
const TICK_MS = 5 * 60_000;
/** Recovery hysteresis: clear only once usage drops below this × threshold. */
const RECOVER_FRACTION = 0.9;

/** Latched breach state per app. */
interface AppThresholdState {
  breached: boolean;
}

@Injectable()
export class NetThresholdMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly states = new Map<string, AppThresholdState>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly net: NetMetricsService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tickOnce(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One monitor pass over every app. Public for tests; never throws. */
  async tickOnce(now: number = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const apps = await this.apps.list();
      const live = new Set<string>();
      for (const app of apps) {
        live.add(app.name);
        await this.checkApp(app.name, now);
      }
      // Drop latched state for apps that disappeared.
      for (const name of [...this.states.keys()]) {
        if (!live.has(name)) this.states.delete(name);
      }
    } catch (err) {
      this.warn(null, 'threshold pass failed', err);
    } finally {
      this.ticking = false;
    }
  }

  private async checkApp(app: string, now: number): Promise<void> {
    const thresholdGbDay = this.thresholdFor(app);
    const thresholdBytes = gbToBytes(thresholdGbDay);
    if (thresholdBytes <= 0) {
      this.states.delete(app); // threshold removed → forget any latch
      return;
    }

    const usage = this.net.summary(app, now).last24h.total;
    const state = this.states.get(app) ?? { breached: false };
    this.states.set(app, state);

    if (!state.breached && usage >= thresholdBytes) {
      state.breached = true;
      await this.dispatch(app, 'network.threshold_exceeded', {
        usageBytes: usage,
        thresholdBytes,
        thresholdGbDay,
        windowHours: 24,
      });
      return;
    }
    if (state.breached && usage < thresholdBytes * RECOVER_FRACTION) {
      state.breached = false;
      await this.dispatch(app, 'network.threshold_recovered', {
        usageBytes: usage,
        thresholdBytes,
        thresholdGbDay,
        windowHours: 24,
      });
    }
  }

  /** Read the app's `network.threshold_gb_day` (0 = unset). Never throws. */
  private thresholdFor(app: string): number {
    try {
      return readNetworkConfig(this.apps.appDir(app)).thresholdGbDay ?? 0;
    } catch {
      return 0;
    }
  }

  private async dispatch(
    app: string,
    event: 'network.threshold_exceeded' | 'network.threshold_recovered',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.callbacks.dispatch(app, event, payload);
      this.logs.write('info', 'net-threshold', `emitted "${event}"`, {
        app,
        ...payload,
      });
    } catch (err) {
      this.warn(app, `dispatch of "${event}" failed`, err);
    }
  }

  private warn(app: string | null, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'net-threshold', message, {
        ...(app ? { app } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* never throw */
    }
  }
}
