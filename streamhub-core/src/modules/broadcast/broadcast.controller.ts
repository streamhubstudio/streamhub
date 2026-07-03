import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { BroadcastService } from './broadcast.service';
import { StartBroadcastDto } from './dto/start-broadcast.dto';
import { StreamEgressInfo } from '../../shared/contracts';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Per-app broadcast (RTMP stream egress): take a LiveKit room and forward it to
 * an external RTMP target (YouTube/Twitch/custom).
 *
 * Routes are scoped under `/apps/:app/...`; auth is enforced by the global
 * Bearer guard. The browser must already be connected + publishing to the room
 * before calling `/broadcast/start`.
 */
@ApiTags('broadcast')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class BroadcastController {
  constructor(
    private readonly broadcast: BroadcastService,
    private readonly quotas: QuotasService,
  ) {}

  @Post('broadcast/start')
  @RequirePermission('broadcast', 'start')
  @ApiOperation({
    summary: 'Start broadcasting a room to an external RTMP URL (stream egress).',
  })
  @ApiOkResponse({
    description: 'Stream egress handle (egressId, status, roomName, rtmpUrl).',
  })
  async start(
    @Param('app') app: string,
    @Body() body: StartBroadcastDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<
    Envelope<{
      egressId: string;
      status: string;
      roomName: string;
      rtmpUrl: string;
    }>
  > {
    await this.quotas.enforceEgress(ctx);
    const info = await this.broadcast.start(
      app,
      body.roomName,
      body.rtmpUrl,
      body.layout,
    );
    return ok({
      egressId: info.egressId,
      status: info.status,
      roomName: info.roomName,
      rtmpUrl: info.urls[0] ?? body.rtmpUrl,
    });
  }

  @Post('broadcast/:id/stop')
  @RequirePermission('broadcast', 'stop')
  @ApiOperation({ summary: 'Stop an in-progress broadcast (stream egress).' })
  @ApiParam({ name: 'id', description: 'Egress id of the broadcast.' })
  async stop(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<Envelope<{ egressId: string; status: string }>> {
    return ok(await this.broadcast.stop(app, id));
  }

  @Get('broadcast')
  @RequirePermission('broadcast', 'read')
  @ApiOperation({
    summary: 'List active broadcasts (RTMP stream egresses) of the app.',
  })
  @ApiOkResponse({ description: 'Active stream egresses for the app.' })
  async list(
    @Param('app') app: string,
  ): Promise<Envelope<StreamEgressInfo[]>> {
    return ok(await this.broadcast.list(app));
  }
}
