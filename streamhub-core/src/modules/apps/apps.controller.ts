import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Optional,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBadRequestResponse,
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

import { AppConfig, AppRecord } from '../../shared/contracts';
import { AppSizes, DbSizesService } from '../../shared/db/db-sizes.service';
import {
  AuthContext,
  CurrentAuth,
  PLATFORM_TENANT_ID,
} from '../../shared/auth-context';
import {
  actorFromCtx,
  AuditService,
  requestIp,
} from '../audit/audit.service';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';
import {
  ApplyPresetResult,
  AppsService,
  ConfigBackup,
  ConfigDryRun,
  ConfigPresetInfo,
  MaskedMqtt,
  MaskedS3,
  MaskedSmtp,
  ReloadResult,
} from './apps.service';
import { CreateAppDto } from './dto/create-app.dto';
import { PutRawConfigDto } from './dto/raw-config.dto';
import { SetMqttDto } from './dto/set-mqtt.dto';
import { SetS3Dto } from './dto/set-s3.dto';
import { SetSmtpDto } from './dto/set-smtp.dto';
import { UpdateAppConfigDto } from './dto/update-app-config.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * CRUD apps (SPEC §6 global).
 *
 * `GET/POST /apps`, `GET/DELETE/PATCH /apps/:name`. Creating an app scaffolds
 * its directory, config.yaml, vods.db and sample pages (SPEC §3). PATCH edits
 * the app's config.yaml (SPEC §7). Auth is enforced by the global auth guard;
 * these routes are not marked public.
 */
