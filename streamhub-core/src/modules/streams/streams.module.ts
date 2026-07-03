import { Module } from '@nestjs/common';
import { STREAMS_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { S3Module } from '../s3/s3.module';
import { HlsController } from './hls.controller';
import { HlsService } from './hls.service';
import { StreamsController } from './streams.controller';
import { StreamsService } from './streams.service';

/**
 * Streams module. Exports STREAMS_SERVICE.
 *
 * Imports AppsModule + S3Module so StreamsService can resolve app config and
 * upload snapshots (both injected @Optional, so the module still boots if those
 * providers are unavailable). LiveKitModule is imported for the live HLS egress
 * (wave-3 §1b). DbService/ConfigService and Callbacks/Logs are global.
 */
@Module({
  imports: [AppsModule, S3Module, LiveKitModule],
  controllers: [StreamsController, HlsController],
  providers: [
    StreamsService,
    HlsService,
    { provide: STREAMS_SERVICE, useExisting: StreamsService },
  ],
  exports: [StreamsService, STREAMS_SERVICE],
})
export class StreamsModule {}
