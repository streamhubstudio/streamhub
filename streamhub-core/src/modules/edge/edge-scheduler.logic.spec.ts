/**
 * Unit — edge/edge-scheduler.logic (PURE placement/capacity/failover).
 *
 * No DB, no sockets: every invariant the scheduler promises is a deterministic
 * function of its inputs — RR rotation, weighted distribution (≈ weights over
 * 1000 draws), the VRAM capacity guard, GRID requirement matching, and the
 * failover spread across the remaining eligible nodes.
 */
import type { EdgeGridCaps } from './edge.types';
import {
  eligibleNodes,
  hasCapacity,
  place,
  planFailover,
  passesRequirements,
  pickRoundRobin,
  pickWeighted,
  vramMaxStreams,
  type SchedulerNode,
} from './edge-scheduler.logic';

/** Deterministic PRNG so the weighted-distribution test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function node(over: Partial<SchedulerNode> = {}): SchedulerNode {
  return {
    id: 'n',
    name: 'n',
    region: null,
    type: 'edge',
    weight: 100,
    status: 'active',
    connected: true,
    grid: null,
    load: 0,
    ...over,
  };
}

const grid = (over: Partial<EdgeGridCaps> = {}): EdgeGridCaps => ({
  gpu: true,
  vramGb: 24,
  vramFreeMb: 24000,
  gpuName: 'RTX',
  capabilities: ['cuda'],
  ...over,
});

describe('edge-scheduler.logic', () => {
  describe('eligibility', () => {
    it('excludes disconnected / draining / disabled / wrong-type / CPU-for-GPU nodes', () => {
      const nodes = [
        node({ id: 'a', connected: false }),
        node({ id: 'b', status: 'draining' }),
        node({ id: 'c', status: 'disabled' }),
        node({ id: 'd', type: 'common' }),
        node({ id: 'e' }), // the only eligible one
      ];
      const elig = eligibleNodes(nodes, {});
      expect(elig.map((n) => n.id)).toEqual(['e']);
    });

    it('admits common nodes only when allowCommon is set', () => {
      const nodes = [node({ id: 'a', type: 'common' })];
      expect(eligibleNodes(nodes, {}).length).toBe(0);
      expect(eligibleNodes(nodes, { allowCommon: true }).map((n) => n.id)).toEqual(['a']);
    });

    it('sorts eligible nodes by id (stable policy input)', () => {
      const nodes = [node({ id: 'c' }), node({ id: 'a' }), node({ id: 'b' })];
      expect(eligibleNodes(nodes, {}).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('GRID requirements (reused matcher)', () => {
    it('passes when gpu + minVram + capabilities are met, fails otherwise', () => {
      const n = node({ grid: grid({ vramGb: 24, capabilities: ['cuda', 'whisper'] }) });
      expect(passesRequirements(n, { gpu: true, minVramGb: 16, capabilities: ['cuda'] })).toBe(true);
      expect(passesRequirements(n, { minVramGb: 32 })).toBe(false);
      expect(passesRequirements(n, { capabilities: ['tensorrt'] })).toBe(false);
    });

    it('a CPU node (no grid) fails a GPU requirement but passes an empty one', () => {
      const cpu = node({ grid: null });
      expect(passesRequirements(cpu, { gpu: true })).toBe(false);
      expect(passesRequirements(cpu, {})).toBe(true);
      expect(passesRequirements(cpu, undefined)).toBe(true);
    });
  });

  describe('VRAM capacity guard', () => {
    it('maxStreams = floor((vramFreeMb - 500) / 200); CPU node is unbounded', () => {
      expect(vramMaxStreams(node({ grid: grid({ vramFreeMb: 700 }) }))).toBe(1);
      expect(vramMaxStreams(node({ grid: grid({ vramFreeMb: 900 }) }))).toBe(2);
      expect(vramMaxStreams(node({ grid: null }))).toBe(Number.POSITIVE_INFINITY);
    });

    it('a node at capacity is not eligible; one with headroom is', () => {
      const full = node({ id: 'full', grid: grid({ vramFreeMb: 700 }), load: 1 });
      const free = node({ id: 'free', grid: grid({ vramFreeMb: 900 }), load: 1 });
      expect(hasCapacity(full)).toBe(false);
      expect(hasCapacity(free)).toBe(true);
      expect(eligibleNodes([full, free], {}).map((n) => n.id)).toEqual(['free']);
    });
  });

  describe('round_robin policy', () => {
    it('rotates across the eligible set in id order', () => {
      const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];
      const picks: string[] = [];
      let cursor = 0;
      for (let i = 0; i < 6; i++) {
        const r = place(nodes, { policy: 'round_robin', cursor });
        cursor = r.cursor;
        picks.push(r.nodeId!);
      }
      expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    });

    it('pickRoundRobin is null-safe on an empty set and advances the cursor otherwise', () => {
      expect(pickRoundRobin([], 3)).toEqual({ nodeId: null, cursor: 3 });
      const r = pickRoundRobin([node({ id: 'x' })], 5);
      expect(r).toEqual({ nodeId: 'x', cursor: 6 });
    });

    it('returns null when nothing is eligible', () => {
      const r = place([node({ id: 'a', connected: false })], { policy: 'round_robin', cursor: 0 });
      expect(r.nodeId).toBeNull();
    });
  });

  describe('weighted policy', () => {
    it('distributes ≈ weights over 1000 draws', () => {
      const nodes = [
        node({ id: 'a', weight: 75 }),
        node({ id: 'b', weight: 25 }),
      ];
      const rand = mulberry32(12345);
      const counts: Record<string, number> = { a: 0, b: 0 };
      for (let i = 0; i < 1000; i++) {
        const id = pickWeighted(eligibleNodes(nodes, {}), rand)!;
        counts[id]++;
      }
      // 750 / 250 expected; allow a generous ±60 (≈6%) band for sampling noise.
      expect(counts.a).toBeGreaterThan(690);
      expect(counts.a).toBeLessThan(810);
      expect(counts.a + counts.b).toBe(1000);
    });

    it('degrades to a uniform pick when every weight is 0', () => {
      const nodes = [node({ id: 'a', weight: 0 }), node({ id: 'b', weight: 0 })];
      const id = pickWeighted(nodes, () => 0.6);
      expect(['a', 'b']).toContain(id);
    });

    it('pickWeighted is null on an empty set', () => {
      expect(pickWeighted([], () => 0.5)).toBeNull();
    });
  });

  describe('failover', () => {
    it('spreads a down node’s assignments across the remaining eligible nodes', () => {
      // Down node absent from the view; two survivors take the 3 orphans RR.
      const survivors = [node({ id: 'a' }), node({ id: 'b' })];
      const { moves } = planFailover(['x1', 'x2', 'x3'], survivors, {
        policy: 'round_robin',
        cursor: 0,
      });
      const targets = moves.map((m) => m.toNodeId);
      expect(targets.every((t) => t === 'a' || t === 'b')).toBe(true);
      // RR + simulated-load spread → a,b,a (not all onto one node).
      expect(new Set(targets).size).toBe(2);
      expect(targets.filter((t) => t === 'a').length).toBe(2);
      expect(targets.filter((t) => t === 'b').length).toBe(1);
    });

    it('parks orphans (toNodeId null) when no node is eligible', () => {
      const { moves } = planFailover(['x1', 'x2'], [node({ id: 'a', connected: false })], {
        policy: 'round_robin',
        cursor: 0,
      });
      expect(moves.every((m) => m.toNodeId === null)).toBe(true);
    });

    it('honours the VRAM capacity guard while spreading (stops overfilling a node)', () => {
      // 'a' can take exactly 1 (free 700 → max 1, load 0); 'b' unbounded (CPU-ish
      // via big free). Two orphans → a then b, never a twice.
      const nodes = [
        node({ id: 'a', grid: grid({ vramFreeMb: 700 }), load: 0 }),
        node({ id: 'b', grid: grid({ vramFreeMb: 100000 }), load: 0 }),
      ];
      const { moves } = planFailover(['x1', 'x2'], nodes, { policy: 'round_robin', cursor: 0 });
      const targets = moves.map((m) => m.toNodeId).sort();
      expect(targets).toEqual(['a', 'b']);
    });
  });
});
