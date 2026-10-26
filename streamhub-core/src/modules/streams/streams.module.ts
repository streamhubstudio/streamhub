import { Module } from '@nestjs/common';
import { STREAMS_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { S3Module } from '../s3/s3.module';
import { HlsController } from './hls.controller';
import { HlsService } from './hls.service';
import { HlsWatchdogService } from './hls-watchdog.service';
import { StreamPluginsModule } from './stream-plugins.module';
import { StreamsController } from './streams.controller';
import { StreamsService } from './streams.service';
import { TagsModule } from '../tags/tags.module';

/**
 * Streams module. Exports STREAMS_SERVICE.
 *
 * Imports AppsModule + S3Module so StreamsService can resolve app config and
 * upload snapshots (both injected @Optional, so the module still boots if those
 * providers are unavailable). LiveKitModule is imported for the live HLS egress
 * (wave-3 §1b). DbService/ConfigService and Callbacks/Logs are global.
 *
 * Hosts PipelineModule (`GET /apps/:app/pipeline`, feature `pipeline`): the
 * pipeline's live hints read this module's `streams` table, and registering it
 * here keeps the scaffolder-owned app.module.ts untouched (same pattern as
 * BackupsModule under SystemModule).
 *
 * Also hosts TagsModule (`/apps/:app/tags` + `/apps/:app/streams/:id/tags`,
 * Vision-Edge §E) for the same reason: dynamic stream tags are a streams-side
 * concern and registering the module here avoids touching app.module.ts.
 */
@Module({
  imports: [
    AppsModule,
    S3Module,
    LiveKitModule,
    PipelineModule,
    StreamPluginsModule,
    TagsModule,
  ],
  controllers: [StreamsController, HlsController],
  providers: [
    StreamsService,
    HlsService,
    // Auto-HLS watchdog + DVR janitor for 24/7 linear channels (QW-2/QW-4).
    HlsWatchdogService,
    { provide: STREAMS_SERVICE, useExisting: StreamsService },
  ],
  exports: [StreamsService, STREAMS_SERVICE],
})
export class StreamsModule {}
