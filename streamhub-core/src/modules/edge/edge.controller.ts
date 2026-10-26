import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
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

import { DbService } from '../../shared/db/db.service';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeGateway } from './edge.gateway';
import { EdgeSchedulerService } from './edge-scheduler.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { NodeCommandDto } from './dto/node-command.dto';
import { PatchEdgeNodeDto } from './dto/patch-edge-node.dto';
import type { EdgeAssignment } from './edge.types';

/** A node dressed for the edge manager UI: registry row + live liveness + stats. */
export interface EdgeNodeView {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  type: 'common' | 'edge';
  weight: number;
  status: string;
  /** Live WS connection right now. */
  connected: boolean;
  /** Not connected AND not heartbeated within the stale window. */
  stale: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  /** Last telemetry/heartbeat stats blob (cpu/mem/disk/grid), or null. */
  stats: Record<string, unknown> | null;
}

/** Raw `nodes` row read by the manager surface. */
interface RawNodeRow {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  type: string | null;
  weight: number | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  stats_json: string | null;
}

/** A node is stale once unseen for longer than this (seconds). */
const STALE_AFTER_SECONDS = 90;

interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * VISION EDGE manager surface (`/api/v1/edge`, global-scope Bearer like the
 * cluster admin routes). Lists nodes with liveness + storage, retypes/weights
 * them, and drives assignments + node commands + remote log tails over the WS
 * channel ({@link EdgeGateway}).
 */
@ApiTags('edge')
@Controller('edge')
export class EdgeController {
  constructor(
    private readonly db: DbService,
    private readonly gateway: EdgeGateway,
    private readonly scheduler: EdgeSchedulerService,
    private readonly assignments: EdgeAssignmentsRepository,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
  ) {}

  // ---- nodes ---------------------------------------------------------------

  @Get('nodes')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List cluster nodes with type/weight, live WS liveness and last stats ' +
      '(cpu/mem/disk/grid). Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: EdgeNodeView[] }' })
  listNodes(@CurrentAuth() ctx?: AuthContext): Envelope<EdgeNodeView[]> {
    this.requireGlobal(ctx);
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, name, url, region, type, weight, status, created_at,
                last_seen_at, stats_json
           FROM nodes ORDER BY created_at ASC, name ASC`,
      )
      .all() as RawNodeRow[];
    return ok(rows.map((r) => this.nodeView(r)));
  }

  @Patch('nodes/:id')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The node id.' })
  @ApiOperation({
    summary: "Set a node's type ('common'|'edge') and/or scheduling weight. Global-scope.",
  })
  @ApiOkResponse({ description: '{ data: EdgeNodeView } — the updated node.' })
  patchNode(
    @Param('id') id: string,
    @Body() dto: PatchEdgeNodeDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<EdgeNodeView> {
    this.requireGlobal(ctx);
    const db = this.db.global();
    const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id);
    if (!exists) throw new NotFoundException({ error: 'unknown node' });

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (dto.type !== undefined) {
      sets.push('type = ?');
      vals.push(dto.type);
    }
    if (dto.weight !== undefined) {
      sets.push('weight = ?');
      vals.push(dto.weight);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    const row = db
      .prepare(
        `SELECT id, name, url, region, type, weight, status, created_at,
                last_seen_at, stats_json FROM nodes WHERE id = ?`,
      )
      .get(id) as RawNodeRow;
    return ok(this.nodeView(row));
  }

  @Post('nodes/:id/command')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The node id.' })
  @ApiOperation({
    summary:
      'Send a command (restart|reboot|ping) to a connected node over the WS ' +
      'channel and await its result. 503 if the node is not connected, 504 on ' +
      'timeout. Audited. Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: { ok, output? } }' })
  async command(
    @Param('id') id: string,
    @Body() dto: NodeCommandDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<{ ok: boolean; output?: string }>> {
    this.requireGlobal(ctx);
    this.logs?.write('info', 'edge', `node command '${dto.command}'`, {
      nodeId: id,
      command: dto.command,
      by: ctx?.userId ?? 'unknown',
    });
    const result = await this.gateway.command(id, dto.command, dto.args);
    return ok(result);
  }

  @Get('nodes/:id/logs')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The node id.' })
  @ApiQuery({ name: 'lines', required: false, description: 'Tail length (default 200).' })
  @ApiOperation({
    summary:
      'Tail a connected node\'s edge-runtime log over the WS channel (5s timeout). ' +
      '503 if not connected, 504 on timeout. Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: { lines: string[] } }' })
  async logs_(
    @Param('id') id: string,
    @Query('lines') lines?: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<{ lines: string[] }>> {
    this.requireGlobal(ctx);
    const n = Math.min(Math.max(Number.parseInt(lines ?? '200', 10) || 200, 1), 2000);
    const out = await this.gateway.logTail(id, n, 5000);
    return ok({ lines: out });
  }

  // ---- assignments ---------------------------------------------------------

  @Get('assignments')
  @ApiBearerAuth()
  @ApiQuery({ name: 'app', required: false, description: 'Filter by app slug.' })
  @ApiOperation({ summary: 'List edge assignments (optionally by app). Global-scope.' })
  @ApiOkResponse({ description: '{ data: EdgeAssignment[] }' })
  listAssignments(
    @Query('app') app?: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<EdgeAssignment[]> {
    this.requireGlobal(ctx);
    return ok(this.assignments.list(app || undefined));
  }

  @Post('assignments')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Schedule a worker workload (app × plugin [× stream]) onto an edge node ' +
      '(pushed over WS; parked pending when no node is eligible). Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: EdgeAssignment }' })
  createAssignment(
    @Body() dto: CreateAssignmentDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<EdgeAssignment> {
    this.requireGlobal(ctx);
    const assignment = this.scheduler.schedule({
      app: dto.app,
      pluginId: dto.pluginId,
      streamId: dto.streamId ?? null,
      config: dto.config,
      policy: dto.policy,
    });
    return ok(assignment);
  }

  @Delete('assignments/:id')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The assignment id.' })
  @ApiOperation({ summary: 'Revoke an assignment (told to the node, then marked revoked). Global-scope.' })
  @ApiOkResponse({ description: '{ data: { id, revoked: true } }' })
  revokeAssignment(
    @Param('id') id: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ id: string; revoked: true }> {
    this.requireGlobal(ctx);
    const revoked = this.scheduler.revoke(id);
    if (!revoked) throw new NotFoundException({ error: 'unknown assignment' });
    return ok({ id, revoked: true as const });
  }

  // ---- internals -----------------------------------------------------------

  private nodeView(r: RawNodeRow): EdgeNodeView {
    const connected = this.gateway.isConnected(r.id);
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      region: r.region,
      type: r.type === 'edge' ? 'edge' : 'common',
      weight: typeof r.weight === 'number' ? r.weight : 100,
      status: r.status,
      connected,
      stale: !connected && this.isStale(r.last_seen_at),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      stats: this.parseStats(r.stats_json),
    };
  }

  private isStale(lastSeenAt: string | null): boolean {
    if (!lastSeenAt) return true;
    const t = Date.parse(lastSeenAt.replace(' ', 'T') + 'Z');
    if (Number.isNaN(t)) return true;
    return Date.now() - t > STALE_AFTER_SECONDS * 1000;
  }

  private parseStats(json: string | null): Record<string, unknown> | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** Reject app-scoped principals from the global surface (no-op in dev). */
  private requireGlobal(ctx?: AuthContext): void {
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException(
        'this endpoint requires a global-scope credential',
      );
    }
  }
}
