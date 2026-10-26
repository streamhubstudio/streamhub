/**
 * REMUX MANAGER — spawns + supervises one `ffmpeg -c copy` process per active
 * RTMP→HLS passthrough ingress. The core owns the lifecycle + logging; ffmpeg
 * only stream-copies RTMP → HLS (see remux-args.util.ts).
 *
 * Modeled on {@link ../plugins/plugin-worker.manager PluginWorkerManager} (spawn,
 * stdout/stderr → ring buffer + LogsService source `remux:<id>`, exit/crash
 * tracking, stopByKey, OnModuleDestroy SIGTERM all) PLUS the recording VOD
 * cleanup (fs.rm the HLS dir on stop). ADDS what the worker manager lacks:
 * crash-restart WHILE PUBLISHING — a "desired" flag (set live by start, cleared
 * by stop) means a non-zero exit while we still want the ingress live re-arms the
 * ffmpeg listener with a small capped backoff, whereas an exit AFTER stop is a
 * normal teardown (no restart).
 *
 * State is keyed by the passthrough `ingressId` so each ingress runs its own
 * remux. No LiveKit, no egress — this path is byte-for-byte independent of the
 * transcode/WebRTC pipeline.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';

import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import {
  buildForwardArgs,
  buildRemuxArgs,
  PassthroughTransport,
  RemuxIngestMode,
} from './remux-args.util';

/** Remux worker status. `live` = ffmpeg running; `idle` = between listens
 *  (armed, waiting for the next push / a scheduled restart); `off` = stopped;
 *  `error` = gave up after too many consecutive failures. */
export type RemuxStatus = 'live' | 'idle' | 'off' | 'error';

export interface RemuxSpec {
  app: string;
  /** Namespaced room (== HLS sub-dir). */
  room: string;
  streamKey: string;
  /**
   * Port the remux uses: the acceptor bind port in `listen` mode (`-listen 1`
   * RTMP / `mode=listener` SRT), the front MediaMTX pull port in `pull` mode, or
   * the pull SOURCE port for a `forward` child.
   */
  port: number;
  /** Absolute HLS output dir. Empty for a `forward` child (no HLS output). */
  hlsDir: string;
  /** Ingest transport (which acceptor ffmpeg arms). Default `rtmp`. */
  transport?: PassthroughTransport;
  /**
   * MPEG-TS PULL source: the canonical `udp://@GROUP:PORT?…` ffmpeg input
   * (REQUIRED when `transport:'mpegts'`; there is no listener/port). Ignored for
   * rtmp/srt.
   */
  sourceUrl?: string;
  /**
   * Ingest mode (default `listen`). `pull` connects OUT to a front MediaMTX on
   * `pullHost:<port>` instead of binding a `-listen` acceptor (single-port switch).
   */
  mode?: RemuxIngestMode;
  /** PULL-mode source host (the front MediaMTX). Default `127.0.0.1`. */
  pullHost?: string;
  /**
   * Child kind (default `hls`). `forward` relays a LiveKit-plane push (`-c copy`
   * FLV to the moved LiveKit ingress) instead of writing HLS — no output dir, and
   * it is HIDDEN from {@link list} so it never leaks into the streams-table sync.
   */
  kind?: 'hls' | 'forward';
  /** FORWARD destination port (the moved LiveKit ingress). */
  destPort?: number;
  /** FORWARD source path after `live/` (the LiveKit stream key/remainder). */
  forwardKey?: string;
  /** App numeric id for LogsService correlation (optional). */
  appId?: number | null;
}

export interface RemuxState {
  id: string;
  app: string;
  room: string;
  status: RemuxStatus;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  /** Number of automatic restarts so far. */
  restarts: number;
  error?: string;
}

export interface RemuxLogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

interface RemuxEntry {
  state: RemuxState;
  spec: RemuxSpec;
  child?: ChildProcess;
  logs: RemuxLogLine[];
  /** Publishing flag: `live` while the ingress should be accepting pushes. */
  desired: 'live' | 'stopped';
  restartTimer?: ReturnType<typeof setTimeout>;
  /** Consecutive crash count (reset on a clean end-of-publish). */
  failures: number;
}

