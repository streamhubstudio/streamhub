/**
 * Persistence for VOD transcripts — per-app `vod_transcripts` table (one row
 * per VOD, keyed/UNIQUE by vod_id; a re-trigger resets the same row).
 *
 * Lives in the consolidated per-app database apps/<name>/app.db reached via
 * `DbService.appDb(app)`. The table is created lazily on first access (same
 * pattern as modules/security ip_rules / modules/auth sessions), so no shared
 * migration file needs editing.
 */
import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';

export type TranscriptStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** Decoded row of vod_transcripts. */
export interface TranscriptRecord {
  id: number;
  vodId: number;
  status: TranscriptStatus;
  /** 'local' (faster-whisper worker) | 'openai'. */
  provider: string | null;
  model: string | null;
  /** Detected/declared ISO language code (e.g. 'es'), null when unknown. */
  language: string | null;
  /** Full plain-text transcript (one `[speaker] text` line per segment). */
  text: string | null;
  /** JSON array of { start, end, text, speaker } segments. */
  segmentsJson: string | null;
  /** JSON array of distinct speaker labels. */
  speakersJson: string | null;
  /** S3 object key of the uploaded SRT (null when upload failed/skipped). */
  srtKey: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  vod_id: number;
  status: TranscriptStatus;
  provider: string | null;
  model: string | null;
  language: string | null;
  text: string | null;
  segments_json: string | null;
  speakers_json: string | null;
  srt_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Partial patch (only provided keys are written). */
export interface TranscriptPatch {
  status?: TranscriptStatus;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  text?: string | null;
  segmentsJson?: string | null;
  speakersJson?: string | null;
  srtKey?: string | null;
  error?: string | null;
}

const PATCH_COLUMNS: Record<keyof TranscriptPatch, string> = {
  status: 'status',
  provider: 'provider',
  model: 'model',
  language: 'language',
  text: 'text',
  segmentsJson: 'segments_json',
  speakersJson: 'speakers_json',
  srtKey: 'srt_key',
  error: 'error',
};

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS vod_transcripts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id        INTEGER NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'queued',
    provider      TEXT,
    model         TEXT,
    language      TEXT,
    text          TEXT,
    segments_json TEXT,
    speakers_json TEXT,
    srt_key       TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

@Injectable()
export class TranscriptsRepository {
  /** Apps whose per-app DB already has the table (avoid re-running DDL). */
  private readonly ensured = new Set<string>();

  constructor(private readonly db: DbService) {}

  private handle(app: string) {
    const h = this.db.appDb(app);
    if (!this.ensured.has(app)) {
      h.exec(TABLE_SQL);
      this.ensured.add(app);
    }
    return h;
  }

  /**
   * Start (or restart) a transcription job for a VOD: upserts the row back to
   * `queued` with a clean slate (previous results/errors wiped).
   */
  begin(app: string, vodId: number, provider: string, model: string): void {
    this.handle(app)
      .prepare(
        `INSERT INTO vod_transcripts (vod_id, status, provider, model)
           VALUES (@vod_id, 'queued', @provider, @model)
         ON CONFLICT(vod_id) DO UPDATE SET
           status = 'queued',
           provider = excluded.provider,
           model = excluded.model,
           language = NULL,
           text = NULL,
           segments_json = NULL,
           speakers_json = NULL,
           srt_key = NULL,
           error = NULL,
           updated_at = datetime('now')`,
      )
      .run({ vod_id: vodId, provider, model });
  }

  /** Apply a partial patch to the VOD's transcript row. Bumps updated_at. */
  patch(app: string, vodId: number, patch: TranscriptPatch): void {
    const keys = Object.keys(patch) as (keyof TranscriptPatch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = @${k}`);
    sets.push("updated_at = datetime('now')");
    const params: Record<string, unknown> = { vod_id: vodId };
    for (const k of keys) params[k] = patch[k] ?? null;
    this.handle(app)
      .prepare(
        `UPDATE vod_transcripts SET ${sets.join(', ')} WHERE vod_id = @vod_id`,
      )
      .run(params);
  }

  getByVod(app: string, vodId: number): TranscriptRecord | null {
    const row = this.handle(app)
      .prepare('SELECT * FROM vod_transcripts WHERE vod_id = ?')
      .get(vodId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  deleteByVod(app: string, vodId: number): void {
    this.handle(app)
      .prepare('DELETE FROM vod_transcripts WHERE vod_id = ?')
      .run(vodId);
  }

  private map(r: Row): TranscriptRecord {
    return {
      id: r.id,
      vodId: r.vod_id,
      status: r.status,
      provider: r.provider,
      model: r.model,
      language: r.language,
      text: r.text,
      segmentsJson: r.segments_json,
      speakersJson: r.speakers_json,
      srtKey: r.srt_key,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
