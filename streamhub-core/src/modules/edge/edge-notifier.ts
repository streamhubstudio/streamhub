/**
 * VISION EDGE — node-event notifier seam.
 *
 * Node liveness events (`node.online`/`node.offline`) are GLOBAL (not per-app),
 * so this is an INJECTABLE seam rather than a hard-wired fan-out. Wave 1B swaps
 * {@link DefaultEdgeNotifier} for the full fan-out (email / Discord / Telegram
 * on top of callbacks + MQTT). The watchdog only ever depends on the
 * {@link EDGE_NOTIFIER} token + {@link EdgeNotifier} interface below, so that
 * replacement touches nothing else.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import {
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import type { CallbackEvent } from '../../shared/contracts';
import {
  NOTIFIER_SERVICE,
  NotifierContract,
} from '../notifications/notifier.contract';

/** DI token for the edge node-event notifier. */
export const EDGE_NOTIFIER = Symbol('EDGE_NOTIFIER');

/** The seam the watchdog fires node liveness (and future threshold) events through. */
export interface EdgeNotifier {
  notify(
    event: 'node.online' | 'node.offline' | string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Default notifier (minimal — Wave 1B replaces it):
 *   1. logs every node event through {@link LogsServiceContract} (source `edge`);
 *   2. for a `node.online`/`node.offline` flip, dispatches the event through the
 *      SIGNED callbacks funnel (webhook + MQTT tap) of every app whose config.yaml
 *      opts in with a truthy `cluster.notify`.
 *
 * Reading the opt-in straight off config.yaml keeps this piece self-contained
 * (no coupling to AppsService); the full notification config model lands in 1B.
 */
@Injectable()
export class DefaultEdgeNotifier implements EdgeNotifier {
  private readonly logger = new Logger(DefaultEdgeNotifier.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
    // Full fan-out (email/Discord/Telegram + rate limits). @Global module —
    // resolves once NotificationsModule is registered; null in isolated tests.
    @Optional()
    @Inject(NOTIFIER_SERVICE)
    private readonly notifier?: NotifierContract,
  ) {}

  async notify(
    event: 'node.online' | 'node.offline' | string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      this.logs?.write('info', 'edge', `cluster ${event}`, payload);
    } catch {
      /* logging must never break the watchdog */
    }
    this.logger.log(`cluster ${event}: ${JSON.stringify(payload)}`);

    // Node liveness flips and the "no capacity" alert both fan out globally +
    // to apps that opt in with `cluster.notify`; anything else is log-only.
    const FANOUT = new Set(['node.online', 'node.offline', 'cluster.capacity']);
    if (!FANOUT.has(event)) return;

    // Global channels (env Discord/Telegram) — cluster events have no app.
    try {
      await this.notifier?.notifyGlobal(event as CallbackEvent, payload);
    } catch {
      /* fan-out is best-effort */
    }

    for (const app of this.optedInApps()) {
      // Per-app fan-out (callback/MQTT/email + per-app overrides) when the
      // notifications module is present; bare signed-callback funnel otherwise.
      try {
        if (this.notifier) {
          await this.notifier.notify(app, event as CallbackEvent, payload);
        } else if (this.callbacks) {
          await this.callbacks.dispatch(app, event as CallbackEvent, payload);
        }
      } catch (err) {
        this.logger.debug(
          `node-event dispatch to '${app}' failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Apps whose config.yaml has a truthy `cluster.notify`. Never throws. */
  private optedInApps(): string[] {
    let names: string[] = [];
    try {
      names = (
        this.db.global().prepare('SELECT name FROM apps').all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (this.optedIn(name)) out.push(name);
    }
    return out;
  }

  private optedIn(app: string): boolean {
    try {
      const file = path.join(this.config.dataDir, 'apps', app, 'config.yaml');
      if (!fs.existsSync(file)) return false;
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) as unknown;
      if (!doc || typeof doc !== 'object') return false;
      const cluster = (doc as { cluster?: unknown }).cluster;
      if (!cluster || typeof cluster !== 'object') return false;
      return this.truthy((cluster as { notify?: unknown }).notify);
    } catch {
      return false;
    }
  }

  private truthy(v: unknown): boolean {
    if (v === true) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'on' || s === 'yes';
    }
    return v === 1;
  }
}
