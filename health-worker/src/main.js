/**
 * STREAM-HEALTH WORKER — entrypoint (orchestration only; every decision lives
 * in the pure, unit-tested modules next to this file).
 *
 * Spawned per app by the StreamHub plugin framework (see
 * streamhub-core/src/plugins/stream-health/plugin.meta.ts). Environment:
 *
 *   HEALTH_APP             app slug
 *   HEALTH_HLS_DIR         <appDir>/hls  (one sub-dir per room, index.m3u8)
 *   HEALTH_DATA_DIR        <appDir>/stream-health (stream-health.db lives here)
 *   HEALTH_CONFIG_JSON     app-level thresholds (install config)
 *   HEALTH_FFPROBE / HEALTH_FFMPEG   binaries (default ffprobe / ffmpeg)
 *   STREAMHUB_INGEST_URL   POST live-data (overview snapshot), framework-injected
 *   STREAMHUB_EVENTS_URL   POST domain events, framework-injected
 *   STREAMHUB_INGEST_TOKEN per-start ingest token, framework-injected
 *
 * Sampling model (CPU-honest, never a full decode): the loop ticks every
 * {@link TICK_MS}; a room is probed when its RESOLVED sample_interval_sec
 * elapsed. One probe = playlist read+diff, stat() of new segments, and — only
 * when a NEW segment appeared — one ffprobe (headers), one bounded TS
 * continuity read (first 4 MB) and one audio-only volumedetect decode of that
 * single segment. A stalled stream costs a file read per cycle, nothing more.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { diffPlaylist, measuredKbps, parsePlaylist } from './playlist.js';
import { buildFfprobeArgs, parseFfprobe } from './probe.js';
import { parseAppConfig, readRoomOverrides, resolveThresholds } from './settings.js';
import { createRoomState, evaluate } from './state.js';
import { analyzeTsContinuity, isTsSegment } from './tscc.js';
import { buildVolumeArgs, parseVolumeDetect } from './volume.js';

const TICK_MS = 2000;
const SUBPROCESS_TIMEOUT_MS = 15_000;
const TS_READ_CAP_BYTES = 4 * 1024 * 1024;
const POST_TIMEOUT_MS = 5000;

const env = process.env;
const APP = env.HEALTH_APP ?? '';
const HLS_DIR = env.HEALTH_HLS_DIR ?? '';
const DB_FILE = path.join(env.HEALTH_DATA_DIR ?? '.', 'stream-health.db');
const FFPROBE = env.HEALTH_FFPROBE ?? 'ffprobe';
const FFMPEG = env.HEALTH_FFMPEG ?? 'ffmpeg';
const EVENTS_URL = env.STREAMHUB_EVENTS_URL ?? '';
const INGEST_URL = env.STREAMHUB_INGEST_URL ?? '';
const INGEST_TOKEN = env.STREAMHUB_INGEST_TOKEN ?? '';
const APP_CONFIG = parseAppConfig(env.HEALTH_CONFIG_JSON);

/** room → { state, prev, lastAdvanceMs, lastSampleMs, facts, snapshot } */
const rooms = new Map();

function log(msg) {
  console.log(`[health-worker] ${msg}`);
}

// ---------------------------------------------------------------------------
// Subprocess + HTTP helpers (fail-soft: any trouble → null, never a crash)
// ---------------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // ffmpeg -f null exits 0; ffprobe errors still often print JSON.
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function post(url, body) {
  if (!url || !INGEST_TOKEN) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-plugin-ingest-token': INGEST_TOKEN,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    /* best-effort */
  } finally {
    clearTimeout(timer);
  }
}

function postEvent(room, event, data) {
  log(`event ${event} room=${room} ${JSON.stringify(data)}`);
  return post(EVENTS_URL, { event, room, data });
}

/** Bounded read of a segment's head for TS continuity analysis. */
function readBounded(file, cap) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, cap);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Per-room probe
// ---------------------------------------------------------------------------

