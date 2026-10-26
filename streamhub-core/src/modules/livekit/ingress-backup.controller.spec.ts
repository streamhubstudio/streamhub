/**
 * Unit — LiveKitController RTMP primary + backup (failover) stream keys.
 *
 * Feature: `POST /apps/:app/ingress` with `backup: true` mints TWO LiveKit
 * ingresses bound to the SAME room, so both keys publish into one room and the
 * player/playback URL is identical whichever key is live. This spec drives the
 * controller directly with a fake LiveKitService but REAL IngressAuthService +
 * IngressBackupService over a migrated temp DB, and pins:
 *   1. two ingresses are created into the SAME room with DISTINCT identities,
 *   2. the create response carries primary + backup keys and both push URLs,
 *   3. BOTH keys authorize independently (ingress_auth row per key),
 *   4. the pairing is persisted (getRoleInfo classifies each side),
 *   5. GET returns the role + the sibling backup key on the primary,
 *   6. backup omitted ⇒ single ingress, no backup fields (back-compat),
 *   7. deleting the primary cascades the backup; deleting a backup only unlinks,
 *   8. with the rtmpPassword feature each key gets its OWN password + validation.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { LiveKitController } from './livekit.controller';
import { IngressAuthService } from './ingress-auth.service';
import { IngressBackupService } from './ingress-backup.service';
import { APPS_SERVICE, type AppConfig } from '../../shared/contracts';

const APP = 'live';

interface FakeIngress {
  ingressId: string;
  url: string;
  streamKey: string;
  roomName: string;
  participantIdentity: string;
}

function makeController(opts: { rtmpPassword?: boolean } = {}) {
  const ctx: UnitContext = makeUnitContext();
  const ingressAuth = new IngressAuthService(ctx.db);
  const ingressBackup = new IngressBackupService(ctx.db);

  // Fake LiveKit ingress service that remembers what it created so listIngress
  // (used by GET/DELETE) reflects the state, and deleteIngress removes it.
  const store: FakeIngress[] = [];
  let n = 0;
  const createIngress = jest.fn(async (input: any) => {
    n += 1;
    const rec: FakeIngress = {
      ingressId: `IN_${n}`,
      url: 'rtmp://internal:1935/live',
      streamKey: `key${n}`,
      roomName: input.roomName,
      participantIdentity: input.participantIdentity,
    };
    store.push(rec);
    return {
      ingressId: rec.ingressId,
      url: rec.url,
      streamKey: rec.streamKey,
      roomName: rec.roomName,
    };
  });
  const deleteIngress = jest.fn(async (id: string) => {
    const i = store.findIndex((r) => r.ingressId === id);
    if (i >= 0) store.splice(i, 1);
  });
  const listIngress = jest.fn(async () =>
    store.map((r) => ({
      ingressId: r.ingressId,
      url: r.url,
      streamKey: r.streamKey,
      roomName: r.roomName,
      participantIdentity: r.participantIdentity,
      inputType: 'rtmp' as const,
    })),
  );
  const listRooms = jest.fn(async () => []);
  const livekit = { createIngress, deleteIngress, listIngress, listRooms } as any;

  const cfg = {
    name: APP,
    roomPrefix: APP,
    features: { rtmpPassword: !!opts.rtmpPassword, adaptivePlayer: false },
    rtmp: { transcode: false },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === APPS_SERVICE) return apps;
      throw new Error('not found');
    }),
  } as any;

  const config = {
    publicWsUrl: 'wss://media.test',
    rtmpPublicHost: 'media.example.com',
    rtmpsEnable: false,
    rtmpsPublicHost: '',
    rtmpsPort: 1936,
    env: () => '',
  } as any;
  const quotas = { enforceConcurrentStreams: jest.fn(async () => {}) } as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
    ingressBackup,
  );
  return {
    ctx,
    controller,
    createIngress,
    deleteIngress,
    ingressAuth,
    ingressBackup,
  };
}

describe('LiveKitController — RTMP primary + backup keys', () => {
  it('creates two ingresses into the SAME room with distinct identities', async () => {
    const { ctx, controller, createIngress } = makeController();
    try {
      const res = await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any);

      expect(createIngress).toHaveBeenCalledTimes(2);
      const rooms = createIngress.mock.calls.map((c) => (c[0] as any).roomName);
      const identities = createIngress.mock.calls.map(
        (c) => (c[0] as any).participantIdentity,
      );
      // BOTH ingresses target the one namespaced room ⇒ one player URL.
      expect(rooms).toEqual(['live-demo', 'live-demo']);
      // Distinct identities so LiveKit never evicts one when both push.
      expect(identities).toEqual(['ingress-live', 'ingress-live-backup']);
      expect(new Set(identities).size).toBe(2);

      const d = res.data as any;
      expect(d.role).toBe('primary');
      expect(d.hasBackup).toBe(true);
      expect(d.primaryStreamKey).toBe('key1');
      expect(d.backupStreamKey).toBe('key2');
      expect(d.backupIngressId).toBe('IN_2');
      // Both push URLs are built for the public RTMP host, one per key.
      expect(d.primary_rtmp_url).toBe(
        'rtmp://media.example.com:1935/live/key1',
      );
      expect(d.backup_rtmp_url).toBe('rtmp://media.example.com:1935/live/key2');
      // Single player_url (same room) — unchanged whichever key is live.
      expect(typeof d.player_url).toBe('string');
    } finally {
      ctx.cleanup();
    }
  });

  it('authorizes BOTH keys and persists the pairing', async () => {
    const { ctx, controller, ingressAuth, ingressBackup } = makeController();
    try {
      await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any);

      // No rtmpPassword feature ⇒ each ingress_auth row authorizes on its own.
      expect(ingressAuth.isAuthorized(APP, 'IN_1')).toBe(true);
      expect(ingressAuth.isAuthorized(APP, 'IN_2')).toBe(true);
      // Each key is stored against its own ingress row.
      expect(ingressAuth.get(APP, 'IN_1')?.streamKey).toBe('key1');
      expect(ingressAuth.get(APP, 'IN_2')?.streamKey).toBe('key2');

      const role = ingressBackup.getRoleInfo(APP, 'IN_1');
      expect(role).toMatchObject({ role: 'primary', backupIngressId: 'IN_2' });
      expect(ingressBackup.getRoleInfo(APP, 'IN_2').role).toBe('backup');
    } finally {
      ctx.cleanup();
    }
  });

  it('GET returns the role and the sibling backup key on the primary', async () => {
    const { ctx, controller } = makeController();
    try {
      await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any);

      const primary = (await controller.getIngress(APP, 'IN_1')).data as any;
      expect(primary.role).toBe('primary');
      expect(primary.pairedIngressId).toBe('IN_2');
      expect(primary.backupStreamKey).toBe('key2');
      expect(primary.backup_rtmp_url).toBe(
        'rtmp://media.example.com:1935/live/key2',
      );

      const backup = (await controller.getIngress(APP, 'IN_2')).data as any;
      expect(backup.role).toBe('backup');
      expect(backup.pairedIngressId).toBe('IN_1');
    } finally {
      ctx.cleanup();
    }
  });

  it('without backup: single ingress, no backup fields (back-compat)', async () => {
    const { ctx, controller, createIngress } = makeController();
    try {
      const res = (await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
      } as any)) as any;
      expect(createIngress).toHaveBeenCalledTimes(1);
      expect(res.data.hasBackup).toBe(false);
      expect(res.data.backupStreamKey).toBeUndefined();
      expect(res.data.primaryStreamKey).toBe('key1');
      expect(res.data.stream_key).toBe('key1');
    } finally {
      ctx.cleanup();
    }
  });

  it('deleting the primary cascades the backup; deleting a backup only unlinks', async () => {
    const { ctx, controller, deleteIngress, ingressBackup, ingressAuth } =
      makeController();
    try {
      await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any);

      const del = (await controller.deleteIngress(APP, 'IN_1')).data as any;
      expect(del.deleted).toBe(true);
      expect(del.backupIngressId).toBe('IN_2');
      // Both LiveKit ingresses were deleted (primary + its standby backup).
      const deletedIds = deleteIngress.mock.calls.map((c) => c[0]);
      expect(deletedIds).toEqual(['IN_1', 'IN_2']);
      // Pairing + auth rows are gone for both.
      expect(ingressBackup.getLinkFor(APP, 'IN_1')).toBeNull();
      expect(ingressAuth.get(APP, 'IN_2')).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it('deleting a backup unlinks the pair but keeps the primary', async () => {
    const { ctx, controller, deleteIngress, ingressBackup, ingressAuth } =
      makeController();
    try {
      await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any);

      await controller.deleteIngress(APP, 'IN_2'); // remove the backup
      const deletedIds = deleteIngress.mock.calls.map((c) => c[0]);
      expect(deletedIds).toEqual(['IN_2']); // primary NOT touched
      expect(ingressBackup.getLinkFor(APP, 'IN_1')).toBeNull();
      expect(ingressAuth.get(APP, 'IN_1')?.streamKey).toBe('key1'); // survives
    } finally {
      ctx.cleanup();
    }
  });

  it('with rtmpPassword: each key gets its OWN password + independent validation', async () => {
    const { ctx, controller, ingressAuth } = makeController({
      rtmpPassword: true,
    });
    try {
      const res = (await controller.createIngress(APP, {
        inputType: 'rtmp' as any,
        room: 'demo',
        backup: true,
      } as any)) as any;

      expect(res.data.requires_password).toBe(true);
      expect(typeof res.data.stream_password).toBe('string');
      expect(typeof res.data.backup_stream_password).toBe('string');
      // Distinct passwords per key.
      expect(res.data.backup_stream_password).not.toBe(
        res.data.stream_password,
      );
      // Neither key is authorized until validated (webhook would terminate).
      expect(ingressAuth.isAuthorized(APP, 'IN_1')).toBe(false);
      expect(ingressAuth.isAuthorized(APP, 'IN_2')).toBe(false);
      // Validating the BACKUP key authorizes it independently of the primary.
      expect(
        ingressAuth.validate(APP, 'IN_2', res.data.backup_stream_password),
      ).toBe(true);
      expect(ingressAuth.isAuthorized(APP, 'IN_2')).toBe(true);
      expect(ingressAuth.isAuthorized(APP, 'IN_1')).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });
});