const MAX_LOG_LINES = 300;
/** Base restart backoff after a crash (ms); grows linearly, capped. */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 15_000;
/** Fast re-arm after a CLEAN end-of-publish (the encoder just disconnected). */
const REARM_MS = 250;
/** Give up (status 'error') after this many consecutive crashes. */
const MAX_CONSECUTIVE_FAILURES = 10;
/** ffmpeg binary (overridable for tests / custom builds). */
const FFMPEG_BIN = process.env.STREAMHUB_FFMPEG_BIN || 'ffmpeg';

@Injectable()
export class RemuxManager implements OnModuleDestroy {
  private readonly logger = new Logger(RemuxManager.name);
  private readonly entries = new Map<string, RemuxEntry>();

  constructor(
    @Inject(LOGS_SERVICE) private readonly logsSvc: LogsServiceContract,
  ) {}

  onModuleDestroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      entry.desired = 'stopped';
      entry.child?.kill('SIGTERM');
    }
    this.entries.clear();
  }

  /**
   * Arm/start the remux for a passthrough ingress. Idempotent while live.
   * `id` is the passthrough ingressId. Creates the HLS dir, marks the ingress
   * "publishing" (desired live) and spawns the `ffmpeg -listen 1 -c copy`.
   */
  start(id: string, spec: RemuxSpec): RemuxState {
    const existing = this.entries.get(id);
    if (existing && (existing.state.status === 'live' || existing.child)) {
      return existing.state;
    }
    const entry: RemuxEntry = existing ?? {
      state: {
        id,
        app: spec.app,
        room: spec.room,
        status: 'idle',
        restarts: 0,
      },
      spec,
      logs: [],
      desired: 'stopped',
      failures: 0,
    };
    entry.spec = spec;
    entry.desired = 'live';
    entry.failures = 0;
    entry.state = {
      id,
      app: spec.app,
      room: spec.room,
      status: 'idle',
      restarts: existing?.state.restarts ?? 0,
      startedAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    this.launch(entry);
    return entry.state;
  }

  /**
   * Stop the remux (SIGTERM), clear the publishing flag so no restart fires, and
   * remove the HLS dir. No-op if unknown. Returns the final state.
   */
  stop(id: string): RemuxState {
    const entry = this.entries.get(id);
    if (!entry) {
      return { id, app: '', room: '', status: 'off', restarts: 0 };
    }
    entry.desired = 'stopped';
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.child?.kill('SIGTERM');
    entry.child = undefined;
    entry.state.status = 'off';
    entry.state.pid = undefined;
    entry.state.stoppedAt = new Date().toISOString();
    // A forward child has no HLS output dir — nothing to clean.
    if (entry.spec.kind === 'forward' || !entry.spec.hlsDir) {
      this.system(entry, 'remux stopped');
    } else {
      this.removeDir(entry.spec.hlsDir);
      this.system(entry, 'remux stopped + HLS dir cleaned');
    }
    return entry.state;
  }

  /** Current state, or undefined if never started/already forgotten. */
  status(id: string): RemuxState | undefined {
    return this.entries.get(id)?.state;
  }

  /**
   * All armed PASSTHROUGH remuxes (app/room/ingressId + desired state) — the walk
   * list for the passthrough→streams-table sync (dashboard visibility). Forward
   * children are EXCLUDED: they relay the LiveKit plane, whose streams rows come
   * from the LiveKit webhook, so a forward must never appear as a passthrough row.
   */
  list(): Array<{
    app: string;
    room: string;
    ingressId: string;
    desired: 'live' | 'stopped';
  }> {
    return [...this.entries.entries()]
      .filter(([, e]) => e.spec.kind !== 'forward')
      .map(([id, e]) => ({
        app: e.spec.app,
        room: e.spec.room,
        ingressId: id,
        desired: e.desired,
      }));
  }

  /** Whether the remux is armed (live or between-listens). */
  isActive(id: string): boolean {
    const s = this.entries.get(id)?.state.status;
    return s === 'live' || s === 'idle';
  }

  /** Recent buffered log lines (newest last). */
  logs(id: string, limit = 200): RemuxLogLine[] {
    const entry = this.entries.get(id);
    if (!entry) return [];
    return entry.logs.slice(-Math.max(1, limit));
  }

  // ---------------------------------------------------------------------------

  private launch(entry: RemuxEntry): void {
    const { spec } = entry;
    const isForward = spec.kind === 'forward';
    if (!isForward) {
      try {
        fs.mkdirSync(spec.hlsDir, { recursive: true });
      } catch (err) {
        this.system(entry, `could not create HLS dir: ${(err as Error).message}`);
      }
    }
    const args = isForward
      ? buildForwardArgs({
          key: spec.forwardKey ?? spec.streamKey,
          sourcePort: spec.port,
          destPort: spec.destPort ?? spec.port,
          host: spec.pullHost,
        })
      : buildRemuxArgs({
          app: spec.app,
          streamKey: spec.streamKey,
          port: spec.port,
          hlsDir: spec.hlsDir,
          transport: spec.transport,
          mode: spec.mode,
          pullHost: spec.pullHost,
          sourceUrl: spec.sourceUrl,
        });
    try {
      const child = spawn(FFMPEG_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.state.pid = child.pid;
      entry.state.status = 'live';

      child.stdout?.on('data', (b: Buffer) =>
        this.append(entry, 'stdout', b),
      );
      child.stderr?.on('data', (b: Buffer) =>
        this.append(entry, 'stderr', b),
      );
      child.on('error', (err: Error) => this.onExit(entry, null, null, err));
      child.on('exit', (code, signal) => this.onExit(entry, code, signal));

      this.system(
        entry,
        `remux started: ${FFMPEG_BIN} ${args.join(' ')} (pid ${child.pid})`,
      );
    } catch (err) {
      this.onExit(entry, null, null, err as Error);
    }
  }

  /**
   * Exit/crash handler + the crash-restart-while-publishing logic (the piece the
   * plugin worker manager lacks).
   */
  private onExit(
    entry: RemuxEntry,
    code: number | null,
    signal: NodeJS.Signals | null,
    err?: Error,
  ): void {
    entry.child = undefined;
    entry.state.pid = undefined;
    entry.state.exitCode = code;
    entry.state.stoppedAt = new Date().toISOString();

    // We asked it to stop → normal teardown, never restart.
    if (entry.desired === 'stopped') {
      entry.state.status = 'off';
      return;
    }

    // Still publishing: decide crash (non-zero / spawn error) vs clean end.
    const crashed = !!err || (!!code && code !== 0);
    if (crashed) {
      entry.failures += 1;
      entry.state.error = err?.message;
      this.system(
        entry,
        `remux crashed (${err ? err.message : `code=${code}, signal=${signal ?? 'none'}`}) ` +
          `— failure #${entry.failures}`,
      );
    } else {
      // A clean exit while still armed = the encoder ended its session; re-arm
      // so the channel stays available for the next push.
      entry.failures = 0;
      this.system(entry, `remux publish session ended (code=${code}) — re-arming`);
    }

    if (entry.failures > MAX_CONSECUTIVE_FAILURES) {
      entry.state.status = 'error';
      entry.state.error = `gave up after ${entry.failures} consecutive failures`;
      this.system(entry, entry.state.error);
      return;
    }

    const delay = crashed
      ? Math.min(RESTART_BASE_MS * entry.failures, RESTART_MAX_MS)
      : REARM_MS;
    entry.state.status = 'idle';
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (entry.desired !== 'live') return;
      entry.state.restarts += 1;
      this.launch(entry);
    }, delay);
  }

  private append(
    entry: RemuxEntry,
    stream: 'stdout' | 'stderr',
    buf: Buffer,
  ): void {
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.push(entry, { ts: new Date().toISOString(), stream, line });
      this.logsSvc.write(
        stream === 'stderr' ? 'warn' : 'info',
        `remux:${entry.state.id}`,
        line,
        { app: entry.state.app, room: entry.state.room, stream },
        entry.spec.appId ?? null,
      );
    }
  }

  private system(entry: RemuxEntry, line: string): void {
    this.push(entry, { ts: new Date().toISOString(), stream: 'system', line });
    this.logsSvc.write(
      'info',
      `remux:${entry.state.id}`,
      line,
      { app: entry.state.app, room: entry.state.room, stream: 'system' },
      entry.spec.appId ?? null,
    );
  }

  private push(entry: RemuxEntry, line: RemuxLogLine): void {
    entry.logs.push(line);
    if (entry.logs.length > MAX_LOG_LINES) {
      entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
    }
  }

  private removeDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(`could not clean ${dir}: ${(e as Error).message}`);
    }
  }
}
