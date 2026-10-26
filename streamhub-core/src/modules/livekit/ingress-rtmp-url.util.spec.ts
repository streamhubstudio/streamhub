/**
 * Unit spec — public RTMP / RTMPS ingest URL contract (ingress-rtmp-url.util).
 *
 * Pins the exact push-URL strings surfaced by POST /apps/:app/ingress and the
 * ingress listing, so OBS-style clients get a stable contract:
 *   - rtmp_url  = rtmp://<host>:1935/live/<key>            (always, when keyed)
 *   - rtmps_url = rtmps://<host>:<port>/live/<key>         (ONLY when enabled)
 * The RTMPS front is transparent (stunnel :port → ingress :1935), so the only
 * differences from the rtmp:// URL are the scheme and the port.
 */
import {
  buildPassthroughRtmpUrl,
  buildPassthroughSrtUrl,
  buildRtmpUrl,
  buildRtmpsUrl,
  DEFAULT_RTMP_HOST,
  type RtmpUrlConfig,
} from './ingress-rtmp-url.util';

const base: RtmpUrlConfig = {
  rtmpPublicHost: 'media.example.com',
  rtmpsEnable: false,
  rtmpsPublicHost: '',
  rtmpsPort: 1936,
};

describe('buildRtmpUrl', () => {
  it('builds rtmp://<host>:1935/live/<key> from RTMP_PUBLIC_HOST', () => {
    expect(buildRtmpUrl('abc123', base)).toBe(
      'rtmp://media.example.com:1935/live/abc123',
    );
  });

  it('falls back to the legacy default host when RTMP_PUBLIC_HOST is empty', () => {
    expect(buildRtmpUrl('k', { ...base, rtmpPublicHost: '' })).toBe(
      `rtmp://${DEFAULT_RTMP_HOST}:1935/live/k`,
    );
  });

  it('returns undefined when there is no stream key', () => {
    expect(buildRtmpUrl(undefined, base)).toBeUndefined();
    expect(buildRtmpUrl('', base)).toBeUndefined();
  });
});

describe('buildRtmpsUrl', () => {
  it('returns undefined when RTMPS is disabled (default, backward-compat)', () => {
    expect(buildRtmpsUrl('abc123', base)).toBeUndefined();
  });

  it('builds rtmps://<host>:<port>/live/<key> when enabled', () => {
    expect(buildRtmpsUrl('abc123', { ...base, rtmpsEnable: true })).toBe(
      'rtmps://media.example.com:1936/live/abc123',
    );
  });

  it('honours a custom RTMPS port', () => {
    expect(
      buildRtmpsUrl('k', { ...base, rtmpsEnable: true, rtmpsPort: 8443 }),
    ).toBe('rtmps://media.example.com:8443/live/k');
  });

  it('prefers RTMPS_PUBLIC_HOST over RTMP_PUBLIC_HOST when set', () => {
    expect(
      buildRtmpsUrl('k', {
        ...base,
        rtmpsEnable: true,
        rtmpsPublicHost: 'rtmps.example.com',
      }),
    ).toBe('rtmps://rtmps.example.com:1936/live/k');
  });

  it('falls back to RTMP_PUBLIC_HOST, then the default host', () => {
    expect(
      buildRtmpsUrl('k', { ...base, rtmpsEnable: true, rtmpsPublicHost: '' }),
    ).toBe('rtmps://media.example.com:1936/live/k');
    expect(
      buildRtmpsUrl('k', {
        rtmpPublicHost: '',
        rtmpsPublicHost: '',
        rtmpsEnable: true,
        rtmpsPort: 1936,
      }),
    ).toBe(`rtmps://${DEFAULT_RTMP_HOST}:1936/live/k`);
  });

  it('shares the rtmp:// path + key — only scheme and port differ', () => {
    const cfg = { ...base, rtmpsEnable: true };
    const rtmp = buildRtmpUrl('sameKey', cfg)!;
    const rtmps = buildRtmpsUrl('sameKey', cfg)!;
    expect(rtmps).toBe(
      rtmp.replace(/^rtmp:/, 'rtmps:').replace(':1935/', ':1936/'),
    );
  });

  it('returns undefined without a stream key even when enabled', () => {
    expect(buildRtmpsUrl(undefined, { ...base, rtmpsEnable: true })).toBeUndefined();
  });
});

describe('buildPassthroughRtmpUrl', () => {
  it('builds rtmp://<host>:<port>/<app>/<key> — its OWN port + /<app>/ path', () => {
    expect(
      buildPassthroughRtmpUrl('ptk_abc', {
        host: 'media.example.com',
        port: 1937,
        app: 'live',
      }),
    ).toBe('rtmp://media.example.com:1937/live/ptk_abc');
  });

  it('is distinct from the LiveKit RTMP URL (never :1935, never /live/)', () => {
    const url = buildPassthroughRtmpUrl('ptk_x', {
      host: 'h.example',
      port: 1937,
      app: 'myapp',
    })!;
    expect(url).not.toContain(':1935');
    expect(url).not.toContain('/live/');
    expect(url).toContain('/myapp/');
  });

  it('falls back to the legacy default host when host is empty', () => {
    expect(
      buildPassthroughRtmpUrl('k', { host: '', port: 1937, app: 'live' }),
    ).toBe(`rtmp://${DEFAULT_RTMP_HOST}:1937/live/k`);
  });

  it('returns undefined without a stream key', () => {
    expect(
      buildPassthroughRtmpUrl(undefined, { host: 'h', port: 1937, app: 'live' }),
    ).toBeUndefined();
  });
});

describe('buildPassthroughSrtUrl', () => {
  it('builds srt://<host>:<port>?streamid=<key> (no path — SRT has none)', () => {
    expect(
      buildPassthroughSrtUrl('ptk_abc', {
        host: 'media.example.com',
        port: 1937,
      }),
    ).toBe('srt://media.example.com:1937?streamid=ptk_abc');
  });

  it('falls back to the legacy default host when host is empty', () => {
    expect(buildPassthroughSrtUrl('k', { host: '', port: 1938 })).toBe(
      `srt://${DEFAULT_RTMP_HOST}:1938?streamid=k`,
    );
  });

  it('returns undefined without a stream key', () => {
    expect(
      buildPassthroughSrtUrl(undefined, { host: 'h', port: 1937 }),
    ).toBeUndefined();
    expect(buildPassthroughSrtUrl('', { host: 'h', port: 1937 })).toBeUndefined();
  });
});
