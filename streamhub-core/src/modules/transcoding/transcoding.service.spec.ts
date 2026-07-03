/**
 * Unit spec — TranscodingService (feature transcoding-adaptive-vod).
 *
 * Pure-mock suite (no DB, no network): APPS_SERVICE / LOGS_SERVICE are
 * contract mocks and HwAccelService is a hand-rolled stub. Locks down:
 *  - the `transcoding` block surfaced by GET /apps/:app/config (enabled /
 *    encoding / vodAdaptive / vodRenditions + hwaccel);
 *  - PATCH mapping: transcodingEnabled/encoding/vodAdaptive/vodRenditions →
 *    AppConfig.transcoding patch;
 *  - INVARIANT: `shouldTranscodeIngress` requires the `transcoding.enabled`
 *    master switch — an app with the default (disabled) config is passthrough
 *    even when rtmp.transcode is true.
 */
import { NotFoundException } from '@nestjs/common';

import { TranscodingService } from './transcoding.service';
import { UpdateTranscodingConfigDto } from './dto/update-transcoding-config.dto';
import type { HwAccelService } from '../system/hwaccel.service';
import type { AppConfig } from '../../shared/contracts';
import {
  mockAppsService,
  mockLogsService,
} from '../../../test/helpers/service-mocks';

const APP = 'live';

function makeAppConfig(over: {
  transcoding?: Partial<NonNullable<AppConfig['transcoding']>>;
  rtmp?: Partial<AppConfig['rtmp']>;
  webrtc?: Partial<AppConfig['webrtc']>;
} = {}): AppConfig {
  return {
    name: APP,
    displayName: 'Live',
    roomPrefix: 'live',
    recording: {
      enabled: true,
      mode: 'room-composite',
      layout: 'grid',
      localDir: 'recordings',
      deleteLocalAfterUpload: true,
      splitMinutes: 0,
      snapshotSeconds: 0,
    },
    s3: {
      provider: 'aws',
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'streamhub/live',
      accessKey: 'AK',
      secretKey: 'SK',
    },
    webrtc: {
      adaptive: true,
      layers: [
        { name: 'high', height: 720 },
        { name: 'med', height: 480 },
        { name: 'low', height: 240 },
      ],
      ...over.webrtc,
    },
    rtmp: { enabled: true, transcode: true, ...over.rtmp },
    transcoding: {
      enabled: false,
      encoding: 'h264',
      vodAdaptive: false,
      vodRenditions: [],
      ...over.transcoding,
    },
    callbacks: { url: '', secret: '' },
    features: {
      rtmpPassword: false,
      viewerCounter: false,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
      publicPlayback: true,
    },
  };
}

function makeHwaccelStub(): HwAccelService {
  return {
    getMode: jest.fn(() => 'auto'),
    setMode: jest.fn(),
    resolve: jest.fn(async () => ({
      requested: 'auto',
      effective: 'cpu',
      type: 'none',
      reason: 'no gpu detected',
    })),
  } as unknown as HwAccelService;
}

