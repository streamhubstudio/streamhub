/**
 * Pure helpers for the player's connection-quality banner and active-speaker
 * highlight (LIVEKIT-UNUSED-FEATURES: `connectionQualityChanged` +
 * `activeSpeakersChanged`). Framework-free so node:test covers every branch;
 * the components (LivePlayer / VideoStage) are thin shells over these.
 */

/** livekit-client ConnectionQuality values (string enum), normalised. */
export type ConnectionQualityName =
  | 'excellent'
  | 'good'
  | 'poor'
  | 'lost'
  | 'unknown'

const QUALITY_NAMES: ReadonlySet<ConnectionQualityName> = new Set([
  'excellent',
  'good',
  'poor',
  'lost',
  'unknown',
])

/** Fold any raw quality value (enum/string/garbage) to a known name. */
export function normalizeQuality(raw: unknown): ConnectionQualityName {
  const s = typeof raw === 'string' ? (raw.toLowerCase() as ConnectionQualityName) : 'unknown'
  return QUALITY_NAMES.has(s) ? s : 'unknown'
}

/**
 * Whether the viewer should see the "poor connection" banner. Only `poor` and
 * `lost` degrade — `unknown` (pre-first-report) must NOT flash a warning.
 */
export function isDegradedQuality(raw: unknown): boolean {
  const q = normalizeQuality(raw)
  return q === 'poor' || q === 'lost'
}

/**
 * Ring classes for a video tile: an accent ring while its participant is
 * speaking, the default hairline otherwise. Centralised so every player stage
 * highlights speakers identically.
 */
export function speakingRingClass(isSpeaking: boolean): string {
  return isSpeaking
    ? 'ring-2 ring-primary-400/90'
    : 'ring-1 ring-white/10'
}
