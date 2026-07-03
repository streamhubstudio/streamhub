import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { DbMaintenanceService } from './db-maintenance.service';
import { DbSizesService } from './db-sizes.service';

/**
 * Global DB module — DbService + DbMaintenanceService + DbSizesService
 * injectable everywhere (consumers need no import edge).
 */
@Global()
@Module({
  providers: [DbService, DbMaintenanceService, DbSizesService],
  exports: [DbService, DbMaintenanceService, DbSizesService],
})
export class DbModule {}
