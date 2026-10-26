import { Injectable } from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';

/** Role of one ingress inside a primary+backup (failover) pair. */
export type IngressRole = 'primary' | 'backup';

/** One primary↔backup pairing row (per-app `ingress_backup_links`). */
export interface IngressBackupLink {
  primaryIngressId: string;
  backupIngressId: string;
  app: string;
  room: string;
  createdAt?: string | null;
}

/**
 * Role + pairing summary for a single ingress id:
 *  - role 'primary' → this id owns a backup (`backupIngressId` set),
 *  - role 'backup'  → this id IS a backup of `primaryIngressId`,
 *  - role null      → the id is not part of a failover pair.
 * `pairedIngressId` is always the OTHER id of the pair (or null).
 */
export interface IngressRoleInfo {
  role: IngressRole | null;
  pairedIngressId: string | null;
  primaryIngressId?: string;
  backupIngressId?: string;
}

interface RawRow {
  primary_ingress_id: string;
  backup_ingress_id: string;
  app: string;
  room: string;
  created_at: string | null;
}

/**
 * Per-app store for primary+backup (failover) RTMP ingress pairs.
 *
 * A "primary + backup stream key" (Dacast/Vimeo-style) is modelled as TWO
 * LiveKit ingresses bound to the SAME room: both keys publish into one room, so
 * the player/playback URL is identical whichever key is live. This table only
 * records the pairing (primary→backup) so the API can label each key's role,
 * surface the sibling key on the primary, and cascade-delete the backup when
 * the primary is removed. The keys/passwords themselves live in `ingress_auth`
 * (one row per ingress) exactly as for a standalone ingress — auth for BOTH
 * keys therefore works with no extra plumbing.
 *
 * STORAGE: the table lives in the per-app `app.db` reached via
 * `DbService.appDb(app)` and is created lazily on first access (same pattern as
 * modules/transcription `vod_transcripts` and modules/security `ip_rules`), so
 * no shared migration file is touched.
 */
@Injectable()
export class IngressBackupService {
  /** Apps whose per-app DB already has the table (avoid re-running the DDL). */
  private readonly ensured = new Set<string>();

  constructor(private readonly db: DbService) {}

  private static readonly TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS ingress_backup_links (
      primary_ingress_id TEXT PRIMARY KEY,
      backup_ingress_id  TEXT NOT NULL UNIQUE,
      app                TEXT NOT NULL,
      room               TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ingress_backup_backup
      ON ingress_backup_links(backup_ingress_id);`;

  private handle(app: string) {
    const h = this.db.appDb(app);
    if (!this.ensured.has(app)) {
      h.exec(IngressBackupService.TABLE_SQL);
      this.ensured.add(app);
    }
    return h;
  }

  /**
   * Record (or replace) a primary→backup pairing. Idempotent on the primary id:
   * re-linking a primary to a new backup replaces the old row.
   */
  link(
    app: string,
    input: { primaryIngressId: string; backupIngressId: string; room: string },
  ): void {
    this.handle(app)
      .prepare(
        `INSERT INTO ingress_backup_links
           (primary_ingress_id, backup_ingress_id, app, room)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(primary_ingress_id) DO UPDATE SET
           backup_ingress_id = excluded.backup_ingress_id,
           room = excluded.room`,
      )
      .run(input.primaryIngressId, input.backupIngressId, app, input.room ?? '');
  }

  /** The pairing whose PRIMARY id is `ingressId`, or null. */
  getByPrimary(app: string, ingressId: string): IngressBackupLink | null {
    const r = this.handle(app)
      .prepare(
        'SELECT * FROM ingress_backup_links WHERE primary_ingress_id = ?',
      )
      .get(ingressId) as RawRow | undefined;
    return r ? IngressBackupService.toLink(r) : null;
  }

  /** The pairing whose BACKUP id is `ingressId`, or null. */
  getByBackup(app: string, ingressId: string): IngressBackupLink | null {
    const r = this.handle(app)
      .prepare('SELECT * FROM ingress_backup_links WHERE backup_ingress_id = ?')
      .get(ingressId) as RawRow | undefined;
    return r ? IngressBackupService.toLink(r) : null;
  }

  /** The pairing that references `ingressId` as EITHER primary or backup. */
  getLinkFor(app: string, ingressId: string): IngressBackupLink | null {
    return this.getByPrimary(app, ingressId) ?? this.getByBackup(app, ingressId);
  }

  /** Role + paired-id summary for one ingress id (never throws on unknown id). */
  getRoleInfo(app: string, ingressId: string): IngressRoleInfo {
    const asPrimary = this.getByPrimary(app, ingressId);
    if (asPrimary) {
      return {
        role: 'primary',
        pairedIngressId: asPrimary.backupIngressId,
        primaryIngressId: asPrimary.primaryIngressId,
        backupIngressId: asPrimary.backupIngressId,
      };
    }
    const asBackup = this.getByBackup(app, ingressId);
    if (asBackup) {
      return {
        role: 'backup',
        pairedIngressId: asBackup.primaryIngressId,
        primaryIngressId: asBackup.primaryIngressId,
        backupIngressId: asBackup.backupIngressId,
      };
    }
    return { role: null, pairedIngressId: null };
  }

  /** Drop any pairing that references `ingressId` (as primary OR backup). */
  remove(app: string, ingressId: string): void {
    this.handle(app)
      .prepare(
        'DELETE FROM ingress_backup_links WHERE primary_ingress_id = ? OR backup_ingress_id = ?',
      )
      .run(ingressId, ingressId);
  }

  private static toLink(r: RawRow): IngressBackupLink {
    return {
      primaryIngressId: r.primary_ingress_id,
      backupIngressId: r.backup_ingress_id,
      app: r.app,
      room: r.room,
      createdAt: r.created_at ?? null,
    };
  }
}
