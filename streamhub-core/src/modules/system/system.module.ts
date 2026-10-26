import { Module } from '@nestjs/common';

import { BackupsModule } from '../backups/backups.module';
import { AuditModule } from '../audit/audit.module';
import { MetricsHistoryModule } from '../metrics-history/metrics-history.module';
import { GpuService } from './gpu.service';
import { HwAccelService } from './hwaccel.service';
import { OsTuningService } from './os-tuning.service';
import { SettingsService } from './settings.service';
import { SystemController } from './system.controller';

/**
 * System module (SPEC §5 transcoding, GPU-optional).
 *
 * Owns GPU detection ({@link GpuService}) + the hardware-accel resolver /
 * SDK-option builder ({@link HwAccelService}). Both are exported so the LiveKit
 * (ingress/egress wiring) and Transcoding (per-app hwaccel config) modules can
 * consume them. Depends only on global providers (Config, Logs, Metrics), so it
 * imports nothing and introduces no dependency cycle.
 *
 * Exposes `GET /api/v1/system/gpu` and `GET /api/v1/system/settings`
 * (read-only, global-scope config reporter — {@link SettingsService}, which
 * reads Config + DbService/DbSizesService from the @Global shared modules).
 *
 * Also hosts {@link BackupsModule} (the /system/backups surface),
 * {@link AuditModule} (append-only security audit trail + compliance posture —
 * `GET /system/audit`, `GET /system/compliance`) and {@link MetricsHistoryModule}
 * (in-app host resource-usage history — `GET /system/metrics/history`): feature
 * modules register through their parent feature module, keeping the
 * scaffolder-owned app.module.ts untouched.
 */
@Module({
  imports: [BackupsModule, AuditModule, MetricsHistoryModule],
  controllers: [SystemController],
  providers: [GpuService, HwAccelService, SettingsService, OsTuningService],
  exports: [GpuService, HwAccelService],
})
export class SystemModule {}
