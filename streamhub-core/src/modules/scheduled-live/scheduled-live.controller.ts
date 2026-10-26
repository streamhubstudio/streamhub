import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../../shared/auth/public.decorator';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';
import { CreateScheduledEventDto } from './dto/create-scheduled-event.dto';
import { PatchScheduledEventDto } from './dto/patch-scheduled-event.dto';
import { ScheduledEventView, ScheduledLiveService } from './scheduled-live.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Scheduled-live agenda (module `scheduled-live`): schedule live-stream
 * "premieres" per app. Each event has an absolute start instant (unix epoch ms,
 * UTC) computed browser-side from a picked wall-time + IANA timezone; the player
 * shows a full-cover countdown until then and reveals the stream at the start.
 *
 * Management routes require the global Bearer guard + `config` RBAC; the `/public`
 * route is anonymous (the /play + /embed players read it with no token) and only
 * exposes enabled, upcoming events.
 */
@ApiTags('scheduled-live')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/scheduled-live')
export class ScheduledLiveController {
  constructor(
    private readonly scheduled: ScheduledLiveService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  /**
   * Owner item 11: the app's configured timezone, used as the DEFAULT for a
   * new/updated event that leaves its own `timezone` empty. Best-effort —
   * never throws (an app config read failure just means no default is
   * offered; the service itself still falls back to `'UTC'`).
   */
  private async defaultTimezone(app: string): Promise<string> {
    try {
      const cfg = await this.apps.getConfig(app);
      return cfg.timezone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  // NOTE: `/public` MUST be declared before any `/:id` route so the literal
  // `public` segment is never captured as an id.
  @Get('public')
  @Public()
  @ApiOperation({
    summary: 'Public agenda for the anonymous player (enabled + upcoming).',
    description:
      'No auth. Returns enabled, not-yet-past scheduled events for the given ' +
      'room (or all rooms when omitted), soonest first — drives the player ' +
      'countdown cover.',
  })
  @ApiQuery({ name: 'room', required: false })
  @ApiQuery({ name: 'sinceMs', required: false, description: 'Lower bound on startAt (unix ms).' })
  @ApiOkResponse({ description: 'Enabled upcoming events.' })
  listPublic(
    @Param('app') app: string,
    @Query('room') room?: string,
    @Query('sinceMs') sinceMs?: string,
  ): Envelope<ScheduledEventView[]> {
    const since = sinceMs !== undefined ? Number(sinceMs) : undefined;
    return ok(
      this.scheduled.listPublic(
        app,
        room,
        Number.isFinite(since) ? (since as number) : undefined,
      ),
    );
  }

  @Get()
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'List every scheduled event (the operator agenda).' })
  @ApiOkResponse({ description: 'All scheduled events, soonest first.' })
  list(@Param('app') app: string): Envelope<ScheduledEventView[]> {
    return ok(this.scheduled.list(app));
  }

  @Post()
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Schedule a new live premiere.' })
  @ApiOkResponse({ description: 'The created scheduled event.' })
  async create(
    @Param('app') app: string,
    @Body() body: CreateScheduledEventDto,
  ): Promise<Envelope<ScheduledEventView>> {
    return ok(this.scheduled.create(app, body, await this.defaultTimezone(app)));
  }

  @Patch(':id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Update a scheduled event (time, enable/disable, …).' })
  @ApiParam({ name: 'id', description: 'Scheduled event id.' })
  @ApiOkResponse({ description: 'The updated scheduled event.' })
  async update(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PatchScheduledEventDto,
  ): Promise<Envelope<ScheduledEventView>> {
    return ok(
      this.scheduled.update(app, id, body, await this.defaultTimezone(app)),
    );
  }

  @Delete(':id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Delete a scheduled event.' })
  @ApiParam({ name: 'id', description: 'Scheduled event id.' })
  @ApiOkResponse({ description: '{ removed: true }' })
  remove(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Envelope<{ removed: true }> {
    return ok(this.scheduled.remove(app, id));
  }
}
