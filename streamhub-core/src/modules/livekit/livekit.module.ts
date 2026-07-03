import { Module } from '@nestjs/common';
import { LIVEKIT_SERVICE } from '../../shared/contracts';
import { SystemModule } from '../system/system.module';
import { LiveKitController } from './livekit.controller';
import { LiveKitService } from './livekit.service';
import { IngressAuthService } from './ingress-auth.service';
import { WebhooksController } from './webhooks.controller';

/**
 * LiveKit integration module. Exports LIVEKIT_SERVICE.
 *
 * Cross-module services (apps/streams/recording/callbacks/logs) are resolved
 * lazily via ModuleRef inside the controllers, so this module imports none of
 * them — keeping the dependency graph acyclic. SystemModule is imported so
 * LiveKitService can inject HwAccelService for GPU-accelerated ingress/egress
 * (SPEC §5 transcoding); SystemModule depends only on global providers, so no
 * cycle is introduced.
 */
@Module({
  imports: [SystemModule],
  controllers: [LiveKitController, WebhooksController],
  providers: [
    LiveKitService,
    IngressAuthService,
    { provide: LIVEKIT_SERVICE, useExisting: LiveKitService },
  ],
  exports: [LiveKitService, IngressAuthService, LIVEKIT_SERVICE],
})
export class LiveKitModule {}
