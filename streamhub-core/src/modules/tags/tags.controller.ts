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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { ApplyTagsDto, CreateTagDto, UpdateTagDto } from './dto/tag.dto';
import { RoomTagsState, TagRecord, TagsRepository } from './tags.repository';

/**
 * Per-app dynamic TAGS CRUD (`/apps/:app/tags`, Vision-Edge §E). A tag is an
 * operator-created entity with a `config_json` settings blob, applied to streams
 * by slug. RBAC: tag reads use `config:read`, writes use `config:write` (tags
 * configure how an app's streams are processed — same trust plane as app
 * config), mirroring the streams controller's guard pattern.
 */
@ApiTags('tags')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name', example: 'live' })
@Controller('apps/:app/tags')
export class TagsController {
  constructor(private readonly tags: TagsRepository) {}

  @Get()
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'List tags',
    description: 'All tags for the app, optionally filtered by kind.',
  })
  @ApiQuery({ name: 'kind', required: false, description: 'Filter by tag kind.' })
  @ApiOkResponse({ description: 'The app tags.' })
  list(
    @Param('app') app: string,
    @Query('kind') kind?: string,
  ): { data: TagRecord[] } {
    return { data: this.tags.list(app, kind?.trim() || undefined) };
  }

  @Post()
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Create a tag' })
  @ApiCreatedResponse({ description: 'The created tag.' })
  create(
    @Param('app') app: string,
    @Body() body: CreateTagDto,
  ): { data: TagRecord } {
    return {
      data: this.tags.create(app, {
        slug: body.slug,
        label: body.label,
        kind: body.kind,
        config_json: body.config_json,
      }),
    };
  }

  @Patch('room/:room')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: "Apply tags to a room's streams",
    description:
      "Replaces the tag slugs on every existing stream row of the room. All " +
      'slugs must reference existing tags. Returns how many stream rows were ' +
      'updated (0 when the room has no stream rows yet).',
  })
  @ApiParam({ name: 'room', description: 'Room name' })
  @ApiOkResponse({ description: 'Applied tags + updated row count.' })
  setRoomTags(
    @Param('app') app: string,
    @Param('room') room: string,
    @Body() body: ApplyTagsDto,
  ): { data: RoomTagsState } {
    return { data: this.tags.setRoomTags(app, room, body.tags) };
  }

  @Get(':slug')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Get a tag' })
  @ApiParam({ name: 'slug', description: 'Tag slug' })
  @ApiNotFoundResponse({ description: 'Tag not found' })
  get(
    @Param('app') app: string,
    @Param('slug') slug: string,
  ): { data: TagRecord } {
    const tag = this.tags.get(app, slug);
    if (!tag) throw new NotFoundException(`tag '${slug}' not found`);
    return { data: tag };
  }

  @Patch(':slug')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Update a tag' })
  @ApiParam({ name: 'slug', description: 'Tag slug' })
  @ApiOkResponse({ description: 'The updated tag.' })
  @ApiNotFoundResponse({ description: 'Tag not found' })
  update(
    @Param('app') app: string,
    @Param('slug') slug: string,
    @Body() body: UpdateTagDto,
  ): { data: TagRecord } {
    return {
      data: this.tags.update(app, slug, {
        label: body.label,
        kind: body.kind,
        config_json: body.config_json,
      }),
    };
  }

  @Delete(':slug')
  @HttpCode(204)
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Delete a tag',
    description:
      "Deletes the tag and prunes its slug from every stream's tags array " +
      'atomically.',
  })
  @ApiParam({ name: 'slug', description: 'Tag slug' })
  @ApiNoContentResponse({ description: 'Tag deleted' })
  @ApiNotFoundResponse({ description: 'Tag not found' })
  remove(@Param('app') app: string, @Param('slug') slug: string): void {
    this.tags.remove(app, slug);
  }
}
