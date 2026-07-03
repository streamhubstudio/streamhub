/**
 * Unit — cluster/ClusterController: the MANUAL `X-Cluster-Token` gate (the part
 * the global Bearer guard does NOT cover, since /join + /heartbeat are @Public)
 * and the global-scope check on GET /nodes.
 *
 *  - env unset          → 503 { error: 'cluster joining disabled ...' }
 *  - wrong / absent tok → 401 (timing-safe compare)
 *  - valid token        → 201 on create / 200 on refresh, enveloped
 *  - /nodes             → app-scoped principal forbidden, global allowed
 */
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { PatchNodeDto } from './dto/patch-node.dto';

const TOKEN = 'super-secret-cluster-token';

function make(env: Record<string, string>): {
  ctx: UnitContext;
  controller: ClusterController;
} {
  const ctx = makeUnitContext(env);
  const service = ctx.newService(ClusterService, ctx.db, ctx.config);
  const controller = ctx.newService(ClusterController, ctx.config, service);
  return { ctx, controller };
}

/** Fake express Request exposing only `X-Cluster-Token` via header(). */
function reqWithToken(token?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'x-cluster-token' ? token : undefined,
  } as unknown as Request;
}

function fakeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

const globalCtx: AuthContext = {
  userId: 'token:1',
  tenantId: 'platform',
  role: 'service',
  isSuperadmin: false,
  scope: 'global',
  via: 'api_token',
};

/** An app-scoped, non-superadmin principal (rejected from the global surface). */
const appCtx: AuthContext = {
  ...globalCtx,
  scope: 'app',
  via: 'user_jwt',
  role: 'owner',
};

// ConfigService snapshots process.env in its ctor; save/restore what we touch
// so config doesn't leak into later tests or other spec files.
const TOUCHED = [
  'STREAMHUB_CLUSTER_TOKEN',
  'STREAMHUB_CLUSTER_REDIS_URL',
  'STREAMHUB_PUBLIC_URL',
  'PUBLIC_BASE_URL',
  'PUBLIC_WS_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_URL',
];

