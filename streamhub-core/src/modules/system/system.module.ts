import { Module } from '@nestjs/common';

import { GpuService } from './gpu.service';
import { HwAccelService } from './hwaccel.service';
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
 */
@Module({
  controllers: [SystemController],
  providers: [GpuService, HwAccelService, SettingsService],
  exports: [GpuService, HwAccelService],
})
export class SystemModule {}
