import { Global, Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { NetMetricsController } from './net-metrics.controller';
import { NetMetricsService } from './net-metrics.service';
import { NetThresholdMonitorService } from './net-threshold-monitor.service';
import { NET_METRICS_SERVICE } from './net-metrics.contract';

/**
 * Net-metrics module (Vision Edge design §J, Wave 1C) — per-app media-plane
 * byte accounting + threshold monitoring + the read API.
 *
 * `@Global` for the same reason as MqttModule: the LiveKit webhook sink taps
 * NET_METRICS_SERVICE via `@Optional()` ModuleRef resolution without importing
 * this module (no DI cycle). Imports AppsModule for APPS_SERVICE; CALLBACKS_
 * and LOGS_SERVICE arrive from their global modules.
 *
 * WIRING FLAG (lead): the HLS egress collector ({@link makeHlsByteCounter}) is
 * NOT wired here — it must be attached at the FRONT of the raw `/hls` mount in
 * `main.ts` (that mount runs ahead of the Nest router and is terminal, so no
 * additive seam exists from inside a module). See the middleware file header.
 */
@Global()
@Module({
  imports: [AppsModule],
  controllers: [NetMetricsController],
  providers: [
    NetMetricsService,
    { provide: NET_METRICS_SERVICE, useExisting: NetMetricsService },
    NetThresholdMonitorService,
  ],
  exports: [NetMetricsService, NET_METRICS_SERVICE],
})
export class NetMetricsModule {}
