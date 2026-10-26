/**
 * Unit spec — RoomsController (per-app rooms API: metadata + moderation + data).
 *
 * Invariants locked down:
 *   1. RBAC: every read route requires stream:read, every mutating route
 *      stream:write (checked via the @RequirePermission metadata).
 *   2. Tenant isolation: the :room param is namespaced under the app's room
 *      prefix, and the rooms listing only returns rooms of that prefix.
 *   3. Kick → removeParticipant; mute resolves kind=audio|video|all to the
 *      participant's track sids; PATCH participant merges the CURRENT
 *      permission grant before an atomic permission update.
 *   4. POST :room/data respects the chat/reactions feature gates and builds
 *      the standard envelope when no raw payload is given.
 *
 * The controller is driven directly with light fakes — no HTTP/DI boot.
 */
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RoomsController } from './rooms.controller';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../authz/permission.decorator';
import { APPS_SERVICE, LOGS_SERVICE, type AppConfig } from '../../shared/contracts';
import { mockLogsService } from '../../../test/helpers/service-mocks';

function makeController(opts: { chat?: boolean; reactions?: boolean } = {}) {
  const livekit = {
    listRoomsDetailed: jest.fn(async () => [
      { name: 'live', sid: 'RM_a', numParticipants: 1, creationTime: 1 },
      { name: 'live-show', sid: 'RM_b', numParticipants: 3, creationTime: 2 },
      { name: 'other-app', sid: 'RM_c', numParticipants: 9, creationTime: 3 },
    ]),
    getRoom: jest.fn(async (name: string) =>
      name === 'live-show' ? { name, sid: 'RM_b', numParticipants: 3, creationTime: 2 } : null,
    ),
    updateRoomMetadata: jest.fn(async (room: string, metadata: string) => ({
      name: room,
      sid: 'RM_b',
      numParticipants: 3,
      creationTime: 2,
      metadata,
    })),
    listParticipantsDetailed: jest.fn(async () => [participant()]),
    getParticipant: jest.fn(async () => participant()),
    removeParticipant: jest.fn(async () => undefined),
    mutePublishedTrack: jest.fn(
      async (_r: string, _i: string, sid: string, muted: boolean) => ({
        trackSid: sid,
        muted,
      }),
    ),
    updateParticipant: jest.fn(async () => participant()),
    updateSubscriptions: jest.fn(async () => undefined),
    sendData: jest.fn(async () => undefined),
  };

  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features: { chat: opts.chat ?? true, reactions: opts.reactions ?? true },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };
  const logs = mockLogsService();
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === APPS_SERVICE) return apps;
      if (token === LOGS_SERVICE) return logs;
      throw new Error('not found');
    }),
  } as any;

  const controller = new RoomsController(livekit as any, moduleRef);
  return { controller, livekit, logs };
}

function participant() {
  return {
    identity: 'pub-1',
    name: 'Pub',
    sid: 'PA_1',
    hidden: false,
    isPublisher: true,
    joinedAt: null,
    tracks: [
      { sid: 'TR_v1', type: 'video', source: 'camera', muted: false },
      { sid: 'TR_a1', type: 'audio', source: 'microphone', muted: false },
    ],
    permission: {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      hidden: false,
    },
  };
}

function permissionOf(handler: (...args: never[]) => unknown): RequiredPermission {
  return new Reflector().get<RequiredPermission>(REQUIRE_PERMISSION_KEY, handler);
}

describe('RoomsController — RBAC metadata', () => {
  it('read routes require stream:read, mutating routes stream:write', () => {
    const p = RoomsController.prototype;
    expect(permissionOf(p.listRooms)).toEqual({ resource: 'stream', action: 'read' });
    expect(permissionOf(p.getRoom)).toEqual({ resource: 'stream', action: 'read' });
    expect(permissionOf(p.listParticipants)).toEqual({ resource: 'stream', action: 'read' });
    expect(permissionOf(p.updateRoomMetadata)).toEqual({ resource: 'stream', action: 'write' });
    expect(permissionOf(p.kickParticipant)).toEqual({ resource: 'stream', action: 'write' });
    expect(permissionOf(p.muteParticipant)).toEqual({ resource: 'stream', action: 'write' });
    expect(permissionOf(p.updateParticipant)).toEqual({ resource: 'stream', action: 'write' });
    expect(permissionOf(p.updateSubscriptions)).toEqual({ resource: 'stream', action: 'write' });
    expect(permissionOf(p.sendData)).toEqual({ resource: 'stream', action: 'write' });
  });
});

