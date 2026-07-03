import { Injectable } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { DbService } from '../../shared/db/db.service';

/** Persisted RTMP ingress auth row (per-app apps/<app>/app.db.ingress_auth). */
export interface IngressAuthRow {
  ingressId: string;
  app: string;
  room: string | null;
  streamKey: string | null;
  requiresPassword: boolean;
  validatedAt: string | null;
  /** Row creation timestamp (present on reads; absent pre-migration rows tolerated). */
  createdAt?: string | null;
}

interface RawRow {
  ingress_id: string;
  app: string;
  room: string | null;
  stream_key: string | null;
  password_hash: string | null;
  password_salt: string | null;
  requires_password: number;
  validated_at: string | null;
  created_at?: string | null;
}

/** Prefix of WS-ingest key ids (`ingress_id`) minted by {@link IngressAuthService.registerWsIngest}. */
export const WS_INGRESS_ID_PREFIX = 'wsi_';
/** Prefix of WS-ingest stream keys (ESP32-WS-INGEST §2). */
export const WS_STREAM_KEY_PREFIX = 'wsk_';

/**
 * RTMP ingress key + password store (SPEC §16).
 *
 * LiveKit's RTMP ingress has no native password beyond the stream key, so the
 * password is a StreamHub-side second factor. We persist a salted scrypt hash per
 * ingress (never the plaintext) and validate it server-side via
 * `POST /apps/:app/ingress/:id/validate` (the integration point an RTMP edge —
 * e.g. nginx-rtmp `on_publish` — calls to authorize a push). On the LiveKit
 * `ingress_started`/`ingress_updated` webhook we enforce it: a passworded
 * ingress that has not been validated is terminated (deleteIngress).
 *
 * STORAGE (decentralized split): rows live in the per-app `app.db`
 * (`appDb(app).ingress_auth`), NOT the global streamhub.db. Every method threads
 * the owning `app` so it can open the right handle. The ingress_id remains the
 * per-app primary key, so lookups are unchanged apart from the DB they hit.
 */
@Injectable()
export class IngressAuthService {
  constructor(private readonly db: DbService) {}

  /**
   * Register an ingress and (optionally) a password. Returns the generated
   * plaintext password exactly once — it is never persisted in the clear.
   */
  register(input: {
    ingressId: string;
    app: string;
    room: string;
    streamKey?: string;
    withPassword: boolean;
  }): { password?: string } {
    let password: string | undefined;
    let hash: string | null = null;
    let salt: string | null = null;
    if (input.withPassword) {
      password = randomBytes(12).toString('base64url');
      salt = randomBytes(16).toString('hex');
      hash = this.hash(password, salt);
    }
    this.db
      .appDb(input.app)
      .prepare(
        `INSERT INTO ingress_auth
           (ingress_id, app, room, stream_key, password_hash, password_salt, requires_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ingress_id) DO UPDATE SET
           app = excluded.app,
           room = excluded.room,
           stream_key = excluded.stream_key,
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt,
           requires_password = excluded.requires_password,
           validated_at = NULL`,
      )
      .run(
        input.ingressId,
        input.app,
        input.room,
        input.streamKey ?? null,
        hash,
        salt,
        input.withPassword ? 1 : 0,
      );
    return { password };
  }

  /** Look up an ingress auth row. */
  get(app: string, ingressId: string): IngressAuthRow | null {
    const r = this.raw(app, ingressId);
    if (!r) return null;
    return {
      ingressId: r.ingress_id,
      app: r.app,
      room: r.room,
      streamKey: r.stream_key,
      requiresPassword: !!r.requires_password,
      validatedAt: r.validated_at,
    };
  }

