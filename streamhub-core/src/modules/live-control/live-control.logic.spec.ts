/**
 * Live-control PURE logic specs — the state machine + cover resolution. No DI,
 * no SQLite: these lock the invariants the service relies on.
 */
import {
  AppDefaults,
  canTransition,
  isCovered,
  opTarget,
  resolveCover,
} from './live-control.logic';

const DEFAULTS: AppDefaults = {
  defaultMode: 'text',
  defaultCardTitle: 'Back soon',
  defaultCardText: 'Paused.',
  defaultCardColor: '#0b0b0f',
  defaultPauseAssetId: 10,
  defaultFinishAssetId: 20,
};

describe('opTarget', () => {
  it('maps each op to its target state', () => {
    expect(opTarget('pause')).toBe('paused');
    expect(opTarget('resume')).toBe('live');
    expect(opTarget('finish')).toBe('finished');
  });
});

describe('canTransition', () => {
  it('allows the intended graph', () => {
    expect(canTransition('live', 'paused')).toBe(true);
    expect(canTransition('live', 'finished')).toBe(true);
    expect(canTransition('paused', 'live')).toBe(true);
    expect(canTransition('paused', 'finished')).toBe(true);
    expect(canTransition('finished', 'live')).toBe(true);
    expect(canTransition('finished', 'paused')).toBe(true);
  });

  it('treats same-state as a no-op except re-pause (swap the cover)', () => {
    expect(canTransition('live', 'live')).toBe(false);
    expect(canTransition('finished', 'finished')).toBe(false);
    expect(canTransition('paused', 'paused')).toBe(true);
  });
});

describe('isCovered', () => {
  it('is true only for paused/finished', () => {
    expect(isCovered('live')).toBe(false);
    expect(isCovered('paused')).toBe(true);
    expect(isCovered('finished')).toBe(true);
  });
});

describe('resolveCover', () => {
  it('returns null for a live stream', () => {
    expect(resolveCover('live', {}, DEFAULTS)).toBeNull();
  });

  it('paused with no override → app default text card', () => {
    const c = resolveCover('paused', {}, DEFAULTS);
    expect(c).toEqual({
      mode: 'text',
      assetId: null,
      cardTitle: 'Back soon',
      cardText: 'Paused.',
      cardColor: '#0b0b0f',
    });
  });

  it('image default with a phase asset uses the pause vs finish asset', () => {
    const d: AppDefaults = { ...DEFAULTS, defaultMode: 'image' };
    expect(resolveCover('paused', {}, d)?.assetId).toBe(10);
    expect(resolveCover('finished', {}, d)?.assetId).toBe(20);
  });

  it('per-stream override wins over the app default', () => {
    const c = resolveCover(
      'paused',
      { mode: 'video', assetId: 99, cardColor: '#fff' },
      DEFAULTS,
    );
    expect(c).toMatchObject({ mode: 'video', assetId: 99, cardColor: '#fff' });
  });

  it('image/video with no resolvable asset degrades to a text card', () => {
    const d: AppDefaults = {
      ...DEFAULTS,
      defaultMode: 'image',
      defaultPauseAssetId: null,
    };
    const c = resolveCover('paused', {}, d);
    expect(c?.mode).toBe('text');
    expect(c?.assetId).toBeNull();
  });

  it('a text card never carries an asset id', () => {
    const c = resolveCover('finished', { mode: 'text', assetId: 5 }, DEFAULTS);
    expect(c?.mode).toBe('text');
    expect(c?.assetId).toBeNull();
  });
});
