import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';
import { AddRestreamDto } from './dto/add-restream.dto';
import { RestreamService, RestreamTargetView } from './restream.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Restream / multi-destination RTMP forwarding of a live stream (AntMedia
 * "endpoints"): forward the stream's room to N external RTMP targets
 * (YouTube/Twitch/Facebook/custom) simultaneously — one LiveKit stream egress
 * per destination.
 *
 * Routes are scoped under `/apps/:app/streams/:id/restream`; auth is the
 * global Bearer guard + `broadcast` RBAC (start/read/stop) + tenant/app
 * isolation via the PermissionGuard. Responses NEVER contain the destination
 * stream key — URLs are masked.
 */
@ApiTags('restream')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@ApiParam({ name: 'id', description: 'Stream id of the live stream.' })
@Controller('apps/:app/streams/:id/restream')
export class RestreamController {
  constructor(
    private readonly restream: RestreamService,
    private readonly quotas: QuotasService,
  ) {}

  @Post()
  @RequirePermission('broadcast', 'start')
  @ApiOperation({
    summary: 'Add a forwarding destination (starts an RTMP stream egress).',
    description:
      'Builds the destination push URL (preset platform + stream key, or a ' +
      'custom rtmp(s):// URL) and launches a dedicated RoomComposite ' +
      'StreamOutput egress towards it. Multiple destinations can run ' +
      'simultaneously; each one is independent.',
  })
  @ApiOkResponse({
    description: 'The created destination (stream key masked in urlMasked).',
  })
  async add(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: AddRestreamDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<RestreamTargetView>> {
    await this.quotas.enforceEgress(ctx);
    return ok(await this.restream.add(app, id, body));
  }

  @Get()
  @RequirePermission('broadcast', 'read')
  @ApiOperation({
    summary: 'List the stream’s forwarding destinations + per-endpoint state.',
    description:
      'Destinations with status starting/active/failed (stopped ones are ' +
      'omitted). URLs are masked — the destination stream key is never returned.',
  })
  @ApiOkResponse({ description: 'Active/failed destinations of the stream.' })
  async list(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<Envelope<RestreamTargetView[]>> {
    return ok(await this.restream.list(app, id));
  }

  @Delete(':egressId')
  @HttpCode(200)
  @RequirePermission('broadcast', 'stop')
  @ApiOperation({
    summary: 'Stop ONE forwarding destination by its egress id.',
    description: 'The other destinations keep pushing. Fires restream_stopped.',
  })
  @ApiParam({ name: 'egressId', description: 'Egress id of the destination.' })
  async remove(
    @Param('app') app: string,
    @Param('id') id: string,
    @Param('egressId') egressId: string,
  ): Promise<Envelope<RestreamTargetView>> {
    return ok(await this.restream.remove(app, id, egressId));
  }
}
