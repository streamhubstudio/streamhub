/**
 * Notifier fan-out contract (module `notifications`, Vision-Edge §H).
 *
 * A single `notify()` funnel fans one event out to the channels configured
 * globally (env) and per-app (`notifications:` config block): callback+MQTT
 * (via CallbacksService.dispatch), email, Discord and Telegram. Consumers
 * (edge watchdog on `node.online/offline`, net-metrics on
 * `network.threshold_*`, wave-2 vision detections) inject NOTIFIER_SERVICE.
 *
 * This module defines its OWN token; the cluster/edge module's EDGE_NOTIFIER
 * seam is aliased onto it by the lead when the edge channel is wired — keeping
 * the two modules decoupled.
 */
import type { CallbackEvent } from '../../shared/contracts';

/** DI token for the notifier fan-out. */
export const NOTIFIER_SERVICE = Symbol('NOTIFIER_SERVICE');

/** The fan-out channels a notify can reach. */
export type NotifyChannel = 'callback' | 'email' | 'discord' | 'telegram';

export interface NotifyOptions {
  /**
   * Dedupe/rate-limit key within (app, channel). Defaults to the event name —
   * pass a more specific key (e.g. `node.offline:<nodeId>`) so distinct
   * subjects are not collapsed by the 300s per-channel rate limit.
   */
  rateKey?: string;
  /** Human title/summary line for the chat channels (Discord/Telegram/email). */
  title?: string;
  /** Restrict to these channels (intersected with what the app configured). */
  channels?: NotifyChannel[];
}

export interface NotifierContract {
  /**
   * Fan `event` (+ `payload`) out to every configured, non-rate-limited channel
   * for `app`. Best-effort and isolated: a failing channel never affects the
   * others and this never throws.
   */
  notify(
    app: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void>;
  /**
   * App-less fan-out for cluster-scope events (node liveness…): env-configured
   * Discord/Telegram only. Per-app channels are delivered via {@link notify}.
   */
  notifyGlobal(
    event: CallbackEvent,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void>;
}
