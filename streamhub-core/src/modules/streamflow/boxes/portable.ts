/**
 * Portable workflow (Streamflow) — export / import a single workflow as JSON.
 *
 * PURE (no NestJS / IO): the controller/service adapt it. Export is round-trip
 * faithful (boxes + edges + positions) but drops db-scoped fields (id,
 * timestamps, enabled) and NEVER carries a secret VALUE:
 *   - secrets live in streamflow's per-app `secrets` table (see the secrets
 *     manager) and are referenced from a box only as `{{secret.NAME}}` — a ref,
 *     not a value, so it is kept verbatim;
 *   - as defence-in-depth, any config field whose KEY looks sensitive, or whose
 *     string VALUE looks like a raw literal key (and is not a template), is
 *     redacted to '' on export and listed in `redactions`.
 *
 * Import validates the graph against the box catalogue (unknown box types → a
 * typed error the controller maps to 400) and the structural invariants
 * (unique ids, edges reference known boxes, acyclic).
 */
import { validateGraph, type GraphBox, type WorkflowGraph } from '../streamflow.graph';
import type { BoxSpec } from './catalogue';

/** Marker + version of the on-disk portable format. */
export const PORTABLE_VERSION = 1 as const;

export interface PortableWorkflow {
  /** Format version (bump on breaking shape changes). */
  streamflow: typeof PORTABLE_VERSION;
  name: string;
  graph: WorkflowGraph;
  /** Config paths redacted on export (informational; never contains values). */
  redactions?: string[];
}

/** Import rejected: a box type is not in the catalogue (unknown box). */
export class GraphImportError extends Error {
  constructor(public readonly unknownTypes: string[]) {
    super(
      `unknown box type${unknownTypes.length > 1 ? 's' : ''}: ${unknownTypes.join(', ')}`,
    );
    this.name = 'GraphImportError';
  }
}

/** Sensitive config KEY names → their VALUE is redacted on export. */
const SENSITIVE_KEY_RE =
  /secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key|private|dsn/i;
/** A raw literal-key VALUE (not a template) → redacted regardless of key name. */
const LITERAL_KEY_RE = /^(sk-|sk_|xox|ghp_|AKIA)|^[A-Za-z0-9/+_-]{40,}$/;
const TEMPLATE_RE = /\{\{/;

function looksLiteralSecret(v: string): boolean {
  const s = v.trim();
  if (!s || TEMPLATE_RE.test(s)) return false; // templates (incl. {{secret.X}}) are refs
  return LITERAL_KEY_RE.test(s);
}

/**
 * Redact secret-ish values from a box config for export. Returns the cleaned
 * config plus the dotted paths that were redacted. Keeps `{{secret.NAME}}` and
 * any other `{{…}}` template ref intact (they carry no value).
 */
export function stripSecretishConfig(
  config: Record<string, unknown> | undefined,
  boxId: string,
): { config: Record<string, unknown>; redactions: string[] } {
  const src = config ?? {};
  const out: Record<string, unknown> = {};
  const redactions: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    const sensitiveKey = SENSITIVE_KEY_RE.test(key);
    if (typeof value === 'string') {
      if ((sensitiveKey && !TEMPLATE_RE.test(value)) || looksLiteralSecret(value)) {
        out[key] = '';
        redactions.push(`${boxId}.${key}`);
        continue;
      }
    }
    out[key] = value;
  }
  return { config: out, redactions };
}

/** A stored workflow → its portable JSON (round-trip faithful, secret-safe). */
export function exportWorkflow(wf: {
  name: string;
  graph: unknown;
}): PortableWorkflow {
  const graph = normalizeGraph(wf.graph);
  const redactions: string[] = [];
  const boxes = graph.boxes.map((b) => {
    const { config, redactions: r } = stripSecretishConfig(b.config, b.id);
    redactions.push(...r);
    return { ...b, config } as GraphBox;
  });
  return {
    streamflow: PORTABLE_VERSION,
    name: wf.name,
    graph: { boxes, edges: graph.edges },
    ...(redactions.length ? { redactions } : {}),
  };
}

/**
 * Portable JSON → a validated `{ name, graph }` ready to create. Throws
 * `GraphImportError` for unknown box types and a plain Error for structural
 * problems (surfaced as 400 by the controller).
 */
export function importWorkflow(
  raw: unknown,
  catalogue: BoxSpec[],
  fallbackName = 'Imported workflow',
): { name: string; graph: WorkflowGraph } {
  const obj = (raw ?? {}) as Partial<PortableWorkflow>;
  const graph = normalizeGraph(obj.graph);
  if (!graph.boxes.length && !graph.edges.length) {
    throw new Error('workflow has no boxes to import');
  }
  const known = new Set(catalogue.map((s) => s.type));
  const unknown = [
    ...new Set(graph.boxes.map((b) => b.type).filter((t) => !known.has(t))),
  ];
  if (unknown.length) throw new GraphImportError(unknown);
  // Structural + acyclic validation (throws GraphValidationError/CyclicGraphError).
  validateGraph(graph);
  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : fallbackName;
  return { name, graph };
}

function normalizeGraph(graph: unknown): WorkflowGraph {
  const g = (graph ?? {}) as { boxes?: unknown; edges?: unknown };
  return {
    boxes: Array.isArray(g.boxes) ? (g.boxes as GraphBox[]) : [],
    edges: Array.isArray(g.edges) ? (g.edges as WorkflowGraph['edges']) : [],
  };
}
