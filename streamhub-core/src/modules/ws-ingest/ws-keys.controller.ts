import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../../shared/auth/public.decorator';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';
import { WsIngestService } from './ws-ingest.service';
import { CreateWsIngestDto } from './dto/create-ws-ingest.dto';

/**
 * Provisioning REST of the direct WS MJPEG ingest (ESP32-WS-INGEST.md §3.6).
 * Same permission plane as the RTMP ingress (`ingress:*`) + the concurrent
 * streams quota on mint. The `live/:room` info endpoint is PUBLIC — it powers
 * the /play + /embed player-mode detection for anonymous viewers (gated by
 * `features.publicPlayback`, mirroring /play-token).
 */
@ApiTags('ws-ingest')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/ws-ingest')
export class WsKeysController {
  constructor(
    private readonly svc: WsIngestService,
    private readonly quotas: QuotasService,
  ) {}

  @Post()
  @RequirePermission('ingress', 'create')
  @ApiOperation({
    summary:
      'Mint a WebSocket ingest key (wsk_) for an ESP32/MJPEG camera. Returns the plaintext key once, plus wsUrl/mjpegUrl/playerUrl.',
  })
  async create(
    @Param('app') app: string,
    @Body() dto: CreateWsIngestDto,
    @CurrentAuth() ctx?: AuthContext,
  ) {
    // A camera key opens a live stream slot — same quota as tokens/ingress.
    await this.quotas.enforceConcurrentStreams(ctx);
    const data = await this.svc.provision(app, dto.room, dto.identity);
    return { data };
  }

  @Get()
  @RequirePermission('ingress', 'read')
  @ApiOperation({
    summary:
      'List the app WS ingest keys with live state (active = camera connected). Credentials ride along, like the RTMP ingress listing.',
  })
  list(@Param('app') app: string) {
    return { data: this.svc.listKeys(app) };
  }

  @Delete(':id')
  @RequirePermission('ingress', 'delete')
  @ApiOperation({
    summary:
      'Revoke a WS ingest key. The live camera connection (if any) is closed immediately.',
  })
  @ApiParam({ name: 'id', description: 'Key id (wsi_…)' })
  remove(@Param('app') app: string, @Param('id') id: string) {
    this.svc.revoke(app, id);
    return { data: { id, deleted: true } };
  }

  @Get('live/:room')
  @Public()
  @ApiOperation({
    summary:
      'PUBLIC: whether a ws-mjpeg camera is live in a room (+ playback URLs). Drives the MJPEG mode of /play and /embed.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async liveInfo(@Param('app') app: string, @Param('room') room: string) {
    return { data: await this.svc.liveInfo(app, room) };
  }
}
