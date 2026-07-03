import { Module } from '@nestjs/common';
import { RecordingModule } from '../recording/recording.module';
import { DbAdminController } from './db-admin.controller';

/**
 * SQLite health / maintenance surface (health, optimize, purge) for the per-app
 * and global DBs. DbMaintenanceService is provided globally by DbModule; this
 * module only imports RecordingModule so the purge can reuse the VOD cascade
 * (RecordingService.deleteVod → row + S3 + local).
 */
@Module({
  imports: [RecordingModule],
  controllers: [DbAdminController],
})
export class DbAdminModule {}
