import { Module } from '@nestjs/common';
import { SAMPLES_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import { SamplesController } from './samples.controller';
import { SamplesService } from './samples.service';

/**
 * Samples module (wave-4 §3). Imports AppsModule for app dir/config lookups.
 * AppsService resolves SamplesService lazily via ModuleRef (no reverse import),
 * so the apps↔samples graph stays acyclic. Exports SAMPLES_SERVICE.
 */
@Module({
  imports: [AppsModule],
  controllers: [SamplesController],
  providers: [
    SamplesService,
    { provide: SAMPLES_SERVICE, useExisting: SamplesService },
  ],
  exports: [SamplesService, SAMPLES_SERVICE],
})
export class SamplesModule {}
