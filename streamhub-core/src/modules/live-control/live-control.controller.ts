import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../../shared/auth/public.decorator';
import { RequirePermission } from '../authz/permission.decorator';
import { CoverOverrideDto } from './dto/cover-override.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { LiveControlService } from './live-control.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/** 50 MB cap for a cover asset (image or a short looping video). */
const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/**
 * Live Control API (module `live-control`). Mounted at
 * `/apps/:app/plugins/live-control/...` — the concrete `live-control` segment +
 * distinct sub-paths (mirrors the fleet plugin's controller convention rather
 * than the generic PluginsController `:id/data` routes). Both the `live-control`
 * console app-tab AND the `live-control-overlay` player-overlay call these
 * routes. `/public` is anonymous (the /play + /embed overlay reads it with no
 * token); everything else takes the global Bearer guard + `config` RBAC.
 */
@ApiTags('live-control')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/plugins/live-control')
export class LiveControlController {
  constructor(private readonly svc: LiveControlService) {}

  // NOTE: `/public` declared before `/streams/:id` so nothing captures it.
  @Get('public')
  @Public()
  @ApiOperation({
    summary: 'Public live-control state for a stream (anonymous overlay).',
    description:
      'PUBLIC (no Bearer): powers the live-control cover on the /play + /embed ' +
      'players. Returns `{ streamId, state, since, cover }` where cover is null ' +
      'while live and otherwise carries the resolved mode + text card + a signed ' +
      'asset URL. Never exposes S3 credentials.',
  })
  @ApiQuery({ name: 'stream', required: false, description: 'Stream id.' })
  @ApiQuery({
    name: 'room',
    required: false,
    description: 'Room name — resolved to the live stream publishing there (player overlays only know the room).',
  })
  @ApiOkResponse({ description: 'Public state + resolved cover.' })
  async publicState(
    @Param('app') app: string,
    @Query('stream') stream?: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.svc.publicState(app, { stream, room }));
  }

  // --- streams + state machine ---------------------------------------------

  @Get('streams')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Live streams + their live-control state (operator list).' })
  @ApiOkResponse({ description: 'Streams with control state.' })
  async streams(@Param('app') app: string) {
    return ok(await this.svc.listStreams(app));
  }

  @Get('streams/:streamId')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'One stream + its live-control state.' })
  @ApiParam({ name: 'streamId', description: 'Stream id.' })
  async stream(@Param('app') app: string, @Param('streamId') streamId: string) {
    return ok(await this.svc.getStream(app, streamId));
  }

  @Post('streams/:streamId/pause')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Pause a live stream — viewers see the cover; audio muted.',
    description:
      'Body (all optional) overrides the app default cover for this stream: ' +
      '{ mode, assetId, cardTitle, cardText, cardColor }. Mutes the publisher ' +
      "audio server-side (best-effort), pushes state to the room and fires " +
      '`livecontrol.paused`. 400 if `assetId` is unknown.',
  })
  @ApiParam({ name: 'streamId', description: 'Stream id.' })
  async pause(
    @Param('app') app: string,
    @Param('streamId') streamId: string,
    @Body() body: CoverOverrideDto,
  ) {
    return ok(await this.svc.transition(app, streamId, 'pause', body ?? {}));
  }

  @Post('streams/:streamId/resume')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Resume a paused stream — back to the live feed; audio unmuted.',
    description: 'Unmutes audio, pushes state and fires `livecontrol.resumed`.',
  })
  @ApiParam({ name: 'streamId', description: 'Stream id.' })
  async resume(@Param('app') app: string, @Param('streamId') streamId: string) {
    return ok(await this.svc.transition(app, streamId, 'resume', {}));
  }

  @Post('streams/:streamId/finish')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Finish a live stream — end with a final card/asset.',
    description:
      'Same override body as pause; drives the stream to `finished` and fires ' +
      '`livecontrol.finished`. Does NOT tear down the underlying stream/room.',
  })
  @ApiParam({ name: 'streamId', description: 'Stream id.' })
  async finish(
    @Param('app') app: string,
    @Param('streamId') streamId: string,
    @Body() body: CoverOverrideDto,
  ) {
    return ok(await this.svc.transition(app, streamId, 'finish', body ?? {}));
  }

  // --- cover assets (S3) ----------------------------------------------------

  @Get('assets')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'List uploaded cover assets (each with a signed URL).' })
  async assets(@Param('app') app: string) {
    return ok(await this.svc.listAssets(app));
  }

  @Post('assets')
  @RequirePermission('config', 'write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ASSET_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a cover asset (image/* or video/*) to the app S3.',
    description:
      'Multipart field `file` (+ optional `label`). 409 `storage_not_configured` ' +
      'when the app has no S3 bucket (same guard as recordings). 400 on an empty ' +
      'or non-image/video upload.',
  })
  async upload(
    @Param('app') app: string,
    @UploadedFile()
    file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
    @Body() body: { label?: string },
  ) {
    return ok(await this.svc.uploadAsset(app, file ?? {}, body?.label));
  }

  @Get('assets/:id/url')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Fresh signed preview URL for one asset.' })
  @ApiParam({ name: 'id', description: 'Asset id.' })
  async assetUrl(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return ok(await this.svc.assetUrl(app, id));
  }

  @Delete('assets/:id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Delete an asset (db row + S3 object).' })
  @ApiParam({ name: 'id', description: 'Asset id.' })
  async deleteAsset(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return ok(await this.svc.deleteAsset(app, id));
  }

  // --- per-app default settings --------------------------------------------

  @Get('settings')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Per-app live-control defaults (static + default assets).' })
  async settings(@Param('app') app: string) {
    return ok(await this.svc.getSettings(app));
  }

  @Put('settings')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Update the per-app default cover assets (pause/finish).',
    description: 'Send `null` to clear a default. 400 when a referenced asset id is unknown.',
  })
  async updateSettings(
    @Param('app') app: string,
    @Body() body: UpdateSettingsDto,
  ) {
    return ok(await this.svc.updateSettings(app, body ?? {}));
  }
}
