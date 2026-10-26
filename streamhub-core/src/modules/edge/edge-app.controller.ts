import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { CreateAppAssignmentDto } from './dto/create-app-assignment.dto';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeSchedulerService } from './edge-scheduler.service';
import type { EdgeAssignment } from './edge.types';

interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * APP-SCOPED edge assignments API (`/apps/:app/edge/assignments`) — the generic
 * per-app surface for scheduling ANY edge-capable plugin's worker onto edge
 * nodes. Distinct from the GLOBAL superadmin `/edge/assignments` (EdgeController):
 * this one is app-scoped (RBAC via @RequirePermission on the app-config
 * resource, exactly like the plugin API) and validates that the plugin is
 * INSTALLED in the app AND its meta declares `worker.edge === true`.
 */
@ApiTags('edge')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/edge')
export class EdgeAppController {
  constructor(
    private readonly scheduler: EdgeSchedulerService,
    private readonly assignments: EdgeAssignmentsRepository,
    private readonly registry: PluginRegistryService,
    private readonly installs: AppPluginsRepository,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  @Get('assignments')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: "List this app's edge assignments." })
  @ApiOkResponse({ description: '{ data: EdgeAssignment[] }' })
  async list(@Param('app') app: string): Promise<Envelope<EdgeAssignment[]>> {
    await this.requireApp(app);
    return ok(this.assignments.list(app));
  }

  @Post('assignments')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Schedule an edge-capable plugin workload (app × plugin [× stream]) onto an edge node.',
    description:
      'Body: { pluginId, streamId?, config?, policy? }. The plugin must be ' +
      'installed in the app and declare worker.edge===true. Parked pending when ' +
      'no node is eligible.',
  })
  @ApiOkResponse({ description: '{ data: EdgeAssignment }' })
  async create(
    @Param('app') app: string,
    @Body() dto: CreateAppAssignmentDto,
  ): Promise<Envelope<EdgeAssignment>> {
    await this.requireApp(app);
    this.requireEdgePlugin(app, dto.pluginId);
    const assignment = this.scheduler.schedule({
      app,
      pluginId: dto.pluginId,
      streamId: dto.streamId ?? null,
      config: dto.config ?? {},
      policy: dto.policy,
    });
    return ok(assignment);
  }

  @Delete('assignments/:id')
  @RequirePermission('config', 'write')
  @ApiParam({ name: 'id', description: 'The assignment id.' })
  @ApiOperation({ summary: 'Revoke one of this app’s edge assignments.' })
  @ApiOkResponse({ description: '{ data: { id, revoked: true } }' })
  async revoke(
    @Param('app') app: string,
    @Param('id') id: string,
  ): Promise<Envelope<{ id: string; revoked: true }>> {
    await this.requireApp(app);
    const existing = this.assignments.get(id);
    if (!existing || existing.app !== app) {
      throw new NotFoundException('unknown assignment for this app');
    }
    const revoked = this.scheduler.revoke(id);
    if (!revoked) throw new NotFoundException('unknown assignment for this app');
    return ok({ id, revoked: true as const });
  }

  // ---- internals -----------------------------------------------------------

  private async requireApp(app: string): Promise<void> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
  }

  /** The plugin must be installed in the app AND declare worker.edge===true. */
  private requireEdgePlugin(app: string, pluginId: string): void {
    const meta = this.registry.getMeta(pluginId);
    if (!meta) throw new NotFoundException(`plugin '${pluginId}' not found`);
    if (meta.worker?.edge !== true) {
      throw new BadRequestException(
        `plugin '${pluginId}' is not edge-capable (worker.edge)`,
      );
    }
    if (!this.installs.get(app, pluginId)) {
      throw new BadRequestException(
        `plugin '${pluginId}' is not installed in app '${app}'`,
      );
    }
  }
}