describe('cluster/ClusterController', () => {
  let ctx: UnitContext;
  let controller: ClusterController;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of TOUCHED) original[k] = process.env[k];
  });
  afterEach(() => {
    ctx?.cleanup();
    for (const k of TOUCHED) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe('POST /cluster/join — token gate', () => {
    it('503 when STREAMHUB_CLUSTER_TOKEN is unset', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: '' }));
      const { res } = fakeRes();
      try {
        controller.join(
          { name: 'edge', ip: '203.0.113.1' },
          reqWithToken(TOKEN),
          res,
        );
        throw new Error('expected 503');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as ServiceUnavailableException).getResponse()).toEqual({
          error: 'cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)',
        });
      }
    });

    it('401 when the X-Cluster-Token header is wrong', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      expect(() =>
        controller.join(
          { name: 'edge', ip: '203.0.113.1' },
          reqWithToken('nope'),
          res,
        ),
      ).toThrow(UnauthorizedException);
    });

    it('401 when the X-Cluster-Token header is absent', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      expect(() =>
        controller.join(
          { name: 'edge', ip: '203.0.113.1' },
          reqWithToken(undefined),
          res,
        ),
      ).toThrow(UnauthorizedException);
    });

    it('201 + enveloped payload on create with the right token', () => {
      ({ ctx, controller } = make({
        STREAMHUB_CLUSTER_TOKEN: TOKEN,
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      }));
      const { res, status } = fakeRes();
      const out = controller.join(
        { name: 'edge', ip: '203.0.113.1' },
        reqWithToken(TOKEN),
        res,
      );
      expect(status).toHaveBeenCalledWith(201);
      expect(out.error).toBeNull();
      expect(out.data.name).toBe('edge');
      expect(out.data.livekit.apiKey).toBe('k');
    });

    it('200 on a refresh (idempotent re-join by name)', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const first = fakeRes();
      controller.join(
        { name: 'edge', ip: '203.0.113.1' },
        reqWithToken(TOKEN),
        first.res,
      );
      expect(first.status).toHaveBeenCalledWith(201);

      const again = fakeRes();
      controller.join(
        { name: 'edge', ip: '203.0.113.9' },
        reqWithToken(TOKEN),
        again.res,
      );
      expect(again.status).toHaveBeenCalledWith(200);
    });
  });

  describe('POST /cluster/heartbeat', () => {
    it('503 when disabled (token gate runs before the lookup)', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: '' }));
      expect(() =>
        controller.heartbeat({ nodeId: 'x' }, reqWithToken(TOKEN)),
      ).toThrow(ServiceUnavailableException);
    });

    it('404 for an unknown node when enabled', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() =>
        controller.heartbeat({ nodeId: 'unknown' }, reqWithToken(TOKEN)),
      ).toThrow(NotFoundException);
    });

    it('marks a joined node active (ok envelope)', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      const joined = controller.join(
        { name: 'hb', ip: '203.0.113.5' },
        reqWithToken(TOKEN),
        res,
      );
      const out = controller.heartbeat(
        { nodeId: joined.data.nodeId },
        reqWithToken(TOKEN),
      );
      expect(out).toEqual({ data: { ok: true }, error: null });
    });
  });

  describe('GET /cluster/nodes — global scope', () => {
    it('forbids an app-scoped, non-superadmin principal', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() => controller.listNodes(appCtx)).toThrow(ForbiddenException);
    });

    it('lists nodes for a global principal', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      controller.join(
        { name: 'n1', ip: '203.0.113.1' },
        reqWithToken(TOKEN),
        res,
      );
      const out = controller.listNodes(globalCtx);
      expect(out.error).toBeNull();
      expect(out.data.map((n) => n.name)).toEqual(['n1']);
    });

    it('allows the dev path (no auth context bound)', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() => controller.listNodes(undefined)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Cluster manager surface (dashboard): info / patch / delete + stats heartbeat
  // ---------------------------------------------------------------------------

  describe('GET /cluster/info — global scope', () => {
    it('enabled=true + built join command when the token env is set', () => {
      ({ ctx, controller } = make({
        STREAMHUB_CLUSTER_TOKEN: TOKEN,
        STREAMHUB_PUBLIC_URL: 'https://media.example.com',
      }));
      const out = controller.info(globalCtx);
      expect(out.error).toBeNull();
      expect(out.data.enabled).toBe(true);
      expect(out.data.clusterToken).toBe(TOKEN);
      expect(out.data.joinCommand).toContain(`--master-token ${TOKEN}`);
      expect(out.data.joinCommand).toContain('--master-ip <THIS_SERVER_IP>');
      expect(out.data.joinCommand).toContain(
        '--master-url https://media.example.com',
      );
    });

    it('enabled=false when the token env is unset', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: '' }));
      expect(controller.info(globalCtx).data.enabled).toBe(false);
    });

    it('forbids an app-scoped principal', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() => controller.info(appCtx)).toThrow(ForbiddenException);
    });
  });

  describe('POST /cluster/heartbeat — with stats', () => {
    it('persists stats that then surface (parsed) in GET /nodes', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      const joined = controller.join(
        { name: 'hb', ip: '203.0.113.5' },
        reqWithToken(TOKEN),
        res,
      );
      controller.heartbeat(
        { nodeId: joined.data.nodeId, stats: { cpu: 0.42, activeStreams: 2 } },
        reqWithToken(TOKEN),
      );
      const nodes = controller.listNodes(globalCtx).data;
      expect(nodes[0].stats).toEqual({ cpu: 0.42, activeStreams: 2 });
      expect(nodes[0].stale).toBe(false);
    });
  });

  describe('PATCH /cluster/nodes/:id — global scope', () => {
    it('updates a node and returns the enriched row', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      const joined = controller.join(
        { name: 'edge', ip: '203.0.113.1' },
        reqWithToken(TOKEN),
        res,
      );
      const out = controller.patchNode(
        joined.data.nodeId,
        { status: 'draining', region: 'eu-west' },
        globalCtx,
      );
      expect(out.error).toBeNull();
      expect(out.data.status).toBe('draining');
      expect(out.data.region).toBe('eu-west');
    });

    it('404 for an unknown node', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() =>
        controller.patchNode('nope', { status: 'disabled' }, globalCtx),
      ).toThrow(NotFoundException);
    });

    it('forbids an app-scoped principal', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() =>
        controller.patchNode('any', { status: 'active' }, appCtx),
      ).toThrow(ForbiddenException);
    });

    it('DTO rejects an out-of-enum status (ValidationPipe surface)', async () => {
      const bad = plainToInstance(PatchNodeDto, { status: 'bogus' });
      const errors = await validate(bad);
      expect(errors.some((e) => e.property === 'status')).toBe(true);
    });

    it('DTO accepts a valid partial patch', async () => {
      const good = plainToInstance(PatchNodeDto, {
        status: 'draining',
        region: 'eu',
      });
      expect(await validate(good)).toHaveLength(0);
    });
  });

  describe('DELETE /cluster/nodes/:id — global scope', () => {
    it('removes a node and returns { id, deleted: true }', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      const { res } = fakeRes();
      const joined = controller.join(
        { name: 'gone', ip: '203.0.113.1' },
        reqWithToken(TOKEN),
        res,
      );
      const out = controller.removeNode(joined.data.nodeId, globalCtx);
      expect(out).toEqual({
        data: { id: joined.data.nodeId, deleted: true },
        error: null,
      });
      expect(controller.listNodes(globalCtx).data).toEqual([]);
    });

    it('404 for an unknown node', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() => controller.removeNode('nope', globalCtx)).toThrow(
        NotFoundException,
      );
    });

    it('forbids an app-scoped principal', () => {
      ({ ctx, controller } = make({ STREAMHUB_CLUSTER_TOKEN: TOKEN }));
      expect(() => controller.removeNode('any', appCtx)).toThrow(
        ForbiddenException,
      );
    });
  });
});
