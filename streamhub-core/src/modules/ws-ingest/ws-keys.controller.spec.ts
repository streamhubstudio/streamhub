/**
 * Unit specs for WsKeysController — the provisioning REST of the direct WS
 * MJPEG ingest (ESP32-WS-INGEST.md §3.6). The controller is thin: quota
 * pre-flight + delegation to WsIngestService; these specs pin the contract
 * (envelope shapes, wsk_/wsi_ prefixes, quota rejection, revoke semantics,
 * public live-info) against a REAL service over the temp DB.
 */
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { IngressAuthService } from '../livekit/ingress-auth.service';
import type { QuotasService } from '../quotas/quotas.service';
import { FrameHub } from './frame-hub';
import { WsIngestService } from './ws-ingest.service';
import { WsKeysController } from './ws-keys.controller';

const APP = 'live';

describe('WsKeysController (ws-ingest provisioning REST)', () => {
  let ctx: UnitContext;
  let controller: WsKeysController;
  let svc: WsIngestService;
  let hub: FrameHub;
  let quotas: { enforceConcurrentStreams: jest.Mock };

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
      .run(APP, APP);
    hub = new FrameHub();
    quotas = { enforceConcurrentStreams: jest.fn(async () => undefined) };
    svc = new WsIngestService(
      ctx.config,
      ctx.db,
      new IngressAuthService(ctx.db),
      hub,
      quotas as unknown as QuotasService,
      ctx.mocks.apps, // getConfig throws by default → config-less fallbacks
    );
    controller = new WsKeysController(svc, quotas as unknown as QuotasService);
  });

  afterEach(() => ctx.cleanup());

  it('POST mints a wsk_ key (quota pre-flight) with connection URLs', async () => {
    const ctxAuth = { tenantId: 't1' } as AuthContext;
    const { data } = await controller.create(APP, { room: 'cam1' }, ctxAuth);

    expect(quotas.enforceConcurrentStreams).toHaveBeenCalledWith(ctxAuth);
    expect(data.id).toMatch(/^wsi_/);
    expect(data.streamKey).toMatch(/^wsk_/);
    expect(data.room).toBe('live-cam1');
    expect(data.identity).toBe(`wscam-${data.streamKey.slice(-6)}`);
    expect(data.wsUrl).toContain('/ingest/ws?app=live&room=cam1');
    expect(data.mjpegUrl).toContain('/live/live/live-cam1/mjpeg');
    expect(data.frameUrl).toContain('/live/live/live-cam1/frame.jpg');
    expect(data.playerUrl).toContain('/play/live/live-cam1');
    expect(data.embedUrl).toContain('/embed/live/live-cam1');
  });

  it('POST honors a custom identity', async () => {
    const { data } = await controller.create(APP, {
      room: 'cam1',
      identity: 'porton-norte',
    });
    expect(data.identity).toBe('porton-norte');
  });

  it('POST propagates a quota rejection (429) without minting', async () => {
    quotas.enforceConcurrentStreams.mockRejectedValue(
      new HttpException({ error: 'quota_exceeded' }, HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(controller.create(APP, { room: 'cam1' })).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(controller.list(APP).data).toHaveLength(0);
  });

  it('POST on an unknown app → 404', async () => {
    await expect(
      controller.create('ghost', { room: 'cam1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET lists the minted keys with live state', async () => {
    const a = (await controller.create(APP, { room: 'cam1' })).data;
    const b = (await controller.create(APP, { room: 'cam2' })).data;

    const { data } = controller.list(APP);
    expect(data).toHaveLength(2);
    const ids = data.map((r) => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(data.every((r) => r.active === false)).toBe(true);
    // Credentials ride along for the reveal dialog (RTMP-listing parity).
    expect(data.map((r) => r.streamKey).sort()).toEqual(
      [a.streamKey, b.streamKey].sort(),
    );
  });

  it('DELETE revokes a key; the key stops authenticating', async () => {
    const { data } = await controller.create(APP, { room: 'cam1' });
    const out = controller.remove(APP, data.id);
    expect(out.data).toEqual({ id: data.id, deleted: true });
    expect(controller.list(APP).data).toHaveLength(0);
  });

  it('DELETE of an unknown key → 404', () => {
    expect(() => controller.remove(APP, 'wsi_nope')).toThrow(NotFoundException);
  });

  it('GET live/:room (public) reports the camera state', async () => {
    await expect(controller.liveInfo(APP, 'cam1')).resolves.toEqual({
      data: expect.objectContaining({ active: false, type: null }),
    });
    // A publisher in the hub flips it (the WS gateway sets this on connect).
    hub.setPublisher(APP, 'live-cam1', true);
    await expect(controller.liveInfo(APP, 'cam1')).resolves.toEqual({
      data: expect.objectContaining({
        active: true,
        type: 'ws-mjpeg',
        room: 'live-cam1',
        mjpegUrl: expect.stringContaining('/live/live/live-cam1/mjpeg'),
      }),
    });
  });
});
