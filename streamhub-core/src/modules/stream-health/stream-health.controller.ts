import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { StreamHealthService } from './stream-health.service';
import { HealthSettingsError } from './stream-health.thresholds';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Stream-health Studio App API (module `stream-health`), mounted at
 * `/apps/:app/plugins/stream-health/...`. The distinct sub-paths (overview /
 * events / streams/:room/settings) never collide with the generic
 * PluginsController `:id` routes — same layout as the vision-apps module.
 * RBAC mirrors the plugin API: global Bearer guard + @RequirePermission on
 * the app-config resource (reads → config:read, writes → config:write).
 *
 * The LIVE snapshot is NOT here: the worker pushes it to the framework
 * live-data channel and the tab polls
 * `GET /apps/:app/plugins/stream-health/live/state?room=overview`.
 */
@ApiTags('stream-health')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/plugins/stream-health')
export class StreamHealthController {
  constructor(private readonly health: StreamHealthService) {}

  @Get('overview')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Health overview: events today + rooms with recent history/overrides.',
  })
  @ApiOkResponse({ description: 'Overview tiles for the monitor tab.' })
  async overview(@Param('app') app: string) {
    return ok(await this.health.overview(app));
  }

  @Get('events')
  @RequirePermission('config', 'read')
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 50, max 1000).' })
  @ApiQuery({ name: 'room', required: false, description: 'Scope to one room.' })
  @ApiOperation({ summary: 'Recent health.* transitions (from the per-app db).' })
  async events(
    @Param('app') app: string,
    @Query('limit') limit?: string,
    @Query('room') room?: string,
  ) {
    const n = Math.max(1, Math.min(1000, Number.parseInt(limit ?? '50', 10) || 50));
    return ok(await this.health.events(app, n, room?.trim() || undefined));
  }

  @Get('streams/:room/settings')
  @RequirePermission('config', 'read')
  @ApiParam({ name: 'room', description: 'Room / stream name.' })
  @ApiOperation({
    summary: 'Per-room threshold override + the resolved effective thresholds.',
  })
  async getSettings(@Param('app') app: string, @Param('room') room: string) {
    return ok(await this.health.getSettings(app, room));
  }

  @Put('streams/:room/settings')
  @RequirePermission('config', 'write')
  @ApiParam({ name: 'room', description: 'Room / stream name.' })
  @ApiOperation({
    summary: 'Set a per-room threshold override (picked up live, no restart).',
    description:
      'Body: { config } — a PARTIAL thresholds object (only overridden keys). ' +
      'Unknown keys or out-of-range values → 400. {} clears the override. The ' +
      'worker re-reads overrides every sampling cycle.',
  })
  async putSettings(
    @Param('app') app: string,
    @Param('room') room: string,
    @Body() body: { config?: unknown },
  ) {
    try {
      return ok(await this.health.putSettings(app, room, body?.config ?? {}));
    } catch (err) {
      if (err instanceof HealthSettingsError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
