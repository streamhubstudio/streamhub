import { join } from 'path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule } from './shared/config/config.module';
import { DbModule } from './shared/db/db.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

import { AdminModule } from './modules/admin/admin.module';
import { DbAdminModule } from './modules/db-admin/db-admin.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthzModule } from './modules/authz/authz.module';
import { QuotasModule } from './modules/quotas/quotas.module';
import { BroadcastModule } from './modules/broadcast/broadcast.module';
import { CallbacksModule } from './modules/callbacks/callbacks.module';
import { ClusterModule } from './modules/cluster/cluster.module';
import { HealthModule } from './modules/health/health.module';
import { LiveKitModule } from './modules/livekit/livekit.module';
import { LogsModule } from './modules/logs/logs.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { RecordingModule } from './modules/recording/recording.module';
import { RestreamModule } from './modules/restream/restream.module';
import { S3Module } from './modules/s3/s3.module';
import { SamplesModule } from './modules/samples/samples.module';
import { StreamsModule } from './modules/streams/streams.module';
import { SystemModule } from './modules/system/system.module';
import { TranscodingModule } from './modules/transcoding/transcoding.module';
import { WsIngestModule } from './modules/ws-ingest/ws-ingest.module';

/**
 * StreamHub-core root module.
 *
 * Shared (scaffolder-owned): ConfigModule, DbModule, LoggerModule.
 * Feature modules below are owned by their respective agents — they fill the
 * service/controller stubs WITHOUT editing this file or shared/.
 */
@Module({
  imports: [
    // Serve the built React SPA from CORE/web (rootPath). The build is copied
    // there at deploy time; a placeholder index.html lives in the repo so boot
    // never 404s. `serveStaticOptions.index` + the default wildcard fallback
    // mean any GET that is NOT an existing file and does NOT match the excluded
    // prefixes returns web/index.html — enabling React client-side routing.
    // `/api/*` (the global-prefixed API, incl. /api/v1/docs + openapi.json) and
    // `/rtc/*` are excluded so they reach their controllers / 404 normally
    // instead of being swallowed by the SPA fallback.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'web'),
      // `/hls/*` is served by a dedicated express.static middleware (wave-3 §1b,
      // registered in main.ts from DATA_DIR/apps) and must NOT be swallowed by
      // the SPA fallback.
      exclude: [
        '/api/(.*)',
        '/rtc/(.*)',
        '/hls/(.*)',
        // ESP32 WS-ingest playback (MJPEG multipart + frame.jpg) is served by a
        // dedicated express mount in main.ts (mountLiveHttp); `/live/ws` is the
        // viewer WebSocket. Keep the whole prefix off the SPA fallback.
        '/live/(.*)',
        // wave-4 §3: public sample embeds + the streamhub-adaptor SDK are served
        // by dedicated express.static mounts in main.ts; keep them off the SPA.
        '/samples/(.*)',
        '/sdk/(.*)',
        // Prometheus scrape endpoint (observability module) — mounted at the
        // root `/metrics`, must not be swallowed by the SPA fallback.
        '/metrics',
      ],
      serveStaticOptions: { index: 'index.html' },
    }),

    // pino structured logging (SPEC §15, §5 logs). pretty in dev.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
    ConfigModule,
    DbModule,
    TenancyModule,
    LogsModule,
    CallbacksModule,
    // Per-app MQTT event publishing + latency monitor (global; feeds the
    // callbacks dispatcher tap and the logs forwarder).
    MqttModule,
    // Observability (Prometheus): global MetricsService + /metrics + HTTP
    // interceptor. Imported early so its interceptor wraps every route.
    MetricsModule,

    // feature modules
    AuthModule,
    // authz + quotas run as a second global guard layer after AuthModule's auth
    // guard populates req.authCtx (wave-5). Phased: log-only until enforce=on.
    AuthzModule,
    QuotasModule,
    HealthModule,
    AppsModule,
    SamplesModule,
    AdminModule,
    LiveKitModule,
    S3Module,
    RecordingModule,
    DbAdminModule,
    BroadcastModule,
    StreamsModule,
    RestreamModule,
    SystemModule,
    TranscodingModule,
    PluginsModule,
    ClusterModule,
    // Direct WS MJPEG ingest for ESP32-CAM devices (ESP32-WS-INGEST.md F1).
    WsIngestModule,
  ],
})
export class AppModule {}
