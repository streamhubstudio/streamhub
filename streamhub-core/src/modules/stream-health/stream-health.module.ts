import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { PluginsModule } from '../plugins/plugins.module';
import { StreamHealthController } from './stream-health.controller';
import { StreamHealthService } from './stream-health.service';
import { StreamHealthStore } from './stream-health.store';

/**
 * STREAM-HEALTH Studio App module.
 *
 * Server side of the `stream-health` plugin (src/plugins/stream-health):
 *   - per-app SQLite (StreamHealthStore → stream-health.db: bounded
 *     health-event history + per-room threshold overrides),
 *   - the funnel-tap SINK (StreamHealthService.onModuleInit subscribes to
 *     CallbacksService.onDispatch — @Global — and records every `health.*`
 *     dispatch; same pattern as Streamflow's trigger tap),
 *   - the read/settings controller at `/apps/:app/plugins/stream-health`.
 *
 * Imports: AppsModule (APPS_SERVICE → appDir), PluginsModule
 * (AppPluginsRepository → the install's app-level thresholds for the
 * resolved view). Callbacks/Db/Logs/Config are @Global.
 */
@Module({
  imports: [AppsModule, PluginsModule],
  controllers: [StreamHealthController],
  providers: [StreamHealthStore, StreamHealthService],
  exports: [StreamHealthService],
})
export class StreamHealthModule {}
