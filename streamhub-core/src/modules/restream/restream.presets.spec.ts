/**
 * Unit specs for the restream preset helpers (pure — no wiring).
 *
 * Locks down:
 *  - destination URL building per platform (base + key) and custom URLs;
 *  - input validation (missing key/url, bad scheme, slashes in keys);
 *  - stream-key masking: the FULL key never survives maskRtmpUrl.
 */
import {
  buildTargetUrl,
  isRtmpUrl,
  maskRtmpUrl,
  RESTREAM_PRESETS,
} from './restream.presets';

describe('restream presets — buildTargetUrl', () => {
  it('builds the YouTube push URL from base + key', () => {
    expect(buildTargetUrl('youtube', { key: 'abcd-efgh-ijkl' })).toBe(
      'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl',
    );
  });

  it('builds the Twitch push URL from base + key', () => {
    expect(buildTargetUrl('twitch', { key: 'live_123_abc' })).toBe(
      'rtmp://live.twitch.tv/app/live_123_abc',
    );
  });

  it('builds the Facebook push URL (rtmps) from base + key', () => {
    expect(buildTargetUrl('facebook', { key: 'FB-123-XYZ' })).toBe(
      'rtmps://live-api-s.facebook.com:443/rtmp/FB-123-XYZ',
    );
  });

  it('custom: uses the pasted URL verbatim', () => {
    expect(
      buildTargetUrl('custom', { url: 'rtmp://ingest.example.com/live/key1' }),
    ).toBe('rtmp://ingest.example.com/live/key1');
  });

  it('custom: appends the key as last segment when both are given', () => {
    expect(
      buildTargetUrl('custom', { url: 'rtmp://ingest.example.com/live/', key: 'k9' }),
    ).toBe('rtmp://ingest.example.com/live/k9');
  });

  it('rejects a preset without a key', () => {
    expect(() => buildTargetUrl('youtube', {})).toThrow(/stream key is required/i);
  });

  it('rejects keys containing slashes or spaces (URL smuggling)', () => {
    expect(() => buildTargetUrl('twitch', { key: 'a/b' })).toThrow(/slash/i);
    expect(() => buildTargetUrl('twitch', { key: 'a b' })).toThrow(/space/i);
  });

  it('rejects a custom destination without url / with a non-rtmp scheme', () => {
    expect(() => buildTargetUrl('custom', {})).toThrow(/url is required/i);
    expect(() =>
      buildTargetUrl('custom', { url: 'https://example.com/live' }),
    ).toThrow(/rtmp/i);
  });

  it('every preset base is itself a valid rtmp(s) URL', () => {
    for (const { base } of Object.values(RESTREAM_PRESETS)) {
      expect(isRtmpUrl(base)).toBe(true);
    }
  });
});

describe('restream presets — maskRtmpUrl', () => {
  it('masks the stream key (last path segment), keeping a 4-char hint', () => {
    const masked = maskRtmpUrl('rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl');
    expect(masked).toBe('rtmp://a.rtmp.youtube.com/live2/abcd…');
    expect(masked).not.toContain('abcd-efgh-ijkl');
  });

  it('fully hides short keys (≤ 4 chars)', () => {
    expect(maskRtmpUrl('rtmp://host/app/key1')).toBe('rtmp://host/app/…');
  });

  it('leaves host-only URLs untouched (nothing to hide)', () => {
    expect(maskRtmpUrl('rtmp://host')).toBe('rtmp://host');
  });

  it('never leaks the key even when it embeds query params', () => {
    const url = 'rtmps://live-api-s.facebook.com:443/rtmp/FB-SECRET?ds=1&a=2';
    const masked = maskRtmpUrl(url);
    expect(masked).not.toContain('FB-SECRET');
    expect(masked).not.toContain('ds=1');
  });
});
