import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { AppLogQueryDto } from './dto/log-query.dto';
import { LogsPageResponse } from './logs.controller';
import { LogsService } from './logs.service';

/**
 * Per-app log viewer — `GET /api/v1/apps/:app/logs`. Same envelope + filters as
 * the global viewer, but the app is taken from the path and every row is scoped
 * to that app (`server_logs.app_id`). Gated by `@RequirePermission('usage',
 * 'read')` + the tenant data-scope, mirroring the per-app DB-admin routes.
 */
@ApiTags('logs')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class AppLogsController {
  constructor(private readonly logs: LogsService) {}

  @Get('logs')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary: 'List logs for a single app',
    description:
      'Logs attributed to this app (server_logs.app_id). Filter by level, ' +
      'source, free-text (q) and ISO date range. Newest first. Paginated.',
  })
  @ApiOkResponse({ description: 'Paginated log entries scoped to the app.' })
  async query(
    @Param('app') app: string,
    @Query() q: AppLogQueryDto,
  ): Promise<LogsPageResponse> {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const filters = { ...q, app, limit, offset };
    const [data, total] = await Promise.all([
      this.logs.query(filters),
      this.logs.count(filters),
    ]);
    return { data, total, limit, offset };
  }
}
