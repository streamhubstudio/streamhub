/**
 * Unit spec — RTMP/SRT→HLS passthrough ffmpeg argv + on-disk layout
 * (remux-args.util). Pins the EXACT command so the remux contract is stable:
 * `-c copy` (never a re-encode), `-listen 1` (ffmpeg is the RTMP acceptor) /
 * `srt://…?mode=listener` (libsrt is the SRT acceptor), the HLS flags, and the
 * output dir that `mountHlsStatic` already serves.
 */
import * as path from 'path';

import {
  buildForwardArgs,
  buildRemuxArgs,
  passthroughHlsDir,
  PASSTHROUGH_HLS_PLAYLIST,
} from './remux-args.util';

describe('passthroughHlsDir', () => {
  it('resolves <dataDir>/apps/<app>/hls/<room> (what mountHlsStatic serves)', () => {
    expect(passthroughHlsDir('/data', 'live', 'live-cam1')).toBe(
      path.join('/data', 'apps', 'live', 'hls', 'live-cam1'),
    );
  });
});

describe('buildRemuxArgs', () => {
  const hlsDir = path.join('/data', 'apps', 'live', 'hls', 'live-ch1');

  it('emits the exact remux argv (-c copy, -listen 1, HLS flags)', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
    });
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-listen',
      '1',
      '-i',
      'rtmp://0.0.0.0:1937/live/ptk_abc',
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, PASSTHROUGH_HLS_PLAYLIST),
    ]);
  });

  it('is a REMUX: contains -c copy and never a video encoder', () => {
    const args = buildRemuxArgs({
      app: 'a',
      streamKey: 'k',
      port: 1937,
      hlsDir,
    });
    expect(args).toContain('copy');
    expect(args.join(' ')).not.toMatch(/libx264|libvpx|-c:v|-b:v|scale=/);
  });

  it('honours a custom port, bind host and HLS window', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'k2',
      port: 1940,
      hlsDir,
      bindHost: '127.0.0.1',
      hlsTime: 2,
      hlsListSize: 10,
    });
    expect(args).toContain('rtmp://127.0.0.1:1940/live/k2');
    const i = args.indexOf('-hls_time');
    expect(args[i + 1]).toBe('2');
    const j = args.indexOf('-hls_list_size');
    expect(args[j + 1]).toBe('10');
  });

  it('the input URL path is /<app>/<key> (NOT LiveKit /live/<key>)', () => {
    const args = buildRemuxArgs({
      app: 'myapp',
      streamKey: 'ptk_xyz',
      port: 1937,
      hlsDir,
    });
    const url = args[args.indexOf('-i') + 1];
    expect(url).toBe('rtmp://0.0.0.0:1937/myapp/ptk_xyz');
    expect(url).not.toContain('/live/');
  });
});

describe('buildRemuxArgs — SRT listener variant', () => {
  const hlsDir = path.join('/data', 'apps', 'live', 'hls', 'live-ch1');

  it('emits the exact SRT argv (-i srt://0.0.0.0:<port>?mode=listener, -c copy, hls)', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
      transport: 'srt',
    });
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      'srt://0.0.0.0:1937?mode=listener',
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, PASSTHROUGH_HLS_PLAYLIST),
    ]);
  });

  it('uses the URL param (mode=listener), never the RTMP-only -listen flag', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
      transport: 'srt',
    });
    expect(args).not.toContain('-listen');
    expect(args[args.indexOf('-i') + 1]).toContain('?mode=listener');
  });

  it('is still a REMUX: -c copy and never a video encoder', () => {
    const args = buildRemuxArgs({
      app: 'a',
      streamKey: 'k',
      port: 1937,
      hlsDir,
      transport: 'srt',
    });
    expect(args).toContain('copy');
    expect(args.join(' ')).not.toMatch(/libx264|libvpx|-c:v|-b:v|scale=/);
  });

  it('honours a custom port and bind host', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'k2',
      port: 1940,
      hlsDir,
      transport: 'srt',
      bindHost: '127.0.0.1',
    });
    expect(args[args.indexOf('-i') + 1]).toBe(
      'srt://127.0.0.1:1940?mode=listener',
    );
  });

  it("transport 'rtmp' (and default) keeps the pre-SRT RTMP argv byte-for-byte", () => {
    const rtmpArgs = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
      transport: 'rtmp',
    });
    const defaultArgs = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
    });
    expect(rtmpArgs).toEqual(defaultArgs);
    expect(rtmpArgs).toContain('-listen');
    expect(rtmpArgs).toContain('rtmp://0.0.0.0:1937/live/ptk_abc');
  });
});

