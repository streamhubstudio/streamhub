import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import {
  APPS_SERVICE,
  AppConfig,
  AppFeatures,
  AppsServiceContract,
  CreateIngressInput,
  LOGS_SERVICE,
  LogsServiceContract,
  MintTokenOptions,
  TranscodingEncoding,
  VodRendition,
  WebrtcLayer,
} from '../../shared/contracts';
import { HwAccelService } from '../system/hwaccel.service';
import { HwaccelDecision, HwaccelMode } from '../system/gpu.types';
import { UpdateTranscodingConfigDto } from './dto/update-transcoding-config.dto';

/**
 * Read-only, transcoding-focused projection of an app's config returned by the
 * GET /apps/:app/config endpoint. Never carries S3 credentials.
 */
export interface TranscodingConfigView {
  app: string;
  /** Adaptive (simulcast) WebRTC delivery enabled. */
  adaptive: boolean;
  /** Effective rendition ladder (e.g. 720/480/240). */
  layers: WebrtcLayer[];
  rtmp: {
    enabled: boolean;
    /** Transcode RTMP ingress to a multi-layer ladder. */
    transcode: boolean;
  };
  /** Wave-2 feature flags (SPEC §16). */
  features: AppFeatures;
  /**
   * Server-side transcoding block (config.yaml `transcoding:`). `enabled` is
   * the master switch (false on new apps = passthrough). `hwaccel` is the
   * app's configured GPU preference; `hwaccelResolved` is what will actually
   * be used on this node after GPU detection + fallback (SPEC §5).
   */
  transcoding: {
    /** Master switch: gates RTMP-ingress transcoding + VOD post-processing. */
    enabled: boolean;
    /** Recording output target: h264 (default) | h264+vp8 (adds WebM/VP8). */
    encoding: TranscodingEncoding;
    /** Adaptive HLS VOD (master + renditions) per recording. */
    vodAdaptive: boolean;
    /** Configured VOD ladder (empty = derived from webrtc.layers). */
    vodRenditions: VodRendition[];
    hwaccel: HwaccelMode;
    hwaccelResolved: HwaccelDecision;
  };
}

/**
 * Shape embedded into a LiveKit token's metadata so clients/recorders know the
 * intended adaptive ladder. Namespaced to avoid clobbering app metadata.
 */
export interface SimulcastTokenHint {
  adaptiveStream: boolean;
  simulcast: boolean;
  layers: WebrtcLayer[];
}

/**
 * Adaptive video config (SPEC §5 transcoding, §7 webrtc/rtmp).
 *
 * Live = LiveKit simulcast + ingress `enableTranscoding` (multi-layer). This
 * service owns the per-app rendition ladder and the two integration helpers
 * other modules use: `applyIngressTranscoding` (ingress) and `applyTokenGrants`
 * (token metadata/simulcast hint). VOD HLS multi-rendition is v2.
 */
@Injectable()
export class TranscodingService {
  constructor(
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    private readonly hwaccel: HwAccelService,
  ) {}

  /** Default WebRTC rendition ladder (matches the config.yaml template). */
  defaultLayers(): WebrtcLayer[] {
    return [
      { name: 'high', height: 720 },
      { name: 'med', height: 480 },
      { name: 'low', height: 240 },
    ];
  }

  /**
   * Resolve an app config, translating an unknown/missing app into a clean 404.
   * Never lets a raw error escape as an unhandled rejection.
   */
  private async resolveConfig(appName: string): Promise<AppConfig> {
    try {
      return await this.apps.getConfig(appName);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logs.write(
        'warn',
        'transcoding',
        `could not load config for app "${appName}"`,
        { error: (err as Error)?.message },
      );
      throw new NotFoundException(`App "${appName}" not found`);
    }
  }

  /** Effective layers for an app; falls back to the default ladder. */
  async layersForApp(appName: string): Promise<WebrtcLayer[]> {
    const cfg = await this.resolveConfig(appName);
    const layers = cfg.webrtc?.layers;
    return layers && layers.length > 0 ? layers : this.defaultLayers();
  }

  /** Transcoding-focused projection for GET /apps/:app/config. */
  async getConfigView(appName: string): Promise<TranscodingConfigView> {
    const cfg = await this.resolveConfig(appName);
    return this.toView(appName, cfg);
  }

