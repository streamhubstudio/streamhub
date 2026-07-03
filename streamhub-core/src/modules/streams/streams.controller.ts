import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
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
import { SnapshotDto } from './dto/snapshot.dto';
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
  constructor(private readonly streams: StreamsService) {}

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
      'uploads it to the app S3 bucket.',
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
}
