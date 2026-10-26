import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { PluginsModule } from '../plugins/plugins.module';
import { SystemModule } from '../system/system.module';
import { PassthroughModule } from '../passthrough/passthrough.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

/**
 * Pipeline module — `GET /apps/:app/pipeline` (resolved media-flow topology).
 *
 * Imports AppsModule (resolved config.yaml + appDir), SystemModule (per-app
 * hwaccel preference + GPU detection → effective encoder), PluginsModule
 * (AppPluginsRepository + PluginRegistryService → the app's installed plugins
 * with their meta) and PassthroughModule (the remux/`-c copy` plane). Vision,
 * Notifier and NetMetrics are @Global providers (injected without an import);
 * Db/Config are @Global too. Restream is read straight from the app db (via
 * DbService) to dodge the RestreamModule → StreamsModule → PipelineModule cycle.
 *
 * Registered through StreamsModule (its live `streams` table feeds every
 * `active` hint) — feature modules enter the app graph via their parent
 * feature module so the scaffolder-owned app.module.ts stays untouched.
 */
@Module({
  imports: [AppsModule, SystemModule, PluginsModule, PassthroughModule],
  controllers: [PipelineController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
