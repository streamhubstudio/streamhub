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
import { FleetModule } from './modules/fleet/fleet.module';
import { HealthModule } from './modules/health/health.module';
import { LiveControlModule } from './modules/live-control/live-control.module';
import { LiveKitModule } from './modules/livekit/livekit.module';
import { LogsModule } from './modules/logs/logs.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { PassthroughModule } from './modules/passthrough/passthrough.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { RecordingModule } from './modules/recording/recording.module';
import { RestreamModule } from './modules/restream/restream.module';
import { S3Module } from './modules/s3/s3.module';
import { ScheduledLiveModule } from './modules/scheduled-live/scheduled-live.module';
import { SamplesModule } from './modules/samples/samples.module';
import { SecurityModule } from './modules/security/security.module';
import { StreamsModule } from './modules/streams/streams.module';
import { SystemModule } from './modules/system/system.module';
import { TranscodingModule } from './modules/transcoding/transcoding.module';
import { WsIngestModule } from './modules/ws-ingest/ws-ingest.module';
import { EdgeModule } from './modules/edge/edge.module';
import { NetMetricsModule } from './modules/net-metrics/net-metrics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StreamflowModule } from './modules/streamflow/streamflow.module';
import { StreamHealthModule } from './modules/stream-health/stream-health.module';
import { IotModule } from './modules/iot/iot.module';

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
      // NestJS 11 / Express 5 use path-to-regexp v8, where the old `(.*)`
      // capture is invalid syntax (it throws "Unexpected ( at index 5" per
      // request that reaches the SPA fallback). The v8 spelling of "this prefix
      // and everything under it" is a named wildcard `*splat`.
      exclude: [
        '/api/*splat',
        '/rtc/*splat',
        '/hls/*splat',
        // ESP32 WS-ingest playback (MJPEG multipart + frame.jpg) is served by a
        // dedicated express mount in main.ts (mountLiveHttp); `/live/ws` is the
        // viewer WebSocket. Keep the whole prefix off the SPA fallback.
        '/live/*splat',
        // wave-4 §3: public sample embeds + the streamhub-adaptor SDK are served
        // by dedicated express.static mounts in main.ts; keep them off the SPA.
        '/samples/*splat',
        '/sdk/*splat',
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
    // Network security (IP allow/blocklist + auto-ban). Its middleware runs
    // ahead of every guard/handler; imported before AuthModule so offense
    // recording is available to the auth failure sites.
    SecurityModule,
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
    ScheduledLiveModule,
    SystemModule,
    TranscodingModule,
    PluginsModule,
    // Agent fleet management over MQTT (the `fleet` plugin's in-core subscriber
    // + command publisher + per-app fleet.db). Imported after PluginsModule so
    // it can read the fleet plugin install state. See features/fleet.md.
    FleetModule,
    // Live Control: pause/resume/finish an already-live stream (the
    // `live-control` console + `live-control-overlay` cover plugins). Imported
    // after PluginsModule so it can read the plugin config for per-app defaults.
    // See https://streamhub.studio/docs/features/live-control.
    LiveControlModule,
    ClusterModule,
    // Direct WS MJPEG ingest for ESP32-CAM devices (ESP32-WS-INGEST.md F1).
    WsIngestModule,
    // RTMP→HLS passthrough (remux, no transcode) — env-gated OFF by default,
    // independent of LiveKit's :1935 ingress (features/rtmp-passthrough.md).
    PassthroughModule,
    // Vision Edge cluster: outbound-WS edge channel + scheduler + watchdog
    // (features/vision-edge). Notifier fan-out (callback/MQTT/email/Discord/
    // Telegram) is @Global; per-app network I/O accounting is @Global too so
    // the LiveKit webhook byte tap resolves its token lazily.
    EdgeModule,
    NotificationsModule,
    NetMetricsModule,
    // Streamflow: n8n-style event workflow engine (Studio App, in-core, no worker).
    StreamflowModule,
    // Stream-health Studio App: per-app health history + per-room thresholds
    // (the worker probes the origin HLS; see features/stream-health.md).
    StreamHealthModule,
    // IoT data plane: per-app MQTT-in subscriber (mqtt.subscribe) feeding
    // dispatch(app,'iot.data') — the same funnel the ws-ingest data frame uses.
    IotModule,
  ],
})
export class AppModule {}
