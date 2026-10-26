import { Module } from '@nestjs/common';

import { BackupsController } from './backups.controller';
import { BackupsScheduler } from './backups.scheduler';
import { BackupsService } from './backups.service';

/**
 * Backups module — versioned + compressed snapshots of every StreamHub SQLite
 * DB (global data/streamhub.db + each apps/<app>/app.db) with 7-day retention
 * and a guarded restore path:
 *
 *  - {@link BackupsService}   — VACUUM INTO + gzip snapshots, retention prune,
 *                               integrity-checked atomic restore,
 *  - {@link BackupsScheduler} — daily BullMQ repeatable job (+ boot catch-up),
 *  - {@link BackupsController} — superadmin API under /system/backups.
 *
 * Registered as an import of SystemModule (the /system/* surface it extends),
 * so app.module.ts / main.ts / shared stay untouched. Depends only on the
 * @Global shared providers (Config, Db, Logs). Docs:
 * https://streamhub.studio/docs/operations/BACKUPS.
 */
@Module({
  controllers: [BackupsController],
  providers: [BackupsService, BackupsScheduler],
  exports: [BackupsService],
})
export class BackupsModule {}
