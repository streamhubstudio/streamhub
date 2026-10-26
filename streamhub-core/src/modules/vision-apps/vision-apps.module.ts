import { forwardRef, Global, Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { EdgeModule } from '../edge/edge.module';
import { PluginsModule } from '../plugins/plugins.module';
import { TagsModule } from '../tags/tags.module';
import { VISION_EVENT_SINK } from './vision-sink.contract';
import { VisionAppController } from './vision.controller';
import { VisionAppService } from './vision.service';
import { VisionMigrationService } from './vision-migration.service';
import { VisionSinkService } from './vision.sink';
import { VisionStore } from './vision.store';

/**
 * VISION APPS Studio-App module (Edge-as-capability, 2.16.0).
 *
 * Hosts the server side of the FOUR vision model-apps (occupancy / counting /
 * crowd / demography), carved out of the old monolithic `vision` plugin:
 *   - per-(app, model) SQLite (VisionStore → `<model>.db`),
 *   - the ONE parametrized read/settings controller + service
 *     (VisionAppController/VisionAppService), mounted at
 *     `/apps/:app/plugins/:visionApp`,
 *   - the detection SINK (VisionSinkService → {@link VISION_EVENT_SINK}),
 *   - the one-shot boot migration (VisionMigrationService).
 *
 * The EDGE spawn resolver + the app-scoped edge assignments API + the reconcile
 * loop moved to `modules/edge` — edge is the cluster's processing concept, not a
 * vision concern.
 *
 * WIRING — app.module.ts is scaffolder-owned and off-limits, so this module is
 * hosted from EdgeModule's imports (a documented ADDITIVE edit; it depends on
 * edge anyway). That makes EdgeModule ↔ VisionAppsModule a module cycle, resolved
 * with forwardRef on BOTH sides — there is NO provider cycle (the edge services
 * never inject vision). @Global so the OPTIONAL {@link VISION_EVENT_SINK} tap in
 * PluginsService resolves without PluginsModule importing this module (absent
 * module → undefined injection → nothing breaks), and so PipelineService can
 * inject VisionAppService for its compute block. Imports: EdgeModule
 * (assignments repo + gateway, for read counts), TagsModule (TagsRepository),
 * PluginsModule (registry + install repo), AppsModule (APPS_SERVICE). Db/Logs/
 * Config + AppLogService are @Global.
 */
@Global()
@Module({
  imports: [forwardRef(() => EdgeModule), TagsModule, PluginsModule, AppsModule],
  controllers: [VisionAppController],
  providers: [
    VisionStore,
    VisionSinkService,
    VisionAppService,
    VisionMigrationService,
    { provide: VISION_EVENT_SINK, useExisting: VisionSinkService },
  ],
  exports: [VISION_EVENT_SINK, VisionAppService],
})
export class VisionAppsModule {}
