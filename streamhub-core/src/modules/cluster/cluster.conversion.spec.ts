/**
 * Unit — cluster CONVERSION + security hardening (CLUSTER-ROADMAP §5/§6).
 *
 *  - join() P0: LiveKit apiSecret + Redis URL are WITHHELD when the join is not
 *    over TLS (STREAMHUB_CLUSTER_REQUIRE_TLS on by default), included over TLS
 *    or when the flag is off.
 *  - controller.join() derives `secure` from X-Forwarded-Proto / req.secure /
 *    loopback and a bad X-Cluster-Token records an `invalid_token` offense (P1).
 *  - joinMaster(): server-side POST to the master's /cluster/join, stores id +
 *    role=edge + master_url; failures don't flip the role.
 *  - leave(): always reverts to standalone locally; best-effort DELETE at the
 *    master only when a masterToken is supplied.
 */
import {
  BadGatewayException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { NodeRoleService } from './node-role.service';

const appCtx: AuthContext = {
  userId: 'token:2',
  tenantId: 't_acme',
  role: 'owner',
  isSuperadmin: false,
  scope: 'app',
  via: 'user_jwt',
};

const TOKEN = 'super-secret-cluster-token';

const TOUCHED = [
  'STREAMHUB_CLUSTER_TOKEN',
  'STREAMHUB_CLUSTER_REDIS_URL',
  'STREAMHUB_CLUSTER_REQUIRE_TLS',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_URL',
];

interface Built {
  ctx: UnitContext;
  service: ClusterService;
  nodeRole: NodeRoleService;
  controller: ClusterController;
  reputation: { recordOffense: jest.Mock };
}

function make(env: Record<string, string> = {}): Built {
  const ctx = makeUnitContext({
    STREAMHUB_CLUSTER_TOKEN: TOKEN,
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    STREAMHUB_CLUSTER_REDIS_URL: 'redis://:pw@10.0.0.1:6379',
    ...env,
  });
  const nodeRole = ctx.newService(NodeRoleService, ctx.db, ctx.config);
  const service = ctx.newService(ClusterService, ctx.db, ctx.config, nodeRole);
  const reputation = { recordOffense: jest.fn() };
  const controller = ctx.newService(
    ClusterController,
    ctx.config,
    service,
    reputation,
  );
  return { ctx, service, nodeRole, controller, reputation };
}

/** Fake express Request with header() + optional ip. */
function req(opts: {
  token?: string;
  proto?: string;
  ip?: string;
  secure?: boolean;
} = {}): Request {
  const headers: Record<string, string | undefined> = {
    'x-cluster-token': opts.token,
    'x-forwarded-proto': opts.proto,
  };
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip: opts.ip,
    secure: opts.secure ?? false,
    socket: { remoteAddress: opts.ip },
  } as unknown as Request;
}

function fakeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

