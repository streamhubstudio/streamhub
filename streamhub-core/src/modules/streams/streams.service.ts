import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RoomServiceClient, IngressClient } from 'livekit-server-sdk';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import {
  APPS_SERVICE,
  AppsServiceContract,
  S3_SERVICE,
  S3ServiceContract,
  SnapshotInput,
  SnapshotResult,
  StreamRecord,
  StreamType,
  StreamsServiceContract,
} from '../../shared/contracts';
import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import type { Db } from '../../shared/db/db.service';
import { MetricsService } from '../metrics/metrics.service';

interface AppRow {
  id: number;
  name: string;
  livekit_room_prefix: string | null;
}

/** Per-room live snapshot used by the per-app stats endpoint. */
export interface RoomLiveStats {
  room: string;
  /** Real subscribers (viewerCounter feature). `null` when unavailable/off. */
  viewers: number | null;
  /** Participants publishing at least one track. */
  publishers: number;
  /** Earliest active stream start in the room (ISO / SQLite datetime). */
  startedAt?: string;
}

/** Live aggregate for one app (active streams + per-room viewer/publisher). */
export interface AppLiveStats {
  activeStreams: number;
  /** Sum of per-room viewers; `null` when the viewerCounter feature is off. */
  totalViewers: number | null;
  rooms: RoomLiveStats[];
}

interface StreamDbRow {
  id: number;
  app_id: number;
  stream_id: string;
  type: StreamType;
  room: string | null;
  participant: string | null;
  status: 'active' | 'ended';
  started_at: string;
  ended_at: string | null;
  last_stats_json: string | null;
}

/**
 * Active streams listing/detail/stop + on-demand snapshots (SPEC §5 streams).
 *
 * Source of truth is the per-app `streams` table, reconciled against live
 * LiveKit rooms/participants. The LiveKit server SDK is used directly because
 * the LiveKitServiceContract does not expose participant listing — see the
 * agent summary for that contract gap.
 *
 * Every external call (LiveKit, ffmpeg, S3) is wrapped so endpoints return
 * controlled errors and never crash the process.
 */
