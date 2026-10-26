/**
 * Unit specs for ScheduledLiveService + ScheduledLiveController wiring
 * (module scheduled-live).
 *
 * The per-app agenda of scheduled live premieres over a REAL migrated per-app
 * DB (nothing dials the network). Locks down:
 *  - create → list: the new event is present, camelCase + boolean enabled;
 *  - listPublic filters out DISABLED and PAST-cutoff events and respects room
 *    (event.room === room OR event.room IS NULL);
 *  - update toggles `enabled` and moves `start_at`;
 *  - remove deletes (and a second remove 404s);
 *  - startAt validation (positive integer) rejects bad input;
 *  - the migration created the `scheduled_events` table;
 *  - RBAC wiring: the controller declares config:read/write;
 *  - tenant/app isolation: rows live in the app's OWN app.db.
 */
import { Reflector } from '@nestjs/core';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { makeUnitContext, mockAppsService, type UnitContext } from '../../../test/helpers';
import { REQUIRE_PERMISSION_KEY } from '../authz/permission.decorator';
import { ScheduledLiveController } from './scheduled-live.controller';
import { ScheduledLiveRepository } from './scheduled-live.repository';
import { ScheduledLiveService } from './scheduled-live.service';

const APP = 'live';
// A fixed "now" far in the future so fixture events are unambiguously past/future.
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0); // 2030-01-01 12:00:00 UTC
const HOUR = 60 * 60 * 1000;