describe('TranscodingService', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let svc: TranscodingService;

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    svc = new TranscodingService(apps, logs, makeHwaccelStub());
  });

  describe('getConfigView', () => {
    it('surfaces the transcoding block (defaults: disabled, h264, no VOD ladder)', async () => {
      apps.getConfig.mockResolvedValue(makeAppConfig());
      const view = await svc.getConfigView(APP);
      expect(view.transcoding).toMatchObject({
        enabled: false,
        encoding: 'h264',
        vodAdaptive: false,
        vodRenditions: [],
        hwaccel: 'auto',
      });
      expect(view.transcoding.hwaccelResolved.effective).toBe('cpu');
    });

    it('surfaces an opted-in config (h264+vp8 + adaptive VOD ladder)', async () => {
      apps.getConfig.mockResolvedValue(
        makeAppConfig({
          transcoding: {
            enabled: true,
            encoding: 'h264+vp8',
            vodAdaptive: true,
            vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
          },
        }),
      );
      const view = await svc.getConfigView(APP);
      expect(view.transcoding.enabled).toBe(true);
      expect(view.transcoding.encoding).toBe('h264+vp8');
      expect(view.transcoding.vodAdaptive).toBe(true);
      expect(view.transcoding.vodRenditions).toEqual([
        { height: 720, bitrateKbps: 2800 },
      ]);
    });

    it('404s for an unknown app', async () => {
      apps.getConfig.mockRejectedValue(new Error('no such app'));
      await expect(svc.getConfigView('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateConfig — encoding selection', () => {
    it('maps transcodingEnabled/encoding/vodAdaptive/vodRenditions onto the patch', async () => {
      apps.getConfig.mockResolvedValue(makeAppConfig());
      apps.updateConfig.mockImplementation(async (_n, patch) =>
        makeAppConfig({
          transcoding: patch.transcoding as NonNullable<
            AppConfig['transcoding']
          >,
        }),
      );
      const dto = new UpdateTranscodingConfigDto();
      dto.transcodingEnabled = true;
      dto.encoding = 'h264+vp8';
      dto.vodAdaptive = true;
      dto.vodRenditions = [
        { height: 720, bitrateKbps: 2800 },
        { height: 480, bitrateKbps: 1400 },
      ];

      const view = await svc.updateConfig(APP, dto);

      expect(apps.updateConfig).toHaveBeenCalledWith(APP, {
        transcoding: {
          enabled: true,
          encoding: 'h264+vp8',
          vodAdaptive: true,
          vodRenditions: [
            { height: 720, bitrateKbps: 2800 },
            { height: 480, bitrateKbps: 1400 },
          ],
        },
      });
      expect(view.transcoding.encoding).toBe('h264+vp8');
    });

    it('a partial patch (encoding only) preserves the other transcoding fields', async () => {
      apps.getConfig.mockResolvedValue(
        makeAppConfig({
          transcoding: { enabled: true, vodAdaptive: true },
        }),
      );
      apps.updateConfig.mockImplementation(async (_n, patch) =>
        makeAppConfig({
          transcoding: patch.transcoding as NonNullable<
            AppConfig['transcoding']
          >,
        }),
      );
      const dto = new UpdateTranscodingConfigDto();
      dto.encoding = 'h264+vp8';

      await svc.updateConfig(APP, dto);

      expect(apps.updateConfig).toHaveBeenCalledWith(APP, {
        transcoding: {
          enabled: true, // preserved
          encoding: 'h264+vp8', // patched
          vodAdaptive: true, // preserved
          vodRenditions: [],
        },
      });
    });

    it('does not touch the transcoding block when no related dto field is set', async () => {
      apps.getConfig.mockResolvedValue(makeAppConfig());
      apps.updateConfig.mockImplementation(async () => makeAppConfig());
      const dto = new UpdateTranscodingConfigDto();
      dto.adaptive = false;

      await svc.updateConfig(APP, dto);

      const patch = apps.updateConfig.mock.calls[0][1];
      expect(patch.transcoding).toBeUndefined();
      expect(patch.webrtc).toBeDefined();
    });
  });

  describe('shouldTranscodeIngress / applyIngressTranscoding', () => {
    it('INVARIANT: default config (transcoding disabled) → passthrough, even with rtmp.transcode=true', async () => {
      apps.getConfig.mockResolvedValue(
        makeAppConfig({ rtmp: { enabled: true, transcode: true } }),
      );
      await expect(svc.shouldTranscodeIngress(APP)).resolves.toBe(false);

      const out = await svc.applyIngressTranscoding(APP, {
        appName: APP,
        roomName: 'r1',
        inputType: 'rtmp',
        participantIdentity: 'cam',
      });
      expect(out.enableTranscoding).toBe(false);
    });

    it('transcodes ingress when the master switch AND rtmp.transcode are on', async () => {
      apps.getConfig.mockResolvedValue(
        makeAppConfig({ transcoding: { enabled: true } }),
      );
      await expect(svc.shouldTranscodeIngress(APP)).resolves.toBe(true);
    });

    it('stays passthrough when enabled but rtmp.transcode is off', async () => {
      apps.getConfig.mockResolvedValue(
        makeAppConfig({
          transcoding: { enabled: true },
          rtmp: { enabled: true, transcode: false },
        }),
      );
      await expect(svc.shouldTranscodeIngress(APP)).resolves.toBe(false);
    });
  });
});
