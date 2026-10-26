/**
 * Unit specs for TranscriptsRepository (module transcription): the per-app
 * `vod_transcripts` table (lazily created in apps/<name>/app.db), the
 * begin() upsert-reset semantics (one row per VOD; re-trigger wipes results)
 * and partial patch mapping.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { TranscriptsRepository } from './transcripts.repository';

const APP = 'live';

describe('TranscriptsRepository', () => {
  let ctx: UnitContext;
  let repo: TranscriptsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new TranscriptsRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  it('creates the table lazily and starts a queued row', () => {
    repo.begin(APP, 7, 'local', 'small');
    const row = repo.getByVod(APP, 7);
    expect(row).toMatchObject({
      vodId: 7,
      status: 'queued',
      provider: 'local',
      model: 'small',
      text: null,
      srtKey: null,
      error: null,
    });
    expect(row?.createdAt).toBeTruthy();
  });

  it('returns null for a VOD that was never transcribed', () => {
    expect(repo.getByVod(APP, 999)).toBeNull();
  });

  it('patch writes only the provided columns', () => {
    repo.begin(APP, 7, 'local', 'small');
    repo.patch(APP, 7, {
      status: 'ready',
      language: 'es',
      text: '[alice] hola',
      segmentsJson: '[{"start":0,"end":1,"text":"hola","speaker":"alice"}]',
      speakersJson: '["alice"]',
      srtKey: 'rec.srt',
    });
    const row = repo.getByVod(APP, 7);
    expect(row).toMatchObject({
      status: 'ready',
      language: 'es',
      text: '[alice] hola',
      srtKey: 'rec.srt',
      provider: 'local', // untouched
      error: null,
    });
  });

  it('begin() is an upsert keyed by vod_id: re-trigger resets the row', () => {
    repo.begin(APP, 7, 'local', 'small');
    repo.patch(APP, 7, {
      status: 'failed',
      error: 'boom',
      text: 'partial',
      srtKey: 'old.srt',
    });
    repo.begin(APP, 7, 'openai', 'whisper-1');
    const row = repo.getByVod(APP, 7);
    expect(row).toMatchObject({
      vodId: 7,
      status: 'queued',
      provider: 'openai',
      model: 'whisper-1',
      text: null,
      srtKey: null,
      error: null,
    });
    // Still ONE row per vod.
    repo.begin(APP, 7, 'local', 'tiny');
    expect(repo.getByVod(APP, 7)?.provider).toBe('local');
  });

  it('rows are isolated per app database', () => {
    repo.begin(APP, 7, 'local', 'small');
    expect(repo.getByVod('other-app', 7)).toBeNull();
  });

  it('deleteByVod removes the row', () => {
    repo.begin(APP, 7, 'local', 'small');
    repo.deleteByVod(APP, 7);
    expect(repo.getByVod(APP, 7)).toBeNull();
  });
});