describe('buildRemuxArgs — PULL mode (MediaMTX single-port switch)', () => {
  const hlsDir = path.join('/data', 'apps', 'live', 'hls', 'live-ch1');

  it('emits the exact pull argv (-i rtmp://127.0.0.1:<port>/<app>/<key>, NO -listen)', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1935,
      hlsDir,
      mode: 'pull',
    });
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      'rtmp://127.0.0.1:1935/live/ptk_abc',
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, PASSTHROUGH_HLS_PLAYLIST),
    ]);
  });

  it('never arms a -listen acceptor (it connects OUT to MediaMTX)', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1935,
      hlsDir,
      mode: 'pull',
    });
    expect(args).not.toContain('-listen');
    expect(args[args.indexOf('-i') + 1]).toBe('rtmp://127.0.0.1:1935/live/ptk_abc');
  });

  it('is still a REMUX: -c copy and never a video encoder', () => {
    const args = buildRemuxArgs({
      app: 'a',
      streamKey: 'ptk_k',
      port: 1935,
      hlsDir,
      mode: 'pull',
    });
    expect(args).toContain('copy');
    expect(args.join(' ')).not.toMatch(/libx264|libvpx|-c:v|-b:v|scale=/);
  });

  it('honours a custom pull host', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 11935,
      hlsDir,
      mode: 'pull',
      pullHost: '10.0.0.5',
    });
    expect(args[args.indexOf('-i') + 1]).toBe('rtmp://10.0.0.5:11935/live/ptk_abc');
  });

  it("mode 'listen' (and default) is unchanged — pull is fully opt-in", () => {
    const listenArgs = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
      mode: 'listen',
    });
    const defaultArgs = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 1937,
      hlsDir,
    });
    expect(listenArgs).toEqual(defaultArgs);
    expect(listenArgs).toContain('-listen');
  });
});

describe('buildRemuxArgs — MPEG-TS PULL variant (udp multicast/unicast)', () => {
  const hlsDir = path.join('/data', 'apps', 'live', 'hls', 'live-ch1');

  it('emits the exact MPEG-TS argv (-f mpegts -i udp://@…, NO -listen, -c copy, hls)', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'ptk_abc',
      port: 0,
      hlsDir,
      transport: 'mpegts',
      sourceUrl: 'udp://@239.1.1.1:5000?overrun_nonfatal=1',
    });
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-f',
      'mpegts',
      '-i',
      'udp://@239.1.1.1:5000?overrun_nonfatal=1',
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list',
      '-hls_segment_filename',
      path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, PASSTHROUGH_HLS_PLAYLIST),
    ]);
  });

  it('is a PULL: forces -f mpegts on input and never arms a -listen acceptor', () => {
    const args = buildRemuxArgs({
      app: 'live',
      streamKey: 'k',
      port: 0,
      hlsDir,
      transport: 'mpegts',
      sourceUrl: 'udp://@239.1.1.1:5000?sources=10.0.0.5&overrun_nonfatal=1',
    });
    expect(args).not.toContain('-listen');
    // The `-f mpegts` right before `-i` is the input demuxer, distinct from the
    // `-f hls` output muxer in the tail.
    const iIdx = args.indexOf('-i');
    expect(args[iIdx - 2]).toBe('-f');
    expect(args[iIdx - 1]).toBe('mpegts');
    expect(args[iIdx + 1]).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&overrun_nonfatal=1',
    );
  });

  it('is still a REMUX: -c copy and never a video encoder', () => {
    const args = buildRemuxArgs({
      app: 'a',
      streamKey: 'k',
      port: 0,
      hlsDir,
      transport: 'mpegts',
      sourceUrl: 'udp://@239.1.1.1:5000?overrun_nonfatal=1',
    });
    expect(args).toContain('copy');
    expect(args.join(' ')).not.toMatch(/libx264|libvpx|-c:v|-b:v|scale=/);
  });
});

describe('buildForwardArgs — LiveKit-plane forward (core owns routing)', () => {
  it('emits the exact forward argv (pull :src → -c copy -f flv push :dest, both loopback)', () => {
    const args = buildForwardArgs({
      key: 'sk_livekit',
      sourcePort: 1935,
      destPort: 11935,
    });
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      'rtmp://127.0.0.1:1935/live/sk_livekit',
      '-c',
      'copy',
      '-f',
      'flv',
      'rtmp://127.0.0.1:11935/live/sk_livekit',
    ]);
  });

  it('is a REMUX: -c copy, FLV output, never a video encoder, no -listen', () => {
    const args = buildForwardArgs({ key: 'k', sourcePort: 1935, destPort: 11935 });
    expect(args).toContain('copy');
    expect(args).toContain('flv');
    expect(args).not.toContain('-listen');
    expect(args.join(' ')).not.toMatch(/libx264|libvpx|-c:v|-b:v|scale=/);
  });

  it('honours a custom host and preserves a deeper remainder key', () => {
    const args = buildForwardArgs({
      key: 'a/b',
      sourcePort: 1935,
      destPort: 11935,
      host: '10.0.0.5',
    });
    expect(args[args.indexOf('-i') + 1]).toBe('rtmp://10.0.0.5:1935/live/a/b');
    expect(args[args.length - 1]).toBe('rtmp://10.0.0.5:11935/live/a/b');
  });
});
