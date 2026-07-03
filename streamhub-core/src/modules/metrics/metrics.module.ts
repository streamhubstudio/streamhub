import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

/**
 * Observability module (Prometheus).
 *
 * `@Global` so every business service can inject {@link MetricsService}
 * `@Optional()` without importing this module — instrumentation stays additive
 * and a service constructed outside the DI container (e.g. a unit test) simply
 * receives `undefined` and no-ops. Registers {@link MetricsInterceptor} as a
 * global APP_INTERCEPTOR so all HTTP traffic is measured, and exposes the
 * `/metrics` scrape endpoint via {@link MetricsController}.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
