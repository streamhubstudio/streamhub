/**
 * TAGS data access (module `tags`).
 *
 * Owns the per-app `tags` table (a small named ENTITY with a `config_json`
 * settings blob) and the `streams.tags` JSON-array column that references tags
 * by slug. Mirrors {@link StreamPluginOverridesService} (per-app `app.db` via
 * `DbService.appDb`, JSON-array column normalization, direct HTTP exceptions) —
 * the two are sibling features (`disabled_plugins` was the precedent for the
 * `streams.tags` column).
 *
 * A tag = an operator-created entity (kind `store` | `zone` | `custom` | …)
 * whose `config_json` carries per-consumer settings (vision models read their
 * per-model blocks from it). Deleting a tag PRUNES its slug from every stream's
 * `tags` array atomically so no stream is ever left pointing at a dead tag.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';

/** kebab-case slug: lowercase alphanumerics in hyphen-separated groups. */
export const TAG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Public shape of a tag (config_json parsed to an object). */
export interface TagRecord {
  slug: string;
  label: string;
  kind: string;
  /** Parsed `config_json` settings blob (schema owned by the tag's consumer). */
  config_json: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Create input for a tag. */
export interface CreateTagInput {
  slug: string;
  label: string;
  kind?: string;
  config_json?: Record<string, unknown>;
}

/** Partial update for a tag (every field optional; slug is immutable). */
export interface UpdateTagInput {
  label?: string;
  kind?: string;
  config_json?: Record<string, unknown>;
}

/** Result of a stream-tagging write. */
export interface StreamTagsState {
  streamId: string;
  tags: string[];
}

/** Result of a room-scoped tagging write. */
export interface RoomTagsState {
  room: string;
  tags: string[];
  /** Number of stream rows updated. */
  updated: number;
}

interface TagRow {
  id: number;
  slug: string;
  label: string;
  kind: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TagsRepository {
  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------------------
  // Tag CRUD
  // ---------------------------------------------------------------------------

  /** List an app's tags (optionally filtered by `kind`), newest first. */
  list(app: string, kind?: string): TagRecord[] {
    this.requireApp(app);
    const adb = this.db.appDb(app);
    const rows = (
      kind
        ? adb
            .prepare(
              'SELECT * FROM tags WHERE kind = ? ORDER BY created_at DESC, id DESC',
            )
            .all(kind)
        : adb
            .prepare('SELECT * FROM tags ORDER BY created_at DESC, id DESC')
            .all()
    ) as TagRow[];
    return rows.map(TagsRepository.toRecord);
  }

  /** One tag by slug, or null when absent. */
  get(app: string, slug: string): TagRecord | null {
    this.requireApp(app);
    const row = this.db
      .appDb(app)
      .prepare('SELECT * FROM tags WHERE slug = ?')
      .get(slug) as TagRow | undefined;
    return row ? TagsRepository.toRecord(row) : null;
  }

  /**
   * Create a tag. Validates the slug (kebab-case) and rejects a duplicate slug
   * with 409. `config_json` defaults to `{}`.
   */
  create(app: string, input: CreateTagInput): TagRecord {
    this.requireApp(app);
    const slug = (input.slug ?? '').trim();
    if (!TAG_SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'invalid slug (kebab-case: lowercase a-z, 0-9, hyphen-separated)',
      );
    }
    const label = (input.label ?? '').trim();
    if (!label) throw new BadRequestException('label is required');
    const kind = (input.kind ?? 'custom').trim() || 'custom';
    const configJson = TagsRepository.stringifyConfig(input.config_json);

    const adb = this.db.appDb(app);
    if (adb.prepare('SELECT 1 FROM tags WHERE slug = ?').get(slug)) {
      throw new ConflictException(`tag '${slug}' already exists`);
    }
    adb
      .prepare(
        'INSERT INTO tags (slug, label, kind, config_json) VALUES (?, ?, ?, ?)',
      )
      .run(slug, label, kind, configJson);
    return this.get(app, slug) as TagRecord;
  }

  /**
   * Patch a tag's label / kind / config_json (any subset). Throws 404 when the
   * tag does not exist. Bumps `updated_at`.
   */
  update(app: string, slug: string, patch: UpdateTagInput): TagRecord {
    this.requireApp(app);
    const adb = this.db.appDb(app);
    const existing = adb
      .prepare('SELECT * FROM tags WHERE slug = ?')
      .get(slug) as TagRow | undefined;
    if (!existing) throw new NotFoundException(`tag '${slug}' not found`);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new BadRequestException('label cannot be empty');
      sets.push('label = ?');
      params.push(label);
    }
    if (patch.kind !== undefined) {
      const kind = patch.kind.trim() || 'custom';
      sets.push('kind = ?');
      params.push(kind);
    }
    if (patch.config_json !== undefined) {
      sets.push('config_json = ?');
      params.push(TagsRepository.stringifyConfig(patch.config_json));
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      adb
        .prepare(`UPDATE tags SET ${sets.join(', ')} WHERE slug = ?`)
        .run(...params, slug);
    }
    return this.get(app, slug) as TagRecord;
  }

