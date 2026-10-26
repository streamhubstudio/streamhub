/**
 * GRID AGENT controller (node side) — the endpoint the ORIGIN calls to run an
 * offloaded plugin worker on THIS node (StreamHub Grid, GRID-1/2).
 *
 * Base `/grid` → `/api/v1/grid/*`. Every route is @Public() to the global
 * Bearer guard and instead authenticates MANUALLY against the shared
 * `STREAMHUB_CLUSTER_TOKEN` via the `X-Cluster-Token` header (timing-safe,
 * same gate as cluster join/heartbeat). Spawning a process from the request
 * body is an RCE surface by design — it is trusted ONLY because a valid
 * cluster token proves the caller is the origin; inputs are still validated.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import { Public } from '../../shared/auth';
import { assertClusterToken } from '../cluster/cluster-token.util';
import { GridWorkerDto } from './dto/grid-worker.dto';
import { GridAgentService, GridWorkerView } from './grid-agent.service';
import { WorkerLogLine } from './plugin-worker.manager';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

const GRID_DISABLED =
  'grid agent disabled (STREAMHUB_CLUSTER_TOKEN unset)';

@ApiTags('grid')
@Controller('grid')
export class GridAgentController {
  constructor(
    private readonly config: ConfigService,
    private readonly agent: GridAgentService,
  ) {}

  @Public()
  @Post('workers')
  @ApiOperation({
    summary:
      'Run an offloaded plugin worker on this node (X-Cluster-Token). Body is ' +
      'a resolved spawn spec { pluginId, appName, command, args, env, ' +
      'ingestToken }. Returns { id, status, ... }.',
  })
  @ApiOkResponse({ description: '{ data: GridWorkerView }' })
  createWorker(
    @Body() dto: GridWorkerDto,
    @Req() req: Request,
  ): Envelope<GridWorkerView> {
    assertClusterToken(req, this.config.clusterToken, GRID_DISABLED);
    return ok(this.agent.spawn(dto));
  }

  @Public()
  @Get('workers/:id/status')
  @ApiParam({ name: 'id', description: 'The remote worker id.' })
  @ApiOperation({
    summary: 'Status of a dispatched worker (X-Cluster-Token). 404 if unknown.',
  })
  @ApiOkResponse({ description: '{ data: GridWorkerView }' })
  status(
    @Param('id') id: string,
    @Req() req: Request,
  ): Envelope<GridWorkerView> {
    assertClusterToken(req, this.config.clusterToken, GRID_DISABLED);
    return ok(this.agent.status(id));
  }

  @Public()
  @Post('workers/:id/stop')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', description: 'The remote worker id.' })
  @ApiOperation({
    summary: 'Stop a dispatched worker (X-Cluster-Token). 404 if unknown.',
  })
  @ApiOkResponse({ description: '{ data: GridWorkerView }' })
  stop(
    @Param('id') id: string,
    @Req() req: Request,
  ): Envelope<GridWorkerView> {
    assertClusterToken(req, this.config.clusterToken, GRID_DISABLED);
    return ok(this.agent.stop(id));
  }

  @Public()
  @Get('workers/:id/logs')
  @ApiParam({ name: 'id', description: 'The remote worker id.' })
  @ApiOperation({
    summary:
      'Recent stdout/stderr of a dispatched worker (X-Cluster-Token). 404 if ' +
      'unknown.',
  })
  @ApiOkResponse({ description: '{ data: WorkerLogLine[] }' })
  logs(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('limit') limit?: string,
  ): Envelope<WorkerLogLine[]> {
    assertClusterToken(req, this.config.clusterToken, GRID_DISABLED);
    const n = limit ? Math.max(1, Math.min(1000, Number(limit) || 200)) : 200;
    return ok(this.agent.logs(id, n));
  }
}
