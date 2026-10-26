import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import {
  CreateWorkflowDto,
  EnableWorkflowDto,
  ImportWorkflowDto,
  ManualRunDto,
  PutSecretDto,
  UpdateWorkflowDto,
} from './dto/workflow.dto';
import { StreamflowSecretsService } from './streamflow-secrets.service';
import { StreamflowService } from './streamflow.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Streamflow plugin API (module `streamflow`). Mounted at
 * `/apps/:app/plugins/streamflow/...` — concrete `streamflow` segment + distinct
 * sub-paths (`workflows`, `runs`, `boxes`), exactly like the fleet controller
 * (this plugin has no worker, so it does not use the generic PluginsController
 * `:id/data` routes). Auth: the global Bearer guard + @RequirePermission on the
 * app-config resource.
 */
@ApiTags('streamflow')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/plugins/streamflow')
export class StreamflowController {
  constructor(
    private readonly streamflow: StreamflowService,
    private readonly secrets: StreamflowSecretsService,
  ) {}

  // --- Box palette ------------------------------------------------------------

  @Get('boxes')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Box-type catalogue (palette + config schema) for the UI.' })
  @ApiOkResponse({ description: 'The full box catalogue (execution boxes gated by config).' })
  boxes(@Param('app') app: string) {
    return ok(this.streamflow.boxes(app));
  }

  @Get('events')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Event catalogue (known trigger events by family) for the UI.' })
  @ApiOkResponse({ description: 'Grouped, scoped event families.' })
  events() {
    return ok(this.streamflow.events());
  }

  // --- Workflows CRUD ---------------------------------------------------------

  @Get('workflows')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'List this app’s workflows.' })
  async listWorkflows(@Param('app') app: string) {
    return ok(await this.streamflow.listWorkflows(app));
  }

  @Post('workflows')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Create a workflow.' })
  async createWorkflow(@Param('app') app: string, @Body() body: CreateWorkflowDto) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) throw new BadRequestException("body must carry a 'name'");
    return ok(
      await this.streamflow.createWorkflow(app, {
        name,
        enabled: body.enabled,
        graph: body.graph,
      }),
    );
  }

  @Post('workflows/import')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Import a workflow from portable JSON (validated).' })
  async importWorkflow(@Param('app') app: string, @Body() body: ImportWorkflowDto) {
    if (!body?.workflow || typeof body.workflow !== 'object') {
      throw new BadRequestException("body must carry a 'workflow' object");
    }
    return ok(await this.streamflow.importWorkflow(app, body.workflow, body.name));
  }

  @Get('workflows/:id')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Get one workflow (with its graph).' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async getWorkflow(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.streamflow.getWorkflow(app, id));
  }

  @Get('workflows/:id/export')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'Export a workflow as portable JSON (secret-safe).' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async exportWorkflow(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.streamflow.exportWorkflow(app, id));
  }

  @Put('workflows/:id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Update a workflow (name / enabled / graph).' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async updateWorkflow(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: UpdateWorkflowDto,
  ) {
    return ok(
      await this.streamflow.updateWorkflow(app, id, {
        name: body.name,
        enabled: body.enabled,
        graph: body.graph,
      }),
    );
  }

  @Delete('workflows/:id')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Delete a workflow (and its run history).' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async deleteWorkflow(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.streamflow.deleteWorkflow(app, id));
  }

  @Post('workflows/:id/enable')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Enable/disable a workflow.' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async enableWorkflow(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: EnableWorkflowDto,
  ) {
    return ok(await this.streamflow.setEnabled(app, id, body?.enabled !== false));
  }

  @Post('workflows/:id/run')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Run a workflow manually (optional payload).' })
  @ApiParam({ name: 'id', description: 'Workflow id.' })
  async runWorkflow(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() body: ManualRunDto,
  ) {
    return ok(await this.streamflow.manualRun(app, id, body?.payload));
  }

  // --- Runs -------------------------------------------------------------------

  @Get('runs')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'List recent runs (optionally filtered by workflow).' })
  async listRuns(
    @Param('app') app: string,
    @Query('workflowId') workflowId?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    return ok(
      await this.streamflow.listRuns(app, {
        workflowId: workflowId?.trim() || undefined,
        limit: Number.isFinite(lim) ? lim : undefined,
      }),
    );
  }

  @Get('runs/:id')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'One run with its per-box steps.' })
  @ApiParam({ name: 'id', description: 'Run id.' })
  async getRun(@Param('app') app: string, @Param('id') id: string) {
    return ok(await this.streamflow.getRun(app, id));
  }

  // --- Secrets (write-only; values NEVER returned) ----------------------------

  @Get('secrets')
  @RequirePermission('config', 'read')
  @ApiOperation({ summary: 'List secret NAMES + masked hint (never the value).' })
  async listSecrets(@Param('app') app: string) {
    return ok(await this.secrets.list(app));
  }

  @Put('secrets/:name')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Create/replace a secret value (encrypted at rest).' })
  @ApiParam({ name: 'name', description: 'Secret name (UPPER_SNAKE_CASE).' })
  async putSecret(
    @Param('app') app: string,
    @Param('name') name: string,
    @Body() body: PutSecretDto,
  ) {
    return ok(await this.secrets.put(app, name, body?.value));
  }

  @Delete('secrets/:name')
  @RequirePermission('config', 'write')
  @ApiOperation({ summary: 'Delete a secret.' })
  @ApiParam({ name: 'name', description: 'Secret name.' })
  async deleteSecret(@Param('app') app: string, @Param('name') name: string) {
    return ok(await this.secrets.remove(app, name));
  }
}