/** Resolve a playlist segment uri under its room dir; null when unsafe. */
function segmentPath(roomDir, uri) {
  if (!uri || /^[a-z]+:\/\//i.test(uri)) return null; // no remote uris
  const clean = String(uri).split('?')[0];
  const resolved = path.resolve(roomDir, clean);
  if (!resolved.startsWith(path.resolve(roomDir) + path.sep)) return null;
  return resolved;
}

async function probeRoom(room, rt, thresholds, nowMs) {
  const roomDir = path.join(HLS_DIR, room);
  let text;
  try {
    text = fs.readFileSync(path.join(roomDir, 'index.m3u8'), 'utf8');
  } catch {
    return false; // playlist gone → stream ended; caller forgets the room
  }
  const pl = parsePlaylist(text);
  if (pl.endlist) return false; // converted to VOD → done

  const diff = diffPlaylist(rt.prev, pl);
  rt.prev = pl;
  if (rt.lastAdvanceMs === null || diff.advanced) rt.lastAdvanceMs = nowMs;
  const secondsSinceAdvance = (nowMs - rt.lastAdvanceMs) / 1000;

  // stat() the new segments for the measured delivery bitrate.
  const segInfos = [];
  let newestPath = null;
  let newestUri = null;
  for (const seg of diff.newSegments) {
    const p = segmentPath(roomDir, seg.uri);
    if (!p) continue;
    try {
      segInfos.push({ bytes: fs.statSync(p).size, duration: seg.duration });
      newestPath = p;
      newestUri = seg.uri;
    } catch {
      /* segment already rotated out */
    }
  }
  const kbps = measuredKbps(segInfos);

  // Deep-probe only when a NEW segment landed (a stalled stream costs nothing).
  let facts = null;
  let hasAudioTrack = null;
  let meanDb = null;
  let desyncMs = null;
  let ccErrors = 0;
  if (newestPath) {
    const probeRes = await run(FFPROBE, buildFfprobeArgs(newestPath));
    facts = parseFfprobe(probeRes.stdout);
    if (facts) {
      hasAudioTrack = facts.audio !== null;
      desyncMs = facts.desyncMs;
      rt.facts = facts;
    }
    if (isTsSegment(newestUri)) {
      const buf = readBounded(newestPath, TS_READ_CAP_BYTES);
      if (buf) ccErrors = analyzeTsContinuity(buf).ccErrors;
    }
    if (hasAudioTrack) {
      const volRes = await run(FFMPEG, buildVolumeArgs(newestPath));
      const vol = parseVolumeDetect(volRes.stderr);
      if (vol) meanDb = vol.meanDb;
    }
  }

  const { events, status, reasons } = evaluate(
    rt.state,
    {
      secondsSinceAdvance,
      droppedSegments: diff.droppedSegments,
      ccErrors,
      newDiscontinuityTags: diff.newDiscontinuityTags,
      hasAudioTrack,
      meanDb,
      desyncMs,
      measuredKbps: kbps,
    },
    thresholds,
    nowMs,
  );
  for (const e of events) void postEvent(room, e.event, e.data);

  const f = rt.facts;
  rt.snapshot = {
    room,
    status,
    reasons,
    facts: f
      ? {
          videoCodec: f.video?.codec ?? null,
          width: f.video?.width ?? null,
          height: f.video?.height ?? null,
          fps: f.video?.fps ?? null,
          audioCodec: f.audio?.codec ?? null,
          sampleRate: f.audio?.sampleRate ?? null,
          channels: f.audio?.channels ?? null,
          bitrateKbps: f.overallBitrateKbps,
        }
      : null,
    metrics: {
      measuredKbps: kbps,
      secondsSinceAdvance: Math.round(secondsSinceAdvance),
      meanDb,
      desyncMs,
      ccErrors,
      droppedSegments: diff.droppedSegments,
      discontinuityTags: diff.newDiscontinuityTags,
      baselineKbps: rt.state.baselineKbps,
    },
    ts: nowMs,
  };
  return true;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function listRooms() {
  try {
    return fs
      .readdirSync(HLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => {
        try {
          return fs.existsSync(path.join(HLS_DIR, name, 'index.m3u8'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

let ticking = false;

async function tick() {
  if (ticking) return; // a slow cycle must not stack
  ticking = true;
  try {
    const nowMs = Date.now();
    const overrides = await readRoomOverrides(DB_FILE);
    const live = new Set(listRooms());

    // Forget rooms whose playlist disappeared.
    for (const room of [...rooms.keys()]) {
      if (!live.has(room)) {
        rooms.delete(room);
        log(`room gone: ${room}`);
      }
    }

    let sampled = false;
    for (const room of live) {
      let rt = rooms.get(room);
      if (!rt) {
        rt = {
          state: createRoomState(),
          prev: null,
          lastAdvanceMs: null,
          lastSampleMs: 0,
          facts: null,
          snapshot: null,
        };
        rooms.set(room, rt);
        log(`room discovered: ${room}`);
      }
      const thresholds = resolveThresholds(APP_CONFIG, overrides.get(room));
      if (nowMs - rt.lastSampleMs < thresholds.sample_interval_sec * 1000) {
        continue;
      }
      rt.lastSampleMs = nowMs;
      const alive = await probeRoom(room, rt, thresholds, nowMs);
      if (!alive) {
        rooms.delete(room);
        continue;
      }
      sampled = true;
    }

    if (sampled || rooms.size > 0) {
      await post(INGEST_URL, {
        room: 'overview',
        ts: Date.now(),
        streams: [...rooms.values()]
          .map((rt) => rt.snapshot)
          .filter((s) => s !== null),
      });
    }
  } catch (err) {
    log(`tick error: ${err?.message ?? err}`);
  } finally {
    ticking = false;
  }
}

function start() {
  if (!APP || !HLS_DIR) {
    console.error('[health-worker] HEALTH_APP / HEALTH_HLS_DIR missing — exiting');
    process.exit(2);
  }
  log(
    `starting app=${APP} hls=${HLS_DIR} db=${DB_FILE} ` +
      `config=${JSON.stringify(APP_CONFIG)}`,
  );
  const timer = setInterval(() => void tick(), TICK_MS);
  const stop = () => {
    clearInterval(timer);
    log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  void tick();
}

start();
