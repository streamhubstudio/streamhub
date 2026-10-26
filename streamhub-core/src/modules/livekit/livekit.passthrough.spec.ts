/**
 * Unit spec — LiveKitController RTMP→HLS passthrough branch (mode=passthrough).
 * Pins that the passthrough path is INDEPENDENT of LiveKit:
 *  - POST /ingress {mode:'passthrough'} mints via the passthrough plane, returns
 *    a :1937 rtmp_url + /hls/…/index.m3u8 + capabilities, and NEVER calls
 *    livekit.createIngress;
 *  - mode defaults from the app's rtmp.passthrough;
 *  - mixing passthrough with adaptive/transcode (or whip/url) → 400;
 *  - DELETE of a pti_ ingress stops the remux + drops the key via the plane and
 *    NEVER calls livekit.deleteIngress;
 *  - SRT: {inputType:'srt', mode:'passthrough'} arms the plane with the srt
 *    transport and returns srt_url (no rtmp_url); srt WITHOUT passthrough mode
 *    is a 400 (LiveKit's ingress API has no SRT input type).
 */
import { BadRequestException } from '@nestjs/common';

import { LiveKitController } from './livekit.controller';
import { PassthroughService } from '../passthrough/passthrough.service';
import { APPS_SERVICE, type AppConfig } from '../../shared/contracts';

function makeCtrl(passthroughConfigured = false) {
  const createIngress = jest.fn(async () => ({
    ingressId: 'IN_1',
    url: 'rtmp://host/live/key1',
    streamKey: 'key1',
    roomName: 'live-ch1',
  }));
  const deleteIngress = jest.fn(async () => undefined);
  const livekit = { createIngress, deleteIngress } as any;

  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features: { adaptivePlayer: false, rtmpPassword: false },
    rtmp: { enabled: true, transcode: !passthroughConfigured, passthrough: passthroughConfigured },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };

  const passthrough = {
    create: jest.fn(
      (
        app: string,
        room: string,
        _appId?: number | null,
        inputType: 'rtmp' | 'srt' = 'rtmp',
      ) => ({
        mode: 'passthrough' as const,
        ingressId: inputType === 'srt' ? 'pti_srt_abc' : 'pti_abc',
        app,
        room,
        streamKey: 'ptk_secret',
        inputType,
        rtmpUrl:
          inputType === 'srt' ? '' : 'rtmp://media.test:1937/live/ptk_secret',
        ...(inputType === 'srt'
          ? { srtUrl: 'srt://media.test:1937?streamid=ptk_secret' }
          : {}),
        hlsUrl: '/hls/live/live-ch1/index.m3u8',
        playerUrl: '/play/live/live-ch1',
        status: 'live' as const,
        capabilities: {
          mode: 'passthrough',
          remux: true,
          webrtc: false,
          subSecondLatency: false,
          adaptiveBitrate: false,
          transcode: false,
          requiresH264Aac: true,
          recording: false,
          roomFeatures: false,
          backupKey: false,
          gpu: false,
          ...(inputType === 'srt' ? { latencyMs: 120 } : {}),
          lost: ['no webrtc'],
        },
      }),
    ),
    remove: jest.fn(() => true),
    list: jest.fn(() => []),
  };

  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === APPS_SERVICE) return apps;
      if (token === PassthroughService) return passthrough;
      throw new Error('not found');
    }),
  } as any;

  const config = {
    publicWsUrl: 'wss://m',
    env: () => '',
    jwtSecret: 's',
    rtmpPublicHost: 'media.test',
    rtmpsEnable: false,
    rtmpsPublicHost: '',
    rtmpsPort: 1936,
  } as any;
  const ingressAuth = { register: jest.fn(() => ({ password: undefined })) } as any;
  const quotas = { enforceConcurrentStreams: jest.fn(async () => {}) } as any;
  const ingressBackup = {
    link: () => {},
    getRoleInfo: () => ({ role: null, pairedIngressId: null }),
    getLinkFor: () => null,
    remove: () => {},
  } as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
    ingressBackup,
  );
  return { controller, createIngress, deleteIngress, passthrough };
}

