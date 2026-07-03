import { Module } from '@nestjs/common';

import { RESTREAM_SERVICE } from '../../shared/contracts';
import { LiveKitModule } from '../livekit/livekit.module';
import { StreamsModule } from '../streams/streams.module';
import { RestreamController } from './restream.controller';
import { RestreamRepository } from './restream.repository';
import { RestreamService } from './restream.service';

/**
 * Restream module: multi-destination RTMP forwarding of a live stream
 * (AntMedia "endpoints"). Imports LiveKit (LIVEKIT_SERVICE) for the stream
 * egresses and Streams (STREAMS_SERVICE) to resolve stream → room; Callbacks/
 * Logs/Quotas/Db are global. Exports RESTREAM_SERVICE so the livekit webhook
 * sink can advance per-endpoint state on egress events.
 */
@Module({
  imports: [LiveKitModule, StreamsModule],
  controllers: [RestreamController],
  providers: [
    RestreamService,
    RestreamRepository,
    { provide: RESTREAM_SERVICE, useExisting: RestreamService },
  ],
  exports: [RestreamService, RESTREAM_SERVICE],
})
export class RestreamModule {}