@ApiTags('apps')
@ApiBearerAuth()
@Controller('apps')
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly quotas: QuotasService,
    private readonly sizes: DbSizesService,
    /** Security audit trail (ISO 8.15) — optional for bare-ctor unit specs. */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** Append a config/lifecycle change to the security audit trail. */
  private auditChange(
    action: string,
    app: string,
    req: Request | undefined,
    ctx: AuthContext | undefined,
    meta?: Record<string, unknown>,
  ): void {
    this.audit?.record({
      action,
      ...actorFromCtx(ctx),
      targetType: 'app',
      targetId: app,
      ip: requestIp(req),
      meta: meta ?? null,
    });
  }

  @Get()
  @RequirePermission('app', 'read')
  @ApiOperation({
    summary:
      'List apps visible to the caller (own tenant; superadmin/global sees all).',
  })
  @ApiOkResponse({ description: 'Array of app records.' })
  list(@CurrentAuth() ctx?: AuthContext): Promise<AppRecord[]> {
    return this.apps.list(ctx);
  }

  @Post()
  @RequirePermission('app', 'create')
  @ApiOperation({
    summary: 'Create an app: scaffolds dirs/config.yaml/vods.db + sample pages.',
  })
  @ApiCreatedResponse({ description: 'The created app record.' })
  async create(
    @Body() dto: CreateAppDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<AppRecord> {
    // Quota: tenant must be under max_apps (phased; bypass for superadmin/token).
    await this.quotas.enforceCreateApp(ctx);
    // Stamp the owning tenant so the app is scoped to its creator. Superadmin /
    // global creds (and the token/service plane) own apps at the platform tenant.
    const tenantId =
      !ctx || ctx.isSuperadmin || ctx.scope === 'global'
        ? PLATFORM_TENANT_ID
        : ctx.tenantId ?? PLATFORM_TENANT_ID;
    const created = await this.apps.create({
      name: dto.name,
      displayName: dto.displayName,
      roomPrefix: dto.roomPrefix,
      tenantId,
    });
    this.auditChange('app.create', dto.name, req, ctx, { tenantId });
    return created;
  }

  @Get(':name')
  @RequirePermission('app', 'read')
  @ApiOperation({ summary: 'Get one app by name.' })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'The app record.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async get(@Param('name') name: string): Promise<AppRecord> {
    const app = await this.apps.get(name);
    if (!app) throw new NotFoundException(`app "${name}" not found`);
    return app;
  }

  @Get(':name/sizes')
  @RequirePermission('app', 'read')
  @ApiOperation({
    summary: "This app's storage footprint: app.db size + total VOD bytes.",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: AppSizes } — dbSizeBytes + vodTotalBytes/vodCount.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async getSizes(@Param('name') name: string): Promise<Envelope<AppSizes>> {
    const app = await this.apps.get(name);
    if (!app) throw new NotFoundException(`app "${name}" not found`);
    return ok(this.sizes.appSizes(name));
  }

  @Patch(':name')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: "Edit an app's config.yaml; returns the merged resolved config.",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Merged app config.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async patch(
    @Param('name') name: string,
    @Body() dto: UpdateAppConfigDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<AppConfig> {
    const merged = await this.apps.updateConfig(name, this.toConfigPatch(dto));
    // Field NAMES only — values may carry secrets (e.g. callbackSecret).
    this.auditChange('config.update', name, req, ctx, {
      via: 'PATCH /apps/:name',
      fields: Object.keys(this.toConfigPatch(dto)),
    });
    // Never return the resolved MQTT broker password in clear (masked-on-read
    // like the S3 credentials; the full value stays in data/secrets.json).
    return merged.mqtt
      ? {
          ...merged,
          mqtt: { ...merged.mqtt, password: merged.mqtt.password ? '****' : '' },
        }
      : merged;
  }

  @Delete(':name')
  @RequirePermission('app', 'delete')
  @ApiOperation({
    summary: 'Delete an app. Optionally purge its VODs/local files.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiQuery({
    name: 'deleteVods',
    required: false,
    type: Boolean,
    description: 'If true, also delete the app VODs and local files.',
  })
  @ApiNoContentResponse({ description: 'App deleted.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async remove(
    @Param('name') name: string,
    @Query('deleteVods', new ParseBoolPipe({ optional: true }))
    deleteVods?: boolean,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<{ deleted: true; name: string }> {
    await this.apps.delete(name, { deleteVods: deleteVods === true });
    this.auditChange('app.delete', name, req, ctx, {
      deleteVods: deleteVods === true,
    });
    return { deleted: true, name };
  }

  // ---------------------------------------------------------------------------
  // Wave-4 §1 — raw config editor + hot-reload
  // ---------------------------------------------------------------------------

  @Get(':name/config/raw')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Raw config.yaml of the app (wave-4 §1).' })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: { yaml } } — raw YAML text.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async getRawConfig(
    @Param('name') name: string,
  ): Promise<Envelope<{ yaml: string }>> {
    return ok({ yaml: await this.apps.getRawConfig(name) });
  }

  @Put(':name/config/raw')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      'Validate + backup + write config.yaml then hot-reload the app (wave-4 §1, fold-2 backup). 400 on parse error (no write).',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: { reloaded, warnings } }.' })
  @ApiBadRequestResponse({ description: 'YAML parse/shape error — not written.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async putRawConfig(
    @Param('name') name: string,
    @Body() dto: PutRawConfigDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<ReloadResult>> {
    const result = await this.apps.putRawConfig(name, dto.yaml);
    // Size only — raw YAML may embed secrets, so it never enters the trail.
    this.auditChange('config.update', name, req, ctx, {
      via: 'PUT /apps/:name/config/raw',
      bytes: dto.yaml.length,
    });
    return ok(result);
  }

  // --- Fold-2: dry-run validate + backups + revert -------------------------

  @Post(':name/config/raw/validate')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary:
      'Fold-2 dry-run: validate proposed config.yaml + return the diff vs current, WITHOUT writing.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({
    description: '{ data: { valid, warnings, error, diff, changed } }.',
  })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async validateRawConfig(
    @Param('name') name: string,
    @Body() dto: PutRawConfigDto,
  ): Promise<Envelope<ConfigDryRun>> {
    return ok(await this.apps.dryRunRawConfig(name, dto.yaml));
  }

  @Get(':name/config/backups')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Fold-2: list timestamped config backups (newest first).' })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: ConfigBackup[] }.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async listConfigBackups(
    @Param('name') name: string,
  ): Promise<Envelope<ConfigBackup[]>> {
    return ok(await this.apps.listConfigBackups(name));
  }

  @Get(':name/config/backups/:ts')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: "Fold-2: read one backup's verbatim config.yaml (for preview/diff).",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiParam({ name: 'ts', description: 'Backup id (the <ts> token).' })
  @ApiOkResponse({ description: '{ data: { yaml } } — backup YAML text.' })
  @ApiNotFoundResponse({ description: 'App or backup not found.' })
  async getConfigBackup(
    @Param('name') name: string,
    @Param('ts') ts: string,
  ): Promise<Envelope<{ yaml: string }>> {
    return ok({ yaml: await this.apps.readConfigBackup(name, ts) });
  }

  @Post(':name/config/backups/:ts/revert')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      'Fold-2: restore a backup as the live config.yaml + hot-reload (current is backed up first).',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiParam({ name: 'ts', description: 'Backup id (the <ts> token).' })
  @ApiOkResponse({ description: '{ data: { reloaded, warnings } }.' })
  @ApiNotFoundResponse({ description: 'App or backup not found.' })
  async revertConfigBackup(
    @Param('name') name: string,
    @Param('ts') ts: string,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<ReloadResult>> {
    const result = await this.apps.revertConfigBackup(name, ts);
    this.auditChange('config.revert', name, req, ctx, { backup: ts });
    return ok(result);
  }

  @Post(':name/reload')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      'Hot-reload an app: re-read config + re-init its S3 client, without restarting the process (wave-4 §1).',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: { reloaded, warnings } }.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async reload(@Param('name') name: string): Promise<Envelope<ReloadResult>> {
    return ok(await this.apps.reload(name));
  }

  // ---------------------------------------------------------------------------
  // G4 — config presets (declarative delivery/quality profiles)
  // ---------------------------------------------------------------------------

  @Get(':name/presets')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary:
      'List the built-in config presets (low-latency / high-quality-recording / mass-audience-HLS / rtmp-passthrough), each flagged `applied` when its keys currently match the app config.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: '{ data: ConfigPresetInfo[] }.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async listPresets(
    @Param('name') name: string,
  ): Promise<Envelope<ConfigPresetInfo[]>> {
    return ok(await this.apps.listConfigPresets(name));
  }

  @Post(':name/presets/:preset/apply')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      "Apply a config preset to the app's config.yaml (deep-merge + backup + hot-reload). Never overwrites S3 credentials/secrets. Returns the diff.",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiParam({
    name: 'preset',
    example: 'low-latency',
    description: 'low-latency | high-quality-recording | mass-audience-HLS | rtmp-passthrough',
  })
  @ApiOkResponse({
    description: '{ data: { preset, applied, reloaded, changed, diff, warnings } }.',
  })
  @ApiNotFoundResponse({ description: 'App or preset not found.' })
  async applyPreset(
    @Param('name') name: string,
    @Param('preset') preset: string,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<ApplyPresetResult>> {
    const result = await this.apps.applyConfigPreset(name, preset);
    this.auditChange('config.preset_apply', name, req, ctx, { preset });
    return ok(result);
  }

  @Post(':name/presets/:preset/deactivate')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      "Deactivate a config preset: reverts every key it sets to the app's factory default (backup + hot-reload). Keys with no factory default (distribution/hls) are removed. Never touches S3 credentials/secrets.",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiParam({
    name: 'preset',
    example: 'low-latency',
    description: 'low-latency | high-quality-recording | mass-audience-HLS | rtmp-passthrough',
  })
  @ApiOkResponse({
    description: '{ data: { preset, applied: false, reloaded, changed, diff, warnings } }.',
  })
  @ApiNotFoundResponse({ description: 'App or preset not found.' })
  async deactivatePreset(
    @Param('name') name: string,
    @Param('preset') preset: string,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<ApplyPresetResult>> {
    const result = await this.apps.deactivateConfigPreset(name, preset);
    this.auditChange('config.preset_deactivate', name, req, ctx, { preset });
    return ok(result);
  }

  // ---------------------------------------------------------------------------
  // Wave-4 §2 — S3 config setter / masked getter
  // ---------------------------------------------------------------------------

  @Get(':name/s3')
  @RequirePermission('s3', 'read')
  @ApiOperation({ summary: 'Get the app S3 config (credentials masked) (wave-4 §2).' })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked S3 config.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async getS3(@Param('name') name: string): Promise<Envelope<MaskedS3>> {
    return ok(await this.apps.getS3(name));
  }

  @Put(':name/s3')
  @RequirePermission('s3', 'write')
  @ApiOperation({
    summary:
      'Set the app S3 block in config.yaml + key/secret in secrets.json, then re-init the S3 client (wave-4 §2). Fold-3: enabling public_url needs confirmPublic=true.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked S3 config after the update.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async setS3(
    @Param('name') name: string,
    @Body() dto: SetS3Dto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<MaskedS3>> {
    const masked = await this.apps.setS3(name, dto);
    // Secret change (ISO 8.15) — never the credentials themselves.
    this.auditChange('s3.update', name, req, ctx, {
      bucket: dto.bucket,
      endpoint: dto.endpoint ?? null,
    });
    return ok(masked);
  }

  // ---------------------------------------------------------------------------
  // MQTT config setter / masked getter (per-app MQTT event publishing)
  // ---------------------------------------------------------------------------

  @Get(':name/mqtt')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Get the app MQTT config (broker password masked).',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked MQTT config (+ latencyAlert block).' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async getMqtt(@Param('name') name: string): Promise<Envelope<MaskedMqtt>> {
    return ok(await this.apps.getMqtt(name));
  }

  @Put(':name/mqtt')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      'Set the app MQTT block in config.yaml + broker password in secrets.json, then reconnect the MQTT client. Omit password to keep the stored one.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked MQTT config after the update.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async setMqtt(
    @Param('name') name: string,
    @Body() dto: SetMqttDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<MaskedMqtt>> {
    const masked = await this.apps.setMqtt(name, dto);
    // Secret change (ISO 8.15) — never the broker password itself.
    this.auditChange('mqtt.update', name, req, ctx, {
      url: dto.url ?? null,
    });
    return ok(masked);
  }

  // ---------------------------------------------------------------------------
  // SMTP config setter / masked getter (owner item 29 — per-app SMTP override)
  // ---------------------------------------------------------------------------

  @Get(':name/smtp')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Get the app SMTP config (password masked).',
    description:
      "App-scoped notifications use this SMTP when enabled, falling back to " +
      "the global STREAMHUB_SMTP_* env — unless a per-user override applies " +
      "(precedence: user > app > global). Test with POST :name/smtp/test.",
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked SMTP config.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async getSmtp(@Param('name') name: string): Promise<Envelope<MaskedSmtp>> {
    return ok(await this.apps.getSmtp(name));
  }

  @Put(':name/smtp')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary:
      'Set the app SMTP block in config.yaml + password in secrets.json. Omit pass to keep the stored one.',
  })
  @ApiParam({ name: 'name', example: 'live' })
  @ApiOkResponse({ description: 'Masked SMTP config after the update.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async setSmtp(
    @Param('name') name: string,
    @Body() dto: SetSmtpDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<MaskedSmtp>> {
    const masked = await this.apps.setSmtp(name, dto);
    // Secret change (ISO 8.15) — never the password itself.
    this.auditChange('smtp.update', name, req, ctx, {
      host: dto.host ?? null,
      enabled: dto.enabled ?? null,
    });
    return ok(masked);
  }

  /** Map the flat UpdateAppConfigDto into a structured Partial<AppConfig>. */
  private toConfigPatch(dto: UpdateAppConfigDto): Partial<AppConfig> {
    const patch: Partial<AppConfig> = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.roomPrefix !== undefined) patch.roomPrefix = dto.roomPrefix;
    if (dto.timezone !== undefined) patch.timezone = dto.timezone.trim();
    if (
      dto.recordingEnabled !== undefined ||
      dto.splitMinutes !== undefined ||
      dto.snapshotSeconds !== undefined ||
      dto.filenameTemplate !== undefined ||
      dto.snapshotTemplate !== undefined ||
      dto.retentionDays !== undefined
    ) {
      patch.recording = {
        ...(dto.recordingEnabled !== undefined
          ? { enabled: dto.recordingEnabled }
          : {}),
        ...(dto.splitMinutes !== undefined
          ? { splitMinutes: dto.splitMinutes }
          : {}),
        ...(dto.snapshotSeconds !== undefined
          ? { snapshotSeconds: dto.snapshotSeconds }
          : {}),
        ...(dto.filenameTemplate !== undefined
          ? { filenameTemplate: dto.filenameTemplate }
          : {}),
        ...(dto.snapshotTemplate !== undefined
          ? { snapshotTemplate: dto.snapshotTemplate }
          : {}),
        ...(dto.retentionDays !== undefined
          ? { retentionDays: dto.retentionDays }
          : {}),
      } as AppConfig['recording'];
    }
    if (dto.rtmpPassthrough !== undefined) {
      patch.rtmp = { passthrough: dto.rtmpPassthrough } as AppConfig['rtmp'];
    }
    if (dto.transcodeMaxHeight !== undefined) {
      // Only the cap; AppsService merges the rest of the webrtc block.
      patch.webrtc = {
        transcodeMaxHeight: dto.transcodeMaxHeight,
      } as AppConfig['webrtc'];
    }
    if (dto.callbackUrl !== undefined || dto.callbackSecret !== undefined) {
      patch.callbacks = {
        ...(dto.callbackUrl !== undefined ? { url: dto.callbackUrl } : {}),
        ...(dto.callbackSecret !== undefined
          ? { secret: dto.callbackSecret }
          : {}),
      } as AppConfig['callbacks'];
    }
    if (dto.features !== undefined) {
      // Pass through only the provided flags; AppsService merges the rest.
      patch.features = { ...dto.features } as AppConfig['features'];
    }
    if (dto.variables !== undefined) {
      patch.variables = { ...dto.variables };
    }
    return patch;
  }
}
