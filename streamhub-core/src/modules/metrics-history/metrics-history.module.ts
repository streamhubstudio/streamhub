import { Module } from '@nestjs/common';

import { MetricsHistoryController } from './metrics-history.controller';
import { MetricsHistoryScheduler } from './metrics-history.scheduler';
import { MetricsHistoryService } from './metrics-history.service';

/**
 * Metrics-history module — lightweight, in-app host resource-usage history
 * (CPU / RAM / Disk / Network sampled once per hour into the global DB, 30-day
 * retention). Complementary to the Prometheus/Grafana stack (`/metrics`): this
 * is the built-in, dependency-free path that drives the dashboard's "Resource
 * history" dot charts.
 *
 *  - {@link MetricsHistoryService}   — schema bootstrap, hourly sampler,
 *                                      retention prune, bucketed read API,
 *  - {@link MetricsHistoryScheduler} — hourly BullMQ repeatable job (+ boot
 *                                      catch-up),
 *  - {@link MetricsHistoryController} — superadmin `GET /system/metrics/history`.
 *
 * Registered as an import of SystemModule (the /system/* surface it extends),
 * so app.module.ts / main.ts / shared stay untouched. Depends only on the
 * @Global shared providers (Config, Db). Docs:
 * https://streamhub.studio/docs/operations/OBSERVABILITY.
 */
@Module({
  controllers: [MetricsHistoryController],
  providers: [MetricsHistoryService, MetricsHistoryScheduler],
  exports: [MetricsHistoryService],
})
export class MetricsHistoryModule {}
