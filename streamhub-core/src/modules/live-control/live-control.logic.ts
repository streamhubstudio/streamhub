/**
 * Live-control PURE logic — the state machine + cover resolution, with ZERO I/O
 * so it is fully unit-testable (no DI, no SQLite, no network). The service is a
 * thin shell that persists + side-effects around these functions.
 */
import type {
  CoverMode,
  LiveControlState,
  StreamOverride,
} from './live-control.store';

/** The operator operations, one per target state. */
export type LiveControlOp = 'pause' | 'resume' | 'finish';

/** Map an operator op to the state it drives the stream into. */
export function opTarget(op: LiveControlOp): LiveControlState {
  switch (op) {
    case 'pause':
      return 'paused';
    case 'finish':
      return 'finished';
    case 'resume':
    default:
      return 'live';
  }
}

/**
 * The allowed state graph. Permissive by design (an operator can always resume a
 * finished stream or pause again) but it locks down the intent so a bad target
 * can never be written. Keyed `from` → set of reachable `to`.
 */
export const TRANSITIONS: Record<LiveControlState, LiveControlState[]> = {
  live: ['paused', 'finished'],
  paused: ['live', 'finished', 'paused'],
  finished: ['live', 'paused'],
};

/**
 * Is moving `from` → `to` allowed? A same-state move is a no-op EXCEPT re-pause
 * (paused→paused) which is allowed so an operator can swap the cover mid-pause.
 */
export function canTransition(from: LiveControlState, to: LiveControlState): boolean {
  if (from === to) return to === 'paused';
  return TRANSITIONS[from].includes(to);
}

/** Whether a target state hides the live feed behind a cover (paused/finished). */
export function isCovered(state: LiveControlState): boolean {
  return state === 'paused' || state === 'finished';
}

/** Per-app defaults (static config + dynamic asset choices) fed to resolveCover. */
export interface AppDefaults {
  defaultMode: CoverMode;
  defaultCardTitle: string;
  defaultCardText: string;
  defaultCardColor: string;
  defaultPauseAssetId: number | null;
  defaultFinishAssetId: number | null;
}

/**
 * The resolved cover to render, BEFORE the service attaches a signed asset URL.
 * `assetId` is meaningful only for image/video modes.
 */
export interface ResolvedCover {
  mode: CoverMode;
  assetId: number | null;
  cardTitle: string | null;
  cardText: string | null;
  cardColor: string;
}

/**
 * Resolve what a paused/finished stream shows: per-stream override wins, else the
 * app default for the phase. An image/video mode with NO resolvable asset falls
 * back to a text card so viewers never see a broken cover. Returns null for a
 * `live` stream (no cover).
 */
export function resolveCover(
  state: LiveControlState,
  override: StreamOverride,
  defaults: AppDefaults,
): ResolvedCover | null {
  if (!isCovered(state)) return null;

  const mode: CoverMode = override.mode ?? defaults.defaultMode;
  const phaseDefaultAsset =
    state === 'finished' ? defaults.defaultFinishAssetId : defaults.defaultPauseAssetId;
  const assetId =
    override.assetId !== undefined && override.assetId !== null
      ? override.assetId
      : phaseDefaultAsset;

  const cardTitle = override.cardTitle ?? defaults.defaultCardTitle;
  const cardText = override.cardText ?? defaults.defaultCardText;
  const cardColor = override.cardColor ?? defaults.defaultCardColor;

  // An image/video cover with no asset degrades to the text card.
  if ((mode === 'image' || mode === 'video') && (assetId === null || assetId === undefined)) {
    return { mode: 'text', assetId: null, cardTitle, cardText, cardColor };
  }

  return {
    mode,
    assetId: mode === 'text' ? null : assetId,
    cardTitle,
    cardText,
    cardColor,
  };
}
