import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { SampleFileInfo } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';
import { SamplesService } from './samples.service';
import { WriteSampleDto } from './dto/write-sample.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Per-app sample management (wave-4 §3). Authed (Bearer) management endpoints
 * under `/apps/:app/samples`. The rendered HTML itself is also served publicly
 * (no auth) at `/samples/<app>/<file>` via a static mount in main.ts for
 * embedding — those bytes are not exposed through this controller.
 */
@ApiTags('samples')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/samples')
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  @Get()
  @RequirePermission('sample', 'read')
  @ApiOperation({ summary: 'List the app sample files (+ embed URLs).' })
  @ApiOkResponse({ description: 'Array of sample file infos.' })
  async list(@Param('app') app: string): Promise<Envelope<SampleFileInfo[]>> {
    return ok(await this.samples.list(app));
  }

  @Post('regenerate')
  @RequirePermission('sample', 'write')
  @ApiOperation({
    summary: 'Regenerate the standard sample set from templates (this app only).',
  })
  @ApiOkResponse({ description: '{ data: { regenerated: [files] } }.' })
  async regenerate(
    @Param('app') app: string,
  ): Promise<Envelope<{ regenerated: string[] }>> {
    return ok({ regenerated: await this.samples.generate(app) });
  }

  @Get(':file')
  @RequirePermission('sample', 'read')
  @ApiOperation({ summary: 'Raw contents of one sample file.' })
  @ApiParam({ name: 'file', example: 'webrtc-publish.html' })
  @ApiOkResponse({ description: '{ data: { file, content } }.' })
  async read(
    @Param('app') app: string,
    @Param('file') file: string,
  ): Promise<Envelope<{ file: string; content: string }>> {
    return ok({ file, content: await this.samples.read(app, file) });
  }

  @Put(':file')
  @RequirePermission('sample', 'write')
  @ApiOperation({
    summary: 'Overwrite one sample file (only this app is affected).',
  })
  @ApiParam({ name: 'file', example: 'webrtc-publish.html' })
  @ApiOkResponse({ description: '{ data: { file, saved: true } }.' })
  async write(
    @Param('app') app: string,
    @Param('file') file: string,
    @Body() dto: WriteSampleDto,
  ): Promise<Envelope<{ file: string; saved: true }>> {
    await this.samples.write(app, file, dto.content);
    return ok({ file, saved: true as const });
  }
}
