import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../authz/permission.decorator';
import { Public } from '../../shared/auth/public.decorator';
import { PatchPluginDto } from './dto/patch-plugin.dto';
import { PinVersionDto } from './dto/pin-version.dto';
import { PluginExportService } from './plugin-export.service';
import { PluginsService } from './plugins.service';
import { PluginVersionService } from './appstore/plugin-version.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Plugin marketplace + per-app install management (module `plugins`).
 * All routes scoped under /apps/:app/plugins. Auth = global Bearer guard;
 * @RequirePermission maps to the app-config resource (phased/log-only until
 * STREAMHUB_AUTHZ_ENFORCE=on), so this is purely additive for existing creds.
 */
@ApiTags('plugins')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/plugins')
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly exporter: PluginExportService,
    private readonly versionSvc: PluginVersionService,
  ) {}

  @Get()
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Marketplace: all built-in plugins + this app install/config state.',
    description:
      'Optional `?stream=`/`?room=` make the list STREAM-AWARE (used by the ' +
      'authenticated player): a plugin the stream/room opted out of is reported ' +
      'as `enabled:false` so overlays honor the per-stream opt-out. Without ' +
      'either param the app-level list is returned unchanged (the marketplace).',
  })
  @ApiOkResponse({ description: 'List of plugin marketplace entries.' })
  @ApiQuery({ name: 'stream', required: false, description: 'Stream id scope.' })
  @ApiQuery({ name: 'room', required: false, description: 'Room name scope.' })
  async list(
    @Param('app') app: string,
    @Query('stream') stream?: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.plugins.list(app, { stream, room }));
  }

  // NOTE: declared BEFORE the `:id` route below so the literal `public` segment
  // is never captured as a plugin id.
  @Get('public')
  @Public()
  @ApiOperation({
    summary:
      "This app's ENABLED player-overlay plugins for anonymous players (no auth).",
    description:
      'PUBLIC (no Bearer): powers the overlays (e.g. Timestamp CCTV) on the ' +
      '/play and /embed pages. Returns only installed+enabled `player-overlay` ' +
      'plugins, each as { id, manifest:{name,ui,configSchema,icon}, config } with ' +
      'the config SANITIZED (secrets + callback/webhook URLs stripped). Never ' +
      'exposes app-tab/panel plugins, disabled installs or the full catalog.',
  })
  @ApiOkResponse({ description: 'Enabled player-overlay plugins (sanitized).' })
  @ApiQuery({ name: 'stream', required: false, description: 'Stream id scope.' })
  @ApiQuery({ name: 'room', required: false, description: 'Room name scope.' })
  async publicOverlays(
    @Param('app') app: string,
    @Query('stream') stream?: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.plugins.publicOverlays(app, { stream, room }));
  }

  @Get(':id')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'One marketplace entry (manifest + install state).' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async getOne(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.plugins.get(app, id));
  }

  @Get(':id/export')
  // Same permission tier as config write (PATCH :id): exporting the app bundle
  // is a sensitive, install-scoped operation.
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Export an installed Studio App as a standalone tarball.',
    description:
      'Bundles the app worker source + a generated Dockerfile, docker-compose, ' +
      '.env.example (placeholders only — no real secrets/hosts) and README into ' +
      'a gzip tarball (streamhub-app-<id>-<version>.tar.gz) that runs on your own ' +
      'infra and talks back over REST/webhooks. 404 unknown plugin, 400 when the ' +
      'plugin is not exportable or not installed in this app.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiProduces('application/gzip')
  @ApiOkResponse({ description: 'The gzip tarball (attachment).' })
  async export(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { filename, body } = await this.exporter.export(app, id);
    return new StreamableFile(body, {
      type: 'application/gzip',
      disposition: `attachment; filename="${filename}"`,
      length: body.length,
    });
  }

  @Get(':id/versions')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Version state for this install (active pin, catalog, history).',
    description:
      'Returns { active, effective, available (the appstore catalog), history }. ' +
      '`active` is the install pin (null = built-in/latest); `effective` is the ' +
      'version that actually runs.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async versions(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.versionSvc.view(app, id));
  }

  @Put(':id/version')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Pin (or unpin) the appstore version this install runs.',
    description:
      'Body { version: "<semver>" | null }. null unpins (built-in/latest). The ' +
      'version must exist in the appstore (404 otherwise). Records the change in ' +
      'history, restarts a running worker so it takes effect, and dispatches ' +
      'plugin.version_changed.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async pinVersion(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: PinVersionDto,
  ) {
    return ok(await this.versionSvc.pin(app, id, body.version ?? null));
  }

  @Post(':id/version/rollback')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Roll back to the version this install ran before its last change.',
    description:
      'Repins to the `from` of the most recent history entry (which may be ' +
      'null = built-in/latest). 400 when there is no history to roll back to.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async rollbackVersion(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.versionSvc.rollback(app, id));
  }

  @Post(':id/install')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Install a plugin into the app (idempotent).' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async install(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.plugins.install(app, id));
  }

  @Patch(':id')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Enable/disable and/or reconfigure an installed plugin.',
    description:
      'Validates `config` against the plugin configSchema. For needsWorker ' +
      'plugins, enabling (re)starts the worker; disabling stops it.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async patch(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: PatchPluginDto,
  ) {
    return ok(
      await this.plugins.patch(app, id, {
        enabled: body.enabled,
        config: body.config,
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Uninstall a plugin (stops its worker).' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async remove(@Param('app') app: string, @Param('id') id: string) {
    await this.plugins.remove(app, id);
    return ok({ removed: true });
  }

  @Post(':id/worker/start')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Explicitly (re)start a plugin worker via the worker-hook.',
    description:
      'For needsWorker plugins only. Requires the plugin installed, enabled ' +
      'and with valid required config. Idempotent (returns the running state).',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async startWorker(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.plugins.startWorker(app, id));
  }

  @Post(':id/worker/stop')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Explicitly stop a plugin worker (no-op if idle).' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async stopWorker(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.plugins.stopWorker(app, id));
  }

  @Get(':id/worker/status')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Current worker state for a needsWorker plugin.' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async workerStatus(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.plugins.workerStatus(app, id));
  }

  @Post(':id/live')
  @Public()
  @ApiOperation({
    summary: "Worker live-data ingest (framework channel, ingest-token auth).",
    description:
      'Called by the plugin WORKER process (not by clients). Auth is NOT the ' +
      'Bearer guard: the worker echoes the per-start ingest token the ' +
      'worker-hook injected as STREAMHUB_INGEST_TOKEN via the ' +
      '`x-plugin-ingest-token` header — pushes without the CURRENT running ' +
      "worker's token are rejected. Body: a JSON object carrying `room` plus " +
      'the plugin-defined payload (size-capped). Stored in memory as the ' +
      'LATEST payload per (app, plugin, room) for GET :id/live.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async ingestLive(
    @Param('app') app: string,
    @Param('id') id: string,
    @Headers('x-plugin-ingest-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return ok(await this.plugins.ingestLive(app, id, token, body));
  }

  @Post(':id/events')
  @Public()
  @ApiOperation({
    summary:
      'Worker DOMAIN-EVENT ingest (framework channel, ingest-token auth).',
    description:
      'Called by the plugin WORKER process (not by clients). Same auth as ' +
      "POST :id/live: the per-start ingest token via `x-plugin-ingest-token` " +
      '(the worker-hook injects STREAMHUB_EVENTS_URL + STREAMHUB_INGEST_TOKEN). ' +
      'Body: { event, room?, data? }. The event name MUST be declared in the ' +
      "plugin manifest's `events` (spoof guard); accepted events are relayed " +
      "through the app's SIGNED callbacks funnel (webhook + MQTT) under that " +
      'name, with `plugin` and `room` merged into the payload.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  async ingestEvent(
    @Param('app') app: string,
    @Param('id') id: string,
    @Headers('x-plugin-ingest-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return ok(await this.plugins.ingestEvent(app, id, token, body));
  }

  @Get(':id/data')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary:
      'Latest worker live data for ANY installed plugin (authenticated).',
    description:
      'Dashboard counterpart of the public GET :id/live: app-tab/panel ' +
      'plugins (whose live data must NOT be public) read their worker feed ' +
      'here behind the Bearer guard. Returns { ts, ageMs, payload } (nulls ' +
      'when nothing was pushed yet); 404 when the plugin is not installed.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiQuery({ name: 'room', required: false, example: 'main' })
  async data(
    @Param('app') app: string,
    @Param('id') id: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.plugins.liveData(app, id, room ?? ''));
  }

  @Get(':id/live')
  @Public()
  @ApiOperation({
    summary:
      "Latest worker live data for an ENABLED player-overlay plugin (no auth).",
    description:
      'PUBLIC (no Bearer): polled by player overlays (incl. anonymous /play + ' +
      '/embed) to render live worker output — e.g. deface face boxes. Answers ' +
      'ONLY for installed + enabled `player-overlay` plugins (404 otherwise). ' +
      'Returns { ts, ageMs, payload } (nulls when nothing was pushed yet) so ' +
      'the client can apply its own staleness policy.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiQuery({ name: 'room', required: false, example: 'main' })
  async liveData(
    @Param('app') app: string,
    @Param('id') id: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.plugins.liveOverlayData(app, id, room ?? ''));
  }

  @Get(':id/live/state')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary:
      'Latest worker live data for the DASHBOARD (auth) — any needsWorker plugin.',
    description:
      'AUTHENTICATED counterpart of GET :id/live for app-tab/panel worker ' +
      'plugins whose live feed must not be public (e.g. the perimeter armed ' +
      'state + alert queue). Answers for any installed + enabled needsWorker ' +
      'plugin regardless of UI slot (404 otherwise). Returns { ts, ageMs, ' +
      'payload } (nulls when nothing was pushed yet).',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiQuery({ name: 'room', required: false, example: 'cam-1' })
  async liveState(
    @Param('app') app: string,
    @Param('id') id: string,
    @Query('room') room?: string,
  ) {
    return ok(await this.plugins.liveWorkerData(app, id, room ?? ''));
  }

  @Get(':id/logs')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Per-plugin logs (worker output + persisted).' })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiQuery({ name: 'limit', required: false, example: 200 })
  async logs(
    @Param('app') app: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Math.max(1, Math.min(1000, Number(limit) || 200)) : 200;
    return ok(await this.plugins.getLogs(app, id, n));
  }
}
