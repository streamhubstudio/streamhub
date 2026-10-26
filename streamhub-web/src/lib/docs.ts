/**
 * Section → docs-page map for the contextual help links (<DocsHint/>).
 *
 * Single source of truth: every dashboard surface that offers a "?" help
 * affordance resolves its target here, so links stay consistent and adding a
 * new one is a one-line change. Paths are RELATIVE to the docs site root
 * (DOCS_URL, see lib/links.ts — the streamhub.studio/docs mirror) whose slugs
 * mirror the `streamhub-docs/` file tree (same path, no `.md`). docs.spec.ts
 * verifies each mapped path corresponds to a real `streamhub-docs/<path>.md`
 * page — only link to pages that exist.
 *
 * Runtime-dep-free (plain TS) so it stays testable under node:test.
 */
// Explicit .ts extension so the module also loads under node:test
// (type-stripping) — same convention as the other src/lib specs.
import { DOCS_URL } from './links.ts'

export const DOCS_PATHS = {
  /** Multi-tenant apps (the Apps page / app concept). */
  apps: 'features/apps-multitenant',
  /** Outbound signed callbacks / integrations. */
  callbacks: 'features/callbacks',
  /** Serving VODs through a CDN. */
  cdnVod: 'features/CDN-VOD',
  /** Multi-node cluster + its observability. */
  cluster: 'operations/CLUSTER-OBSERVABILITY',
  /** Per-app config.yaml reference (Config tab). */
  config: 'config-reference',
  /** DB maintenance / app upkeep (Sistema tab). */
  dbMaintenance: 'features/db-maintenance',
  /** Low-latency HLS live playback. */
  hlsLive: 'features/hls-live',
  /** RTMP/WHIP/RTSP ingest + stream keys (incl. backup keys). */
  ingress: 'features/ingress',
  /** Metrics / logs / observability surfaces. */
  observability: 'features/observability',
  /** The animated per-app pipeline diagram. */
  pipeline: 'features/pipeline-diagram',
  /** Embeddable / built-in players. */
  players: 'features/players',
  /** Plugin framework + shipped plugins. */
  plugins: 'features/plugins',
  /** Recording to per-app S3 (VODs tab). */
  recording: 'features/recording',
  /** RTMP→HLS passthrough (remux, no transcode) ingest. */
  rtmpPassthrough: 'features/rtmp-passthrough',
  /** Sample pages / example embeds. */
  samples: 'features/samples',
  /** Live streams lifecycle. */
  streams: 'features/streams',
  /** API tokens & play tokens. */
  tokens: 'features/tokens',
  /** VOD management/playback. */
  vod: 'features/vod',
} as const

export type DocsSection = keyof typeof DOCS_PATHS

/** Absolute docs URL for a mapped section. */
export function docsUrl(section: DocsSection): string {
  return `${DOCS_URL}/${DOCS_PATHS[section]}`
}