  /**
   * Validate a presented password against the stored hash. On success the row
   * is marked validated (so the webhook enforcement lets the ingress live).
   * Returns true when the ingress requires no password.
   */
  validate(app: string, ingressId: string, password: string | undefined): boolean {
    const r = this.raw(app, ingressId);
    if (!r) return false;
    if (!r.requires_password) {
      this.markValidated(app, ingressId);
      return true;
    }
    if (!password || !r.password_hash || !r.password_salt) return false;
    const candidate = this.hash(password, r.password_salt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(r.password_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    this.markValidated(app, ingressId);
    return true;
  }

  /**
   * Whether an ingress is authorized to keep streaming: true when it needs no
   * password, or when a matching password has already been validated.
   */
  isAuthorized(app: string, ingressId: string): boolean {
    const r = this.raw(app, ingressId);
    if (!r) return true; // not tracked → not governed by this feature
    if (!r.requires_password) return true;
    return r.validated_at != null;
  }

  remove(app: string, ingressId: string): void {
    this.db
      .appDb(app)
      .prepare('DELETE FROM ingress_auth WHERE ingress_id = ?')
      .run(ingressId);
  }

  // ---------------------------------------------------------------------------
  // Direct WS ingest keys (ESP32-WS-INGEST.md §2/§3.6) — same store/lifecycle
  // as the RTMP ingress keys, but minted by StreamHub itself (no LiveKit
  // ingress behind them): ingress_id `wsi_<rand>`, stream_key `wsk_<rand>`.
  // ---------------------------------------------------------------------------

  /**
   * Mint a WS-ingest key for a room. Returns the plaintext `wsk_` key (also
   * persisted in `stream_key`, mirroring how LiveKit RTMP keys are stored —
   * hashing them is a planned, non-blocking hardening).
   */
  registerWsIngest(input: {
    app: string;
    room: string;
  }): { ingressId: string; streamKey: string } {
    const ingressId = `${WS_INGRESS_ID_PREFIX}${randomBytes(6).toString('hex')}`;
    const streamKey = `${WS_STREAM_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    this.db
      .appDb(input.app)
      .prepare(
        `INSERT INTO ingress_auth
           (ingress_id, app, room, stream_key, requires_password)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(ingressId, input.app, input.room, streamKey);
    return { ingressId, streamKey };
  }

  /** Look up an ingress_auth row by its stream key (WS handshake auth). */
  findByStreamKey(app: string, streamKey: string): IngressAuthRow | null {
    if (!streamKey) return null;
    const r = this.db
      .appDb(app)
      .prepare('SELECT * FROM ingress_auth WHERE stream_key = ?')
      .get(streamKey) as RawRow | undefined;
    return r ? IngressAuthService.toRow(r) : null;
  }

  /** All WS-ingest keys of an app (ingress_id LIKE 'wsi_%'), newest first. */
  listWsIngest(app: string): IngressAuthRow[] {
    const rows = this.db
      .appDb(app)
      .prepare(
        "SELECT * FROM ingress_auth WHERE ingress_id LIKE 'wsi\\_%' ESCAPE '\\' " +
          'ORDER BY created_at DESC, ingress_id DESC',
      )
      .all() as RawRow[];
    return rows.map((r) => IngressAuthService.toRow(r));
  }

  private static toRow(r: RawRow): IngressAuthRow {
    return {
      ingressId: r.ingress_id,
      app: r.app,
      room: r.room,
      streamKey: r.stream_key,
      requiresPassword: !!r.requires_password,
      validatedAt: r.validated_at,
      createdAt: r.created_at ?? null,
    };
  }

  private markValidated(app: string, ingressId: string): void {
    this.db
      .appDb(app)
      .prepare(
        "UPDATE ingress_auth SET validated_at = datetime('now') WHERE ingress_id = ?",
      )
      .run(ingressId);
  }

  private raw(app: string, ingressId: string): RawRow | undefined {
    return this.db
      .appDb(app)
      .prepare('SELECT * FROM ingress_auth WHERE ingress_id = ?')
      .get(ingressId) as RawRow | undefined;
  }

  private hash(password: string, salt: string): string {
    return scryptSync(password, salt, 32).toString('hex');
  }
}
