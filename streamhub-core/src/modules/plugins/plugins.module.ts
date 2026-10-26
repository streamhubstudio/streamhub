import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { StreamPluginsModule } from '../streams/stream-plugins.module';
import { AppPluginsRepository } from './app-plugins.repository';
import { AppstoreController } from './appstore/appstore.controller';
import { AppstoreService } from './appstore/appstore.service';
import { PluginVersionHistoryRepository } from './appstore/plugin-version-history.repository';
import { PluginVersionService } from './appstore/plugin-version.service';
import { GridAgentController } from './grid-agent.controller';
import { GridAgentService } from './grid-agent.service';
import { PluginGridService } from './plugin-grid.service';
import { PluginLiveDataService } from './plugin-livedata.service';
import { PluginExportService } from './plugin-export.service';
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
  imports: [AppsModule, StreamPluginsModule],
  controllers: [PluginsController, GridAgentController, AppstoreController],
  providers: [
    PluginRegistryService,
    AppPluginsRepository,
    PluginGridService,
    PluginWorkerManager,
    PluginLiveDataService,
    PluginsService,
    PluginExportService,
    GridAgentService,
    // Appstore (immutable per-app-version store + pin/rollback).
    AppstoreService,
    PluginVersionHistoryRepository,
    PluginVersionService,
    { provide: PLUGINS_SERVICE, useExisting: PluginsService },
  ],
  // AppPluginsRepository is exported so plugin BACKENDS (e.g. the
  // transcription module) can read their own install state + RAW config
  // (incl. secrets) without a redacting service in between. AppstoreService is
  // exported so the edge GenericSpawnResolver can attach the bundle ref to an
  // assign frame for a pinned install.
  exports: [
    PluginsService,
    PLUGINS_SERVICE,
    PluginRegistryService,
    AppPluginsRepository,
    AppstoreService,
    PluginVersionService,
  ],
})
export class PluginsModule {}
