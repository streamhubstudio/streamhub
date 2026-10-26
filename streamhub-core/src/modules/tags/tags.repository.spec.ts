/**
 * Unit specs for TagsRepository — per-app tag CRUD + stream/room tagging
 * (module `tags`, Vision-Edge §E). Uses the shared harness (a real migrated
 * temp app.db + direct row inserts), mirroring stream-plugins.service.spec.
 *
 * Locks the feature invariants:
 *  - CRUD round-trips (create/get/list/update) with config_json as an object;
 *  - slug is kebab-case validated; duplicate slug → 409;
 *  - deleting a tag prunes its slug from EVERY stream atomically;
 *  - stream/room tagging validates every slug exists (400) and the stream row
 *    exists (404);
 *  - an unknown app → 404 (never auto-creates a stray app.db).
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { TagsRepository } from './tags.repository';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const APP = 'live';

describe('TagsRepository', () => {
  let ctx: UnitContext;
  let repo: TagsRepository;
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
    opts: { room?: string; tags?: string[] } = {},
  ): void {
    const { room = 'room-a', tags = [] } = opts;
    ctx.db
      .appDb(APP)
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, participant, status, tags)
         VALUES (?, ?, 'webrtc', ?, ?, 'active', ?)`,
      )
      .run(appId, streamId, room, streamId.split('/')[1] ?? null, JSON.stringify(tags));
  }

  function rawTags(streamId: string): string[] {
    const row = ctx.db
      .appDb(APP)
      .prepare('SELECT tags FROM streams WHERE stream_id = ?')
      .get(streamId) as { tags: string };
    return JSON.parse(row.tags);
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    appId = seedApp();
    repo = new TagsRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  describe('CRUD', () => {
    it('creates a tag with defaults and round-trips config_json as an object', () => {
      const tag = repo.create(APP, {
        slug: 'store-downtown',
        label: 'Downtown',
        kind: 'store',
        config_json: { fps: 3, zones: [1, 2] },
      });
      expect(tag).toMatchObject({
        slug: 'store-downtown',
        label: 'Downtown',
        kind: 'store',
        config_json: { fps: 3, zones: [1, 2] },
      });
      expect(repo.get(APP, 'store-downtown')).toMatchObject({
        config_json: { fps: 3, zones: [1, 2] },
      });
    });

    it('defaults kind to custom and config_json to {}', () => {
      const tag = repo.create(APP, { slug: 'plain', label: 'Plain' });
      expect(tag.kind).toBe('custom');
      expect(tag.config_json).toEqual({});
    });

    it('lists tags and filters by kind', () => {
      repo.create(APP, { slug: 'a-store', label: 'A', kind: 'store' });
      repo.create(APP, { slug: 'a-zone', label: 'Z', kind: 'zone' });
      expect(repo.list(APP).map((t) => t.slug).sort()).toEqual([
        'a-store',
        'a-zone',
      ]);
      expect(repo.list(APP, 'store').map((t) => t.slug)).toEqual(['a-store']);
    });

    it('updates label/kind/config_json partially', () => {
      repo.create(APP, {
        slug: 'x',
        label: 'X',
        kind: 'custom',
        config_json: { a: 1 },
      });
      const out = repo.update(APP, 'x', { label: 'X2', config_json: { b: 2 } });
      expect(out).toMatchObject({
        slug: 'x',
        label: 'X2',
        kind: 'custom',
        config_json: { b: 2 },
      });
    });

    it('rejects an invalid (non-kebab) slug with 400', () => {
      expect(() =>
        repo.create(APP, { slug: 'Not_Kebab', label: 'x' }),
      ).toThrow(BadRequestException);
      expect(() => repo.create(APP, { slug: '-lead', label: 'x' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a duplicate slug with 409', () => {
      repo.create(APP, { slug: 'dup', label: 'one' });
      expect(() => repo.create(APP, { slug: 'dup', label: 'two' })).toThrow(
        ConflictException,
      );
    });

    it('get/update on a missing tag → null / 404', () => {
      expect(repo.get(APP, 'ghost')).toBeNull();
      expect(() => repo.update(APP, 'ghost', { label: 'x' })).toThrow(
        NotFoundException,
      );
    });

    it('unknown app → 404 (no stray app.db)', () => {
      expect(() => repo.list('ghost-app')).toThrow(NotFoundException);
      expect(() => repo.create('ghost-app', { slug: 's', label: 'l' })).toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete prunes streams', () => {
    it('deletes the tag and removes its slug from every stream atomically', () => {
      repo.create(APP, { slug: 'store-a', label: 'A' });
      repo.create(APP, { slug: 'zone-x', label: 'Z' });
      insertStream('room-a/cam1', { tags: ['store-a', 'zone-x'] });
      insertStream('room-a/cam2', { tags: ['store-a'] });
      insertStream('room-b/cam3', { tags: ['zone-x'] });

      repo.remove(APP, 'store-a');

      expect(repo.get(APP, 'store-a')).toBeNull();
      expect(rawTags('room-a/cam1')).toEqual(['zone-x']);
      expect(rawTags('room-a/cam2')).toEqual([]);
      expect(rawTags('room-b/cam3')).toEqual(['zone-x']); // untouched
    });

    it('deleting a missing tag → 404 and touches nothing', () => {
      insertStream('room-a/cam1', { tags: [] });
      expect(() => repo.remove(APP, 'nope')).toThrow(NotFoundException);
    });
  });

  describe('stream tagging', () => {
    beforeEach(() => {
      repo.create(APP, { slug: 'store-a', label: 'A' });
      repo.create(APP, { slug: 'zone-x', label: 'Z' });
      insertStream('room-a/cam1', { room: 'room-a', tags: [] });
    });

    it('sets a stream tags, normalizing (dedupe/trim) and persisting', () => {
      const out = repo.setStreamTags(APP, 'room-a/cam1', [
        'store-a',
        'store-a', // dup
        '  zone-x  ', // trimmed
        '', // dropped
        7 as unknown as string, // dropped
      ]);
      expect(out).toEqual({ streamId: 'room-a/cam1', tags: ['store-a', 'zone-x'] });
      expect(rawTags('room-a/cam1')).toEqual(['store-a', 'zone-x']);
      expect(repo.getStreamTags(APP, 'room-a/cam1').tags).toEqual([
        'store-a',
        'zone-x',
      ]);
    });

    it('rejects an unknown slug with 400 and leaves the stream unchanged', () => {
      expect(() =>
        repo.setStreamTags(APP, 'room-a/cam1', ['store-a', 'ghost']),
      ).toThrow(BadRequestException);
      expect(rawTags('room-a/cam1')).toEqual([]);
    });

    it('setting tags on a missing stream → 404', () => {
      expect(() => repo.setStreamTags(APP, 'nope/x', ['store-a'])).toThrow(
        NotFoundException,
      );
      expect(() => repo.getStreamTags(APP, 'nope/x')).toThrow(NotFoundException);
    });

    it('empty array clears a stream tags', () => {
      repo.setStreamTags(APP, 'room-a/cam1', ['store-a']);
      expect(repo.setStreamTags(APP, 'room-a/cam1', []).tags).toEqual([]);
      expect(rawTags('room-a/cam1')).toEqual([]);
    });
  });

  describe('room tagging', () => {
    beforeEach(() => {
      repo.create(APP, { slug: 'store-a', label: 'A' });
      insertStream('room-a/cam1', { room: 'room-a', tags: [] });
      insertStream('room-a/cam2', { room: 'room-a', tags: [] });
      insertStream('room-b/cam3', { room: 'room-b', tags: [] });
    });

    it('applies tags to every stream row of the room and reports the count', () => {
      const out = repo.setRoomTags(APP, 'room-a', ['store-a']);
      expect(out).toEqual({ room: 'room-a', tags: ['store-a'], updated: 2 });
      expect(rawTags('room-a/cam1')).toEqual(['store-a']);
      expect(rawTags('room-a/cam2')).toEqual(['store-a']);
      expect(rawTags('room-b/cam3')).toEqual([]); // other room untouched
    });

    it('a room with no stream rows yet → updated 0 (not an error)', () => {
      expect(repo.setRoomTags(APP, 'empty-room', ['store-a']).updated).toBe(0);
    });

    it('rejects an unknown slug with 400', () => {
      expect(() => repo.setRoomTags(APP, 'room-a', ['ghost'])).toThrow(
        BadRequestException,
      );
    });
  });
});
