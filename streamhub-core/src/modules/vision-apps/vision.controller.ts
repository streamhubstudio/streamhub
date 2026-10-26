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
import { PutStreamSettingsDto } from './dto/vision.dto';
import { VisionAppService } from './vision.service';
import { VisionSettingsError } from './vision-settings';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Vision Studio Apps API (module `vision-apps`), mounted at
 * `/apps/:app/plugins/:visionApp/...` where `:visionApp` is one of the four
 * model-apps (occupancy | counting | crowd | demography). ONE controller class
 * parametrized by model — NOT four copies. The distinct sub-paths (overview /
 * streams / events) never collide with the generic PluginsController `:id`
 * routes. RBAC mirrors the rest of the plugin API: the global Bearer guard +
 * @RequirePermission on the app-config resource (reads → config:read, writes →
 * config:write).
 *
 * ASSIGNMENTS are NOT here — the generic edge assignments API lives at
 * `/apps/:app/edge/assignments` (edge is the cluster's processing concept).
 */
@ApiTags('vision-apps')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@ApiParam({
  name: 'visionApp',
  description: 'Vision model-app id: occupancy | counting | crowd | demography.',
})
@Controller('apps/:app/plugins/:visionApp')
export class VisionAppController {
  constructor(private readonly vision: VisionAppService) {}

  @Get('overview')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Model overview: events today, edge assignments, active streams.' })
  @ApiOkResponse({ description: 'Overview tiles for this model.' })
  async overview(@Param('app') app: string, @Param('visionApp') model: string) {
    return ok(await this.vision.overview(app, model));
  }

  @Get('streams')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Active rooms with their tags + whether this model has a settings override.' })
  async streams(@Param('app') app: string, @Param('visionApp') model: string) {
    return ok(await this.vision.streams(app, model));
  }

  @Get('streams/:room/settings')
  @RequirePermission('config', 'read')
  @ApiParam({ name: 'room', description: 'Room / stream name.' })
  @ApiOperation({ summary: 'Get a room settings override + its resolved config for this model.' })
  async getSettings(
    @Param('app') app: string,
    @Param('visionApp') model: string,
    @Param('room') room: string,
  ) {
    return ok(await this.vision.getSettings(app, model, room));
  }

  @Put('streams/:room/settings')
  @RequirePermission('config', 'write')
  @ApiParam({ name: 'room', description: 'Room / stream name.' })
  @ApiOperation({
    summary: 'Set a room settings override (polygons / lines / roi) for this model.',
    description:
      'Body: { config }. Validated + normalized (points clamped to 0–1, ' +
      'polygons need ≥3 points); 400 on an invalid shape.',
  })
  async putSettings(
    @Param('app') app: string,
    @Param('visionApp') model: string,
    @Param('room') room: string,
    @Body() body: PutStreamSettingsDto,
  ) {
    try {
      return ok(await this.vision.putSettings(app, model, room, body?.config ?? {}));
    } catch (err) {
      if (err instanceof VisionSettingsError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get('events')
  @RequirePermission('config', 'read')
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 50, max 1000).' })
  @ApiOperation({ summary: 'Recent detection events for this model (from its per-app db).' })
  async events(
    @Param('app') app: string,
    @Param('visionApp') model: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.max(1, Math.min(1000, Number.parseInt(limit ?? '50', 10) || 50));
    return ok(await this.vision.events(app, model, n));
  }
}
