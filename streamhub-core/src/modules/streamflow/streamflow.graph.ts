/**
 * PURE workflow graph walk (Streamflow runner core).
 *
 * A workflow is a DAG of boxes joined by port-typed edges. `runGraph` walks it
 * from the trigger box, calling an injected `exec(box)` per box, and follows the
 * edges that leave the port `exec` returned (so condition/switch boxes branch).
 * It is deliberately free of NestJS/services/persistence so the graph logic is
 * exhaustively unit-testable: linear, branch true/false, cycle rejection,
 * max-steps and box-throws → propagates.
 *
 * Edges are structured (`{from, fromPort?, to, toPort?}`); a `boxId:port` colon
 * shorthand is also accepted on `from`/`to` (box ids never contain a colon).
 */

export interface GraphBox {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  fromPort?: string;
  to: string;
  toPort?: string;
}

export interface WorkflowGraph {
  boxes: GraphBox[];
  edges: GraphEdge[];
}

export class GraphValidationError extends Error {}
export class CyclicGraphError extends GraphValidationError {}
export class MaxStepsError extends Error {}

export interface RunStepRecord {
  boxId: string;
  boxType: string;
  port: string;
  output: unknown;
}

export interface RunGraphResult {
  steps: RunStepRecord[];
  visited: string[];
}

export interface RunGraphOptions {
  /** Hard cap on executed boxes (default 100). */
  maxSteps?: number;
}

/** Box id referenced by an endpoint string (`a` or `a:port`). */
export function endpointBox(ep: string): string {
  const s = String(ep ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(0, i) : s;
}

/** Port of an endpoint string (explicit field wins; else after `:`; else def). */
export function endpointPort(ep: string, explicit: string | undefined, def: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const s = String(ep ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : def;
}

export function edgeFromBox(e: GraphEdge): string {
  return endpointBox(e.from);
}
export function edgeFromPort(e: GraphEdge): string {
  return endpointPort(e.from, e.fromPort, 'out');
}
export function edgeToBox(e: GraphEdge): string {
  return endpointBox(e.to);
}

/**
 * Validate structure: non-empty unique-id boxes, edges reference known boxes,
 * and the directed graph is acyclic. Throws GraphValidationError / CyclicGraphError.
 */
export function validateGraph(graph: WorkflowGraph): void {
  if (!graph || !Array.isArray(graph.boxes)) {
    throw new GraphValidationError('graph.boxes must be an array');
  }
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const ids = new Set<string>();
  for (const b of graph.boxes) {
    if (!b || typeof b.id !== 'string' || !b.id) {
      throw new GraphValidationError('every box needs a non-empty string id');
    }
    if (ids.has(b.id)) {
      throw new GraphValidationError(`duplicate box id '${b.id}'`);
    }
    ids.add(b.id);
  }
  for (const e of edges) {
    const from = edgeFromBox(e);
    const to = edgeToBox(e);
    if (!ids.has(from)) {
      throw new GraphValidationError(`edge from unknown box '${from}'`);
    }
    if (!ids.has(to)) {
      throw new GraphValidationError(`edge to unknown box '${to}'`);
    }
  }
  assertAcyclic(graph.boxes, edges);
}

function assertAcyclic(boxes: GraphBox[], edges: GraphEdge[]): void {
  const adj = new Map<string, string[]>();
  for (const b of boxes) adj.set(b.id, []);
  for (const e of edges) {
    adj.get(edgeFromBox(e))?.push(edgeToBox(e));
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const b of boxes) color.set(b.id, WHITE);

  const visit = (node: string): void => {
    color.set(node, GREY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next);
      if (c === GREY) throw new CyclicGraphError(`cycle through box '${next}'`);
      if (c === WHITE) visit(next);
    }
    color.set(node, BLACK);
  };
  for (const b of boxes) {
    if (color.get(b.id) === WHITE) visit(b.id);
  }
}

/**
 * Walk the graph from `startBoxId`, executing each reachable box once and
 * following the edges leaving the port `exec` returned (default 'out'). Returns
 * the ordered step records. `exec` throwing propagates (the caller records the
 * failing step + marks the run failed). Throws MaxStepsError past the cap.
 */
export async function runGraph(
  graph: WorkflowGraph,
  startBoxId: string,
  exec: (box: GraphBox) => Promise<{ output?: unknown; port?: string }>,
  opts: RunGraphOptions = {},
): Promise<RunGraphResult> {
  validateGraph(graph);
  const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? 100));
  const byId = new Map(graph.boxes.map((b) => [b.id, b]));
  if (!byId.has(startBoxId)) {
    throw new GraphValidationError(`start box '${startBoxId}' not in graph`);
  }
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const executed = new Set<string>();
  const steps: RunStepRecord[] = [];
  const queue: string[] = [startBoxId];
  let executions = 0;

  while (queue.length) {
    const boxId = queue.shift() as string;
    if (executed.has(boxId)) continue;
    const box = byId.get(boxId);
    if (!box) continue;
    if (++executions > maxSteps) {
      throw new MaxStepsError(`exceeded max steps (${maxSteps})`);
    }
    executed.add(boxId);

    const res = await exec(box);
    const port = res.port ?? 'out';
    steps.push({ boxId, boxType: box.type, port, output: res.output });

    for (const e of edges) {
      if (edgeFromBox(e) === boxId && edgeFromPort(e) === port) {
        const target = edgeToBox(e);
        if (!executed.has(target)) queue.push(target);
      }
    }
  }

  return { steps, visited: [...executed] };
}

/** Find the entry (trigger) box: prefer a matching type, else the given id. */
export function findTriggerBox(
  graph: WorkflowGraph,
  preferType?: (type: string) => boolean,
): GraphBox | undefined {
  const boxes = Array.isArray(graph?.boxes) ? graph.boxes : [];
  if (preferType) {
    const hit = boxes.find((b) => preferType(b.type));
    if (hit) return hit;
  }
  // Fallback: a box with no inbound edge.
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const targets = new Set(edges.map((e) => edgeToBox(e)));
  return boxes.find((b) => !targets.has(b.id)) ?? boxes[0];
}
