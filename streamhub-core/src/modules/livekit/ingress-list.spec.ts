/**
 * Unit spec — GET /apps/:app/ingress (paginated listing, UI de STREAMS/INGRESS).
 *
 * The CCTV use-case (hundreds of RTMP cameras) needs a REAL paginated listing:
 * `{ data, total, limit, offset }` like the VODs/logs endpoints. This spec pins:
 *   1. permission metadata: same `ingress:read` as before (no privilege change),
 *   2. tenant isolation: only ingresses whose room belongs to the app prefix,
 *   3. paging: total = filtered size, slice by limit/offset (clamped),
 *   4. row shape: stream_key + rtmp_url (RTMP_PUBLIC_HOST) always present so
 *      the UI can reveal the ingest credentials from the list (not only on
 *      create), plus live state (status/bitrate) and viewers (participants-1),
 *   5. filters: room (bare or prefixed) and q (id/name/room substring).
 *
 * The controller is driven directly with light fakes — no HTTP/DI boot needed.
 */
import { Reflector } from '@nestjs/core';

import { LiveKitController } from './livekit.controller';
import type { IngressListItem } from './livekit.service';
import {
  REQUIRE_PERMISSION_KEY,
  type RequiredPermission,
} from '../authz/permission.decorator';
import { APPS_SERVICE, type AppConfig } from '../../shared/contracts';

const PREFIX = 'live';

function makeIngress(n: number, room: string): IngressListItem {
  return {
    ingressId: `IN_${room}_${n}`,
    url: `rtmp://internal:1935/x`,
    streamKey: `key-${room}-${n}`,
    roomName: room,
    name: `cam-${n}`,
    inputType: 'rtmp',
    status: 'publishing',
    bitrate: 2_500_000,
    width: 1280,
    height: 720,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeController(items: IngressListItem[]) {
  const listIngress = jest.fn(async () => items);
  const listRooms = jest.fn(async (names?: string[]) =>
    (names ?? []).map((name) => ({
      name,
      sid: `RM_${name}`,
      numParticipants: 3, // 1 publisher + 2 viewers
      creationTime: 0,
    })),
  );
  const livekit = { listIngress, listRooms } as any;

  const cfg = {
    name: PREFIX,
    roomPrefix: PREFIX,
    features: {},
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
    env: () => '',
  } as any;
  const ingressAuth = {
    get: jest.fn((_app: string, id: string) =>
      id.endsWith('_1')
        ? { ingressId: id, requiresPassword: true }
        : null,
    ),
  } as any;
  const quotas = {} as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
  );
  return { controller, listIngress, listRooms, ingressAuth };
}

/** 30 ingresses of the app (+5 of ANOTHER app that must never leak). */
function fixtures(): IngressListItem[] {
  const mine = Array.from({ length: 30 }, (_, i) =>
    makeIngress(i, i === 0 ? PREFIX : `${PREFIX}-cam${i}`),
  );
  const foreign = Array.from({ length: 5 }, (_, i) =>
    makeIngress(i, `otherapp-cam${i}`),
  );
  return [...mine, ...foreign];
}

describe('LiveKitController — GET /apps/:app/ingress (paginated)', () => {
  it('keeps the ingress:read permission on the handler', () => {
    const perm = new Reflector().get<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      LiveKitController.prototype.listIngress,
    );
    expect(perm).toEqual({ resource: 'ingress', action: 'read' });
  });

  it('isolates by app prefix and answers { data, total, limit, offset }', async () => {
    const { controller } = makeController(fixtures());
    const res = await controller.listIngress(PREFIX, {});

    expect(res.total).toBe(30); // the 5 foreign rows never leak
    expect(res.limit).toBe(50);
    expect(res.offset).toBe(0);
    expect(res.data).toHaveLength(30);
    expect(
      res.data.every(
        (r) => r.room === PREFIX || r.room.startsWith(`${PREFIX}-`),
      ),
    ).toBe(true);
  });

  it('pages with limit/offset while total stays the filtered count', async () => {
    const { controller } = makeController(fixtures());
    const res = await controller.listIngress(PREFIX, {
      limit: 20,
      offset: 20,
    });

    expect(res.total).toBe(30);
    expect(res.limit).toBe(20);
    expect(res.offset).toBe(20);
    expect(res.data).toHaveLength(10); // 30 rows → second page has 10
  });

  it('clamps out-of-range paging instead of rejecting', async () => {
    const { controller } = makeController(fixtures());
    const res = await controller.listIngress(PREFIX, {
      limit: 100000,
      offset: -5 as unknown as number,
    });
    expect(res.limit).toBe(500);
    expect(res.offset).toBe(0);
  });

  it('every row carries the revealable ingest credentials + live state', async () => {
    const { controller } = makeController(fixtures());
    const res = await controller.listIngress(PREFIX, { limit: 2 });

    const row = res.data[0];
    expect(row.stream_key).toBe(row.streamKey);
    // rtmp_url is built with RTMP_PUBLIC_HOST + the stream key.
    expect(row.rtmp_url).toBe(
      `rtmp://media.example.com:1935/live/${row.streamKey}`,
    );
    expect(row.status).toBe('publishing');
    expect(row.bitrate).toBe(2_500_000);
    expect(row.width).toBe(1280);
    expect(row.height).toBe(720);
    // viewers ≈ numParticipants - 1 (the publisher itself).
    expect(row.viewers).toBe(2);
    // ingress_auth row present for *_1 ids → requires_password surfaces.
    const withPass = res.data.find((r) => r.ingressId.endsWith('_1'));
    const noPass = res.data.find((r) => !r.ingressId.endsWith('_1'));
    expect(withPass?.requires_password ?? true).toBe(true);
    expect(noPass?.requires_password).toBe(false);
  });

  it('only resolves viewers for the PAGE rooms (single listRooms call)', async () => {
    const { controller, listRooms } = makeController(fixtures());
    await controller.listIngress(PREFIX, { limit: 5, offset: 0 });
    expect(listRooms).toHaveBeenCalledTimes(1);
    const names = listRooms.mock.calls[0][0] as string[];
    expect(names.length).toBeLessThanOrEqual(5);
  });

  it('viewers degrade to null when LiveKit rooms cannot be listed', async () => {
    const { controller, listRooms } = makeController(fixtures());
    listRooms.mockRejectedValueOnce(new Error('livekit down'));
    const res = await controller.listIngress(PREFIX, { limit: 3 });
    expect(res.data).toHaveLength(3); // listing never fails on a viewers gap
    expect(res.data.every((r) => r.viewers === null)).toBe(true);
  });

  it('filters by room (bare name gets the app prefix) and by q substring', async () => {
    const { controller } = makeController(fixtures());

    const byRoom = await controller.listIngress(PREFIX, { room: 'cam7' });
    expect(byRoom.total).toBe(1);
    expect(byRoom.data[0].room).toBe(`${PREFIX}-cam7`);

    const byQ = await controller.listIngress(PREFIX, { q: 'cam-2' });
    // cam-2 matches names cam-2 and cam-20..29 → 11 of the app's rows.
    expect(byQ.total).toBe(11);
    expect(byQ.data.every((r) => r.room.startsWith(PREFIX))).toBe(true);
  });
});
