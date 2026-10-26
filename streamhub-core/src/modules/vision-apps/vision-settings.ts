/**
 * VISION EDGE — PURE per-model settings validation + normalization.
 *
 * `validateModelSettings(model, raw)` turns an untrusted `config_json` body into
 * the canonical, storable shape for that model (Wave-2 CONTRACT schemas), or
 * throws {@link VisionSettingsError} (→ 400 at the controller). Dependency-free
 * and side-effect-free so it is trivially unit-testable and reusable by the
 * scheduler when it resolves an assignment's config.
 *
 * Normalization rules:
 *   - polygon / line / ROI coordinates are clamped to [0,1] and rounded to 4
 *     decimals (sub-pixel at any resolution);
 *   - a polygon needs >= 3 points, a line a positive length;
 *   - ids are trimmed non-empty strings (auto-filled when absent);
 *   - unknown keys are dropped (only the schema fields survive), so nothing a
 *     client sends can smuggle extra state into an assignment frame.
 */
import {
  DemographyConfig,
  LineConfig,
  LinesConfig,
  ModelConfig,
  NormPoint,
  PoiConfig,
  VisionModel,
  ZoneConfig,
  ZonesConfig,
  isVisionModel,
} from './vision.types';

/** Thrown on an invalid settings body; the controller maps it to 400. */
export class VisionSettingsError extends Error {}

const DETECTS = new Set(['personas', 'vehiculos']);
const INSIDES = new Set(['top', 'bottom', 'left', 'right']);
const ENGINES = new Set(['local', 'openai', 'deepseek']);

