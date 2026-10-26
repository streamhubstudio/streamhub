/**
 * LiveControlService specs — the transition side effects, the S3 storage guard
 * and the cover resolution end-to-end, driven against a REAL live-control.db
 * (better-sqlite3 in a tmp dir) with faked apps/streams/s3/livekit/callbacks.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LiveControlService } from './live-control.service';
import { LiveControlStore } from './live-control.store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-svc-'));
}

interface Fakes {
  bucket: string;
  streams: { streamId: string; type: string; room: string; status: string; startedAt: string; participant: string | null }[];
  participants: { identity: string; tracks: { sid: string; type: string }[] }[];
  config: Record<string, unknown>;
}

function build(overrides: Partial<Fakes> = {}) {
  const dir = tmpDir();
  const f: Fakes = {
    bucket: 'b1',
    streams: [
      { streamId: 's1', type: 'rtmp', room: 'live-room1', status: 'live', startedAt: '2026-07-13T00:00:00Z', participant: 'pub1' },
    ],
    participants: [{ identity: 'pub1', tracks: [{ sid: 'AT1', type: 'audio' }, { sid: 'VT1', type: 'video' }] }],
    config: {},
    ...overrides,
  };

  const store = new LiveControlStore();
  store.fileFor = () => path.join(dir, 'live-control.db');

  const apps = {
    appDir: () => dir,
    getConfig: async () => ({ name: 'live', s3: { bucket: f.bucket, prefix: '', publicUrl: '' } }),
  };
  const streams = {
    list: async () => f.streams,
    get: async (_a: string, id: string) => f.streams.find((s) => s.streamId === id) ?? null,
  };
  const logs = { write: () => {}, query: async () => [] };
  const repo = { get: () => ({ enabled: true, config: f.config }) };
  const s3 = {
    uploadBuffer: jest.fn(async () => ({ key: 'k', bucket: 'b1', url: '', sizeBytes: 1 })),
    presignGet: jest.fn(async () => 'https://signed/x'),
    delete: jest.fn(async () => {}),
  };
  const callbacks = { dispatch: jest.fn(async () => {}) };
  const livekit = {
    listParticipantsDetailed: jest.fn(async () => f.participants),
    mutePublishedTrack: jest.fn(async () => ({ trackSid: 'AT1', muted: true })),
    sendData: jest.fn(async () => {}),
  };

  const svc = new LiveControlService(
    apps as never,
    streams as never,
    logs as never,
    repo as never,
    store,
    s3 as never,
    callbacks as never,
    livekit as never,
  );
  return { svc, store, s3, callbacks, livekit, dir, f };
}

describe('LiveControlService transitions', () => {
  it('pause → paused, mutes audio, pushes state, fires livecontrol.paused', async () => {
    const { svc, callbacks, livekit } = build();
    const view = await svc.transition('live', 's1', 'pause', {});
    expect(view.state).toBe('paused');
    expect(view.cover?.mode).toBe('text'); // default mode
    // audio track muted, video track NOT muted
    expect(livekit.mutePublishedTrack).toHaveBeenCalledWith('live-room1', 'pub1', 'AT1', true);
    expect(livekit.mutePublishedTrack).not.toHaveBeenCalledWith('live-room1', 'pub1', 'VT1', true);
    expect(livekit.sendData).toHaveBeenCalled();
    expect(callbacks.dispatch).toHaveBeenCalledWith('live', 'livecontrol.paused', expect.objectContaining({ stream: 's1', room: 'live-room1' }));
  });

  it('resume → live, unmutes audio, fires livecontrol.resumed', async () => {
    const { svc, callbacks, livekit } = build();
    await svc.transition('live', 's1', 'pause', {});
    const view = await svc.transition('live', 's1', 'resume', {});
    expect(view.state).toBe('live');
    expect(view.cover).toBeNull();
    expect(livekit.mutePublishedTrack).toHaveBeenLastCalledWith('live-room1', 'pub1', 'AT1', false);
    expect(callbacks.dispatch).toHaveBeenLastCalledWith('live', 'livecontrol.resumed', expect.any(Object));
  });

  it('finish → finished, fires livecontrol.finished', async () => {
    const { svc, callbacks } = build();
    const view = await svc.transition('live', 's1', 'finish', {});
    expect(view.state).toBe('finished');
    expect(callbacks.dispatch).toHaveBeenCalledWith('live', 'livecontrol.finished', expect.any(Object));
  });

  it('does not mute server-side when muteAudioServerSide=false', async () => {
    const { svc, livekit } = build({ config: { muteAudioServerSide: false } });
    await svc.transition('live', 's1', 'pause', {});
    expect(livekit.mutePublishedTrack).not.toHaveBeenCalled();
  });

  it('rejects a pause referencing an unknown asset id (400)', async () => {
    const { svc } = build();
    await expect(svc.transition('live', 's1', 'pause', { assetId: 999 })).rejects.toThrow(
      /asset '999' not found/,
    );
  });
});

describe('LiveControlService assets + storage guard', () => {
  it('uploads an image asset to S3 and records it', async () => {
    const { svc, s3 } = build();
    const asset = await svc.uploadAsset(
      'live',
      { buffer: Buffer.from('img'), originalname: 'a b.png', mimetype: 'image/png' },
      'Intro',
    );
    expect(asset.kind).toBe('image');
    expect(asset.label).toBe('Intro');
    expect(s3.uploadBuffer).toHaveBeenCalled();
    const list = await svc.listAssets('live');
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe('https://signed/x');
  });

  it('rejects a non image/video upload (400)', async () => {
    const { svc } = build();
    await expect(
      svc.uploadAsset('live', { buffer: Buffer.from('x'), originalname: 'a.pdf', mimetype: 'application/pdf' }),
    ).rejects.toThrow(/unsupported asset type/);
  });

  it('BUCKET GUARD: 409 storage_not_configured when the app has no S3 bucket', async () => {
    const { svc } = build({ bucket: '' });
    await expect(
      svc.uploadAsset('live', { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    await expect(
      svc.uploadAsset('live', { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('pause with an image asset resolves an image cover with a signed URL', async () => {
    const { svc } = build();
    const asset = await svc.uploadAsset('live', {
      buffer: Buffer.from('img'),
      originalname: 'cover.jpg',
      mimetype: 'image/jpeg',
    });
    const view = await svc.transition('live', 's1', 'pause', { mode: 'image', assetId: asset.id });
    expect(view.cover?.mode).toBe('image');
    expect(view.cover?.assetId).toBe(asset.id);
    expect(view.cover?.assetUrl).toBe('https://signed/x');
  });

  it('deletes an asset (db row + S3 object)', async () => {
    const { svc, s3 } = build();
    const a = await svc.uploadAsset('live', { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' });
    const res = await svc.deleteAsset('live', a.id);
    expect(res.removed).toBe(true);
    expect(s3.delete).toHaveBeenCalled();
    expect(await svc.listAssets('live')).toHaveLength(0);
  });
});

describe('LiveControlService reads + settings', () => {
  it('listStreams joins the live stream with its control state', async () => {
    const { svc } = build();
    await svc.transition('live', 's1', 'pause', {});
    const { streams } = await svc.listStreams('live');
    expect(streams).toHaveLength(1);
    expect(streams[0].control.state).toBe('paused');
  });

  it('publicState returns a live/no-cover shape for an untouched stream', async () => {
    const { svc } = build();
    const view = await svc.publicState('live', { stream: 's1' });
    expect(view.state).toBe('live');
    expect(view.cover).toBeNull();
  });

  it('publicState resolves a room to its live stream', async () => {
    const { svc } = build();
    await svc.transition('live', 's1', 'pause', {});
    const view = await svc.publicState('live', { room: 'live-room1' });
    expect(view.streamId).toBe('s1');
    expect(view.state).toBe('paused');
  });

  it('settings validate the referenced asset id exists', async () => {
    const { svc } = build();
    await expect(svc.updateSettings('live', { defaultPauseAssetId: 42 })).rejects.toThrow(/not found/);
    const a = await svc.uploadAsset('live', { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' });
    const s = await svc.updateSettings('live', { defaultPauseAssetId: a.id });
    expect(s.defaultPauseAssetId).toBe(a.id);
  });
});
