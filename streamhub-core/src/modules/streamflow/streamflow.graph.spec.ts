/**
 * Unit spec — pure graph walk (streamflow.graph). Drives the DAG runner with a
 * synthetic `exec` (no boxes/services): linear chain order, branch selection by
 * returned port, cycle rejection, unknown-box/edge validation, the max-steps
 * backstop, and box-throws propagating out of runGraph.
 */
import {
  CyclicGraphError,
  GraphValidationError,
  MaxStepsError,
  findTriggerBox,
  runGraph,
  validateGraph,
  type WorkflowGraph,
} from './streamflow.graph';

const box = (id: string, type = 'noop') => ({ id, type });

describe('validateGraph', () => {
  it('rejects duplicate ids and edges to unknown boxes', () => {
    expect(() =>
      validateGraph({ boxes: [box('a'), box('a')], edges: [] }),
    ).toThrow(GraphValidationError);
    expect(() =>
      validateGraph({ boxes: [box('a')], edges: [{ from: 'a', to: 'ghost' }] }),
    ).toThrow(/unknown box/);
  });

  it('rejects a cycle', () => {
    const g: WorkflowGraph = {
      boxes: [box('a'), box('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(() => validateGraph(g)).toThrow(CyclicGraphError);
  });
});

describe('runGraph', () => {
  it('executes a linear chain in order', async () => {
    const g: WorkflowGraph = {
      boxes: [box('a'), box('b'), box('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const seen: string[] = [];
    const res = await runGraph(g, 'a', async (b) => {
      seen.push(b.id);
      return { output: b.id };
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(res.steps.map((s) => s.boxId)).toEqual(['a', 'b', 'c']);
  });

  it('follows only the port the box returned (branch true)', async () => {
    const g: WorkflowGraph = {
      boxes: [box('cond', 'logic.condition'), box('yes'), box('no')],
      edges: [
        { from: 'cond', fromPort: 'true', to: 'yes' },
        { from: 'cond', fromPort: 'false', to: 'no' },
      ],
    };
    const seen: string[] = [];
    await runGraph(g, 'cond', async (b) => {
      seen.push(b.id);
      return b.id === 'cond' ? { port: 'true' } : {};
    });
    expect(seen).toEqual(['cond', 'yes']);
  });

  it('follows the false branch when the box returns it', async () => {
    const g: WorkflowGraph = {
      boxes: [box('cond'), box('yes'), box('no')],
      edges: [
        { from: 'cond:true', to: 'yes' },
        { from: 'cond:false', to: 'no' },
      ],
    };
    const seen: string[] = [];
    await runGraph(g, 'cond', async (b) =>
      b.id === 'cond' ? { port: 'false' } : {},
    );
    // colon-shorthand ports resolve too
    const res = await runGraph(g, 'cond', async (b) => {
      seen.push(b.id);
      return b.id === 'cond' ? { port: 'false' } : {};
    });
    expect(seen).toEqual(['cond', 'no']);
    expect(res.visited).toEqual(['cond', 'no']);
  });

  it('runs a fan-in box only once (diamond)', async () => {
    const g: WorkflowGraph = {
      boxes: [box('a'), box('b'), box('c'), box('d')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    };
    const counts: Record<string, number> = {};
    await runGraph(g, 'a', async (b) => {
      counts[b.id] = (counts[b.id] ?? 0) + 1;
      return {};
    });
    expect(counts.d).toBe(1);
  });

  it('throws MaxStepsError past the cap', async () => {
    const boxes = ['a', 'b', 'c', 'd', 'e'].map((id) => box(id));
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'e' },
    ];
    await expect(
      runGraph({ boxes, edges }, 'a', async () => ({}), { maxSteps: 3 }),
    ).rejects.toBeInstanceOf(MaxStepsError);
  });

  it('propagates a box throw (runner marks the run failed)', async () => {
    const g: WorkflowGraph = {
      boxes: [box('a'), box('b')],
      edges: [{ from: 'a', to: 'b' }],
    };
    await expect(
      runGraph(g, 'a', async (b) => {
        if (b.id === 'b') throw new Error('exec boom');
        return {};
      }),
    ).rejects.toThrow('exec boom');
  });
});

describe('findTriggerBox', () => {
  it('prefers a box matching the type predicate', () => {
    const g: WorkflowGraph = {
      boxes: [box('x', 'action.http'), box('t', 'trigger.event')],
      edges: [{ from: 't', to: 'x' }],
    };
    expect(findTriggerBox(g, (t) => t.startsWith('trigger.'))?.id).toBe('t');
  });

  it('falls back to the box with no inbound edge', () => {
    const g: WorkflowGraph = {
      boxes: [box('a'), box('b')],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(findTriggerBox(g)?.id).toBe('a');
  });
});
