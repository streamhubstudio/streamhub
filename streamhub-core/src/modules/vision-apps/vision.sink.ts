/**
 * VISION APPS — the detection sink (per-model db + rotated app log).
 *
 * Bound to {@link VISION_EVENT_SINK} by the @Global VisionAppsModule; called by
 * `PluginsService.ingestEvent` AFTER it dispatches a vision-family event through
 * the app's signed callbacks. So every occupancy/count/crowd/demography event
 * lands in THREE places: the signed webhook + MQTT tap (callbacks), the per-app
 * rotated `app.log` (AppLogService), and the matching model's per-app db
 * (`<model>.db`). Every path is best-effort and never throws.
 */
import { Inject, Injectable } from '@nestjs/common';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { AppLogService } from '../logs/app-log.service';
import { VisionEventSink } from './vision-sink.contract';
import { VisionStore } from './vision.store';
import { eventModel } from './vision.types';

@Injectable()
export class VisionSinkService implements VisionEventSink {
  constructor(
    private readonly store: VisionStore,
    private readonly appLog: AppLogService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  record(app: string, event: string, payload: Record<string, unknown>): void {
    const model = eventModel(event);
    if (!model) return;
    // Rotated per-app audit line — cheap, never depends on the DB path.
    try {
      this.appLog.appLog(app, { source: 'vision', event, ...payload });
    } catch {
      /* logging must never break ingest */
    }
    // vision.db table for this model.
    try {
      const appDir = this.apps.appDir(app);
      const room = typeof payload.room === 'string' ? payload.room : '';
      const data = payload as Record<string, unknown>;
      switch (model) {
        case 'occupancy':
          this.store.recordOccupancy(app, appDir, room, event, data);
          break;
        case 'counting':
          this.store.recordCount(app, appDir, room, event, data);
          break;
        case 'crowd':
          this.store.recordCrowd(app, appDir, room, event, data);
          break;
        case 'demography':
          this.store.recordDemography(app, appDir, room, event, data);
          break;
      }
    } catch {
      /* per-app DB trouble can never break event ingest */
    }
  }
}
