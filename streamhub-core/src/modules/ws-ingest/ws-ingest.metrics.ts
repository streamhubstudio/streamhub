import { Injectable, Optional } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';

import { MetricsService } from '../metrics/metrics.service';

const PREFIX = 'streamhub_';

/**
 * Prometheus counters/gauges of the WS-ingest gateway (ESP32-WS-INGEST.md §5).
 * Registered onto the central MetricsService registry (its `registry` field is
 * the module's plumbing seam) so they ride the existing `/metrics` scrape. When
 * MetricsService is absent (bare unit tests) the metrics are created against no
 * registry and every hook is a harmless no-op recorder.
 */
@Injectable()
export class WsIngestMetrics {
  private readonly cameras: Gauge<string>;
  private readonly frames: Counter<string>;
  private readonly bytes: Counter<string>;
  private readonly dropped: Counter<string>;
  private readonly viewers: Gauge<string>;

  constructor(@Optional() metrics?: MetricsService) {
    const registers = metrics ? [metrics.registry] : [];
    this.cameras = new Gauge({
      name: `${PREFIX}ws_ingest_cameras`,
      help: 'Live ws-mjpeg cameras connected to the ingest gateway, by app.',
      labelNames: ['app'],
      registers,
    });
    this.frames = new Counter({
      name: `${PREFIX}ws_ingest_frames_total`,
      help: 'JPEG frames accepted from ws-mjpeg cameras.',
      registers,
    });
    this.bytes = new Counter({
      name: `${PREFIX}ws_ingest_bytes_total`,
      help: 'Bytes of JPEG frames accepted from ws-mjpeg cameras.',
      registers,
    });
    this.dropped = new Counter({
      name: `${PREFIX}ws_ingest_dropped_frames_total`,
      help: 'Frames dropped by the gateway, by reason (fps|too_large|not_jpeg).',
      labelNames: ['reason'],
      registers,
    });
    this.viewers = new Gauge({
      name: `${PREFIX}ws_ingest_viewers`,
      help: 'Connected MJPEG viewers, by app and kind (ws|http).',
      labelNames: ['app', 'kind'],
      registers,
    });
  }

  setCameras(app: string, n: number): void {
    this.cameras.set({ app }, n);
  }

  frame(bytes: number): void {
    this.frames.inc();
    if (bytes > 0) this.bytes.inc(bytes);
  }

  droppedFrame(reason: 'fps' | 'too_large' | 'not_jpeg'): void {
    this.dropped.inc({ reason });
  }

  setViewers(app: string, kind: 'ws' | 'http', n: number): void {
    this.viewers.set({ app, kind }, n);
  }
}
