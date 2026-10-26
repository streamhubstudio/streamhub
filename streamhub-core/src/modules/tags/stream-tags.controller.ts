import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { ApplyTagsDto } from './dto/tag.dto';
import { StreamTagsState, TagsRepository } from './tags.repository';

/**
 * Per-stream tagging (`/apps/:app/streams/:id/tags`, Vision-Edge §E). Replaces
 * the tag slugs applied to one stream row; every slug must reference an existing
 * tag. Read uses `stream:read`, write uses `stream:write` (mirrors the streams
 * controller). Separate controller from {@link TagsController} so the tag CRUD
 * and the stream-side join live under their natural path prefixes.
 */
@ApiTags('tags')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@Controller('apps/:app')
export class StreamTagsController {
  constructor(private readonly tags: TagsRepository) {}

  @Get('streams/:id/tags')
  @RequirePermission('stream', 'read')
  @ApiOperation({ summary: "Get a stream's applied tags" })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiOkResponse({ description: 'The applied tag slugs.' })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  getStreamTags(
    @Param('app') app: string,
    @Param('id') id: string,
  ): { data: StreamTagsState } {
    return { data: this.tags.getStreamTags(app, id) };
  }

  @Patch('streams/:id/tags')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: "Set a stream's applied tags",
    description:
      'Replaces the tag slugs applied to this stream. All slugs must reference ' +
      'existing tags (400 otherwise).',
  })
  @ApiParam({ name: 'id', description: 'Stream id' })
  @ApiOkResponse({ description: 'The applied tag slugs.' })
  @ApiNotFoundResponse({ description: 'Stream not found' })
  setStreamTags(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: ApplyTagsDto,
  ): { data: StreamTagsState } {
    return { data: this.tags.setStreamTags(app, id, body.tags) };
  }
}
