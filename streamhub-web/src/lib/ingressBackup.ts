/**
 * Pure helpers for the primary + backup (failover) RTMP stream keys.
 *
 * The backend answers `POST /apps/:app/ingress` (with `backup: true`) with a
 * PRIMARY key/URL plus, when a backup was minted, a BACKUP key/URL — BOTH keys
 * publish into the same room, so the player/playback URL is identical whichever
 * key is live. These helpers normalise that response (tolerating the snake_case
 * and camelCase field aliases the API uses) into a tidy shape the UI renders,
 * and classify a listed ingress row's role. Dependency-free → node:test-able.
 */

export type IngressRole = 'primary' | 'backup'

/** One ingest credential set (OBS "Server" + "Stream Key" live in ../lib/ingest). */
export interface IngressKeySet {
  streamKey?: string
  rtmpUrl?: string
  rtmpsUrl?: string
  /** Optional stream password (only when the app's rtmpPassword feature is on). */
  password?: string
}

/** Normalised primary(+optional backup) view of an ingress create response. */
export interface IngressKeyPair {
  primary: IngressKeySet
  backup?: IngressKeySet
}

/** Minimal shape read here (a superset of the real `Ingress`). */
interface IngressLike {
  [k: string]: unknown
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** First present string among the given keys (field-alias tolerant). */
function pick(ing: IngressLike, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(ing[k])
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * Split an ingress create response into its primary (+ optional backup)
 * credential sets. The primary falls back to the legacy single-key fields
 * (`stream_key`/`rtmp_url`) so a non-backup response still yields a primary set.
 */
export function ingressKeyPair(ing: IngressLike | null | undefined): IngressKeyPair {
  const i = ing ?? {}
  const primary: IngressKeySet = {
    streamKey: pick(i, ['primaryStreamKey', 'stream_key', 'streamKey']),
    rtmpUrl: pick(i, ['primary_rtmp_url', 'rtmp_url', 'rtmpUrl']),
    rtmpsUrl: pick(i, ['primary_rtmps_url', 'rtmps_url']),
    password: pick(i, ['stream_password']),
  }
  const backupKey = pick(i, ['backupStreamKey', 'backup_stream_key'])
  const backup: IngressKeySet | undefined = backupKey
    ? {
        streamKey: backupKey,
        rtmpUrl: pick(i, ['backup_rtmp_url']),
        rtmpsUrl: pick(i, ['backup_rtmps_url']),
        password: pick(i, ['backup_stream_password']),
      }
    : undefined
  return backup ? { primary, backup } : { primary }
}

/** Whether an ingress create response carries a backup (failover) key. */
export function hasBackupKey(ing: IngressLike | null | undefined): boolean {
  return !!ingressKeyPair(ing).backup
}

/** Role of a listed ingress row, when the backend annotated one. */
export function ingressRole(
  ing: IngressLike | null | undefined,
): IngressRole | undefined {
  const role = str((ing ?? {}).role)
  return role === 'primary' || role === 'backup' ? role : undefined
}
