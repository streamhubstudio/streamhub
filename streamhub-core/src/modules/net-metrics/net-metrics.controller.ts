/**
 * Per-app network I/O read API (Vision Edge design §J, Wave 1C). Same per-app
 * auth surface as the streams routes (`@Controller('apps/:app')` + a
 * `@RequirePermission('usage','read')` gate — network bytes are usage data).
 *
 *   GET /apps/:app/net              → rolling summary + threshold posture
 *   GET /apps/:app/net/history?hours → bucketed in/out rows for the sparkline
 *
 * The threshold itself is configured via the existing raw-config surface
 * (`network.threshold_gb_day` in config.yaml); this API only reports it.
 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';
import {
  NetHistoryBucket,
  NetMetricsService,
  NetSummary,
} from './net-metrics.service';
import { readNetworkConfig } from './net-config.util';

@ApiTags('net-metrics')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@Controller('apps/:app')
export class NetMetricsController {
  constructor(
    private readonly net: NetMetricsService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  @Get('net')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary: 'App network I/O summary',
    description:
      'Rolling per-app media-plane byte totals (today / last 24h / last 7d, ' +
      'per direction and source) plus the configured threshold posture.',
  })
  @ApiOkResponse({ description: 'Network usage summary.' })
  async summary(@Param('app') app: string): Promise<{ data: NetSummary }> {
    const threshold = readNetworkConfig(this.apps.appDir(app)).thresholdGbDay ?? 0;
    return { data: this.net.summary(app, Date.now(), threshold) };
  }

  @Get('net/history')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary: 'App network I/O history',
    description:
      'Hourly-bucketed in/out byte rows for the dashboard sparkline. ' +
      '`hours` (default 48) is clamped to [1, 720].',
  })
  @ApiQuery({ name: 'hours', required: false, example: 48 })
  @ApiOkResponse({ description: 'Bucketed network history.' })
  async history(
    @Param('app') app: string,
    @Query('hours') hours?: string,
  ): Promise<{ data: { hours: number; buckets: NetHistoryBucket[] } }> {
    const parsed = Number(hours);
    const h = Number.isFinite(parsed) && parsed > 0 ? parsed : 48;
    return { data: { hours: h, buckets: this.net.history(app, h) } };
  }
}
