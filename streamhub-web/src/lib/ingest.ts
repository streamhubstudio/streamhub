/**
 * Pure helpers around RTMP ingest credentials (URL + stream key).
 *
 * The backend answers each ingress row with `rtmp_url` (the FULL push URL,
 * rtmp://<RTMP_PUBLIC_HOST>:1935/<app-path>/<stream-key>) and `stream_key`.
 * OBS-style encoders want the two halves separately ("Server" / "Stream Key"),
 * so these helpers split/join them. Dependency-free → node:test-able.
 */

export interface IngestParts {
  /** What goes in the encoder's "Server" field. */
  server: string
  /** What goes in the encoder's "Stream Key" field (absent when unknown). */
  key?: string
}

/** Join a server base and a stream key into the full push URL. */
export function joinIngestUrl(
  server?: string | null,
  key?: string | null,
): string | undefined {
  const base = server?.trim().replace(/\/+$/, '')
  if (!base) return undefined
  const k = key?.trim()
  return k ? `${base}/${k}` : base
}

/**
 * Split ingest credentials into OBS-style { server, key }.
 *
 * - When `fullUrl` ends with `/<streamKey>`, the server is the URL minus that
 *   suffix (the canonical backend shape).
 * - Otherwise the URL is already the bare server (LiveKit's ingress `url`)
 *   and the key rides along verbatim.
 * Returns undefined when there is no URL at all.
 */
export function splitIngestUrl(
  fullUrl?: string | null,
  streamKey?: string | null,
): IngestParts | undefined {
  const url = fullUrl?.trim().replace(/\/+$/, '')
  const key = streamKey?.trim() || undefined
  if (!url) return undefined
  if (key && url.endsWith(`/${key}`)) {
    return { server: url.slice(0, url.length - key.length - 1), key }
  }
  return { server: url, key }
}

/**
 * Mask a secret for at-a-glance display: keeps the first `visible` chars and
 * pads with bullets to the original length (capped so huge keys stay short).
 */
export function maskSecret(secret?: string | null, visible = 4): string {
  const s = secret ?? ''
  if (!s) return ''
  const head = s.slice(0, Math.max(0, visible))
  const hidden = Math.min(Math.max(s.length - head.length, 4), 12)
  return `${head}${'•'.repeat(hidden)}`
}
