/**
 * Wired-network geometry — pure, deterministic, no SVG / React / dependencies.
 *
 * Feeds <WiredCables> (the auth cover's animated "streaming signal" backdrop):
 * given a box + seed it lays out nodes on a lightly-jittered grid and links each
 * one to its nearest neighbours with curved cable paths (cubic béziers) ready to
 * drop straight into <path d=…> and SMIL <mpath href>. The layout is a pure
 * function of its options (seeded PRNG) so renders are stable and it stays
 * unit-testable without a DOM.
 */

export interface WiredNode {
  x: number
  y: number
  /** Visual radius hint (viewBox units). */
  r: number
}

export interface WiredCable {
  /** Stable id — referenced by <path id> and the pulse's SMIL <mpath href>. */
  id: string
  /** SVG path data ("M… C…"). */
  d: string
  /** Endpoint node indices, always `from < to` (deduped, undirected). */
  from: number
  to: number
  /** Straight-line endpoint distance — drives pulse duration / dash length. */
  length: number
}

export interface WiredNetwork {
  nodes: WiredNode[]
  cables: WiredCable[]
}

export interface WiredNetworkOptions {
  width: number
  height: number
  /** Target node count; laid out on the nearest grid that holds them. */
  nodeCount?: number
  /** Links from each node to its nearest neighbours. */
  linksPerNode?: number
  seed?: number
}

/** Mulberry32 — tiny deterministic PRNG yielding numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Cubic-bézier "cable" between two nodes. `curvature` bows the cable out
 * perpendicular to the a→b line (signed: ± picks the side); 0 = straight.
 */
export function cablePath(a: WiredNode, b: WiredNode, curvature = 0.2): string {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // Unit normal to the segment.
  const nx = -dy / len
  const ny = dx / len
  const off = len * curvature
  const c1x = round(a.x + dx * 0.25 + nx * off)
  const c1y = round(a.y + dy * 0.25 + ny * off)
  const c2x = round(b.x - dx * 0.25 + nx * off)
  const c2y = round(b.y - dy * 0.25 + ny * off)
  return `M${round(a.x)},${round(a.y)} C${c1x},${c1y} ${c2x},${c2y} ${round(b.x)},${round(b.y)}`
}

/**
 * Lay out `nodeCount` nodes on a jittered grid sized to the box, then link each
 * to its `linksPerNode` nearest neighbours (undirected, deduped).
 */
export function buildWiredNetwork({
  width,
  height,
  nodeCount = 15,
  linksPerNode = 2,
  seed = 1,
}: WiredNetworkOptions): WiredNetwork {
  const rnd = mulberry32(seed)

  // Grid proportioned to the box so cells stay roughly square.
  const cols = Math.max(2, Math.round(Math.sqrt(nodeCount * (width / height))))
  const rows = Math.max(2, Math.ceil(nodeCount / cols))
  const cellW = width / cols
  const cellH = height / rows

  const nodes: WiredNode[] = []
  for (let r = 0; r < rows && nodes.length < nodeCount; r++) {
    for (let c = 0; c < cols && nodes.length < nodeCount; c++) {
      const jx = (rnd() - 0.5) * cellW * 0.55
      const jy = (rnd() - 0.5) * cellH * 0.55
      const x = round(clamp(cellW * (c + 0.5) + jx, 0, width))
      const y = round(clamp(cellH * (r + 0.5) + jy, 0, height))
      nodes.push({ x, y, r: round(2 + rnd() * 2) })
    }
  }

  const seen = new Set<string>()
  const cables: WiredCable[] = []
  for (let i = 0; i < nodes.length; i++) {
    const neighbours = nodes
      .map((n, j) => ({ j, d2: dist2(nodes[i], n) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d2 - b.d2)
    const links = Math.min(linksPerNode, neighbours.length)
    for (let k = 0; k < links; k++) {
      const j = neighbours[k].j
      const lo = Math.min(i, j)
      const hi = Math.max(i, j)
      const key = `${lo}-${hi}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = nodes[lo]
      const b = nodes[hi]
      const curvature = 0.12 + rnd() * 0.16 // gentle bow
      const side = rnd() < 0.5 ? -1 : 1
      cables.push({
        id: `shc-${key}`,
        d: cablePath(a, b, curvature * side),
        from: lo,
        to: hi,
        length: round(Math.sqrt(neighbours[k].d2)),
      })
    }
  }

  return { nodes, cables }
}

function dist2(a: WiredNode, b: WiredNode): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