describe('LiveKitController — RTMP→HLS passthrough', () => {
  it('mode=passthrough returns a :1937 rtmp_url + /hls url + capabilities, WITHOUT calling createIngress', async () => {
    const { controller, createIngress, passthrough } = makeCtrl();

    const res = await controller.createIngress('live', {
      inputType: 'rtmp',
      room: 'ch1',
      mode: 'passthrough',
    } as any);

    expect(createIngress).not.toHaveBeenCalled();
    expect(passthrough.create).toHaveBeenCalledWith('live', 'live-ch1');
    expect(res.data).toMatchObject({
      mode: 'passthrough',
      ingressId: 'pti_abc',
      stream_key: 'ptk_secret',
      rtmp_url: 'rtmp://media.test:1937/live/ptk_secret',
      hls_url: '/hls/live/live-ch1/index.m3u8',
    });
    expect((res.data as any).rtmp_url).toContain(':1937');
    expect((res.data as any).capabilities.remux).toBe(true);
  });

  it('defaults mode from the app rtmp.passthrough flag', async () => {
    const { controller, createIngress, passthrough } = makeCtrl(true);
    const res = await controller.createIngress('live', {
      inputType: 'rtmp',
      room: 'ch1',
    } as any);
    expect(passthrough.create).toHaveBeenCalledTimes(1);
    expect(createIngress).not.toHaveBeenCalled();
    expect((res.data as any).mode).toBe('passthrough');
  });

  it('rejects mixing passthrough with transcoding (400)', async () => {
    const { controller, createIngress, passthrough } = makeCtrl();
    await expect(
      controller.createIngress('live', {
        inputType: 'rtmp',
        room: 'ch1',
        mode: 'passthrough',
        enableTranscoding: true,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passthrough.create).not.toHaveBeenCalled();
    expect(createIngress).not.toHaveBeenCalled();
  });

  it('rejects passthrough on a whip/url input (400)', async () => {
    const { controller, passthrough } = makeCtrl();
    await expect(
      controller.createIngress('live', {
        inputType: 'whip',
        room: 'ch1',
        mode: 'passthrough',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passthrough.create).not.toHaveBeenCalled();
  });

  it('a normal (transcode) ingress still calls livekit.createIngress', async () => {
    const { controller, createIngress, passthrough } = makeCtrl();
    await controller.createIngress('live', {
      inputType: 'rtmp',
      room: 'ch1',
    } as any);
    expect(createIngress).toHaveBeenCalledTimes(1);
    expect(passthrough.create).not.toHaveBeenCalled();
  });

  it('DELETE of a pti_ ingress removes via the plane, NOT via livekit', async () => {
    const { controller, deleteIngress, passthrough } = makeCtrl();
    const res = await controller.deleteIngress('live', 'pti_abc');
    expect(passthrough.remove).toHaveBeenCalledWith('live', 'pti_abc');
    expect(deleteIngress).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      ingressId: 'pti_abc',
      deleted: true,
      mode: 'passthrough',
    });
  });
});

describe('LiveKitController — SRT passthrough', () => {
  it("{inputType:'srt', mode:'passthrough'} arms the plane with the srt transport and returns srt_url + hls_url, WITHOUT calling createIngress", async () => {
    const { controller, createIngress, passthrough } = makeCtrl();

    const res = await controller.createIngress('live', {
      inputType: 'srt',
      room: 'ch1',
      mode: 'passthrough',
    } as any);

    expect(createIngress).not.toHaveBeenCalled();
    expect(passthrough.create).toHaveBeenCalledWith(
      'live',
      'live-ch1',
      undefined,
      'srt',
    );
    expect(res.data).toMatchObject({
      mode: 'passthrough',
      inputType: 'srt',
      ingressId: 'pti_srt_abc',
      stream_key: 'ptk_secret',
      srt_url: 'srt://media.test:1937?streamid=ptk_secret',
      hls_url: '/hls/live/live-ch1/index.m3u8',
    });
    // Push URL per transport: srt_url XOR rtmp_url.
    expect((res.data as any).rtmp_url).toBeUndefined();
    expect((res.data as any).capabilities.latencyMs).toBe(120);
  });

  it('srt with an explicit transcode mode → 400 (LiveKit has no SRT input type)', async () => {
    const { controller, createIngress, passthrough } = makeCtrl();
    await expect(
      controller.createIngress('live', {
        inputType: 'srt',
        room: 'ch1',
        mode: 'transcode',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passthrough.create).not.toHaveBeenCalled();
    expect(createIngress).not.toHaveBeenCalled();
  });

  it('srt with NO mode on a non-passthrough app → 400 (never reaches LiveKit)', async () => {
    const { controller, createIngress, passthrough } = makeCtrl();
    await expect(
      controller.createIngress('live', {
        inputType: 'srt',
        room: 'ch1',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passthrough.create).not.toHaveBeenCalled();
    expect(createIngress).not.toHaveBeenCalled();
  });

  it("srt with NO mode still lands on the passthrough plane when the app's rtmp.passthrough defaults it", async () => {
    const { controller, createIngress, passthrough } = makeCtrl(true);
    const res = await controller.createIngress('live', {
      inputType: 'srt',
      room: 'ch1',
    } as any);
    expect(createIngress).not.toHaveBeenCalled();
    expect(passthrough.create).toHaveBeenCalledWith(
      'live',
      'live-ch1',
      undefined,
      'srt',
    );
    expect((res.data as any).srt_url).toContain('srt://');
  });

  it('an RTMP passthrough create keeps the pre-SRT call shape + response (no srt fields)', async () => {
    const { controller, passthrough } = makeCtrl();
    const res = await controller.createIngress('live', {
      inputType: 'rtmp',
      room: 'ch1',
      mode: 'passthrough',
    } as any);
    expect(passthrough.create).toHaveBeenCalledWith('live', 'live-ch1');
    expect((res.data as any).srt_url).toBeUndefined();
    expect((res.data as any).rtmp_url).toContain(':1937');
  });

  it('DELETE of a pti_srt_ ingress removes via the plane, NOT via livekit', async () => {
    const { controller, deleteIngress, passthrough } = makeCtrl();
    const res = await controller.deleteIngress('live', 'pti_srt_abc');
    expect(passthrough.remove).toHaveBeenCalledWith('live', 'pti_srt_abc');
    expect(deleteIngress).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      ingressId: 'pti_srt_abc',
      deleted: true,
      mode: 'passthrough',
    });
  });
});
