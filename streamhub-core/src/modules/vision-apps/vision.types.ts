/**
 * VISION APPS — shared domain types (leaf module, no Nest/service imports).
 *
 * Kept dependency-free so the pure settings validator, the store, the sink and
 * the Nest services can all import these shapes without an import cycle. The four
 * models are now four first-class Studio Apps (Edge-as-capability); a model id IS
 * a plugin id (occupancy / counting / crowd / demography).
 */

/** The four vision models a stream can run. */
export const VISION_MODELS = [
  'occupancy',
  'counting',
  'crowd',
  'demography',
] as const;
export type VisionModel = (typeof VISION_MODELS)[number];

/** True for one of the four known model ids. */
export function isVisionModel(v: unknown): v is VisionModel {
  return typeof v === 'string' && (VISION_MODELS as readonly string[]).includes(v);
}

/**
 * The DOMAIN EVENT names the vision worker family may emit — the UNION of the
 * four apps' manifest `events` allowlists. Duplicated here (not imported from the
 * metas) so the leaf stays free of the plugin-contract import; the sink routes
 * each into its model's per-app db via {@link eventModel}.
 */
export const VISION_EVENTS = [
  'occupancy.session_started',
  'occupancy.session_ended',
  'occupancy.alert',
  'count.in',
  'count.out',
  'count.occupancy',
  'crowd.count',
  'crowd.threshold',
  'demography.face',
] as const;
export type VisionEventName = (typeof VISION_EVENTS)[number];

/** The event-name prefixes that route into the vision sink (vision.db + log). */
export const VISION_EVENT_PREFIXES = [
  'occupancy.',
  'count.',
  'crowd.',
  'demography.',
] as const;

/** Which model a `<family>.<name>` event belongs to (drives the sink table). */
export function eventModel(event: string): VisionModel | null {
  if (event.startsWith('occupancy.')) return 'occupancy';
  if (event.startsWith('count.')) return 'counting';
  if (event.startsWith('crowd.')) return 'crowd';
  if (event.startsWith('demography.')) return 'demography';
  return null;
}

/** True when the event name is one this plugin family owns (sink routing). */
export function isVisionEvent(event: string): boolean {
  return VISION_EVENT_PREFIXES.some((p) => event.startsWith(p));
}

// ---------------------------------------------------------------------------
// Per-model config_json schemas (Wave-2 CONTRACT §"Polygon/line config schema")
// ---------------------------------------------------------------------------

/** A normalized [0,1] point over the video frame (x, y). */
export type NormPoint = [number, number];

/** What a zone counts. Spanish domain labels are the contract's ('personas'|'vehiculos'). */
export type ZoneDetect = 'personas' | 'vehiculos';

/** A tagged polygon zone (occupancy + crowd). */
export interface ZoneConfig {
  id: string;
  /** Tag slug this zone is associated with (empty = none). */
  tag: string;
  detect: ZoneDetect;
  /** Polygon vertices, normalized 0–1, screen coords (y down). >= 3 points. */
  points: NormPoint[];
  confidence?: number;
  /** Occupancy alert threshold (persons/vehicles inside). */
  alertLimit?: number;
  /** Sustain seconds before an over-limit becomes an alert. */
  alertAfterSec?: number;
}

/** A tagged counting line + its inside side. */
export interface LineConfig {
  id: string;
  tag: string;
  /** Line anchor + geometry, normalized 0–1. */
  x: number;
  y: number;
  length: number;
  angle: number;
  inside: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * A generic tagged POI polygon (owner item 34) — a named region ANY model can
 * gate detections to. Lighter than a ZoneConfig (no class/alert): just id + tag
 * + polygon. Used by counting + demography; occupancy/crowd already gate by
 * their richer ZoneConfig polygons.
 */
export interface PoiConfig {
  id: string;
  tag: string;
  /** Polygon vertices, normalized 0–1, screen coords (y down). >= 3 points. */
  points: NormPoint[];
}

/** occupancy / crowd config_json. */
export interface ZonesConfig {
  zones: ZoneConfig[];
}

/** counting config_json. */
export interface LinesConfig {
  lines: LineConfig[];
  fps: number;
  capacity?: number;
  /** Optional POIs: a crossing only counts inside one, and carries its name. */
  pois?: PoiConfig[];
}

/** demography config_json. */
export interface DemographyConfig {
  roi?: { points: NormPoint[] };
  /** Optional tagged POIs: a face is gated + stamped by the POI it falls in. */
  pois?: PoiConfig[];
  intervalSec: number;
  engine: 'local' | 'openai' | 'deepseek';
  aiPrompt?: string;
  aiBudgetMonthly?: number;
}

/** Any model's resolved config_json (opaque record at the wire). */
export type ModelConfig = Record<string, unknown>;
