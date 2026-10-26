/**
 * Unit spec — MediaMTX publish-path classifier (single-port :1935 switch). Pins
 * the routing seam: LiveKit plane (`live/<key>`) vs StreamHub passthrough
 * (`<app>/<key>`) vs garbage, INCLUDING the `live` app collision — a passthrough
 * push whose app is literally `live` must still route to the passthrough plane
 * because the `ptk_` key marks the capability.
 */
import { classifyMediamtxPath } from './mediamtx-path.util';

describe('classifyMediamtxPath', () => {
  it('routes `<app>/<key>` to the passthrough plane', () => {
    expect(classifyMediamtxPath('myapp/ptk_abc')).toEqual({
      kind: 'passthrough',
      app: 'myapp',
      key: 'ptk_abc',
    });
    // A non-ptk key on a non-live app is still the passthrough shape (validated
    // downstream, where an unknown key is rejected).
    expect(classifyMediamtxPath('shop/somekey')).toEqual({
      kind: 'passthrough',
      app: 'shop',
      key: 'somekey',
    });
  });

  it('routes a real LiveKit push `live/<livekitKey>` to the LiveKit plane (carrying the forward key)', () => {
    expect(classifyMediamtxPath('live/sk_livekit')).toEqual({
      kind: 'livekit',
      key: 'sk_livekit',
    });
    expect(classifyMediamtxPath('live/anything')).toEqual({
      kind: 'livekit',
      key: 'anything',
    });
  });

  it('routes a passthrough push on the "live" app (live/ptk_…) to PASSTHROUGH', () => {
    // The default seeded app is `live`; a passthrough key there must NOT be
    // mistaken for the LiveKit namespace.
    expect(classifyMediamtxPath('live/ptk_xyz')).toEqual({
      kind: 'passthrough',
      app: 'live',
      key: 'ptk_xyz',
    });
  });

  it('treats a deeper live/a/b path as the LiveKit plane (forward key = remainder)', () => {
    expect(classifyMediamtxPath('live/a/b')).toEqual({ kind: 'livekit', key: 'a/b' });
  });

  it('is tolerant of a stray leading slash', () => {
    expect(classifyMediamtxPath('/myapp/ptk_abc')).toEqual({
      kind: 'passthrough',
      app: 'myapp',
      key: 'ptk_abc',
    });
  });

  it('marks garbage / non-two-segment paths invalid', () => {
    for (const bad of ['', 'single', 'a/b/c', 'x/y/z/w']) {
      expect(classifyMediamtxPath(bad)).toEqual({ kind: 'invalid' });
    }
  });
});
