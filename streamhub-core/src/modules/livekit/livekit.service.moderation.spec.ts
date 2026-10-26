/**
 * Unit spec — LiveKitService moderation & metadata wrappers (rooms API).
 *
 * Locks down the mapping between the StreamHub rooms API and the native
 * LiveKit RoomServiceClient calls that were previously unused
 * (LIVEKIT-UNUSED-FEATURES.md):
 *   1. listParticipantsDetailed / getParticipant expose track sids + the
 *      current permission grant (the merge base for atomic perm updates),
 *   2. mutePublishedTrack / updateSubscriptions / updateRoomMetadata /
 *      updateParticipant forward the exact arguments,
 *   3. every wrapper is guarded: an SDK failure surfaces as a 503
 *      ServiceUnavailableException (never an unhandled crash).
 *
 * The RoomServiceClient is a plain jest fake injected into the service's lazy
 * client slot — nothing dials the network.
 */
import { ServiceUnavailableException } from '@nestjs/common';

import { LiveKitService } from './livekit.service';
import { mockLogsService } from '../../../test/helpers/service-mocks';

function makeService(roomClient: Record<string, jest.Mock>) {
  const config = {
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
  } as any;
  const logs = mockLogsService();
  const svc = new LiveKitService(config, logs);
  (svc as any)._roomClient = roomClient;
  return { svc, logs };
}

/** A protocol-shaped participant (plain object is fine — mapping is structural). */
function fakeParticipant(over: Partial<any> = {}) {
  return {
    identity: 'pub-1',
    name: 'Publisher One',
    sid: 'PA_1',
    metadata: '{"role":"host"}',
    joinedAt: 1_700_000_000, // seconds
    permission: {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      hidden: false,
    },
    tracks: [
      { sid: 'TR_v1', type: 1, source: 1, muted: false }, // VIDEO / CAMERA
      { sid: 'TR_a1', type: 0, source: 2, muted: true }, // AUDIO / MICROPHONE
    ],
    ...over,
  };
}

describe('LiveKitService — moderation & metadata wrappers', () => {
  it('listParticipantsDetailed maps identity/tracks/permission (sids exposed)', async () => {
    const roomClient = {
      listParticipants: jest.fn(async () => [fakeParticipant()]),
    };
    const { svc } = makeService(roomClient);

    const [p] = await svc.listParticipantsDetailed('live-room1');

    expect(roomClient.listParticipants).toHaveBeenCalledWith('live-room1');
    expect(p).toMatchObject({
      identity: 'pub-1',
      sid: 'PA_1',
      hidden: false,
      isPublisher: true,
      metadata: '{"role":"host"}',
      permission: {
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        hidden: false,
      },
    });
    expect(p.tracks).toEqual([
      { sid: 'TR_v1', type: 'video', source: 'camera', muted: false },
      { sid: 'TR_a1', type: 'audio', source: 'microphone', muted: true },
    ]);
    expect(p.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getParticipant maps a single participant', async () => {
    const roomClient = {
      getParticipant: jest.fn(async () => fakeParticipant({ tracks: [] })),
    };
    const { svc } = makeService(roomClient);

    const p = await svc.getParticipant('live-room1', 'pub-1');

    expect(roomClient.getParticipant).toHaveBeenCalledWith(
      'live-room1',
      'pub-1',
    );
    expect(p.isPublisher).toBe(false);
    expect(p.tracks).toEqual([]);
  });

  it('mutePublishedTrack forwards args and returns { trackSid, muted }', async () => {
    const roomClient = {
      mutePublishedTrack: jest.fn(async () => ({ sid: 'TR_v1', muted: true })),
    };
    const { svc } = makeService(roomClient);

    const res = await svc.mutePublishedTrack('live-r', 'pub-1', 'TR_v1', true);

    expect(roomClient.mutePublishedTrack).toHaveBeenCalledWith(
      'live-r',
      'pub-1',
      'TR_v1',
      true,
    );
    expect(res).toEqual({ trackSid: 'TR_v1', muted: true });
  });

  it('updateParticipant passes only the provided fields (options form)', async () => {
    const roomClient = {
      updateParticipant: jest.fn(async () => fakeParticipant()),
    };
    const { svc } = makeService(roomClient);

    await svc.updateParticipant('live-r', 'pub-1', {
      metadata: '{"onAir":true}',
    });

    expect(roomClient.updateParticipant).toHaveBeenCalledWith(
      'live-r',
      'pub-1',
      { metadata: '{"onAir":true}' },
    );

    await svc.updateParticipant('live-r', 'pub-1', {
      permission: { canPublish: false, canSubscribe: true },
    });
    expect(roomClient.updateParticipant).toHaveBeenLastCalledWith(
      'live-r',
      'pub-1',
      { permission: { canPublish: false, canSubscribe: true } },
    );
  });

  it('updateSubscriptions forwards trackSids + subscribe flag', async () => {
    const roomClient = { updateSubscriptions: jest.fn(async () => undefined) };
    const { svc } = makeService(roomClient);

    await svc.updateSubscriptions('live-r', 'viewer-1', ['TR_a', 'TR_b'], false);

    expect(roomClient.updateSubscriptions).toHaveBeenCalledWith(
      'live-r',
      'viewer-1',
      ['TR_a', 'TR_b'],
      false,
    );
  });

  it('updateRoomMetadata returns the room info incl. metadata', async () => {
    const roomClient = {
      updateRoomMetadata: jest.fn(async () => ({
        name: 'live-r',
        sid: 'RM_1',
        numParticipants: 2,
        creationTime: 1700000000,
        metadata: '{"onAir":true}',
      })),
    };
    const { svc } = makeService(roomClient);

    const res = await svc.updateRoomMetadata('live-r', '{"onAir":true}');

    expect(roomClient.updateRoomMetadata).toHaveBeenCalledWith(
      'live-r',
      '{"onAir":true}',
    );
    expect(res).toMatchObject({
      name: 'live-r',
      sid: 'RM_1',
      metadata: '{"onAir":true}',
    });
  });

  it('getRoom returns null when the room is not live, detail when it is', async () => {
    const roomClient = {
      listRooms: jest.fn(async (names?: string[]) =>
        names?.includes('live-yes')
          ? [
              {
                name: 'live-yes',
                sid: 'RM_9',
                numParticipants: 1,
                creationTime: 1700000000,
                metadata: '',
              },
            ]
          : [],
      ),
    };
    const { svc } = makeService(roomClient);

    await expect(svc.getRoom('live-no')).resolves.toBeNull();
    await expect(svc.getRoom('live-yes')).resolves.toMatchObject({
      name: 'live-yes',
      sid: 'RM_9',
    });
  });

  it('guards every wrapper: SDK failure → 503, logged, never a crash', async () => {
    const boom = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const roomClient = {
      listParticipants: boom,
      getParticipant: boom,
      mutePublishedTrack: boom,
      updateParticipant: boom,
      updateSubscriptions: boom,
      updateRoomMetadata: boom,
    };
    const { svc, logs } = makeService(roomClient);

    await expect(svc.listParticipantsDetailed('r')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(svc.getParticipant('r', 'i')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      svc.mutePublishedTrack('r', 'i', 'TR', true),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      svc.updateParticipant('r', 'i', { name: 'x' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      svc.updateSubscriptions('r', 'i', ['TR'], true),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.updateRoomMetadata('r', 'm')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logs.write).toHaveBeenCalledWith(
      'error',
      'livekit',
      expect.stringContaining('failed'),
      expect.any(Object),
    );
  });
});
