/**
 * Pure builders for the RTMP/SRT→HLS passthrough (remux) ffmpeg command +
 * on-disk layout. No DI, no side effects — so the exact argv + HLS paths can be
 * pinned under jest without spawning ffmpeg (mirrors vod-transcode.util.ts style).
 *
 * REMUX, not transcode: `-c copy` streams-copies the incoming H.264/AAC into an
 * HLS playlist + `.ts` segments (near-zero CPU, no GPU). The output dir is the
 * SAME `<DATA_DIR>/apps/<app>/hls/<room>/` that `main.ts mountHlsStatic` serves
 * under `/hls/<app>/<room>/…`, so playback is free (no player change).
 *
 * INGEST FRONT (implementation note): we have no pure-JS RTMP/SRT server
 * dependency (see features/rtmp-passthrough.md for the node-media-server
 * evaluation), so ffmpeg ITSELF is the acceptor on the passthrough port:
 *  - RTMP: `-listen 1 -i rtmp://0.0.0.0:<port>/<app>/<key>` (TCP);
 *  - SRT:  `-i srt://0.0.0.0:<port>?mode=listener` (UDP, libsrt — the
 *    `mode=listener` URL param replaces `-listen 1`; the receive latency budget
 *    stays libsrt's default ~120 ms unless the encoder negotiates more).
 * The listener binds `0.0.0.0` so an external encoder (OBS/ffmpeg) can push to
 * it; only a REGISTERED passthrough key ever gets a listener armed, so an
 * unknown key finds no server (connection refused) and nothing is spawned.
 * NOTE (SRT auth): ffmpeg's srt listener does NOT enforce a streamid match, so
 * — exactly like the RTMP plane — the minted key stays the capability: no key
 * registered ⇒ no listener armed on that port. The push URL still carries
 * `?streamid=<key>` for encoder compatibility/traceability.
 */
import * as path from 'path';

/**
 * Ingest transport of a passthrough ingress.
 *  - `rtmp` / `srt` — push LISTENERS: ffmpeg IS the acceptor (`-listen 1` /
 *    `mode=listener`) on a per-ingress port; the minted key gates the listener.
 *  - `mpegts` — a PULL source: there is no client push. ffmpeg connects OUT to a
 *    multicast group / unicast port with `-f mpegts -i udp://@GROUP:PORT?…`. The
 *    source URL rides in {@link RemuxArgsOptions.sourceUrl} (built + validated by
 *    mpegts-source.util); no port is bound from the passthrough pool.
 */
export type PassthroughTransport = 'rtmp' | 'srt' | 'mpegts';

/** libsrt's default receive latency budget (ms) — surfaced as a capability note. */
export const PASSTHROUGH_SRT_LATENCY_MS = 120;

/** Playlist filename written into the app's HLS room dir. */
export const PASSTHROUGH_HLS_PLAYLIST = 'index.m3u8';
/** Default HLS target segment duration (seconds). */
export const PASSTHROUGH_HLS_TIME = 4;
/** Default rolling live-window size (segments kept in the playlist). */
export const PASSTHROUGH_HLS_LIST_SIZE = 6;
/** Bind address for the ffmpeg `-listen 1` RTMP acceptor. */
export const PASSTHROUGH_LISTEN_HOST = '0.0.0.0';
/** Loopback host the PULL-mode remux fetches from (MediaMTX front on the box). */
export const PASSTHROUGH_PULL_HOST = '127.0.0.1';

/**
 * How the remux gets its input:
 *  - `listen` (DEFAULT): ffmpeg IS the acceptor — `-listen 1` RTMP / `mode=listener`
 *    SRT on a per-ingress port. This is the shipped multi-port plane.
 *  - `pull`: ffmpeg CONNECTS OUT to a front MediaMTX that owns the public :1935
 *    (`-i rtmp://127.0.0.1:<port>/<app>/<key>`, no `-listen`). Used only under
 *    the single-port switch (STREAMHUB_MEDIAMTX_ENABLE); RTMP only (SRT stays on
 *    its own listener — see features/rtmp-single-port.md non-goals).
 */
export type RemuxIngestMode = 'listen' | 'pull';

/**
 * On-disk HLS output dir for a passthrough room:
 * `<dataDir>/apps/<app>/hls/<room>/`. This is exactly what `mountHlsStatic`
 * rewrites `/hls/<app>/<room>/…` onto — writing here makes the existing HLS
 * player serve the remuxed stream with zero extra wiring.
 */
export function passthroughHlsDir(
  dataDir: string,
  app: string,
  room: string,
): string {
  return path.join(dataDir, 'apps', app, 'hls', room);
}

export interface RemuxArgsOptions {
  /** App slug (RTMP path segment #1; unused in the SRT input URL). */
  app: string;
  /** Passthrough stream key (`ptk_…`, RTMP path segment #2). */
  streamKey: string;
  /** Port the ffmpeg acceptor binds (`-listen 1` RTMP / `mode=listener` SRT). */
  port: number;
  /** Absolute HLS output dir (see {@link passthroughHlsDir}). */
  hlsDir: string;
  /** Ingest transport. Default `rtmp`. */
  transport?: PassthroughTransport;
  /**
   * How ffmpeg gets its input (default `listen`). `pull` connects OUT to a front
   * MediaMTX on `pullHost:<port>` instead of arming a `-listen` acceptor.
   */
  mode?: RemuxIngestMode;
  /**
   * MPEG-TS PULL source: the canonical `udp://@GROUP:PORT?…` ffmpeg input
   * (built + validated by mpegts-source.util). REQUIRED when `transport:'mpegts'`
   * — the input becomes `-f mpegts -i <sourceUrl>` (no listener, no per-ingress
   * port). Ignored for rtmp/srt.
   */
  sourceUrl?: string;
  /** Bind host for the listener. Default `0.0.0.0`. */
  bindHost?: string;
  /** PULL-mode source host (the front MediaMTX). Default `127.0.0.1`. */
  pullHost?: string;
  /** HLS segment seconds. Default 4. */
  hlsTime?: number;
  /** HLS live-window size. Default 6. */
  hlsListSize?: number;
}

