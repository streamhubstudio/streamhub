import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import { HlsService } from './hls.service';
import {
  HlsStartResponseDto,
  HlsStatusResponseDto,
  HlsStopResponseDto,
} from './dto/hls-response.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Live HLS egress for a stream's room (wave-3 §1b). Routes scoped under
 * /apps/:app/streams/:id/hls. Auth is enforced by the global Bearer guard.
 */
@ApiTags('streams')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@ApiParam({ name: 'id', description: 'Stream id of the live stream.' })
@Controller('apps/:app/streams/:id/hls')
export class HlsController {
  constructor(
    private readonly hls: HlsService,
    private readonly config: ConfigService,
  ) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start the live HLS egress for a stream room.',
    description:
      'Launches a RoomComposite SegmentedFileOutput (HLS) egress writing ' +
      'index.m3u8 + .ts segments under the data dir; the core serves them at ' +
      '/hls/<app>/<room>/index.m3u8. Idempotent: an already-running egress is ' +
      'reused. Fires the hls_started callback.',
  })
  @ApiOkResponse({ type: HlsStartResponseDto })
  async start(
    @Param('app') app: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<HlsStartResponseDto> {
    return ok(await this.hls.start(app, id, this.baseUrl(req)));
  }

  @Post('stop')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stop the live HLS egress for a stream room.',
    description: 'Stops the active HLS egress(es) and fires hls_stopped.',
  })
  @ApiOkResponse({ type: HlsStopResponseDto })
  async stop(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<HlsStopResponseDto> {
    return ok(await this.hls.stop(app, id));
  }

  @Get()
  @ApiOperation({
    summary: 'Live HLS status for a stream.',
    description:
      'Returns whether a live HLS playlist is available and its public URL.',
  })
  @ApiOkResponse({ type: HlsStatusResponseDto })
  async status(
    @Param('app') app: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<HlsStatusResponseDto> {
    return ok(await this.hls.status(app, id, this.baseUrl(req)));
  }

  /**
   * Public origin used to build absolute playlist URLs: the configured
   * PUBLIC_BASE_URL when set, otherwise derived from the request (honoring
   * X-Forwarded-Proto/Host from the reverse proxy).
   */
  private baseUrl(req: Request): string {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl.replace(/\/+$/, '');
    }
    const fwdProto = (req.headers['x-forwarded-proto'] as string | undefined)
      ?.split(',')[0]
      ?.trim();
    const proto = fwdProto || req.protocol || 'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ||
      req.headers.host ||
      `${this.config.host}:${this.config.port}`;
    return `${proto}://${host}`;
  }
}