describe('RoomsController — rooms & metadata', () => {
  it('lists only rooms under the app prefix (tenant isolation)', async () => {
    const { controller } = makeController();
    const res = await controller.listRooms('live');
    expect(res.data.map((r: any) => r.name)).toEqual(['live', 'live-show']);
  });

  it('namespaces :room under the prefix and 404s when not live', async () => {
    const { controller, livekit } = makeController();

    const res = await controller.getRoom('live', 'show');
    expect(livekit.getRoom).toHaveBeenCalledWith('live-show');
    expect(res.data).toMatchObject({ name: 'live-show' });

    await expect(controller.getRoom('live', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('PATCH :room/metadata calls updateRoomMetadata with the namespaced room', async () => {
    const { controller, livekit } = makeController();
    const res = await controller.updateRoomMetadata('live', 'show', {
      metadata: '{"onAir":true}',
    });
    expect(livekit.updateRoomMetadata).toHaveBeenCalledWith(
      'live-show',
      '{"onAir":true}',
    );
    expect(res.data).toMatchObject({ metadata: '{"onAir":true}' });
  });
});

describe('RoomsController — moderation', () => {
  it('kick calls removeParticipant and writes an audit log line', async () => {
    const { controller, livekit, logs } = makeController();
    const res = await controller.kickParticipant('live', 'show', 'pub-1');
    expect(livekit.removeParticipant).toHaveBeenCalledWith('live-show', 'pub-1');
    expect(res.data).toEqual({ room: 'live-show', identity: 'pub-1', removed: true });
    expect(logs.write).toHaveBeenCalledWith(
      'info',
      'livekit-moderation',
      'participant kicked',
      expect.objectContaining({ app: 'live', room: 'live-show', identity: 'pub-1' }),
    );
  });

  it('mute with an explicit trackSid mutes exactly that track', async () => {
    const { controller, livekit } = makeController();
    const res = await controller.muteParticipant('live', 'show', 'pub-1', {
      trackSid: 'TR_v1',
    });
    expect(livekit.mutePublishedTrack).toHaveBeenCalledTimes(1);
    expect(livekit.mutePublishedTrack).toHaveBeenCalledWith(
      'live-show',
      'pub-1',
      'TR_v1',
      true,
    );
    expect(res.data.tracks).toEqual([{ trackSid: 'TR_v1', muted: true }]);
  });

  it('mute kind=audio resolves the audio track sids of the participant', async () => {
    const { controller, livekit } = makeController();
    await controller.muteParticipant('live', 'show', 'pub-1', {
      kind: 'audio',
      muted: true,
    });
    expect(livekit.mutePublishedTrack).toHaveBeenCalledTimes(1);
    expect(livekit.mutePublishedTrack).toHaveBeenCalledWith(
      'live-show',
      'pub-1',
      'TR_a1',
      true,
    );
  });

  it('mute kind=all mutes every published track; 404 when none', async () => {
    const { controller, livekit } = makeController();
    await controller.muteParticipant('live', 'show', 'pub-1', {});
    expect(livekit.mutePublishedTrack).toHaveBeenCalledTimes(2);

    livekit.getParticipant.mockResolvedValueOnce({
      ...participant(),
      tracks: [],
    });
    await expect(
      controller.muteParticipant('live', 'show', 'pub-1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PATCH participant merges the current grant into an atomic permission set', async () => {
    const { controller, livekit } = makeController();
    await controller.updateParticipant('live', 'show', 'pub-1', {
      canPublish: false,
    });
    // hidden/canSubscribe/canPublishData survive from the current grant.
    expect(livekit.updateParticipant).toHaveBeenCalledWith('live-show', 'pub-1', {
      metadata: undefined,
      name: undefined,
      permission: {
        canPublish: false,
        canSubscribe: true,
        canPublishData: true,
        hidden: false,
      },
    });
  });

  it('PATCH participant without permission fields never touches the grant', async () => {
    const { controller, livekit } = makeController();
    await controller.updateParticipant('live', 'show', 'pub-1', {
      metadata: '{"role":"guest"}',
    });
    expect(livekit.getParticipant).not.toHaveBeenCalled();
    expect(livekit.updateParticipant).toHaveBeenCalledWith('live-show', 'pub-1', {
      metadata: '{"role":"guest"}',
      name: undefined,
      permission: undefined,
    });
  });

  it('subscriptions endpoint forwards trackSids + subscribe', async () => {
    const { controller, livekit } = makeController();
    const res = await controller.updateSubscriptions('live', 'show', 'viewer-1', {
      trackSids: ['TR_v1'],
      subscribe: false,
    });
    expect(livekit.updateSubscriptions).toHaveBeenCalledWith(
      'live-show',
      'viewer-1',
      ['TR_v1'],
      false,
    );
    expect(res.data).toMatchObject({ subscribe: false });
  });
});

describe('RoomsController — per-room data push', () => {
  it('builds the envelope and sends to the namespaced room', async () => {
    const { controller, livekit } = makeController();
    const res = await controller.sendData('live', 'show', {
      topic: 'scoreboard',
      message: '2-1',
    } as any);
    expect(livekit.sendData).toHaveBeenCalledTimes(1);
    const [room, payload, opts] = livekit.sendData.mock.calls[0];
    expect(room).toBe('live-show');
    expect(JSON.parse(payload)).toMatchObject({ topic: 'scoreboard', message: '2-1' });
    expect(opts).toMatchObject({ topic: 'scoreboard' });
    expect(res.data).toEqual({ sent: true, room: 'live-show', topic: 'scoreboard' });
  });

  it('respects the chat/reactions feature gates (404 when disabled)', async () => {
    const { controller, livekit } = makeController({ chat: false, reactions: false });
    await expect(
      controller.sendData('live', 'show', { topic: 'chat', message: 'x' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.sendData('live', 'show', { topic: 'reaction', reaction: '❤️' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(livekit.sendData).not.toHaveBeenCalled();
  });
});