/** A fetch-Response-like stub for global.fetch. */
function fetchResp(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('cluster conversion + security', () => {
  const original: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let built: Built;

  beforeAll(() => {
    for (const k of TOUCHED) original[k] = process.env[k];
  });
  afterEach(() => {
    built?.ctx.cleanup();
    global.fetch = realFetch;
    for (const k of TOUCHED) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  // -------------------------------------------------------------------------
  // P0 — TLS gating of the join secrets
  // -------------------------------------------------------------------------
  describe('join() secret gating', () => {
    it('withholds apiSecret + redis over plaintext (default requireTLS)', () => {
      built = make();
      const { payload } = built.service.join(
        { name: 'e', ip: '203.0.113.1' },
        { secure: false },
      );
      expect(payload.livekit.apiKey).toBe('k'); // non-secret, always sent
      expect(payload.livekit.apiSecret).toBe(''); // withheld
      expect(payload.redisUrl).toBeNull(); // withheld
      expect(payload.secretsWithheld).toBe(true);
      expect(payload.hint).toMatch(/TLS/);
    });

    it('includes the secrets over TLS', () => {
      built = make();
      const { payload } = built.service.join(
        { name: 'e', ip: '203.0.113.1' },
        { secure: true },
      );
      expect(payload.livekit.apiSecret).toBe('s');
      expect(payload.redisUrl).toBe('redis://:pw@10.0.0.1:6379');
      expect(payload.secretsWithheld).toBeUndefined();
    });

    it('includes the secrets over plaintext when requireTLS is off', () => {
      built = make({ STREAMHUB_CLUSTER_REQUIRE_TLS: 'off' });
      const { payload } = built.service.join(
        { name: 'e', ip: '203.0.113.1' },
        { secure: false },
      );
      expect(payload.livekit.apiSecret).toBe('s');
      expect(payload.redisUrl).toBe('redis://:pw@10.0.0.1:6379');
    });
  });

  // -------------------------------------------------------------------------
  // controller.join secure detection + P1 auto-ban offense
  // -------------------------------------------------------------------------
  describe('controller.join TLS detection', () => {
    it('X-Forwarded-Proto=https → secrets included', () => {
      built = make();
      const { res } = fakeRes();
      const out = built.controller.join(
        { name: 'e', ip: '203.0.113.1' },
        req({ token: TOKEN, proto: 'https', ip: '203.0.113.9' }),
        res,
      );
      expect(out.data.livekit.apiSecret).toBe('s');
    });

    it('plaintext remote → secrets withheld', () => {
      built = make();
      const { res } = fakeRes();
      const out = built.controller.join(
        { name: 'e', ip: '203.0.113.1' },
        req({ token: TOKEN, proto: 'http', ip: '203.0.113.9' }),
        res,
      );
      expect(out.data.livekit.apiSecret).toBe('');
      expect(out.data.secretsWithheld).toBe(true);
    });

    it('loopback client → secrets included (same-host join, not MITM-exposed)', () => {
      built = make();
      const { res } = fakeRes();
      const out = built.controller.join(
        { name: 'e', ip: '203.0.113.1' },
        req({ token: TOKEN, ip: '127.0.0.1' }),
        res,
      );
      expect(out.data.livekit.apiSecret).toBe('s');
    });
  });

  describe('assertClusterToken auto-ban wiring (P1)', () => {
    it('records an invalid_token offense on a wrong token, then 401', () => {
      built = make();
      const { res } = fakeRes();
      expect(() =>
        built.controller.join(
          { name: 'e', ip: '203.0.113.1' },
          req({ token: 'nope', ip: '203.0.113.9' }),
          res,
        ),
      ).toThrow(UnauthorizedException);
      expect(built.reputation.recordOffense).toHaveBeenCalledWith(
        '203.0.113.9',
        'invalid_token',
      );
    });

    it('does NOT record an offense on a valid token', () => {
      built = make();
      const { res } = fakeRes();
      built.controller.join(
        { name: 'e', ip: '203.0.113.1' },
        req({ token: TOKEN, proto: 'https', ip: '203.0.113.9' }),
        res,
      );
      expect(built.reputation.recordOffense).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // joinMaster
  // -------------------------------------------------------------------------
  describe('joinMaster()', () => {
    it('calls the master, stores id + role=edge + master_url', async () => {
      built = make();
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          fetchResp(true, 201, {
            data: { nodeId: 'node-123', secretsWithheld: false },
            error: null,
          }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const out = await built.service.joinMaster({
        masterUrl: 'https://master.example.com/',
        clusterToken: 'the-token',
        nodeName: 'edge-1',
        nodeIp: '203.0.113.50',
        region: 'eu',
      });

      // Called the right URL with the cluster token header + body.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://master.example.com/api/v1/cluster/join');
      expect(init.method).toBe('POST');
      expect(init.headers['x-cluster-token']).toBe('the-token');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        name: 'edge-1',
        ip: '203.0.113.50',
        region: 'eu',
      });

      // Local state flipped.
      expect(out.role).toBe('edge');
      expect(out.nodeId).toBe('node-123');
      expect(out.masterUrl).toBe('https://master.example.com');
      expect(out.heartbeatEnv.STREAMHUB_MASTER_NODE_ID).toBe('node-123');
      expect(built.nodeRole.getRole()).toBe('edge');
      expect(built.nodeRole.getMasterUrl()).toBe('https://master.example.com');
      expect(built.nodeRole.getMasterNodeId()).toBe('node-123');
    });

    it('auto-detects the node ip when omitted', async () => {
      built = make();
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          fetchResp(true, 200, { data: { nodeId: 'n' }, error: null }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;
      await built.service.joinMaster({
        masterUrl: 'https://m.example.com',
        clusterToken: 't',
        nodeName: 'edge-x',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(typeof body.ip).toBe('string');
      expect(body.ip.length).toBeGreaterThan(0);
    });

    it('throws BadGateway + keeps role standalone when the master rejects', async () => {
      built = make();
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchResp(false, 401, { error: 'bad token' })) as unknown as typeof fetch;
      await expect(
        built.service.joinMaster({
          masterUrl: 'https://m.example.com',
          clusterToken: 'wrong',
          nodeName: 'edge-1',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(built.nodeRole.getRole()).toBe('standalone');
    });

    it('throws BadGateway when the response has no nodeId', async () => {
      built = make();
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchResp(true, 200, { data: {}, error: null })) as unknown as typeof fetch;
      await expect(
        built.service.joinMaster({
          masterUrl: 'https://m.example.com',
          clusterToken: 't',
          nodeName: 'edge-1',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(built.nodeRole.getRole()).toBe('standalone');
    });
  });

  // -------------------------------------------------------------------------
  // leave
  // -------------------------------------------------------------------------
  describe('leave()', () => {
    function makeEdge(): Built {
      const b = make();
      b.nodeRole.setRole('edge');
      b.nodeRole.setMasterUrl('https://m.example.com');
      b.nodeRole.setMasterNodeId('node-9');
      return b;
    }

    it('reverts to standalone + de-registers with a master token', async () => {
      built = makeEdge();
      const fetchMock = jest
        .fn()
        .mockResolvedValue(fetchResp(true, 200, { data: {}, error: null }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const out = await built.service.leave({ masterToken: 'sk_master' });
      expect(out).toMatchObject({ role: 'standalone', deregistered: true });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://m.example.com/api/v1/cluster/nodes/node-9');
      expect(init.method).toBe('DELETE');
      expect(init.headers.authorization).toBe('Bearer sk_master');

      // Local linkage cleared.
      expect(built.nodeRole.getRole()).toBe('standalone');
      expect(built.nodeRole.getMasterUrl()).toBeNull();
      expect(built.nodeRole.getMasterNodeId()).toBeNull();
    });

    it('reverts locally but skips de-register without a master token', async () => {
      built = makeEdge();
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const out = await built.service.leave({});
      expect(out.role).toBe('standalone');
      expect(out.deregistered).toBe(false);
      expect(out.detail).toMatch(/masterToken/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(built.nodeRole.getRole()).toBe('standalone');
    });

    it('reports deregistered=false when the master DELETE fails', async () => {
      built = makeEdge();
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchResp(false, 403, { error: 'nope' })) as unknown as typeof fetch;
      const out = await built.service.leave({ masterToken: 'sk_master' });
      expect(out.role).toBe('standalone');
      expect(out.deregistered).toBe(false);
      expect(out.detail).toMatch(/403/);
    });

    it('a node with no master linkage just goes standalone', async () => {
      built = make(); // role standalone, no linkage
      const out = await built.service.leave({ masterToken: 'sk_master' });
      expect(out).toMatchObject({ role: 'standalone', deregistered: false });
    });
  });

  // -------------------------------------------------------------------------
  // controller global-scope gate on the conversion endpoints
  // -------------------------------------------------------------------------
  describe('controller conversion endpoints — global scope', () => {
    it('join-master forbids an app-scoped principal', async () => {
      built = make();
      await expect(
        built.controller.joinMaster(
          {
            masterUrl: 'https://m.example.com',
            clusterToken: 't',
            nodeName: 'edge-1',
          },
          appCtx,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('leave forbids an app-scoped principal', async () => {
      built = make();
      await expect(built.controller.leave({}, appCtx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('join-master delegates + envelopes for a global principal', async () => {
      built = make();
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fetchResp(true, 200, { data: { nodeId: 'n1' }, error: null }),
        ) as unknown as typeof fetch;
      const out = await built.controller.joinMaster(
        {
          masterUrl: 'https://m.example.com',
          clusterToken: 't',
          nodeName: 'edge-1',
        },
        undefined, // dev path (no auth ctx) — allowed, like the other endpoints
      );
      expect(out.error).toBeNull();
      expect(out.data.role).toBe('edge');
      expect(out.data.nodeId).toBe('n1');
    });
  });
});