function clamp01(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new VisionSettingsError('coordinate must be a finite number');
  }
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function optNum(v: unknown, lo: number, hi: number, label: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new VisionSettingsError(`${label} must be a number`);
  }
  return Math.min(hi, Math.max(lo, n));
}

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VisionSettingsError(`${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function normPoints(raw: unknown, label: string): NormPoint[] {
  if (!Array.isArray(raw)) throw new VisionSettingsError(`${label} must be an array of [x,y] points`);
  return raw.map((p) => {
    if (!Array.isArray(p) || p.length < 2) {
      throw new VisionSettingsError(`${label} point must be [x,y]`);
    }
    return [clamp01(p[0]), clamp01(p[1])] as NormPoint;
  });
}

function trimId(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || fallback;
}

function trimTag(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// ---------------------------------------------------------------------------
// Per-model validators
// ---------------------------------------------------------------------------

function validateZone(raw: unknown, index: number): ZoneConfig {
  const o = asObject(raw, `zone[${index}]`);
  const points = normPoints(o.points, `zone[${index}].points`);
  if (points.length < 3) {
    throw new VisionSettingsError(`zone[${index}] needs at least 3 points`);
  }
  const detect = o.detect === 'vehiculos' ? 'vehiculos' : 'personas';
  if (o.detect !== undefined && !DETECTS.has(String(o.detect))) {
    throw new VisionSettingsError(`zone[${index}].detect must be personas|vehiculos`);
  }
  const zone: ZoneConfig = {
    id: trimId(o.id, `zone-${index + 1}`),
    tag: trimTag(o.tag),
    detect,
    points,
  };
  const confidence = optNum(o.confidence, 0, 1, `zone[${index}].confidence`);
  if (confidence !== undefined) zone.confidence = round4(confidence);
  const alertLimit = optNum(o.alertLimit, 0, 100000, `zone[${index}].alertLimit`);
  if (alertLimit !== undefined) zone.alertLimit = Math.round(alertLimit);
  const alertAfterSec = optNum(o.alertAfterSec, 0, 86400, `zone[${index}].alertAfterSec`);
  if (alertAfterSec !== undefined) zone.alertAfterSec = Math.round(alertAfterSec);
  return zone;
}

function validateZones(raw: Record<string, unknown>): ZonesConfig {
  const zonesRaw = raw.zones;
  if (zonesRaw !== undefined && !Array.isArray(zonesRaw)) {
    throw new VisionSettingsError('zones must be an array');
  }
  const zones = Array.isArray(zonesRaw) ? zonesRaw.map((z, i) => validateZone(z, i)) : [];
  return { zones };
}

function validatePoi(raw: unknown, index: number): PoiConfig {
  const o = asObject(raw, `poi[${index}]`);
  const points = normPoints(o.points, `poi[${index}].points`);
  if (points.length < 3) {
    throw new VisionSettingsError(`poi[${index}] needs at least 3 points`);
  }
  return {
    id: trimId(o.id, `poi-${index + 1}`),
    tag: trimTag(o.tag),
    points,
  };
}

/** Optional per-stream POIs (owner item 34); absent → the field is omitted. */
function validatePois(raw: Record<string, unknown>): PoiConfig[] | undefined {
  const poisRaw = raw.pois;
  if (poisRaw === undefined) return undefined;
  if (!Array.isArray(poisRaw)) throw new VisionSettingsError('pois must be an array');
  return poisRaw.map((p, i) => validatePoi(p, i));
}

function validateLine(raw: unknown, index: number): LineConfig {
  const o = asObject(raw, `line[${index}]`);
  const length = optNum(o.length, 0, 2, `line[${index}].length`);
  if (length === undefined || length <= 0) {
    throw new VisionSettingsError(`line[${index}] needs a positive length`);
  }
  const inside = String(o.inside ?? '');
  if (!INSIDES.has(inside)) {
    throw new VisionSettingsError(`line[${index}].inside must be top|bottom|left|right`);
  }
  const angleRaw = optNum(o.angle, -360, 360, `line[${index}].angle`);
  return {
    id: trimId(o.id, `line-${index + 1}`),
    tag: trimTag(o.tag),
    x: clamp01(o.x),
    y: clamp01(o.y),
    length: round4(length),
    angle: round4(angleRaw ?? 0),
    inside: inside as LineConfig['inside'],
  };
}

function validateLines(raw: Record<string, unknown>): LinesConfig {
  const linesRaw = raw.lines;
  if (linesRaw !== undefined && !Array.isArray(linesRaw)) {
    throw new VisionSettingsError('lines must be an array');
  }
  const lines = Array.isArray(linesRaw) ? linesRaw.map((l, i) => validateLine(l, i)) : [];
  const fps = optNum(raw.fps, 0.5, 30, 'fps') ?? 3.5;
  const out: LinesConfig = { lines, fps: round4(fps) };
  const capacity = optNum(raw.capacity, 0, 1000000, 'capacity');
  if (capacity !== undefined) out.capacity = Math.round(capacity);
  const pois = validatePois(raw);
  if (pois !== undefined) out.pois = pois;
  return out;
}

function validateDemography(raw: Record<string, unknown>): DemographyConfig {
  const engine = String(raw.engine ?? 'local');
  if (!ENGINES.has(engine)) {
    throw new VisionSettingsError('engine must be local|openai|deepseek');
  }
  const out: DemographyConfig = {
    intervalSec: Math.round(optNum(raw.intervalSec, 5, 86400, 'intervalSec') ?? 120),
    engine: engine as DemographyConfig['engine'],
  };
  if (raw.roi !== undefined && raw.roi !== null) {
    const roi = asObject(raw.roi, 'roi');
    const points = normPoints(roi.points, 'roi.points');
    if (points.length < 3) throw new VisionSettingsError('roi needs at least 3 points');
    out.roi = { points };
  }
  const pois = validatePois(raw);
  if (pois !== undefined) out.pois = pois;
  if (raw.aiPrompt !== undefined) {
    if (typeof raw.aiPrompt !== 'string') throw new VisionSettingsError('aiPrompt must be a string');
    const p = raw.aiPrompt.trim();
    if (p) out.aiPrompt = p.slice(0, 2000);
  }
  const budget = optNum(raw.aiBudgetMonthly, 0, 1000000, 'aiBudgetMonthly');
  if (budget !== undefined) out.aiBudgetMonthly = round4(budget);
  return out;
}

/**
 * Validate + normalize a per-model `config_json` body. Throws
 * {@link VisionSettingsError} on an unknown model or an invalid shape.
 */
export function validateModelSettings(model: string, raw: unknown): ModelConfig {
  if (!isVisionModel(model)) {
    throw new VisionSettingsError(`unknown model '${model}'`);
  }
  const obj = raw === undefined || raw === null ? {} : asObject(raw, 'config');
  switch (model as VisionModel) {
    case 'occupancy':
    case 'crowd':
      return validateZones(obj) as unknown as ModelConfig;
    case 'counting':
      return validateLines(obj) as unknown as ModelConfig;
    case 'demography':
      return validateDemography(obj) as unknown as ModelConfig;
  }
}

/** The canonical EMPTY config_json for a model (used as the resolution base). */
export function emptyModelSettings(model: VisionModel): ModelConfig {
  switch (model) {
    case 'occupancy':
    case 'crowd':
      return { zones: [] };
    case 'counting':
      return { lines: [], fps: 3.5 };
    case 'demography':
      return { intervalSec: 120, engine: 'local' };
  }
}
