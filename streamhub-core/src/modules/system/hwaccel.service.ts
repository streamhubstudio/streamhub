import * as fs from 'fs';
import * as path from 'path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  EncodingOptions,
  IngressVideoEncodingPreset,
  IngressVideoOptions,
  TrackSource,
  VideoCodec,
} from '@livekit/protocol';

import { ConfigService } from '../../shared/config/config.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { MetricsService } from '../metrics/metrics.service';
import { GpuService } from './gpu.service';
import { HwaccelDecision, HwaccelMode } from './gpu.types';

/** Sidecar filename (per app) holding the transcoding hwaccel preference. */
const SIDECAR = 'transcoding.json';
const VALID_MODES: readonly HwaccelMode[] = ['auto', 'gpu', 'cpu'];

/** Result of building egress encoding options for an app. */
export interface EgressHwOptions {
  /** Encoding options to attach to the egress request (undefined ⇒ CPU/default). */
  encodingOptions?: EncodingOptions;
  decision: HwaccelDecision;
}

/** Result of building ingress video options for an app. */
export interface IngressHwOptions {
  /** Video options to attach to the ingress request (undefined ⇒ CPU/default). */
  video?: IngressVideoOptions;
  decision: HwaccelDecision;
}

/**
 * Resolves an app's `hwaccel` preference against the live {@link GpuService}
 * status and produces the LiveKit SDK encoding options that steer egress /
 * ingress toward hardware encoding — with a guaranteed CPU fallback.
 *
 * Ownership & storage (SPEC §5 transcoding): the per-app preference lives in a
 * small sidecar `apps/<app>/transcoding.json` owned by this service, so the
 * app's existing config.yaml / DB are untouched. The global default comes from
 * `TRANSCODING_HWACCEL` (auto|gpu|cpu, default 'auto').
 *
 * IMPORTANT (documented in deploy/GPU.md): the SDK request cannot itself pick
 * the ffmpeg encoder (x264 vs h264_nvenc vs VAAPI). It only carries the target
 * codec/resolution/bitrate; the ACTUAL hardware path is chosen by the egress /
 * ingress WORKER based on its build + node config (NVENC/VAAPI + nvidia runtime).
 * What this service does is (a) decide gpu-vs-cpu from real detection, (b) attach
 * explicit H.264 encoding options when GPU is chosen so a GPU-capable worker can
 * hardware-encode, and (c) record which path was taken. When no GPU is present
 * (or the app is set to `cpu`) it attaches nothing — i.e. exactly today's CPU
 * behaviour.
 *
 * Every public method is failure-proof: any error resolves to a CPU decision
 * with NO options, so ingress/egress is never broken by this feature.
 */