/**
 * Build the `ffmpeg` argv (excluding the `ffmpeg` binary itself) for a
 * passthrough remux. PURE — deterministic given the options.
 *
 *   RTMP (listen): ffmpeg -hide_banner -loglevel warning -listen 1 \
 *           -i rtmp://<bindHost>:<port>/<app>/<key> …
 *   SRT  (listen): ffmpeg -hide_banner -loglevel warning \
 *           -i srt://<bindHost>:<port>?mode=listener …
 *   RTMP (pull):   ffmpeg -hide_banner -loglevel warning \
 *           -i rtmp://<pullHost>:<port>/<app>/<key> …   (NO -listen — connects out)
 *   MPEG-TS (pull): ffmpeg -hide_banner -loglevel warning \
 *           -f mpegts -i udp://@<group>:<port>?… …      (NO -listen — multicast/unicast PULL)
 *
 * shared tail: -c copy -f hls -hls_time 4 -hls_list_size 6 \
 *     -hls_flags delete_segments+append_list \
 *     -hls_segment_filename <dir>/seg_%05d.ts <dir>/index.m3u8
 */
export function buildRemuxArgs(opts: RemuxArgsOptions): string[] {
  const bindHost = opts.bindHost ?? PASSTHROUGH_LISTEN_HOST;
  const hlsTime = opts.hlsTime ?? PASSTHROUGH_HLS_TIME;
  const hlsListSize = opts.hlsListSize ?? PASSTHROUGH_HLS_LIST_SIZE;
  const input =
    opts.transport === 'mpegts'
      ? [
          // MPEG-TS PULL: connect OUT to a multicast group / unicast port and
          // demux MPEG-TS. `-f mpegts` forces the demuxer (the whole point of
          // this transport) so a silent group never mis-probes; the source URL
          // is the canonical, pre-validated udp://@GROUP:PORT?… (no -listen).
          '-f',
          'mpegts',
          '-i',
          opts.sourceUrl ?? '',
        ]
      : opts.mode === 'pull'
      ? [
          // PULL: connect OUT to the front MediaMTX on :<port> (no `-listen`).
          // RTMP only — MediaMTX owns the public port and drives arming via its
          // ready hook. `pullHost` is loopback (the front runs on the box).
          '-i',
          `rtmp://${opts.pullHost ?? PASSTHROUGH_PULL_HOST}:${opts.port}/${opts.app}/${opts.streamKey}`,
        ]
      : opts.transport === 'srt'
        ? [
            // SRT acceptor: libsrt listens itself via the mode=listener URL param
            // (`-listen 1` is RTMP-only). Latency stays libsrt's ~120 ms default.
            '-i',
            `srt://${bindHost}:${opts.port}?mode=listener`,
          ]
        : [
            // ffmpeg is the RTMP acceptor (no pure-JS RTMP dep) — listen for ONE push.
            '-listen',
            '1',
            '-i',
            `rtmp://${bindHost}:${opts.port}/${opts.app}/${opts.streamKey}`,
          ];
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    ...input,
    // REMUX: stream-copy, never re-encode. This is the whole point.
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    String(hlsTime),
    '-hls_list_size',
    String(hlsListSize),
    '-hls_flags',
    'delete_segments+append_list',
    '-hls_segment_filename',
    path.join(opts.hlsDir, 'seg_%05d.ts'),
    path.join(opts.hlsDir, PASSTHROUGH_HLS_PLAYLIST),
  ];
}

export interface ForwardArgsOptions {
  /** Path AFTER `live/` — the LiveKit stream key (or deeper remainder). */
  key: string;
  /** Front MediaMTX RTMP port to pull from (source). */
  sourcePort: number;
  /** Moved LiveKit ingress RTMP port to push to (destination). */
  destPort: number;
  /** Loopback host for both hops (source + dest run on the box). Default 127.0.0.1. */
  host?: string;
}

/**
 * Build the `ffmpeg` argv for the LiveKit-plane FORWARD hop (single-port switch).
 * MediaMTX is dumb (no path regexes/forwards) so the core relays a `live/<key>`
 * publish itself: pull `-c copy` off MediaMTX and push FLV to the moved LiveKit
 * ingress. PURE — deterministic given the options.
 *
 *   ffmpeg -hide_banner -loglevel warning \
 *     -i rtmp://127.0.0.1:<sourcePort>/live/<key> \
 *     -c copy -f flv rtmp://127.0.0.1:<destPort>/live/<key>
 */
export function buildForwardArgs(opts: ForwardArgsOptions): string[] {
  const host = opts.host ?? PASSTHROUGH_PULL_HOST;
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    `rtmp://${host}:${opts.sourcePort}/live/${opts.key}`,
    // REMUX: stream-copy, never re-encode — LiveKit's ingress does any transcode.
    '-c',
    'copy',
    '-f',
    'flv',
    `rtmp://${host}:${opts.destPort}/live/${opts.key}`,
  ];
}
