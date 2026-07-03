import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { SystemModule } from '../system/system.module';
import { TranscodingController } from './transcoding.controller';
import { TranscodingService } from './transcoding.service';

/**
 * Transcoding/adaptive config module. Imports AppsModule to read/write per-app
 * config via APPS_SERVICE (LOGS_SERVICE is global) and SystemModule for the
 * per-app GPU hwaccel preference (HwAccelService). Exports TranscodingService
 * so the livekit/auth modules can apply ingress transcoding + token simulcast.
 */
@Module({
  imports: [AppsModule, SystemModule],
  controllers: [TranscodingController],
  providers: [TranscodingService],
  exports: [TranscodingService],
})
export class TranscodingModule {}
