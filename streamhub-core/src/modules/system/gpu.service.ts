import { execFile } from 'child_process';
import * as fs from 'fs';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { MetricsService } from '../metrics/metrics.service';
import { GpuDevice, GpuStatus, GpuType } from './gpu.types';

/** Where VAAPI/DRM render nodes live on Linux. */
const DRI_DIR = '/dev/dri';
/** Hard cap on how long any external probe binary may run. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Detects GPU hardware-transcoding capability of the local NODE (SPEC §5
 * transcoding, GPU-optional).
 *
 * Two probes, tried in priority order:
 *   1. NVIDIA — `nvidia-smi --query-gpu=index,name,memory.total,driver_version`.
 *      Success ⇒ `type:'nvidia'` with the parsed device list + driver.
 *   2. VAAPI  — enumerate `/dev/dri/renderD*` render nodes; if any exist ⇒
 *      `type:'vaapi'`. `vainfo` is consulted opportunistically for the driver
 *      name but is NOT required (its absence never fails detection).
 *
 * ROBUSTNESS CONTRACT: every code path is wrapped so a missing binary, denied
 * permission, weird output, or slow probe degrades to `available:false,
 * type:'none'` — detection can never crash the process or a request.
 *
 * The result is cached after the first probe (and refreshed on boot); callers
 * use {@link status} (cached) or {@link refresh} (force a re-probe).
 */
@Injectable()
export class GpuService {
  private cached?: GpuStatus;
  private inflight?: Promise<GpuStatus>;

  constructor(
    private readonly config: ConfigService,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Probe once on boot so `/api/v1/system/gpu` is warm and metrics populate. */
  async onModuleInit(): Promise<void> {
    await this.refresh().catch(() => undefined);
  }

  /** Cached status; probes lazily on first use. */
  async status(): Promise<GpuStatus> {
    if (this.cached) return this.cached;
    return this.refresh();
  }

  /** Synchronous view of the last probe (undefined before the first probe). */
  cachedStatus(): GpuStatus | undefined {
    return this.cached;
  }

  /** Force a fresh probe (coalesces concurrent callers). */
  async refresh(): Promise<GpuStatus> {
    if (this.inflight) return this.inflight;
    this.inflight = this.probe()
      .then((s) => {
        this.cached = s;
        this.publishMetric(s);
        return s;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  // ---------------------------------------------------------------------------
  // Probing
  // ---------------------------------------------------------------------------

  private async probe(): Promise<GpuStatus> {
    const checkedAt = new Date().toISOString();

    // Allow an operator to hard-disable detection (treat node as CPU-only).
    if ((this.config.env('GPU_DISABLE') || '').toLowerCase() === 'true') {
      return {
        available: false,
        type: 'none',
        devices: [],
        checkedAt,
        detail: 'disabled via GPU_DISABLE=true',
      };
    }

    const nvidia = await this.probeNvidia(checkedAt);
    if (nvidia) return nvidia;

    const vaapi = await this.probeVaapi(checkedAt);
    if (vaapi) return vaapi;

    return {
      available: false,
      type: 'none',
      devices: [],
      checkedAt,
      detail: 'no NVIDIA (nvidia-smi) and no VAAPI (/dev/dri render node)',
    };
  }

  /** NVIDIA probe via nvidia-smi CSV. Returns undefined when unavailable. */
  private async probeNvidia(checkedAt: string): Promise<GpuStatus | undefined> {
    let out: string;
    try {
      out = await this.run('nvidia-smi', [
        '--query-gpu=index,name,memory.total,driver_version',
        '--format=csv,noheader,nounits',
      ]);
    } catch (err) {
      this.logs.write('debug', 'system', 'nvidia-smi probe failed', {
        error: (err as Error)?.message,
      });
      return undefined;
    }

    const devices: GpuDevice[] = [];
    let driver: string | undefined;
    for (const line of out.split('\n')) {
      const row = line.trim();
      if (!row) continue;
      // "0, NVIDIA GeForce RTX 3090, 24576, 550.90.07"
      const cols = row.split(',').map((c) => c.trim());
      const [idxRaw, name, memRaw, drv] = cols;
      if (!name) continue;
      const index = Number.parseInt(idxRaw, 10);
      const memoryMiB = Number.parseInt(memRaw, 10);
      devices.push({
        kind: 'nvidia',
        name,
        index: Number.isNaN(index) ? undefined : index,
        memoryMiB: Number.isNaN(memoryMiB) ? undefined : memoryMiB,
      });
      if (!driver && drv) driver = drv;
    }

    if (devices.length === 0) return undefined;
    return {
      available: true,
      type: 'nvidia',
      devices,
      driver,
      checkedAt,
      detail: `nvidia-smi reported ${devices.length} GPU(s)`,
    };
  }

  /** VAAPI probe: enumerate /dev/dri render nodes; vainfo driver is best-effort. */
  private async probeVaapi(checkedAt: string): Promise<GpuStatus | undefined> {
    let renderNodes: string[] = [];
    try {
      renderNodes = fs
        .readdirSync(DRI_DIR)
        .filter((f) => f.startsWith('renderD'))
        .sort();
    } catch (err) {
      this.logs.write('debug', 'system', 'vaapi /dev/dri scan failed', {
        error: (err as Error)?.message,
      });
      return undefined;
    }
    if (renderNodes.length === 0) return undefined;

    const devices: GpuDevice[] = renderNodes.map((f) => ({
      kind: 'vaapi',
      name: `${DRI_DIR}/${f}`,
    }));

    // Best-effort driver name via vainfo; never required.
    let driver: string | undefined;
    try {
      const vainfo = await this.run('vainfo', [
        '--display',
        'drm',
        '--device',
        devices[0].name,
      ]);
      const m = /Driver version:\s*(.+)/i.exec(vainfo);
      if (m) driver = m[1].trim();
    } catch {
      /* vainfo missing / failed — driver stays undefined */
    }

    return {
      available: true,
      type: 'vaapi',
      devices,
      driver,
      checkedAt,
      detail: `found ${devices.length} VAAPI render node(s)`,
    };
  }

  /** Run a probe binary with a hard timeout; rejects on any failure. */
  private run(bin: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout ?? '');
        },
      );
    });
  }

  private publishMetric(status: GpuStatus): void {
    try {
      this.metrics?.setGpuAvailable(status);
    } catch {
      /* metrics are best-effort */
    }
  }
}

/** Map a GPU family to the acceleration label used in logs/metrics. */
export function accelLabel(type: GpuType): string {
  return type;
}
