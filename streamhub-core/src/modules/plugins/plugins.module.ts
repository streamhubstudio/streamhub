import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { AppPluginsRepository } from './app-plugins.repository';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginWorkerManager } from './plugin-worker.manager';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

/** DI token for cross-module consumers of the registry (optional). */
export const PLUGINS_SERVICE = Symbol('PLUGINS_SERVICE');

/**
 * Plugin/marketplace framework (module `plugins`).
 *
 * Imports AppsModule for APPS_SERVICE (app existence + appDir + id). Db/Logs/
 * Config are @Global. The catalog is auto-discovered at boot by
 * PluginRegistryService (no central file). Exports the registry + service so a
 * future consumer (e.g. a player-overlay resolver) can read the catalog.
 */
@Module({
  imports: [AppsModule],
  controllers: [PluginsController],
  providers: [
    PluginRegistryService,
    AppPluginsRepository,
    PluginWorkerManager,
    PluginsService,
    { provide: PLUGINS_SERVICE, useExisting: PluginsService },
  ],
  exports: [PluginsService, PLUGINS_SERVICE, PluginRegistryService],
})
export class PluginsModule {}
