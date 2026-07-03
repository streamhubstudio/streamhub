import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { StreamsModule } from '../streams/streams.module';
import { FrameHub } from './frame-hub';
import { LiveHttpService } from './live-http';
import { WsIngestGateway } from './ws-ingest.gateway';
import { WsIngestMetrics } from './ws-ingest.metrics';
import { WsIngestService } from './ws-ingest.service';
import { WsKeysController } from './ws-keys.controller';

/**
 * Direct WebSocket MJPEG ingest for ESP32-CAM class devices
 * (streamhub-docs/integrations/ESP32-WS-INGEST.md — F1).
 *
 * Pieces:
 *  - {@link WsIngestGateway}   `wss://…/ingest/ws` (cameras) + `/live/ws`
 *    (viewers) hung off the core HTTP server (upgrade event).
 *  - {@link WsIngestService}   handshake auth (wsk_ keys via ingress_auth),
 *    quota/feature gates, protocol limits, stream registration.
 *  - {@link FrameHub}          in-memory last-frame store + per-viewer fan-out.
 *  - {@link LiveHttpService}   `/live/<app>/<room>/mjpeg` + `frame.jpg`
 *    (mounted from main.ts via `mountLiveHttp`, outside the API prefix).
 *  - {@link WsKeysController}  provisioning REST under /apps/:app/ws-ingest.
 *
 * Imports: LiveKitModule (IngressAuthService key store), StreamsModule
 * (STREAMS_SERVICE registration), AppsModule (APPS_SERVICE config). Quotas /
 * Callbacks / Metrics are global modules.
 */
@Module({
  imports: [LiveKitModule, StreamsModule, AppsModule],
  controllers: [WsKeysController],
  providers: [FrameHub, WsIngestMetrics, WsIngestService, WsIngestGateway, LiveHttpService],
  exports: [WsIngestService, LiveHttpService, FrameHub],
})
export class WsIngestModule {}
