import { Module } from '@nestjs/common';
import { APPS_SERVICE } from '../../shared/contracts';
import { S3Module } from '../s3/s3.module';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';

/**
 * Apps module. Exports APPS_SERVICE for cross-module consumers.
 *
 * Imports S3Module so AppsService can re-initialize the per-app S3 client on a
 * config hot-reload (wave-4 §1/§2) and resolve credentials via SecretsStore.
 * SamplesService is resolved lazily via ModuleRef (no import edge) to keep the
 * apps↔samples graph acyclic.
 */
@Module({
  imports: [S3Module],
  controllers: [AppsController],
  providers: [AppsService, { provide: APPS_SERVICE, useExisting: AppsService }],
  exports: [AppsService, APPS_SERVICE],
})
export class AppsModule {}
