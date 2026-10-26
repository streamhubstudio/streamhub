/**
 * Unit specs for StreamPluginOverridesService — the per-stream plugin opt-out
 * storage + resolution (per-app `streams.disabled_plugins`).
 *
 * Locks down the feature invariants:
 *  - a fresh stream defaults to [] (affected by every app-enabled plugin);
 *  - set/get round-trips + normalizes (dedupe, drop non-strings/empties);
 *  - opting one stream out does NOT touch a sibling stream (per-stream only);
 *  - room resolution unions the disabled ids across the room's ACTIVE streams
 *    and ignores ended ones;
 *  - unknown stream/room → [] (degrade to app default), and get/set on a
 *    missing stream → NotFound.
 *
 * Uses the shared harness: a real migrated temp app.db + direct row inserts.
 */
import { NotFoundException } from '@nestjs/common';

import { StreamPluginOverridesService } from './stream-plugins.service';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const APP = 'live';

describe('StreamPluginOverridesService', () => {
  let ctx: UnitContext;
  let svc: StreamPluginOverridesService;
  let appId: number;

  function seedApp(name = APP): number {
    const res = ctx.db
      .global()
      .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
      .run(name, name);
    return Number(res.lastInsertRowid);
  }

  function insertStream(
    streamId: string,
    opts: { room?: string; status?: 'active' | 'ended' } = {},
  ): void {
    const { room = 'room-a', status = 'active' } = opts;
    ctx.db
      .appDb(APP)
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
         VALUES (?, ?, 'webrtc', ?, ?, ?)`,
      )
      .run(appId, streamId, room, streamId.split('/')[1] ?? null, status);
  }

  /** Read the raw stored cell (to assert what actually persisted). */
  function rawDisabled(streamId: string): string {
    const row = ctx.db
      .appDb(APP)
      .prepare('SELECT disabled_plugins FROM streams WHERE stream_id = ?')
      .get(streamId) as { disabled_plugins: string };
    return row.disabled_plugins;
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    appId = seedApp();
    svc = new StreamPluginOverridesService(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  it('migration adds disabled_plugins defaulting to [] on every stream', () => {
    insertStream('room-a/cam1');
    expect(rawDisabled('room-a/cam1')).toBe('[]');
    expect(svc.getForStream(APP, 'room-a/cam1').disabled).toEqual([]);
  });

  it('DEFAULT: a stream opts out of nothing (all app plugins apply)', () => {
    insertStream('room-a/cam1');
    // Nothing disabled → resolveDisabled is empty for stream and room.
    expect(svc.disabledForStream(APP, 'room-a/cam1')).toEqual([]);
    expect(svc.disabledForRoom(APP, 'room-a')).toEqual([]);
  });

  it('set/get round-trips and normalizes (dedupe, drop empties/non-strings)', () => {
    insertStream('room-a/cam1');
    const out = svc.setForStream(APP, 'room-a/cam1', [
      'watermark',
      'watermark', // dup
      '  timestamp  ', // trimmed
      '', // dropped
      42 as unknown as string, // dropped
    ]);
    expect(out).toEqual({
      streamId: 'room-a/cam1',
      disabled: ['watermark', 'timestamp'],
    });
    expect(svc.getForStream(APP, 'room-a/cam1').disabled).toEqual([
      'watermark',
      'timestamp',
    ]);
    expect(JSON.parse(rawDisabled('room-a/cam1'))).toEqual([
      'watermark',
      'timestamp',
    ]);
  });

  it('opting one stream out of a plugin does NOT affect a sibling stream', () => {
    insertStream('room-a/cam1', { room: 'room-a' });
    insertStream('room-b/cam2', { room: 'room-b' });

    svc.setForStream(APP, 'room-a/cam1', ['watermark']);

    // cam1 opted out of watermark only…
    expect(svc.disabledForStream(APP, 'room-a/cam1')).toEqual(['watermark']);
    // …cam2 is untouched (still affected by everything).
    expect(svc.disabledForStream(APP, 'room-b/cam2')).toEqual([]);
    expect(svc.disabledForRoom(APP, 'room-b')).toEqual([]);
  });

  it('room resolution UNIONS active streams and ignores ended ones', () => {
    // Two live publishers in the same room, different opt-outs.
    insertStream('room-a/cam1', { room: 'room-a', status: 'active' });
    insertStream('room-a/cam2', { room: 'room-a', status: 'active' });
    // An ended stream that opted out of yolo — must be ignored.
    insertStream('room-a/old', { room: 'room-a', status: 'ended' });

    svc.setForStream(APP, 'room-a/cam1', ['watermark']);
    svc.setForStream(APP, 'room-a/cam2', ['timestamp']);
    svc.setForStream(APP, 'room-a/old', ['yolo']);

    const disabled = svc.disabledForRoom(APP, 'room-a').sort();
    expect(disabled).toEqual(['timestamp', 'watermark']);
    expect(disabled).not.toContain('yolo');
  });

  it('resolveDisabled prefers an exact stream over the room aggregate', () => {
    insertStream('room-a/cam1', { room: 'room-a' });
    insertStream('room-a/cam2', { room: 'room-a' });
    svc.setForStream(APP, 'room-a/cam1', ['watermark']);
    svc.setForStream(APP, 'room-a/cam2', ['timestamp']);

    // stream scope → just that stream's list.
    expect(svc.resolveDisabled(APP, { stream: 'room-a/cam1' })).toEqual([
      'watermark',
    ]);
    // room scope → the union.
    expect(svc.resolveDisabled(APP, { room: 'room-a' }).sort()).toEqual([
      'timestamp',
      'watermark',
    ]);
    // neither → empty (app default).
    expect(svc.resolveDisabled(APP, {})).toEqual([]);
  });

  it('unknown stream/room → [] for resolution but NotFound for get/set', () => {
    expect(svc.disabledForStream(APP, 'nope/x')).toEqual([]);
    expect(svc.disabledForRoom(APP, 'ghost-room')).toEqual([]);
    expect(() => svc.getForStream(APP, 'nope/x')).toThrow(NotFoundException);
    expect(() => svc.setForStream(APP, 'nope/x', ['watermark'])).toThrow(
      NotFoundException,
    );
  });
});
