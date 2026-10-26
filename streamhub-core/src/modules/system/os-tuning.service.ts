import { Injectable, Logger } from '@nestjs/common';

import { buildReport, createProcReader } from './os-tuning.knobs';
import { OsTuningReport } from './os-tuning.types';

/**
 * Read-only OS performance-tuning reporter (GET /system/os-tuning).
 *
 * Inspects the host's kernel/limit knobs that matter for a LiveKit/WebRTC media
 * server (UDP socket buffers, listen backlog, UDP memory ceiling, ephemeral
 * port range, file-descriptor limits, swappiness, transparent hugepages) and
 * reports current vs recommended vs an applied/not-applied verdict.
 *
 * It NEVER writes: applying kernel params from inside a container is unsafe and
 * out of scope — `install.sh` applies them on the real host. All the logic
 * lives in the pure {@link buildReport} over a {@link createProcReader}; this
 * class just supplies the real fs-backed reader and guarantees the report can
 * never throw (a non-Linux/locked-down host degrades to all-`unknown`).
 */
@Injectable()
export class OsTuningService {
  private readonly logger = new Logger(OsTuningService.name);

  /** The full OS-tuning report. Degrades to all-unknown rather than throwing. */
  report(): OsTuningReport {
    try {
      // A fresh reader per call so `/proc/self/limits` reflects the live process.
      return buildReport(createProcReader());
    } catch (err) {
      this.logger.debug(`os-tuning probe failed: ${String(err)}`);
      // Last-resort: an all-unknown report shaped like the platform we run on.
      return buildReport({ platform: 'unknown', read: () => null });
    }
  }
}
