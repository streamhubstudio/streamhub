import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../authz/permission.decorator';
import { StreamsService } from './streams.service';
import {
  StreamPluginOverridesService,
  StreamPluginsState,
} from './stream-plugins.service';
import { SnapshotDto } from './dto/snapshot.dto';
import { StreamPluginsDto } from './dto/stream-plugins.dto';
import {
  SnapshotResultDto,
  StreamResponseDto,
} from './dto/stream-response.dto';

/** Per-app streams + snapshots (SPEC §6 per-app). Requires auth. */
@ApiTags('streams')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@Controller('apps/:app')
export class StreamsController {
  constructor(
    private readonly streams: StreamsService,
    private readonly streamPlugins: StreamPluginOverridesService,
  ) {}

  @Get('streams')
  @RequirePermission('stream', 'read')
  @ApiOperation({
    summary: 'List active streams',
    description:
      'Active streams for the app, reconciled against live LiveKit rooms/participants.',
  })
  @ApiOkResponse({ type: StreamResponseDto, isArray: true })
  async list(
    @Param('app') app: string,
  ): Promise<{ data: StreamResponseDto[] }> {
    return { data: await this.streams.list(app) };
  }

  @Get('streams/:id')
  @RequirePermission('stream', 'read')
  @ApiOperation({ summary: 'Get stream detail' })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiOkResponse({ type: StreamResponseDto })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  async get(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<{ data: StreamResponseDto }> {
    const stream = await this.streams.get(app, id);
    if (!stream) throw new NotFoundException(`stream '${id}' not found`);
    return { data: stream };
  }

  @Get('streams/:id/plugins')
  @RequirePermission('stream', 'read')
  @ApiOperation({
    summary: "Get a stream's plugin opt-out list",
    description:
      'Returns the plugin ids this stream is opted OUT of. A stream is affected ' +
      "by every plugin the app enables EXCEPT those listed here. Default is [] " +
      '(the stream is affected by all app-enabled plugins).',
  })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  getPlugins(
    @Param('app') app: string,
    @Param('id') id: string,
  ): { data: StreamPluginsState } {
    return { data: this.streamPlugins.getForStream(app, id) };
  }

  @Patch('streams/:id/plugins')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: "Set a stream's plugin opt-out list",
    description:
      'Replaces the plugin ids this stream is opted OUT of. Pass [] to make the ' +
      "stream affected by all of the app's enabled plugins again. Per-stream " +
      'only — other streams in the app are unaffected.',
  })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiOkResponse({ description: 'Updated opt-out list' })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  setPlugins(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: StreamPluginsDto,
  ): { data: StreamPluginsState } {
    return { data: this.streamPlugins.setForStream(app, id, body.disabled) };
  }

  @Delete('streams/:id')
  @HttpCode(204)
  @RequirePermission('stream', 'stop')
  @ApiOperation({
    summary: 'Stop a stream',
    description:
      'Disconnects the participant / removes the ingress / ends the room, ' +
      'and marks the stream ended.',
  })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiNoContentResponse({ description: 'Stream stopped' })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  stop(@Param('app') app: string, @Param('id') id: string): Promise<void> {
    return this.streams.stop(app, id);
  }

  @Post('snapshots')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: 'On-demand snapshot',
    description:
      'Captures a single frame from the room via ffmpeg and (if configured) ' +
      'uploads it to the app S3 bucket. Fires the `stream.snapshot` event.',
  })
  @ApiOkResponse({ type: SnapshotResultDto })
  async snapshot(
    @Param('app') app: string,
    @Body() body: SnapshotDto,
  ): Promise<{ data: SnapshotResultDto }> {
    return {
      data: await this.streams.snapshot({
        appName: app,
        roomName: body.room,
        participantIdentity: body.participantIdentity,
      }),
    };
  }

  @Post('streams/:id/snapshot')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: 'On-demand snapshot of a stream (by id)',
    description:
      'Captures a single frame NOW for the stream and (if configured) uploads ' +
      'it to the app S3 bucket, returning its key/URL. Works for LiveKit-backed ' +
      'streams (room composite) AND passthrough/HLS streams (latest on-disk HLS ' +
      'segment). Fires the `stream.snapshot` event through the callbacks funnel.',
  })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiOkResponse({ type: SnapshotResultDto })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  async snapshotStream(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<{ data: SnapshotResultDto }> {
    return { data: await this.streams.snapshotByStream(app, id) };
  }
}