@Injectable()
export class HwAccelService {
  constructor(
    private readonly config: ConfigService,
    private readonly gpu: GpuService,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Per-app hwaccel preference (sidecar-backed)
  // ---------------------------------------------------------------------------

  /** Global default from env (validated), falling back to 'auto'. */
  defaultMode(): HwaccelMode {
    const raw = (this.config.env('TRANSCODING_HWACCEL') || '').toLowerCase();
    return (VALID_MODES as readonly string[]).includes(raw)
      ? (raw as HwaccelMode)
      : 'auto';
  }

  private sidecarPath(app: string): string {
    return path.join(this.config.dataDir, 'apps', app, SIDECAR);
  }

  /** Read the app's configured hwaccel mode (never throws). */
  getMode(app: string): HwaccelMode {
    try {
      const raw = fs.readFileSync(this.sidecarPath(app), 'utf8');
      const parsed = JSON.parse(raw) as { hwaccel?: string };
      const mode = (parsed.hwaccel || '').toLowerCase();
      if ((VALID_MODES as readonly string[]).includes(mode)) {
        return mode as HwaccelMode;
      }
    } catch {
      /* missing/invalid sidecar ⇒ fall back to the global default */
    }
    return this.defaultMode();
  }

  /** Persist the app's hwaccel mode. Returns the stored mode. */
  setMode(app: string, mode: HwaccelMode): HwaccelMode {
    if (!(VALID_MODES as readonly string[]).includes(mode)) {
      throw new Error(`invalid hwaccel mode "${mode}"`);
    }
    const file = this.sidecarPath(app);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ hwaccel: mode }, null, 2));
    } catch (err) {
      this.logs.write('warn', 'transcoding', 'could not persist hwaccel mode', {
        app,
        mode,
        error: (err as Error)?.message,
      });
    }
    return mode;
  }

  // ---------------------------------------------------------------------------
  // Resolution (mode + live GPU status ⇒ decision)
  // ---------------------------------------------------------------------------

  /** Resolve the effective gpu/cpu decision for an app (never throws). */
  async resolve(app: string): Promise<HwaccelDecision> {
    let requested: HwaccelMode = 'auto';
    try {
      requested = this.getMode(app);
      if (requested === 'cpu') {
        return {
          requested,
          effective: 'cpu',
          type: 'none',
          reason: 'app configured hwaccel=cpu',
        };
      }
      const gpu = await this.gpu.status();
      if (gpu.available) {
        return {
          requested,
          effective: 'gpu',
          type: gpu.type,
          reason:
            requested === 'gpu'
              ? `hwaccel=gpu and ${gpu.type} GPU available`
              : `hwaccel=auto resolved to ${gpu.type} GPU`,
        };
      }
      return {
        requested,
        effective: 'cpu',
        type: 'none',
        reason:
          requested === 'gpu'
            ? 'hwaccel=gpu but no GPU detected — CPU fallback'
            : 'hwaccel=auto and no GPU detected — CPU',
      };
    } catch (err) {
      this.logs.write('warn', 'transcoding', 'hwaccel resolve failed — CPU', {
        app,
        error: (err as Error)?.message,
      });
      return {
        requested,
        effective: 'cpu',
        type: 'none',
        reason: 'resolution error — CPU fallback',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // SDK option builders
  // ---------------------------------------------------------------------------

  /**
   * Build egress encoding options for an app. When GPU is chosen, returns an
   * explicit H.264 EncodingOptions (so a GPU-capable egress worker hardware-
   * encodes). Otherwise returns no options (today's CPU/default behaviour).
   */
  async egressEncoding(app: string): Promise<EgressHwOptions> {
    const decision = await this.resolve(app);
    if (decision.effective !== 'gpu') return { decision };
    try {
      const encodingOptions = new EncodingOptions({
        width: 1280,
        height: 720,
        framerate: 30,
        videoCodec: VideoCodec.H264_MAIN,
        videoBitrate: 3000,
        keyFrameInterval: 2,
      });
      return { encodingOptions, decision };
    } catch (err) {
      this.logs.write('warn', 'transcoding', 'egress hw options build failed', {
        app,
        error: (err as Error)?.message,
      });
      return { decision: { ...decision, effective: 'cpu', type: 'none' } };
    }
  }

  /**
   * Build ingress video options for an app. When GPU is chosen, returns an
   * H.264 simulcast preset (a GPU-capable ingress worker hardware-encodes it).
   * Otherwise no options (default forwarding/transcoding behaviour).
   */
  async ingressVideo(app: string): Promise<IngressHwOptions> {
    const decision = await this.resolve(app);
    if (decision.effective !== 'gpu') return { decision };
    try {
      const video = new IngressVideoOptions({
        source: TrackSource.CAMERA,
        encodingOptions: {
          case: 'preset',
          value: IngressVideoEncodingPreset.H264_720P_30FPS_3_LAYERS,
        },
      });
      return { video, decision };
    } catch (err) {
      this.logs.write('warn', 'transcoding', 'ingress hw options build failed', {
        app,
        error: (err as Error)?.message,
      });
      return { decision: { ...decision, effective: 'cpu', type: 'none' } };
    }
  }

  /** Record which acceleration path a media op actually used (metric, best-effort). */
  recordUsage(kind: 'egress' | 'ingress', decision: HwaccelDecision): void {
    try {
      this.metrics?.recordTranscode(kind, decision.effective, decision.type);
    } catch {
      /* metrics are best-effort */
    }
  }
}
