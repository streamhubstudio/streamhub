import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { Public } from '../../shared/auth';
import {
  ClusterInfo,
  ClusterService,
  JoinPayload,
  NodeRow,
} from './cluster.service';
import { JoinNodeDto } from './dto/join-node.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { PatchNodeDto } from './dto/patch-node.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Cluster / edge-node registration (one-liner installer).
 *
 * `/join` and `/heartbeat` are @Public() to the global Bearer guard and instead
 * authenticate MANUALLY against `STREAMHUB_CLUSTER_TOKEN` via the
 * `X-Cluster-Token` header (timing-safe). `/nodes` is a normal authenticated,
 * global-scope admin surface (like /stats, /admin) that lists the registry.
 */
@ApiTags('cluster')
@Controller('cluster')
export class ClusterController {
  constructor(
    private readonly config: ConfigService,
    private readonly cluster: ClusterService,
  ) {}

  @Public()
  @Post('join')
  @ApiOperation({
    summary:
      'Register an edge node (X-Cluster-Token). Returns the bootstrap config ' +
      '(Redis, public ws, LiveKit keys). Idempotent by node name.',
  })
  @ApiOkResponse({ description: '{ data: { nodeId, name, redisUrl, ... } }' })
  join(
    @Body() dto: JoinNodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Envelope<JoinPayload> {
    this.assertClusterToken(req);
    const { created, payload } = this.cluster.join(dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return ok(payload);
  }

  @Public()
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Node liveness ping (X-Cluster-Token). Marks the node active and stores ' +
      'the optional `stats` blob (~4KB). 404 if the node is unknown.',
  })
  @ApiOkResponse({ description: '{ data: { ok: true } }' })
  heartbeat(
    @Body() dto: HeartbeatDto,
    @Req() req: Request,
  ): Envelope<{ ok: true }> {
    this.assertClusterToken(req);
    this.cluster.heartbeat(dto.nodeId, dto.stats);
    return ok({ ok: true as const });
  }

  @Get('info')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cluster overview for the dashboard manager: enabled flag, node count, ' +
      'cluster token + redis, and the ready-to-copy join one-liner. ' +
      'Global-scope (superadmin) surface.',
  })
  @ApiOkResponse({ description: '{ data: ClusterInfo }' })
  info(@CurrentAuth() ctx?: AuthContext): Envelope<ClusterInfo> {
    this.requireGlobal(ctx);
    return ok(this.cluster.info());
  }

  @Get('nodes')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List registered cluster nodes (parsed stats + derived `stale`). ' +
      'Requires a global-scope token (admin surface, like /stats).',
  })
  @ApiOkResponse({ description: '{ data: NodeRow[] }' })
  listNodes(@CurrentAuth() ctx?: AuthContext): Envelope<NodeRow[]> {
    this.requireGlobal(ctx);
    return ok(this.cluster.listNodes());
  }

  @Patch('nodes/:id')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The node id (UUID).' })
  @ApiOperation({
    summary:
      "Update a node's name/region/status (dashboard manager). Global-scope. " +
      '404 if the node is unknown.',
  })
  @ApiOkResponse({ description: '{ data: NodeRow } — the updated row.' })
  @ApiNotFoundResponse({ description: 'Unknown node.' })
  patchNode(
    @Param('id') id: string,
    @Body() dto: PatchNodeDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<NodeRow> {
    this.requireGlobal(ctx);
    return ok(this.cluster.updateNode(id, dto));
  }

  @Delete('nodes/:id')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'The node id (UUID).' })
  @ApiOperation({
    summary:
      'Remove a node from the registry (dashboard manager). Global-scope. ' +
      '404 if the node is unknown.',
  })
  @ApiOkResponse({ description: '{ data: { id, deleted: true } }' })
  @ApiNotFoundResponse({ description: 'Unknown node.' })
  removeNode(
    @Param('id') id: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ id: string; deleted: true }> {
    this.requireGlobal(ctx);
    this.cluster.removeNode(id);
    return ok({ id, deleted: true as const });
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * Manual cluster-token gate for the node-facing endpoints. Disabled (503)
   * when the env is unset; otherwise a timing-safe compare of the
   * `X-Cluster-Token` header against `STREAMHUB_CLUSTER_TOKEN` (401 on mismatch
   * or absence). The token itself is never logged.
   */
  private assertClusterToken(req: Request): void {
    const expected = this.config.clusterToken;
    if (!expected) {
      throw new ServiceUnavailableException({
        error: 'cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)',
      });
    }
    const provided = req.header('x-cluster-token');
    if (!this.tokenMatches(provided, expected)) {
      throw new UnauthorizedException({ error: 'invalid cluster token' });
    }
  }

  /** Constant-time compare over SHA-256 digests (fixed length, no early-out). */
  private tokenMatches(provided: string | undefined, expected: string): boolean {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
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
