import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { LogEntry } from '../../shared/contracts';
import { LogQueryDto } from './dto/log-query.dto';
import { LogsService } from './logs.service';

/** Paginated `GET /logs` response (SPEC §6 `{data,error}` convention). */
export interface LogsPageResponse {
  data: LogEntry[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Log viewer — `GET /api/v1/logs` (SPEC §6). Auth-protected by the global
 * SkylineAuthGuard (no `@Public()` here). Supports filters by app/level/date
 * range plus pagination.
 */
@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  @ApiOperation({
    summary: 'List server logs',
    description:
      'Filter by app name, level, source, free-text (q) and ISO date range. ' +
      'Newest first. Paginated.',
  })
  @ApiOkResponse({ description: 'Paginated log entries.' })
  async query(@Query() q: LogQueryDto): Promise<LogsPageResponse> {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const [data, total] = await Promise.all([
      this.logs.query({ ...q, limit, offset }),
      this.logs.count(q),
    ]);
    return { data, total, limit, offset };
  }
}
