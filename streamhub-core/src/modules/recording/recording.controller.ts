import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { AppStats, AppStatsService } from './app-stats.service';
import { RecordingService, VodDetail } from './recording.service';
import { StartRecordingDto } from './dto/start-recording.dto';
import { ListVodsDto } from './dto/list-vods.dto';
import {
  RecordingHandle,
  STREAMS_SERVICE,
  StreamsServiceContract,
  VodRecord,
} from '../../shared/contracts';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

/** Paginated envelope: adds total/limit/offset alongside data (VODs list). */
interface PagedEnvelope<T> extends Envelope<T> {
  total: number;
  limit: number;
  offset: number;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Per-app recording + VODs (SPEC §6 per-app, §8). Routes scoped under
 * /apps/:app/... . Auth is enforced by the global Bearer guard.
 */
@ApiTags('recording')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class RecordingController {
  constructor(
    private readonly recording: RecordingService,
    @Inject(STREAMS_SERVICE)
    private readonly streams: StreamsServiceContract,
    private readonly quotas: QuotasService,
    private readonly stats: AppStatsService,
  ) {}

  @Post('streams/:id/record/start')
  @RequirePermission('recording', 'start')
  @ApiOperation({
    summary: 'Start recording a live stream (egress over the stream room).',
    description:
      'Resolves the stream id to its LiveKit room and starts a room-composite ' +
      'egress (reusing the recording flow). Honors the app split/snapshot config.',
  })
  @ApiParam({ name: 'id', description: 'Stream id of the live stream.' })
  @ApiOkResponse({ description: 'Recording handle (vodId + egressId + status).' })
  async recordStreamStart(
    @Param('app') app: string,
    @Param('id') id: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<RecordingHandle>> {
    await this.quotas.enforceRecordingMinutes(ctx);
    const stream = await this.streams.get(app, id);
    if (!stream) throw new NotFoundException(`stream '${id}' not found`);
    if (!stream.room) {
      throw new BadRequestException(`stream '${id}' has no room to record`);
    }
    const handle = await this.recording.startForStream(app, id, stream.room);
    return ok(handle);
  }

  @Post('streams/:id/record/stop')
  @RequirePermission('recording', 'stop')
  @ApiOperation({
    summary: 'Stop the in-progress recording of a live stream.',
  })
  @ApiParam({ name: 'id', description: 'Stream id of the live stream.' })
  @ApiOkResponse({ description: 'Recording handle (egressId + status).' })
  async recordStreamStop(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<Envelope<RecordingHandle>> {
    const handle = await this.recording.stopForStream(app, id);
    return ok(handle);
  }

  @Post('recording/start')
  @RequirePermission('recording', 'start')
  @ApiOperation({
    summary: 'Start a recording (egress) for a room of the app.',
  })
  @ApiOkResponse({ description: 'Recording handle (vodId + egressId).' })
  async start(
    @Param('app') app: string,
    @Body() body: StartRecordingDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<RecordingHandle>> {
    await this.quotas.enforceRecordingMinutes(ctx);
    const handle = await this.recording.start({
      appName: app,
      roomName: body.roomName,
      streamId: body.streamId,
    });
    return ok(handle);
  }

  @Post('recording/:id/stop')
  @RequirePermission('recording', 'stop')
  @ApiOperation({ summary: 'Stop an in-progress recording.' })
  @ApiParam({
    name: 'id',
    description: 'VOD id (numeric) or egress id of the recording.',
  })
  async stop(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<Envelope<RecordingHandle>> {
    const handle = await this.recording.stop(app, id);
    return ok(handle);
  }

  @Get('vods')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary:
      'List VODs of the app with filters/ordering/paging + total count. ' +
      'Filters: room, status, since/until (started_at). order=started_at|size_bytes|id, ' +
      "dir=asc|desc, all=1 returns everything. Default order id DESC.",
  })
  @ApiOkResponse({
    description: '{ data: VodRecord[], total, limit, offset, error: null }',
  })
  listVods(
    @Param('app') app: string,
    @Query() query: ListVodsDto,
  ): PagedEnvelope<VodRecord[]> {
    const page = this.recording.listVods(app, query);
    return {
      data: page.data,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      error: null,
    };
  }

  @Post('vods/:id/probe')
  @RequirePermission('vod', 'write')
  @ApiOperation({
    summary:
      'Probe a VOD with ffprobe and backfill duration_s / width / height / ' +
      'format (for VODs recorded before the metadata pipeline). Sources the ' +
      'local file when present, else a presigned S3 URL. Best-effort: a ' +
      'failed probe returns probed:false without touching the row.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  @ApiOkResponse({ description: '{ data: VodRecord & { probed: boolean } }' })
  async probeVod(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Envelope<VodRecord & { probed: boolean }>> {
    return ok(await this.recording.probeVod(app, id));
  }

  @Get('vods/:id/download')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary:
      'Get a download URL for a VOD (attachment). S3-backed → presigned URL ' +
      'with attachment disposition; local-only → URL to the /raw stream. ' +
      '409 when not ready, 404 when no file exists.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  @ApiOkResponse({
    description: '{ data: { url, filename, expiresInSeconds } }',
  })
  @ApiConflictResponse({ description: 'VOD is not ready.' })
  async downloadVod(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<
    Envelope<{ url: string; filename: string; expiresInSeconds: number | null }>
  > {
    const dl = await this.recording.getDownload(app, id);
    if (dl.source === 's3') {
      return ok({
        url: dl.url,
        filename: dl.filename,
        expiresInSeconds: dl.expiresInSeconds,
      });
    }
    // Local-only: point at the raw streaming endpoint (no expiry).
    const url = `/api/v1/apps/${encodeURIComponent(app)}/vods/${id}/raw`;
    return ok({ url, filename: dl.filename, expiresInSeconds: null });
  }

  @Get('vods/:id/raw')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary:
      'Stream a local VOD file as an attachment download. 409 when not ready, ' +
      '404 when no local file is present.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  downloadVodRaw(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const { localPath, filename, contentType } = this.recording.openLocalRaw(
      app,
      id,
    );
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(createReadStream(localPath));
  }

  @Get('stats')
  @RequirePermission('app', 'read')
  @ApiOperation({
    summary:
      'Per-app stats: live streams/viewers, VOD counts/storage, ingress and ' +
      'a 24h log rollup. Cached 5s. viewers are null when the viewerCounter ' +
      'feature is off.',
  })
  @ApiOkResponse({ description: '{ data: AppStats }' })
  getStats(@Param('app') app: string): Promise<Envelope<AppStats>> {
    return this.stats.stats(app).then(ok);
  }

  @Get('vods/:id')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary:
      'VOD detail with playback URLs (url/presignedUrl/publicUrl, wave-4 §2) ' +
      'plus post-transcode variants: `adaptive` (HLS master playlist entry ' +
      'point, when the app generates an adaptive ladder) and `variants` ' +
      '(master + HLS renditions + alternate encodings such as WebM/VP8).',
  })
  async getVod(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Envelope<VodDetail>> {
    return ok(await this.recording.getVod(app, id));
  }

  @Delete('vods/:id')
  @RequirePermission('vod', 'delete')
  @ApiOperation({
    summary:
      'Delete a VOD with cascade: app.db row + S3 object + S3 snapshot + local file/snapshot.',
    description:
      'Returns { id, deleted, s3Deleted, localDeleted }: s3Deleted counts the ' +
      'S3 objects removed (recording + snapshot), localDeleted is true when a ' +
      'local file was removed. Idempotent for already-absent objects.',
  })
  @ApiOkResponse({
    description: '{ data: { id, deleted, s3Deleted, localDeleted } }',
  })
  async deleteVod(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<
    Envelope<{
      id: number;
      deleted: true;
      s3Deleted: number;
      localDeleted: boolean;
    }>
  > {
    const res = await this.recording.deleteVod(app, id);
    return ok({ id, ...res });
  }
}
