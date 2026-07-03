import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { BroadcastController } from './broadcast.controller';
import { BroadcastService } from './broadcast.service';

/**
 * Broadcast module: RTMP stream egress (forward a LiveKit room to an external
 * RTMP target). Imports LiveKit (LIVEKIT_SERVICE) + Apps (APPS_SERVICE) to
 * consume their contracts; Logs is global.
 */
@Module({
  imports: [LiveKitModule, AppsModule],
  controllers: [BroadcastController],
  providers: [BroadcastService],
})
export class BroadcastModule {}