@Injectable()
export class StreamsService implements StreamsServiceContract {
  private readonly logger = new Logger(StreamsService.name);
  private readonly roomClient?: RoomServiceClient;
  private readonly ingressClient?: IngressClient;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    @Optional()
    @Inject(APPS_SERVICE)
    private readonly apps?: AppsServiceContract,
    @Optional()
    @Inject(S3_SERVICE)
    private readonly s3?: S3ServiceContract,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const host = StreamsService.httpUrl(this.config.livekitUrl);
    const key = this.config.livekitApiKey;
    const secret = this.config.livekitApiSecret;
    if (host && key && secret) {
      try {
        this.roomClient = new RoomServiceClient(host, key, secret);
        this.ingressClient = new IngressClient(host, key, secret);
      } catch (err) {
        this.logger.warn(`livekit clients init failed: ${String(err)}`);
      }
    }
  }

  private static httpUrl(u: string): string {
    if (!u) return u;
    return u.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Active streams for an app, reconciled against live LiveKit rooms. */
  async list(appName: string): Promise<StreamRecord[]> {
    const app = this.requireApp(appName);
    const adb = this.db.appDb(appName);

    await this.reconcile(app, adb);

    const rows = adb
      .prepare(
        "SELECT * FROM streams WHERE status = 'active' ORDER BY started_at DESC",
      )
      .all() as StreamDbRow[];
    return rows.map(StreamsService.toRecord);
  }

  /** Detail of a single stream (active or ended). */
  async get(appName: string, streamId: string): Promise<StreamRecord | null> {
    this.requireApp(appName);
    const adb = this.db.appDb(appName);
    const row = adb
      .prepare('SELECT * FROM streams WHERE stream_id = ?')
      .get(streamId) as StreamDbRow | undefined;
    if (!row) return null;

    // Best-effort live enrichment for active streams (viewer/participant count).
    let viewers: number | undefined;
    if (row.status === 'active' && row.room && this.roomClient) {
      try {
        const participants = await this.roomClient.listParticipants(row.room);
        const publishers = participants.filter(
          (p) => (p.tracks?.length ?? 0) > 0,
        ).length;
        // Viewer counter (SPEC §16): real subscribers only — exclude publishers
        // and hidden/QC participants.
        viewers = participants.filter(
          (p) => (p.tracks?.length ?? 0) === 0 && !p.permission?.hidden,
        ).length;
        const stats = {
          live: true,
          participants: participants.length,
          publishers,
          viewers,
        };
        adb
          .prepare('UPDATE streams SET last_stats_json = ? WHERE id = ?')
          .run(JSON.stringify(stats), row.id);
        row.last_stats_json = JSON.stringify(stats);
      } catch (err) {
        this.logger.debug(`enrich get(${streamId}) failed: ${String(err)}`);
      }
    }

    // Only expose `viewers` when the app enables the counter feature.
    if (viewers !== undefined && this.apps) {
      try {
        const cfg = await this.apps.getConfig(appName);
        if (!cfg.features?.viewerCounter) viewers = undefined;
      } catch {
        /* if config can't be read, still expose the computed count */
      }
    }

    const record = StreamsService.toRecord(row);
    if (viewers !== undefined) {
      record.viewers = viewers;
      if (row.room) this.metrics?.setViewers(appName, row.room, viewers);
    }
    return record;
  }

  /**
   * Live aggregate for one app (drives GET /apps/:app/stats): active stream
   * count + per-room publisher/viewer counts. Reuses the same
   * `listParticipants` + viewerCounter gating as {@link get}. Viewers are
   * `null` (per room and in total) when the viewerCounter feature is off or
   * LiveKit is unreachable — never throws for a live-count gap.
   */
  async liveStats(appName: string): Promise<AppLiveStats> {
    const app = this.requireApp(appName);
    const adb = this.db.appDb(appName);
    await this.reconcile(app, adb);

    const activeStreams = (
      adb
        .prepare("SELECT COUNT(*) AS n FROM streams WHERE status = 'active'")
        .get() as { n: number }
    ).n;

    const rows = adb
      .prepare(
        "SELECT room, started_at FROM streams " +
          "WHERE status = 'active' AND room IS NOT NULL ORDER BY started_at ASC",
      )
      .all() as { room: string; started_at: string }[];

    // Only expose viewer counts when the app enables the feature.
    let viewerCounter = false;
    if (this.apps) {
      try {
        const cfg = await this.apps.getConfig(appName);
        viewerCounter = !!cfg.features?.viewerCounter;
      } catch {
        /* config unreadable → treat as off */
      }
    }

    // Distinct rooms with the earliest active start.
    const roomStarts = new Map<string, string>();
    for (const r of rows) {
      if (!roomStarts.has(r.room)) roomStarts.set(r.room, r.started_at);
    }

    const roomsOut: RoomLiveStats[] = [];
    let totalViewers: number | null = viewerCounter ? 0 : null;
    for (const [room, startedAt] of roomStarts) {
      let publishers = 0;
      let viewers: number | null = viewerCounter ? 0 : null;
      if (this.roomClient) {
        try {
          const parts = await this.roomClient.listParticipants(room);
          publishers = parts.filter((p) => (p.tracks?.length ?? 0) > 0).length;
          if (viewerCounter) {
            viewers = parts.filter(
              (p) => (p.tracks?.length ?? 0) === 0 && !p.permission?.hidden,
            ).length;
            this.metrics?.setViewers(appName, room, viewers);
          }
        } catch (err) {
          this.logger.debug(
            `liveStats listParticipants(${room}) failed: ${String(err)}`,
          );
          viewers = null; // unknown for this room
        }
      } else {
        viewers = null; // LiveKit not configured → unknown
      }
      if (viewerCounter && viewers !== null && totalViewers !== null) {
        totalViewers += viewers;
      }
      roomsOut.push({ room, viewers, publishers, startedAt });
    }

    return { activeStreams, totalViewers, rooms: roomsOut };
  }

  /**
   * Stop a stream: disconnect the participant (webrtc), remove the ingress
   * (rtmp/whip/rtsp), or delete the room when it has no other active streams.
   * Always marks the row ended; LiveKit cleanup is best-effort.
   */
  async stop(appName: string, streamId: string): Promise<void> {
    this.requireApp(appName);
    const adb = this.db.appDb(appName);
    const row = adb
      .prepare('SELECT * FROM streams WHERE stream_id = ?')
      .get(streamId) as StreamDbRow | undefined;
    if (!row) throw new NotFoundException(`stream '${streamId}' not found`);

    if (row.status === 'active') {
      await this.teardownLiveKit(adb, row);
    }

    adb
      .prepare(
        "UPDATE streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?",
      )
      .run(row.id);
    this.metrics?.streamStopped(appName);
  }

  /**
   * Upsert a stream row (used by webhook handlers in the livekit module).
   *
   * `stream_id` is the CANONICAL key `${room}/${participant}` for every
   * participant-backed stream (webrtc and ingress rtmp/whip/rtsp alike) — the
   * webhook path and reconcile() both derive it the same way, so a given
   * publisher can only ever produce one row (see `canonicalStreamId`).
   *
   * The `type` column is never downgraded from an ingress type
   * (rtmp/whip/rtsp) back to 'webrtc': webhook ordering is not guaranteed, so
   * whichever of ingress_started / participant_joined / reconcile fires first
   * establishes the ingress type and later 'webrtc' upserts leave it intact.
   */
  async upsert(
    appName: string,
    streamId: string,
    type: StreamType,
    room: string,
    participant: string | null,
  ): Promise<StreamRecord> {
    const app = this.requireApp(appName);
    const adb = this.db.appDb(appName);
    adb
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
         VALUES (?, ?, ?, ?, ?, 'active')
         ON CONFLICT(stream_id) DO UPDATE SET
           type = CASE
             WHEN excluded.type = 'webrtc'
                  AND streams.type IN ('rtmp','whip','rtsp','ws-mjpeg')
               THEN streams.type
             ELSE excluded.type
           END,
           room = excluded.room,
           participant = excluded.participant,
           status = 'active',
           ended_at = NULL`,
      )
      .run(app.id, streamId, type, room, participant);
    const row = adb
      .prepare('SELECT * FROM streams WHERE stream_id = ?')
      .get(streamId) as StreamDbRow;
    return StreamsService.toRecord(row);
  }

  /**
   * Mark a stream ended without any LiveKit teardown (webhook path). Called on
   * participant_left / track_unpublished: the publisher has already left or
   * stopped publishing, so — unlike stop() — there is no participant/ingress to
   * disconnect. Idempotent: a missing or already-ended row is a no-op.
   */
  async end(appName: string, streamId: string): Promise<void> {
    this.requireApp(appName);
    const adb = this.db.appDb(appName);
    const info = adb
      .prepare(
        "UPDATE streams SET status = 'ended', ended_at = datetime('now') " +
          "WHERE stream_id = ? AND status = 'active'",
      )
      .run(streamId);
    if (info.changes > 0) {
      this.metrics?.streamStopped(appName);
    }
  }

  /**
   * On-demand snapshot via ffmpeg (SPEC §5 streams). Captures a single frame
   * from the room's media source into apps/<app>/snapshots/ and, if S3 is
   * configured/available, uploads it. Returns a controlled error rather than
   * crashing when ffmpeg or the source is unavailable.
   */
  async snapshot(input: SnapshotInput): Promise<SnapshotResult> {
    const app = this.requireApp(input.appName);
    const room = (input.roomName ?? '').trim();
    if (!room) throw new BadRequestException('roomName is required');

    const dir = path.join(
      this.config.dataDir,
      'apps',
      app.name,
      'snapshots',
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new ServiceUnavailableException(
        `cannot create snapshots dir: ${String(err)}`,
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${StreamsService.safe(room)}-${stamp}.jpg`;
    const localPath = path.join(dir, fileName);
    const source = this.snapshotSource(app, room, input.participantIdentity);

    await this.captureFrame(source, localPath);
    this.metrics?.snapshotTaken(app.name);

    // Best-effort S3 upload; on any failure fall back to a local file reference.
    const logicalKey = `snapshots/${fileName}`;
    if (this.apps && this.s3) {
      try {
        const cfg = await this.apps.getConfig(app.name);
        const key = cfg.s3.prefix
          ? `${cfg.s3.prefix}/${logicalKey}`
          : logicalKey;
        const res = await this.s3.upload(cfg.s3, localPath, key, 'image/jpeg');
        let url = res.url;
        try {
          url = await this.s3.presignGet(cfg.s3, res.key, 3600);
        } catch (err) {
          this.logger.debug(`presign failed, using object url: ${String(err)}`);
        }
        return { key: res.key, url };
      } catch (err) {
        this.logger.warn(
          `snapshot S3 upload failed, returning local: ${String(err)}`,
        );
      }
    }
    return { key: logicalKey, url: `file://${localPath}` };
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private requireApp(appName: string): AppRow {
    let row: AppRow | undefined;
    try {
      row = this.db
        .global()
        .prepare(
          'SELECT id, name, livekit_room_prefix FROM apps WHERE name = ?',
        )
        .get(appName) as AppRow | undefined;
    } catch (err) {
      throw new ServiceUnavailableException(`db error: ${String(err)}`);
    }
    if (!row) throw new NotFoundException(`app '${appName}' not found`);
    return row;
  }

  private appPrefix(app: AppRow): string {
    return (app.livekit_room_prefix && app.livekit_room_prefix.trim()) || app.name;
  }

  private roomBelongs(app: AppRow, roomName: string): boolean {
    const prefix = this.appPrefix(app);
    return roomName === prefix || roomName.startsWith(prefix);
  }

  /** Grace window (ms) before a freshly-created stream can be pruned, so a
   * participant that has joined but not yet published a track doesn't flap
   * ended→active on consecutive reconciles. */
  private static readonly PRUNE_GRACE_MS = 15_000;

  /** Canonical stream key for a participant-backed stream. Both the webhook
   * path (participant_joined / ingress_started) and reconcile() derive the
   * stream_id this way, so one publisher maps to exactly one row. */
  static canonicalStreamId(room: string, identity: string): string {
    return `${room}/${identity}`;
  }

  /** Map a LiveKit participant kind to a StreamHub stream type. Ingress
   * publishers (RTMP/WHIP/RTSP) are marked 'rtmp' so they are not treated as
   * WebRTC and are deduped against their own ingress_started event. */
  private static kindToType(kind: ParticipantInfo_Kind | undefined): StreamType {
    return kind === ParticipantInfo_Kind.INGRESS ? 'rtmp' : 'webrtc';
  }

  private ageMs(startedAt: string): number {
    // started_at is SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' in UTC.
    const t = Date.parse(`${startedAt.replace(' ', 'T')}Z`);
    return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
  }

  /**
   * Reconcile DB streams against live LiveKit state:
   * - one-time cleanup of legacy (pre-canonical) stale rows,
   * - discover live publishers in the app's rooms as canonical rows,
   * - prune (end) active rows whose (room, participant) is no longer a live
   *   publisher — the real fix for streams stuck EN VIVO.
   * No-op when LiveKit is unreachable (avoids ending streams on transient errors).
   */
  private async reconcile(app: AppRow, adb: Db): Promise<void> {
    if (!this.roomClient) return;

    // One-time / idempotent cleanup: any active row whose stream_id is not in
    // canonical `${room}/${identity}` form (no '/') is a legacy record from the
    // pre-fix webhook path (bare identity, or an ingressId like 'IN_...'). The
    // live ones are re-created below under their canonical id, so ending these
    // here collapses the historical duplicates without losing live streams.
    adb
      .prepare(
        "UPDATE streams SET status = 'ended', ended_at = datetime('now') " +
          "WHERE status = 'active' AND instr(stream_id, '/') = 0 " +
          "AND type != 'ws-mjpeg'",
      )
      .run();

    let rooms: Awaited<ReturnType<RoomServiceClient['listRooms']>>;
    try {
      rooms = await this.roomClient.listRooms();
    } catch (err) {
      this.logger.debug(`reconcile listRooms failed: ${String(err)}`);
      return;
    }

    const appRooms = rooms.filter((r) => this.roomBelongs(app, r.name));
    // room → set of live publisher identities (tracks > 0).
    const liveByRoom = new Map<string, Set<string>>();
    // rooms whose participant list could not be fetched → never prune them.
    const unknownRooms = new Set<string>();
    for (const r of appRooms) {
      try {
        const parts = await this.roomClient.listParticipants(r.name);
        const publishers = parts.filter((p) => (p.tracks?.length ?? 0) > 0);
        liveByRoom.set(r.name, new Set(publishers.map((p) => p.identity)));
        // Discover live publishers as canonical rows (kind-aware type).
        for (const p of publishers) {
          const streamId = StreamsService.canonicalStreamId(r.name, p.identity);
          const type = StreamsService.kindToType(p.kind);
          const existing = adb
            .prepare(
              "SELECT id FROM streams WHERE stream_id = ? AND status = 'active'",
            )
            .get(streamId) as { id: number } | undefined;
          if (!existing) {
            try {
              await this.upsert(app.name, streamId, type, r.name, p.identity);
            } catch (err) {
              this.logger.debug(`discover upsert failed: ${String(err)}`);
            }
          }
        }
      } catch (err) {
        this.logger.debug(`listParticipants(${r.name}) failed: ${String(err)}`);
        unknownRooms.add(r.name);
      }
    }

    const liveRoomNames = new Set(appRooms.map((r) => r.name));
    const active = adb
      .prepare("SELECT * FROM streams WHERE status = 'active'")
      .all() as StreamDbRow[];
    for (const s of active) {
      if (!s.room) continue;
      // ws-mjpeg streams do NOT live in LiveKit (they come from the ws-ingest
      // gateway, not from webhooks): their liveness is owned by the gateway
      // (connect → upsert, disconnect/idle → end), so reconcile must NEVER
      // prune them — pruning here would end every live ESP32 camera on each
      // list() call. See streamhub-docs/integrations/ESP32-WS-INGEST.md §2.
      if (s.type === 'ws-mjpeg') continue;
      // Grace: leave very new rows alone so a not-yet-publishing participant
      // doesn't get pruned on the next tick.
      if (this.ageMs(s.started_at) < StreamsService.PRUNE_GRACE_MS) continue;
      // Room's participants couldn't be listed → state unknown, don't prune.
      if (unknownRooms.has(s.room)) continue;

      const roomGone = !liveRoomNames.has(s.room);
      const publishers = liveByRoom.get(s.room);
      const participantGone =
        !roomGone &&
        !!s.participant &&
        publishers !== undefined &&
        !publishers.has(s.participant);
      if (roomGone || participantGone) {
        adb
          .prepare(
            "UPDATE streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?",
          )
          .run(s.id);
      }
    }
  }

  private async teardownLiveKit(adb: Db, row: StreamDbRow): Promise<void> {
    if (!row.room) return;
    // ws-mjpeg streams have no LiveKit participant/ingress/room to tear down —
    // the socket is owned by the ws-ingest gateway (revoking the key or the
    // camera disconnecting closes it). Marking the row ended is enough here.
    if (row.type === 'ws-mjpeg') return;
    try {
      if (row.type === 'webrtc' && row.participant && this.roomClient) {
        await this.roomClient.removeParticipant(row.room, row.participant);
        return;
      }
      if (
        (row.type === 'rtmp' || row.type === 'whip' || row.type === 'rtsp') &&
        this.ingressClient
      ) {
        // Ingress-backed streams are keyed canonically (`${room}/${identity}`),
        // not by ingressId — resolve the ingress by its room + participant
        // identity and delete it. Fall back to disconnecting the participant.
        const ingressId = await this.findIngressId(row.room, row.participant);
        if (ingressId) {
          await this.ingressClient.deleteIngress(ingressId);
        } else if (row.participant && this.roomClient) {
          await this.roomClient.removeParticipant(row.room, row.participant);
        }
        return;
      }
      // Fallback: delete the room only when no other active stream uses it.
      if (this.roomClient) {
        const others = adb
          .prepare(
            "SELECT COUNT(*) AS n FROM streams WHERE room = ? AND status = 'active' AND id != ?",
          )
          .get(row.room, row.id) as { n: number };
        if ((others?.n ?? 0) === 0) {
          await this.roomClient.deleteRoom(row.room);
        }
      }
    } catch (err) {
      this.logger.warn(
        `livekit teardown for ${row.stream_id} failed (continuing): ${String(err)}`,
      );
    }
  }

  /** Resolve the LiveKit ingressId for a canonical ingress stream by matching
   * the ingress room + participant identity. Best-effort; null when not found. */
  private async findIngressId(
    room: string,
    participant: string | null,
  ): Promise<string | null> {
    if (!this.ingressClient) return null;
    try {
      const ingresses = await this.ingressClient.listIngress({ roomName: room });
      const match = ingresses.find(
        (i) =>
          i.roomName === room &&
          (!participant || i.participantIdentity === participant),
      );
      return match?.ingressId ?? null;
    } catch (err) {
      this.logger.debug(`listIngress(${room}) failed: ${String(err)}`);
      return null;
    }
  }

  /** Build the ffmpeg input source for a room snapshot. */
  private snapshotSource(
    app: AppRow,
    room: string,
    participant?: string,
  ): string {
    const template = this.config.env('STREAMHUB_SNAPSHOT_SOURCE');
    if (template) {
      return template
        .replace(/\{app\}/g, app.name)
        .replace(/\{room\}/g, room)
        .replace(/\{participant\}/g, participant ?? '');
    }
    // Default: pull from the app's RTMP namespace on the public media host.
    const host = this.config.rtmpPublicHost || '127.0.0.1';
    return `rtmp://${host}:1935/${this.appPrefix(app)}/${room}`;
  }

  /** Run ffmpeg to grab a single frame. Throws a controlled error on failure. */
  private captureFrame(source: string, outPath: string): Promise<void> {
    const args = [
      '-y',
      '-loglevel',
      'error',
      '-rw_timeout',
      '10000000', // 10s in microseconds for network inputs
      '-i',
      source,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath,
    ];
    return new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, { timeout: 20000 }, (err) => {
        if (!err) {
          resolve();
          return;
        }
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          reject(
            new ServiceUnavailableException('ffmpeg is not installed/available'),
          );
          return;
        }
        this.logger.warn(`ffmpeg snapshot failed: ${String(err)}`);
        reject(
          new ServiceUnavailableException(
            'snapshot capture failed (source unreachable or no video frame)',
          ),
        );
      });
    });
  }

  private static safe(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private static toRecord(row: StreamDbRow): StreamRecord {
    return {
      id: row.id,
      appId: row.app_id,
      streamId: row.stream_id,
      type: row.type,
      room: row.room ?? '',
      participant: row.participant,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastStatsJson: row.last_stats_json,
    };
  }
}
