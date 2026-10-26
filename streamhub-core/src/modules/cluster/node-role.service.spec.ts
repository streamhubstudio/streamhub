/**
 * Unit — cluster/NodeRoleService: the DB-driven cluster role model
 * (CLUSTER-ROADMAP §5 step 1). Stored in the global `_streamhub_meta` KV.
 *
 *  - default is `standalone` (empty KV, no env),
 *  - first boot seeds from STREAMHUB_NODE_ROLE / STREAMHUB_MASTER_URL,
 *  - the KV wins over env on subsequent boots (a conversion sticks),
 *  - setRole/setMasterUrl round-trip; isEdge() reflects the stored role,
 *  - a bogus role coerces to standalone.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { coerceNodeRole, NodeRoleService } from './node-role.service';

const TOUCHED = ['STREAMHUB_NODE_ROLE', 'STREAMHUB_MASTER_URL'];

function make(env: Record<string, string> = {}): {
  ctx: UnitContext;
  svc: NodeRoleService;
} {
  const ctx = makeUnitContext(env);
  const svc = ctx.newService(NodeRoleService, ctx.db, ctx.config);
  return { ctx, svc };
}

describe('cluster/NodeRoleService', () => {
  let ctx: UnitContext;
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

  describe('coerceNodeRole', () => {
    it('accepts the three known roles (case-insensitive)', () => {
      expect(coerceNodeRole('standalone')).toBe('standalone');
      expect(coerceNodeRole('MASTER')).toBe('master');
      expect(coerceNodeRole(' edge ')).toBe('edge');
    });
    it('falls back to standalone for junk / null', () => {
      expect(coerceNodeRole('bogus')).toBe('standalone');
      expect(coerceNodeRole('')).toBe('standalone');
      expect(coerceNodeRole(null)).toBe('standalone');
      expect(coerceNodeRole(undefined)).toBe('standalone');
    });
  });

  describe('default / seed', () => {
    it('defaults to standalone with an empty KV and no env', () => {
      const built = make({ STREAMHUB_NODE_ROLE: '', STREAMHUB_MASTER_URL: '' });
      ctx = built.ctx;
      // Note: no onModuleInit() → nothing seeded; getRole reads the empty KV.
      expect(built.svc.getRole()).toBe('standalone');
      expect(built.svc.isEdge()).toBe(false);
      expect(built.svc.getMasterUrl()).toBeNull();
    });

    it('seeds role + master_url from env on first boot', () => {
      const built = make({
        STREAMHUB_NODE_ROLE: 'edge',
        STREAMHUB_MASTER_URL: 'https://master.example.com/',
      });
      ctx = built.ctx;
      built.svc.onModuleInit();
      expect(built.svc.getRole()).toBe('edge');
      expect(built.svc.isEdge()).toBe(true);
      // trailing slash trimmed
      expect(built.svc.getMasterUrl()).toBe('https://master.example.com');
    });

    it('coerces a bogus env role to standalone on seed', () => {
      const built = make({ STREAMHUB_NODE_ROLE: 'overlord' });
      ctx = built.ctx;
      built.svc.onModuleInit();
      expect(built.svc.getRole()).toBe('standalone');
    });

    it('KV wins over env on the next boot (seed is first-boot only)', () => {
      const first = make({ STREAMHUB_NODE_ROLE: 'edge' });
      ctx = first.ctx;
      first.svc.onModuleInit();
      expect(first.svc.getRole()).toBe('edge');

      // A second service over the SAME db but a DIFFERENT env must NOT re-seed.
      process.env.STREAMHUB_NODE_ROLE = 'master';
      const second = first.ctx.newService(
        NodeRoleService,
        first.ctx.db,
        first.ctx.config,
      );
      second.onModuleInit();
      expect(second.getRole()).toBe('edge'); // KV value preserved
    });
  });

  describe('setRole / setMasterUrl', () => {
    it('round-trips a role change', () => {
      const built = make({ STREAMHUB_NODE_ROLE: 'standalone' });
      ctx = built.ctx;
      built.svc.onModuleInit();
      built.svc.setRole('master');
      expect(built.svc.getRole()).toBe('master');
      built.svc.setRole('edge');
      expect(built.svc.isEdge()).toBe(true);
    });

    it('sets then clears the master url', () => {
      const built = make({});
      ctx = built.ctx;
      built.svc.onModuleInit();
      built.svc.setMasterUrl('https://m.example.com//');
      expect(built.svc.getMasterUrl()).toBe('https://m.example.com');
      built.svc.setMasterUrl(null);
      expect(built.svc.getMasterUrl()).toBeNull();
      built.svc.setMasterUrl('   ');
      expect(built.svc.getMasterUrl()).toBeNull();
    });

    it('coerces a bogus role passed to setRole', () => {
      const built = make({});
      ctx = built.ctx;
      built.svc.onModuleInit();
      built.svc.setRole('nonsense' as never);
      expect(built.svc.getRole()).toBe('standalone');
    });
  });
});
