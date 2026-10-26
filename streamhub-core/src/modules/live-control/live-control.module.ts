import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { CallbacksModule } from '../callbacks/callbacks.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { PluginsModule } from '../plugins/plugins.module';
import { S3Module } from '../s3/s3.module';
import { StreamsModule } from '../streams/streams.module';
import { LiveControlController } from './live-control.controller';
import { LiveControlService } from './live-control.service';
import { LiveControlStore } from './live-control.store';

/**
 * Live Control module — pause/resume/finish an already-live stream for the
 * `live-control` (console) + `live-control-overlay` (cover) plugins. Hosts the
 * per-app state machine + `live-control.db` (LiveControlStore) + S3 cover-asset
 * management, exposed at /apps/:app/plugins/live-control.
 *
 * Imports:
 *  - AppsModule      → APPS_SERVICE (appDir + resolved S3 config).
 *  - StreamsModule   → STREAMS_SERVICE (live stream list + room resolution).
 *  - PluginsModule   → AppPluginsRepository (per-app plugin config = defaults).
 *  - S3Module        → S3Service (uploadBuffer / presignGet / delete of assets).
 *  - LiveKitModule   → LiveKitService (server-side audio mute + data push).
 *  - CallbacksModule → CALLBACKS_SERVICE (livecontrol.* funnel events).
 * Db/Logs/Config are @Global.
 */
@Module({
  imports: [
    AppsModule,
    StreamsModule,
    PluginsModule,
    S3Module,
    LiveKitModule,
    CallbacksModule,
  ],
  controllers: [LiveControlController],
  providers: [LiveControlStore, LiveControlService],
  exports: [LiveControlService],
})
export class LiveControlModule {}
