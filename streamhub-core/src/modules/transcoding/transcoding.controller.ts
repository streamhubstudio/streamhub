import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UpdateTranscodingConfigDto } from './dto/update-transcoding-config.dto';
import {
  TranscodingConfigView,
  TranscodingService,
} from './transcoding.service';
import { WebrtcLayer } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';

/**
 * Per-app adaptive/transcoding config (SPEC §5 transcoding, §6 per-app
 * GET/PATCH /config). Owns `/apps/:app/config` and the rendition-ladder helper.
 */
@ApiTags('transcoding')
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class TranscodingController {
  constructor(private readonly transcoding: TranscodingService) {}

  @Get('config')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Get the adaptive/transcoding config for an app.',
  })
  @ApiOkResponse({ description: 'Transcoding config (no secrets).' })
  getConfig(@Param('app') app: string): Promise<TranscodingConfigView> {
    return this.transcoding.getConfigView(app);
  }

  @Patch('config')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Patch the adaptive/transcoding config for an app.',
  })
  @ApiOkResponse({ description: 'Merged transcoding config.' })
  patchConfig(
    @Param('app') app: string,
    @Body() dto: UpdateTranscodingConfigDto,
  ): Promise<TranscodingConfigView> {
    return this.transcoding.updateConfig(app, dto);
  }

  @Get('transcoding/layers')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Effective WebRTC rendition ladder for an app.' })
  @ApiOkResponse({ description: 'Rendition ladder (720/480/240 by default).' })
  layers(@Param('app') app: string): Promise<WebrtcLayer[]> {
    return this.transcoding.layersForApp(app);
  }
}
