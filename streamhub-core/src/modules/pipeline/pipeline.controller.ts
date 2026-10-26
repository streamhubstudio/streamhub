import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { AppPipeline, PipelineService } from './pipeline.service';

/**
 * `GET /apps/:app/pipeline` — the app's resolved media-pipeline topology
 * (feature `pipeline`). Read-only, app-scoped, authed like every other
 * `/apps/:app/*` GET (Bearer + `app:read`). The response shape is a stable
 * frontend contract: the dashboard renders it as an animated flow diagram.
 */
@ApiTags('apps')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@Controller('apps/:app')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get('pipeline')
  @RequirePermission('app', 'read')
  @ApiOperation({
    summary:
      "Resolved media-pipeline topology: ingest → processing → delivery → storage, derived from the app's config.yaml plus live hints (active streams / on-disk HLS).",
  })
  @ApiOkResponse({
    description:
      '{ data: { ingest[], ingestFront, processing{transcoding,adaptive,passthrough}, compute{edge,vision}, delivery[], storage{recording,s3}, plugins[], live{activeStreams,tags}, events, notifications, net } }. No credentials/secrets ever appear (bucket/public-URL names + booleans/counts only).',
  })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async get(
    @Param('app') app: string,
  ): Promise<{ data: AppPipeline; error: null }> {
    return { data: await this.pipeline.get(app), error: null };
  }
}