  /**
   * Apply a partial transcoding config patch (PATCH /apps/:app/config). Merges
   * into the app config via APPS_SERVICE and returns the resulting view.
   */
  async updateConfig(
    appName: string,
    dto: UpdateTranscodingConfigDto,
  ): Promise<TranscodingConfigView> {
    const current = await this.resolveConfig(appName);

    const patch: Partial<AppConfig> = {};

    if (dto.adaptive !== undefined || dto.layers !== undefined) {
      patch.webrtc = {
        adaptive: dto.adaptive ?? current.webrtc.adaptive,
        layers:
          dto.layers !== undefined
            ? dto.layers.map((l) => ({ name: l.name, height: l.height }))
            : current.webrtc.layers,
      };
    }

    if (dto.rtmpTranscode !== undefined) {
      patch.rtmp = {
        enabled: current.rtmp.enabled,
        transcode: dto.rtmpTranscode,
      };
    }

    if (
      dto.transcodingEnabled !== undefined ||
      dto.encoding !== undefined ||
      dto.vodAdaptive !== undefined ||
      dto.vodRenditions !== undefined
    ) {
      patch.transcoding = {
        enabled: dto.transcodingEnabled ?? current.transcoding?.enabled ?? false,
        encoding: dto.encoding ?? current.transcoding?.encoding ?? 'h264',
        vodAdaptive:
          dto.vodAdaptive ?? current.transcoding?.vodAdaptive ?? false,
        vodRenditions:
          dto.vodRenditions !== undefined
            ? dto.vodRenditions.map((r) => ({
                height: r.height,
                bitrateKbps: r.bitrateKbps,
              }))
            : (current.transcoding?.vodRenditions ?? []),
      };
    }

    if (dto.features !== undefined) {
      patch.features = { ...dto.features } as AppConfig['features'];
    }

    // GPU hw-accel preference (SPEC §5). Stored by HwAccelService in a per-app
    // sidecar (independent of config.yaml), so it round-trips via GET/PATCH here.
    if (dto.hwaccel !== undefined) {
      this.hwaccel.setMode(appName, dto.hwaccel);
    }

    let merged: AppConfig;
    try {
      merged = await this.apps.updateConfig(appName, patch);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logs.write(
        'error',
        'transcoding',
        `failed to update config for app "${appName}"`,
        { error: (err as Error)?.message },
      );
      throw new NotFoundException(`App "${appName}" not found`);
    }

    this.logs.write('info', 'transcoding', `updated config for app "${appName}"`, {
      adaptive: merged.webrtc?.adaptive,
      layers: merged.webrtc?.layers?.length,
      rtmpTranscode: merged.rtmp?.transcode,
    });

    return this.toView(appName, merged);
  }

  // --- Integration helpers consumed by the livekit / auth modules -----------

  /**
   * Whether RTMP ingress for this app should be transcoded into a multi-layer
   * ladder. Requires the `transcoding.enabled` master switch (false by default
   * on new apps = passthrough) AND rtmp.{enabled,transcode}. A resolved config
   * always carries `transcoding`; a missing block (stale fixture) counts as
   * disabled.
   */
  async shouldTranscodeIngress(appName: string): Promise<boolean> {
    const cfg = await this.resolveConfig(appName);
    return Boolean(
      cfg.transcoding?.enabled && cfg.rtmp?.enabled && cfg.rtmp?.transcode,
    );
  }

  /**
   * Return a copy of the given ingress input with `enableTranscoding` set from
   * the app's config. Callers (livekit module) pass this to createIngress.
   */
  async applyIngressTranscoding(
    appName: string,
    input: CreateIngressInput,
  ): Promise<CreateIngressInput> {
    const enableTranscoding = await this.shouldTranscodeIngress(appName);
    return { ...input, enableTranscoding };
  }

  /**
   * Adaptive/simulcast hint for a token. Empty when the app is not adaptive.
   */
  async simulcastHint(appName: string): Promise<SimulcastTokenHint> {
    const cfg = await this.resolveConfig(appName);
    const adaptive = Boolean(cfg.webrtc?.adaptive);
    return {
      adaptiveStream: adaptive,
      simulcast: adaptive,
      layers:
        cfg.webrtc?.layers && cfg.webrtc.layers.length > 0
          ? cfg.webrtc.layers
          : this.defaultLayers(),
    };
  }

  /**
   * Return a copy of the given mint-token options with the app's simulcast hint
   * merged into `metadata` under the `streamhub` namespace. Existing metadata is
   * preserved when it is valid JSON; otherwise it is kept verbatim under `_raw`.
   */
  async applyTokenGrants(
    appName: string,
    opts: MintTokenOptions,
  ): Promise<MintTokenOptions> {
    const hint = await this.simulcastHint(appName);

    let base: Record<string, unknown> = {};
    if (opts.metadata) {
      try {
        const parsed = JSON.parse(opts.metadata);
        base =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : { _raw: opts.metadata };
      } catch {
        base = { _raw: opts.metadata };
      }
    }

    const metadata = JSON.stringify({ ...base, streamhub: { simulcast: hint } });
    return { ...opts, metadata };
  }

  private async toView(
    appName: string,
    cfg: AppConfig,
  ): Promise<TranscodingConfigView> {
    const hwaccel = this.hwaccel.getMode(appName);
    const hwaccelResolved = await this.hwaccel.resolve(appName);
    return {
      app: appName,
      adaptive: Boolean(cfg.webrtc?.adaptive),
      layers:
        cfg.webrtc?.layers && cfg.webrtc.layers.length > 0
          ? cfg.webrtc.layers
          : this.defaultLayers(),
      rtmp: {
        enabled: Boolean(cfg.rtmp?.enabled),
        transcode: Boolean(cfg.rtmp?.transcode),
      },
      features: cfg.features,
      transcoding: {
        enabled: Boolean(cfg.transcoding?.enabled),
        encoding: cfg.transcoding?.encoding ?? 'h264',
        vodAdaptive: Boolean(cfg.transcoding?.vodAdaptive),
        vodRenditions: cfg.transcoding?.vodRenditions ?? [],
        hwaccel,
        hwaccelResolved,
      },
    };
  }
}