describe('ScheduledLiveService', () => {
  let ctx: UnitContext;
  let repo: ScheduledLiveRepository;
  let svc: ScheduledLiveService;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new ScheduledLiveRepository(ctx.db);
    svc = new ScheduledLiveService(repo);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // schema
  // ---------------------------------------------------------------------------

  it('the migration created the scheduled_events table', () => {
    const row = ctx.db
      .appDb(APP)
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_events'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('scheduled_events');
  });

  // ---------------------------------------------------------------------------
  // create + list
  // ---------------------------------------------------------------------------

  it('create → list: the new event is present with camelCase view', () => {
    const created = svc.create(APP, {
      startAt: NOW + HOUR,
      timezone: 'America/Argentina/Buenos_Aires',
      title: 'Gran estreno',
      room: 'room1',
      message: 'Ya casi',
      enabled: true,
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.startAt).toBe(NOW + HOUR);
    expect(created.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(created.enabled).toBe(true);

    const all = svc.list(APP);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Gran estreno');
    expect(all[0].room).toBe('room1');
  });

  it('defaults timezone to UTC and enabled to true when omitted', () => {
    const created = svc.create(APP, { startAt: NOW + HOUR });
    expect(created.timezone).toBe('UTC');
    expect(created.enabled).toBe(true);
    expect(created.room).toBeNull();
    expect(created.title).toBeNull();
  });

  it('owner item 11: an omitted timezone falls back to the given defaultTimezone (the app tz)', () => {
    const created = svc.create(
      APP,
      { startAt: NOW + HOUR },
      'America/Argentina/Buenos_Aires',
    );
    expect(created.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('owner item 11: an EXPLICIT event timezone always wins over defaultTimezone', () => {
    const created = svc.create(
      APP,
      { startAt: NOW + HOUR, timezone: 'Europe/Madrid' },
      'America/Argentina/Buenos_Aires',
    );
    expect(created.timezone).toBe('Europe/Madrid');
  });

  it('owner item 11: update() also falls back to defaultTimezone when clearing the timezone', () => {
    const created = svc.create(APP, {
      startAt: NOW + HOUR,
      timezone: 'Europe/Madrid',
    });
    const updated = svc.update(APP, created.id, { timezone: '' }, 'Asia/Tokyo');
    expect(updated.timezone).toBe('Asia/Tokyo');
  });

  it('rejects a non-positive / non-integer startAt', () => {
    expect(() => svc.create(APP, { startAt: 0 })).toThrow(BadRequestException);
    expect(() => svc.create(APP, { startAt: -5 })).toThrow(BadRequestException);
    expect(() => svc.create(APP, { startAt: 1.5 })).toThrow(BadRequestException);
  });

  it('list is ordered soonest-first', () => {
    svc.create(APP, { startAt: NOW + 3 * HOUR, title: 'C' });
    svc.create(APP, { startAt: NOW + HOUR, title: 'A' });
    svc.create(APP, { startAt: NOW + 2 * HOUR, title: 'B' });
    expect(svc.list(APP).map((e) => e.title)).toEqual(['A', 'B', 'C']);
  });

  // ---------------------------------------------------------------------------
  // listPublic — filters disabled + past, respects room
  // ---------------------------------------------------------------------------

  it('listPublic drops disabled and past-cutoff events; keeps upcoming', () => {
    const future = svc.create(APP, { startAt: NOW + HOUR, title: 'future' });
    svc.create(APP, { startAt: NOW + 2 * HOUR, title: 'disabled', enabled: false });
    svc.create(APP, { startAt: NOW - 5 * HOUR, title: 'past' });

    const rows = svc.listPublic(APP, undefined, NOW - HOUR);
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('future');
    expect(titles).not.toContain('disabled'); // enabled=0
    expect(titles).not.toContain('past'); // start_at < cutoff
    expect(rows.every((r) => r.id === future.id || r.enabled)).toBe(true);
  });

  it('listPublic respects room: room match OR global (room IS NULL)', () => {
    svc.create(APP, { startAt: NOW + HOUR, title: 'room1', room: 'room1' });
    svc.create(APP, { startAt: NOW + HOUR, title: 'room2', room: 'room2' });
    svc.create(APP, { startAt: NOW + HOUR, title: 'global', room: null });

    const forRoom1 = svc.listPublic(APP, 'room1', NOW).map((r) => r.title);
    expect(forRoom1).toEqual(expect.arrayContaining(['room1', 'global']));
    expect(forRoom1).not.toContain('room2');

    // No room filter → every enabled upcoming event.
    const all = svc.listPublic(APP, undefined, NOW).map((r) => r.title);
    expect(all).toEqual(expect.arrayContaining(['room1', 'room2', 'global']));
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  it('update toggles enabled and moves start_at', () => {
    const e = svc.create(APP, { startAt: NOW + HOUR, enabled: true });

    const disabled = svc.update(APP, e.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    // A disabled event drops out of the public listing.
    expect(svc.listPublic(APP, undefined, NOW)).toHaveLength(0);

    const moved = svc.update(APP, e.id, { enabled: true, startAt: NOW + 5 * HOUR });
    expect(moved.startAt).toBe(NOW + 5 * HOUR);
    expect(moved.enabled).toBe(true);
    expect(svc.listPublic(APP, undefined, NOW)).toHaveLength(1);
  });

  it('update 404s on an unknown id', () => {
    expect(() => svc.update(APP, 9999, { enabled: false })).toThrow(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  it('remove deletes the event; a second remove 404s', () => {
    const e = svc.create(APP, { startAt: NOW + HOUR });
    expect(svc.remove(APP, e.id)).toEqual({ removed: true });
    expect(svc.list(APP)).toHaveLength(0);
    expect(() => svc.remove(APP, e.id)).toThrow(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // tenant/app isolation — per-app app.db
  // ---------------------------------------------------------------------------

  it('events of one app are invisible to another app (per-app DB)', () => {
    svc.create(APP, { startAt: NOW + HOUR, title: 'only-live' });
    expect(svc.list('other')).toHaveLength(0);
    expect(svc.listPublic('other', undefined, NOW)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Real-time agenda push (LIVEKIT-UNUSED-FEATURES item 1) — every agenda
// mutation pushes an `agenda-updated` data message (topic `scheduled-live`) to
// the affected LiveKit room(s); the overlay's 30 s poll stays as fallback.
// -----------------------------------------------------------------------------

describe('ScheduledLiveService — real-time agenda push', () => {
  let ctx: UnitContext;
  let repo: ScheduledLiveRepository;
  let svc: ScheduledLiveService;
  let livekit: { sendData: jest.Mock; listRooms: jest.Mock };
  let moduleRef: { get: jest.Mock };

  /** Flush the fire-and-forget notify (a macrotask drains all microtasks). */
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new ScheduledLiveRepository(ctx.db);
    livekit = {
      sendData: jest.fn(async () => undefined),
      listRooms: jest.fn(async () => [
        { name: 'live', sid: 'RM_a', numParticipants: 1, creationTime: 1 },
        { name: 'live-show', sid: 'RM_b', numParticipants: 2, creationTime: 2 },
        { name: 'other-x', sid: 'RM_c', numParticipants: 5, creationTime: 3 },
      ]),
    };
    const apps = {
      getConfig: jest.fn(async () => ({ roomPrefix: 'live' })),
    };
    moduleRef = { get: jest.fn(() => apps) };
    svc = new ScheduledLiveService(repo, livekit as never, moduleRef as never);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('create with a room pushes agenda-updated to the namespaced room only', async () => {
    svc.create(APP, { startAt: NOW + HOUR, room: 'show' });
    await flush();

    expect(livekit.sendData).toHaveBeenCalledTimes(1);
    const [room, payload, opts] = livekit.sendData.mock.calls[0];
    expect(room).toBe('live-show');
    expect(opts).toEqual({ topic: 'scheduled-live', reliable: true });
    expect(JSON.parse(payload)).toMatchObject({
      type: 'agenda-updated',
      app: APP,
      room: 'show',
    });
  });

  it('create with no room pushes to every live room under the app prefix', async () => {
    svc.create(APP, { startAt: NOW + HOUR });
    await flush();

    const rooms = livekit.sendData.mock.calls.map((c) => c[0]).sort();
    // Only the app's rooms; the foreign 'other-x' room is never notified.
    expect(rooms).toEqual(['live', 'live-show']);
    expect(JSON.parse(livekit.sendData.mock.calls[0][1])).toMatchObject({
      type: 'agenda-updated',
      room: null,
    });
  });

  it('update pushes to the event room; moving rooms notifies old AND new', async () => {
    const e = svc.create(APP, { startAt: NOW + HOUR, room: 'show' });
    await flush();
    livekit.sendData.mockClear();

    svc.update(APP, e.id, { enabled: false });
    await flush();
    expect(livekit.sendData).toHaveBeenCalledTimes(1);
    expect(livekit.sendData.mock.calls[0][0]).toBe('live-show');

    livekit.sendData.mockClear();
    svc.update(APP, e.id, { room: 'main' });
    await flush();
    const rooms = livekit.sendData.mock.calls.map((c) => c[0]).sort();
    expect(rooms).toEqual(['live-main', 'live-show']);
  });

  it('remove pushes with the removed event room', async () => {
    const e = svc.create(APP, { startAt: NOW + HOUR, room: 'show' });
    await flush();
    livekit.sendData.mockClear();

    svc.remove(APP, e.id);
    await flush();
    expect(livekit.sendData).toHaveBeenCalledTimes(1);
    expect(livekit.sendData.mock.calls[0][0]).toBe('live-show');
  });

  it('a push failure NEVER fails the agenda mutation (best-effort)', async () => {
    livekit.sendData.mockRejectedValue(new Error('livekit down'));
    livekit.listRooms.mockRejectedValue(new Error('livekit down'));

    const created = svc.create(APP, { startAt: NOW + HOUR, room: 'show' });
    await flush();
    expect(created.id).toBeGreaterThan(0);
    expect(svc.list(APP)).toHaveLength(1);
  });

  it('without a LiveKitService the service works poll-only (no crash)', async () => {
    const bare = new ScheduledLiveService(repo);
    const created = bare.create(APP, { startAt: NOW + HOUR, room: 'show' });
    await flush();
    expect(created.id).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Controller wiring — RBAC permissions (enforcement is the guard's; here we lock
// the declared metadata) + the public route bypasses auth.
// -----------------------------------------------------------------------------

describe('ScheduledLiveController — permissions', () => {
  const reflector = new Reflector();

  it("GET / declares 'config:read'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, ScheduledLiveController.prototype.list),
    ).toEqual({ resource: 'config', action: 'read' });
  });

  it("POST declares 'config:write'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, ScheduledLiveController.prototype.create),
    ).toEqual({ resource: 'config', action: 'write' });
  });

  it("PATCH declares 'config:write'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, ScheduledLiveController.prototype.update),
    ).toEqual({ resource: 'config', action: 'write' });
  });

  it("DELETE declares 'config:write'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, ScheduledLiveController.prototype.remove),
    ).toEqual({ resource: 'config', action: 'write' });
  });

  it('the /public route is marked @Public (no bearer required)', () => {
    expect(
      reflector.get('streamhub:isPublic', ScheduledLiveController.prototype.listPublic),
    ).toBe(true);
    // …and it is NOT permission-guarded.
    expect(
      reflector.get(
        REQUIRE_PERMISSION_KEY,
        ScheduledLiveController.prototype.listPublic,
      ),
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Controller wiring — owner item 11: the app's configured timezone becomes the
// DEFAULT for create/update when the request body leaves `timezone` empty.
// -----------------------------------------------------------------------------

describe('ScheduledLiveController — app timezone default (owner item 11)', () => {
  function makeController(appTimezone: string | undefined) {
    const scheduled = {
      create: jest.fn((..._args: unknown[]) => ({ id: 1 }) as never),
      update: jest.fn((..._args: unknown[]) => ({ id: 1 }) as never),
    } as unknown as ScheduledLiveService;
    const apps = mockAppsService({
      getConfig: jest.fn(async () => ({ timezone: appTimezone }) as never),
    });
    const controller = new ScheduledLiveController(scheduled, apps);
    return { controller, scheduled };
  }

  it("create() resolves the app's configured timezone as the default", async () => {
    const { controller, scheduled } = makeController('America/Argentina/Buenos_Aires');
    await controller.create(APP, { startAt: NOW + HOUR });
    expect(scheduled.create).toHaveBeenCalledWith(
      APP,
      { startAt: NOW + HOUR },
      'America/Argentina/Buenos_Aires',
    );
  });

  it("update() resolves the app's configured timezone as the default", async () => {
    const { controller, scheduled } = makeController('Asia/Tokyo');
    await controller.update(APP, 1, { enabled: false });
    expect(scheduled.update).toHaveBeenCalledWith(
      APP,
      1,
      { enabled: false },
      'Asia/Tokyo',
    );
  });

  it("falls back to 'UTC' when the app has no timezone configured", async () => {
    const { controller, scheduled } = makeController(undefined);
    await controller.create(APP, { startAt: NOW + HOUR });
    expect(scheduled.create).toHaveBeenCalledWith(
      APP,
      { startAt: NOW + HOUR },
      'UTC',
    );
  });

  it("falls back to 'UTC' when the app config lookup fails (best-effort)", async () => {
    const scheduled = {
      create: jest.fn((..._args: unknown[]) => ({ id: 1 }) as never),
    } as unknown as ScheduledLiveService;
    const apps = mockAppsService({
      getConfig: jest.fn(async () => {
        throw new NotFoundException('app not found');
      }),
    });
    const controller = new ScheduledLiveController(scheduled, apps);
    await controller.create(APP, { startAt: NOW + HOUR });
    expect(scheduled.create).toHaveBeenCalledWith(
      APP,
      { startAt: NOW + HOUR },
      'UTC',
    );
  });
});
