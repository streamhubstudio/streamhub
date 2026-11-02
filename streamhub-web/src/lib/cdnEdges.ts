/**
 * CDN edges (3.4.0) — HLS cache nodes registered with `install.sh --cdn-edge`.
 * They heartbeat `stats = {role: 'cdn-edge', cdn: {conns, reqTotal, txBytes,
 * txMbps, cacheDir}}`; GET /cluster/nodes returns that blob verbatim. Pure,
 * dependency-free helpers for the Cluster page (tested under node:test).
 */

/** The slice of a ClusterNode these helpers read. */
export interface CdnEdgeNodeLike {
  stats?: Record<string, unknown> | null
}

/** The display view of one cdn-edge's heartbeat (`null` = not reported). */
export interface CdnEdgeView {
  gbpsOut: number | null
  conns: number | null
  cacheDir: string | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function cdnBlock(node: CdnEdgeNodeLike): Record<string, unknown> | null {
  const cdn = node.stats?.cdn
  return cdn != null && typeof cdn === 'object' && !Array.isArray(cdn)
    ? (cdn as Record<string, unknown>)
    : null
}

/** A node is a cdn-edge when its heartbeat says so (role or a cdn block). */
export function isCdnEdge(node: CdnEdgeNodeLike): boolean {
  return node.stats?.role === 'cdn-edge' || cdnBlock(node) != null
}

/** Gbps out (txMbps / 1000), connections and cache dir of a cdn-edge. */
export function cdnEdgeView(node: CdnEdgeNodeLike): CdnEdgeView {
  const cdn = cdnBlock(node)
  const mbps = num(cdn?.txMbps)
  const conns = num(cdn?.conns)
  return {
    gbpsOut: mbps == null ? null : mbps / 1000,
    conns: conns == null ? null : Math.round(conns),
    cacheDir: typeof cdn?.cacheDir === 'string' && cdn.cacheDir ? cdn.cacheDir : null,
  }
}

/** "1.23" Gbps (two decimals; three under 0.1 so a trickle is not "0.00"). */
export function formatGbps(gbps: number | null, empty = '—'): string {
  if (gbps == null || !Number.isFinite(gbps) || gbps < 0) return empty
  return gbps > 0 && gbps < 0.1 ? gbps.toFixed(3) : gbps.toFixed(2)
}

/** Sum of the reported Gbps out (edges that did not report are skipped). */
export function totalGbps(nodes: CdnEdgeNodeLike[]): number {
  return nodes.reduce((sum, n) => sum + (cdnEdgeView(n).gbpsOut ?? 0), 0)
}
