import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { MediamtxHookController } from './mediamtx-hook.controller';
import { PassthroughRtmpServer } from './passthrough.rtmp-server';
import { PassthroughService } from './passthrough.service';
import { RemuxManager } from './remux.manager';

/**
 * RTMP→HLS passthrough (remux, no transcode) — the AntMedia-style cheap ingest
 * plane (features/rtmp-passthrough.md). Additive + independent: it never touches
 * LiveKit's :1935 ingress or the transcode/WebRTC/egress path.
 *
 * Pieces:
 *  - {@link RemuxManager}         spawns/supervises `ffmpeg -c copy` per ingress.
 *  - {@link PassthroughService}   auth gate (prePublish key check) + orchestration
 *    (create/arm/remove/list) — resolved lazily by LiveKitController via ModuleRef.
 *  - {@link PassthroughRtmpServer} env-gated OnApplicationBootstrap/Shutdown front
 *    (OFF by default); re-arms persisted ingresses on boot.
 *  - {@link MediamtxHookController} loopback-only auth/ready/notready sink for the
 *    single-port :1935 switch (features/rtmp-single-port.md).
 *
 * Imports: LiveKitModule (IngressAuthService key store), AppsModule (APPS_SERVICE
 * for boot re-arm). LogsModule is global. No hard dependency the other way —
 * LiveKitController resolves PassthroughService via ModuleRef, so LiveKitModule
 * never imports this module (no DI cycle).
 */
@Module({
  imports: [LiveKitModule, AppsModule],
  controllers: [MediamtxHookController],
  providers: [RemuxManager, PassthroughService, PassthroughRtmpServer],
  exports: [PassthroughService, RemuxManager],
})
export class PassthroughModule {}
