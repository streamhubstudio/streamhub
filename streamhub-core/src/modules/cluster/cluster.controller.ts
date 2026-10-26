import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { Public } from '../../shared/auth';
import { assertClusterToken } from './cluster-token.util';
import { IpReputationService } from '../security/ip-reputation.service';
import {
  ClusterInfo,
  ClusterService,
  JoinMasterResult,
  JoinPayload,
  LeaveResult,
  NodeRow,
} from './cluster.service';
import { JoinNodeDto } from './dto/join-node.dto';
import { JoinMasterDto } from './dto/join-master.dto';
import { LeaveDto } from './dto/leave.dto';
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
    /**
     * Network-security sink (optional for bare unit specs). A failed
     * `X-Cluster-Token` check records an `invalid_token` offense so the existing
     * auto-ban (modules/security) covers cluster brute-force. Fire-and-forget.
     */
    @Optional() private readonly reputation?: IpReputationService,
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
    // P0: secrets are only vended over TLS — tell the service the transport.
    const { created, payload } = this.cluster.join(dto, {
      secure: this.isSecure(req),
    });
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
  // standalone ↔ cluster conversion (dashboard/CLI, global-scope)
  // ---------------------------------------------------------------------------

  @Post('join-master')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Convert this node into a cluster EDGE of a remote master. Server-side ' +
      'calls the master /cluster/join with the given clusterToken, stores the ' +
      'returned node id and sets role=edge. Returns the heartbeat.env values ' +
      'the installer applies (media plane needs a container recreate). ' +
      'Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: JoinMasterResult }' })
  async joinMaster(
    @Body() dto: JoinMasterDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<JoinMasterResult>> {
    this.requireGlobal(ctx);
    return ok(await this.cluster.joinMaster(dto));
  }

  @Post('leave')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Leave the cluster: revert this node to standalone and clear the master ' +
      'linkage (always succeeds locally), then best-effort de-register at the ' +
      'master (pass the master global token to authenticate the DELETE). ' +
      'Global-scope.',
  })
  @ApiOkResponse({ description: '{ data: LeaveResult }' })
  async leave(
    @Body() dto: LeaveDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<LeaveResult>> {
    this.requireGlobal(ctx);
    return ok(await this.cluster.leave(dto));
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * Manual cluster-token gate for the node-facing endpoints. Disabled (503)
   * when the env is unset; otherwise a timing-safe compare of the
   * `X-Cluster-Token` header against `STREAMHUB_CLUSTER_TOKEN` (401 on mismatch
   * or absence). The token itself is never logged. Shared with the GRID agent
   * via `cluster-token.util`.
   */
  private assertClusterToken(req: Request): void {
    // Shared timing-safe gate (also used by the GRID agent). The `onInvalid`
    // hook feeds the auto-ban (P1) so brute-forcing the cluster token gets the
    // IP banned by the security middleware — fire-and-forget, never throws.
    assertClusterToken(req, this.config.clusterToken, undefined, () =>
      this.reputation?.recordOffense(this.clientIp(req), 'invalid_token'),
    );
  }

  /**
   * Whether this request reached us over TLS (P0 gate for vending secrets):
   * `X-Forwarded-Proto === 'https'` at the trusted proxy, a direct TLS socket
   * (`req.secure`), or a loopback client (same-host join / origin — not
   * MITM-exposed, so secrets are safe).
   */
  private isSecure(req: Request): boolean {
    const xfp = (req.header('x-forwarded-proto') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (xfp === 'https') return true;
    if (req.secure) return true;
    const ip = this.clientIp(req);
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  }

  /** Proxy-validated client IP (X-Forwarded-For honoured via `trust proxy`). */
  private clientIp(req: Request): string {
    const raw = req.ip || req.socket?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
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