  /**
   * Delete a tag AND prune its slug from every stream's `tags` array — both in a
   * single transaction so a stream can never reference a deleted tag. Throws 404
   * when the tag does not exist.
   */
  remove(app: string, slug: string): void {
    this.requireApp(app);
    const adb = this.db.appDb(app);
    const tx = adb.transaction((s: string) => {
      const del = adb.prepare('DELETE FROM tags WHERE slug = ?').run(s);
      if (del.changes === 0) {
        throw new NotFoundException(`tag '${s}' not found`);
      }
      // Prune the slug from any stream that references it.
      const rows = adb.prepare('SELECT id, tags FROM streams').all() as {
        id: number;
        tags: string | null;
      }[];
      for (const r of rows) {
        const current = TagsRepository.parseTags(r.tags);
        if (current.includes(s)) {
          const next = current.filter((t) => t !== s);
          adb
            .prepare('UPDATE streams SET tags = ? WHERE id = ?')
            .run(JSON.stringify(next), r.id);
        }
      }
    });
    tx(slug);
  }

  // ---------------------------------------------------------------------------
  // Stream tagging (streams.tags JSON-array column)
  // ---------------------------------------------------------------------------

  /** A stream's applied tag slugs. Throws 404 when the stream row is absent. */
  getStreamTags(app: string, streamId: string): StreamTagsState {
    this.requireApp(app);
    const row = this.db
      .appDb(app)
      .prepare('SELECT tags FROM streams WHERE stream_id = ?')
      .get(streamId) as { tags: string | null } | undefined;
    if (!row) throw new NotFoundException(`stream '${streamId}' not found`);
    return { streamId, tags: TagsRepository.parseTags(row.tags) };
  }

  /**
   * Replace a stream's applied tag slugs. Every slug must reference an existing
   * tag (400 otherwise). Throws 404 when the stream row is absent.
   */
  setStreamTags(app: string, streamId: string, slugs: unknown[]): StreamTagsState {
    this.requireApp(app);
    const tags = this.normalizeAndValidate(app, slugs);
    const info = this.db
      .appDb(app)
      .prepare('UPDATE streams SET tags = ? WHERE stream_id = ?')
      .run(JSON.stringify(tags), streamId);
    if (info.changes === 0) {
      throw new NotFoundException(`stream '${streamId}' not found`);
    }
    return { streamId, tags };
  }

  /**
   * Replace the tag slugs on EVERY stream row of a room (the join point Wave-2
   * will use to auto-associate new stream rows). Every slug must exist (400
   * otherwise). Returns how many rows were updated — 0 when the room has no
   * stream rows yet (not an error: the association simply applies to what
   * exists).
   */
  setRoomTags(app: string, room: string, slugs: unknown[]): RoomTagsState {
    this.requireApp(app);
    const tags = this.normalizeAndValidate(app, slugs);
    const info = this.db
      .appDb(app)
      .prepare('UPDATE streams SET tags = ? WHERE room = ?')
      .run(JSON.stringify(tags), room);
    return { room, tags, updated: Number(info.changes) || 0 };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Guard: the app must exist in the global registry BEFORE touching
   * `appDb(app)` (which would otherwise create + migrate a stray app.db for a
   * bogus name). Mirrors {@link StreamsService.requireApp}.
   */
  private requireApp(app: string): void {
    let row: { id: number } | undefined;
    try {
      row = this.db
        .global()
        .prepare('SELECT id FROM apps WHERE name = ?')
        .get(app) as { id: number } | undefined;
    } catch (err) {
      throw new ServiceUnavailableException(`db error: ${String(err)}`);
    }
    if (!row) throw new NotFoundException(`app '${app}' not found`);
  }

  /** Normalize a slug array (dedupe/trim/drop empties) + assert each exists. */
  private normalizeAndValidate(app: string, slugs: unknown[]): string[] {
    const tags = TagsRepository.normalize(slugs ?? []);
    if (tags.length === 0) return tags;
    const placeholders = tags.map(() => '?').join(', ');
    const known = new Set(
      (
        this.db
          .appDb(app)
          .prepare(`SELECT slug FROM tags WHERE slug IN (${placeholders})`)
          .all(...tags) as { slug: string }[]
      ).map((r) => r.slug),
    );
    const unknown = tags.filter((t) => !known.has(t));
    if (unknown.length) {
      throw new BadRequestException(
        `unknown tag slug(s): ${unknown.join(', ')}`,
      );
    }
    return tags;
  }

  /** Coerce to a deduped array of non-empty string slugs (order preserved). */
  private static normalize(ids: unknown[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  /** Parse a `streams.tags` / any JSON-array cell into a clean slug array. */
  private static parseTags(json: string | null | undefined): string[] {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? TagsRepository.normalize(v) : [];
    } catch {
      return [];
    }
  }

  /** Stringify a config object → JSON text (defaults to `{}`; never throws). */
  private static stringifyConfig(config: Record<string, unknown> | undefined): string {
    if (config === undefined || config === null) return '{}';
    try {
      return JSON.stringify(config);
    } catch {
      return '{}';
    }
  }

  private static toRecord(row: TagRow): TagRecord {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.config_json ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      /* corrupt cell → empty config */
    }
    return {
      slug: row.slug,
      label: row.label,
      kind: row.kind,
      config_json: config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
