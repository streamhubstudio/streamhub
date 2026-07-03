import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { static as expressStatic } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';
import { ConfigService } from './shared/config/config.service';
import { mountLiveHttp } from './modules/ws-ingest/live-http';
import { AUTH_VALIDATOR } from './shared/auth';
import {
  AUTH_RATE_LIMIT_PATHS,
  createAuthRateLimiter,
} from './shared/http/auth-rate-limit';

const GLOBAL_PREFIX = 'api/v1';

/**
 * Mount the live-HLS static server (wave-3 §1b).
 *
 * Public layout: `/hls/<app>/<room>/index.m3u8` (+ `.ts` segments). On-disk
 * layout: `<DATA_DIR>/apps/<app>/hls/<room>/...`, i.e. the `hls` segment sits
 * in the MIDDLE — so we rewrite the incoming URL to inject it, then serve from
 * `<DATA_DIR>/apps`. CORS is fully open; the `.m3u8` playlist is no-cache (it
 * mutates every segment) while `.ts` segments are immutable + long-cached.
 *
 * Registered via `app.use()` BEFORE `app.listen()`, so it runs ahead of the
 * Nest router / SPA ServeStatic fallback (which also excludes `/hls/*`). The
 * handler is terminal: a missing file returns 404 rather than falling through
 * to index.html.
 */
function mountHlsStatic(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  const appsRoot = join(config.dataDir, 'apps');
  const serve = expressStatic(appsRoot, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.use(
    '/hls',
    (req: Request, res: Response, next: NextFunction): void => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      // Inside this mount req.url is `/<app>/<room>/<file...>`; the on-disk
      // path is `<app>/hls/<room>/<file...>`, so inject the `hls` segment.
      const m = /^\/([^/]+)\/([^/]+)\/(.+)$/.exec(req.url);
      if (m) {
        req.url = `/${m[1]}/hls/${m[2]}/${m[3]}`;
      }
      serve(req, res, (err?: unknown) => {
        if (err) {
          next(err as Error);
          return;
        }
        // Terminal: do NOT fall through to the SPA for unknown HLS files.
        res
          .status(404)
          .json({
            data: null,
            error: { code: 'not_found', message: 'HLS resource not found' },
          });
      });
    },
  );
}

/**
 * Mount the public per-app SAMPLES static server (wave-4 §3, hardened wave-5
 * Fold-4 — sample isolation).
 *
 * Public layout: `/samples/<app>/<file>` (auth-less, embeddable). On-disk:
 * `<DATA_DIR>/apps/<app>/samples/<file>`, so the `samples` segment is injected
 * in the MIDDLE before serving from `<DATA_DIR>/apps`. Terminal: a missing file
 * returns 404 instead of falling through to the SPA.
 *
 * SECURITY: these are OUR generated templates (SamplesService renders them from
 * the in-repo `sample-templates.ts`), NOT arbitrary user uploads — so the threat
 * model is "keep the sample sandboxed" rather than "defend against hostile HTML".
 * We serve every sample DOCUMENT under a CSP `sandbox` so it stays fenced off, but
 * WITH `allow-same-origin` (integration fix): a publish-capable sample needs a
 * real origin to (a) do a same-origin `fetch()` for its public play/listen token
 * (no CORS layer exists for the API) and (b) call `getUserMedia()` — both are
 * HARD-DENIED under an opaque origin, which killed every publish sample (incl. the
 * conference). `allow-scripts` keeps the player/SDK running; `allow-forms`/`popups`
 * /`modals` are for convenience. `frame-ancestors *` keeps embeds working.
 *
 * Consequence (documented for sample authors): samples still authenticate with a
 * PUBLIC listen/embed token (minted per room, passed via the page/query) or an
 * ephemeral token — never a panel/admin credential. With `allow-same-origin` a
 * sample technically shares this origin, so an operator editing a sample must
 * treat that edit as trusted same-origin code (as they would any in-repo asset).
 *
 * The sandbox CSP is applied to HTML only; static assets (.js/.m3u8/.ts/...)
 * keep open CORS + CORP so cross-site embeds/CDNs can fetch them.
 */
function mountSamplesStatic(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  const appsRoot = join(config.dataDir, 'apps');
  const serve = expressStatic(appsRoot, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
        // Sandboxed but same-origin: `allow-same-origin` lets our generated
        // samples fetch their public play/listen token (same-origin, no CORS)
        // and call getUserMedia() — both are hard-denied under an opaque origin.
        res.setHeader(
          'Content-Security-Policy',
          "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals; frame-ancestors *",
        );
        // Cacheless HTML so a re-edited sample is picked up immediately.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=60');
      }
    },
  });
  app.use('/samples', (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    const m = /^\/([^/]+)\/([^/?#]+)/.exec(req.url);
    if (m) {
      req.url = `/${m[1]}/samples/${m[2]}`;
    }
    serve(req, res, () => {
      res.status(404).json({
        data: null,
        error: { code: 'not_found', message: 'sample not found' },
      });
    });
  });
}

/**
 * Mount the SDK static server (wave-4 §3): serves the streamhub-adaptor build at
 * `/sdk/streamhub-adaptor.global.js` (and any other SDK asset). The directory is
 * configurable via `SDK_DIR`; it defaults to `<DATA_DIR>/sdk`. The dir is
 * created if missing so the mount never crashes before the adaptor is deployed
 * (a missing file simply 404s, and the samples fall back to livekit-client).
 */
function mountSdkStatic(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  const sdkDir = config.env('SDK_DIR') || join(config.dataDir, 'sdk');
  try {
    mkdirSync(sdkDir, { recursive: true });
  } catch {
    /* non-fatal */
  }
  app.use(
    '/sdk',
    expressStatic(sdkDir, {
      index: false,
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=300');
      },
    }),
  );
}

/**
 * Fase-0 M6 — fail-closed boot assert. In production the AUTH_VALIDATOR MUST be
 * bound (the AuthModule binds it to AuthService). If it is missing, auth would be
 * disabled (the guard's dev fallback allows everything), so we refuse to start.
 * In dev/test a missing validator is tolerated so the bare skeleton can boot.
 */
function assertAuthWiredInProduction(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  if (!config.isProduction) return;
  let bound = true;
  try {
    bound = !!app.get(AUTH_VALIDATOR, { strict: false });
  } catch {
    bound = false;
  }
  if (!bound) {
    throw new Error(
      'FATAL: AUTH_VALIDATOR is not bound but NODE_ENV=production — refusing to ' +
        'start with authentication disabled. Ensure the AuthModule is loaded.',
    );
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // Use pino as the framework logger.
  app.useLogger(app.get(Logger));

  // LiveKit posts webhooks as `application/webhook+json`; register the JSON body
  // parser for that content-type too so `req.rawBody` (rawBody:true above) is
  // captured and the webhook signature validates against the exact signed bytes.
  app.useBodyParser('json', {
    type: ['application/json', 'application/webhook+json'],
  });

  const config = app.get(ConfigService);

  // Fase-0 M6 — refuse to boot in production without a real auth validator bound
  // (fail-closed). The AuthModule binds AUTH_VALIDATOR; a build that ships the
  // bare skeleton (no auth) would otherwise serve every route unauthenticated.
  assertAuthWiredInProduction(app, config);

  // Fase-0 M6 — HTTP hardening (helmet). CSP is left OFF (the SPA/Swagger/players
  // rely on inline scripts and the sample sandbox sets its own per-mount CSP);
  // CORP/COEP/COOP and X-Frame-Options are disabled so the /play + /embed players
  // stay embeddable cross-origin and HLS/SDK/sample assets keep loading. The safe
  // defaults (HSTS, nosniff, referrer-policy, hide x-powered-by, …) stay on.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      frameguard: false,
    }),
  );

  // Trust the first proxy hop (Caddy/nginx) so req.ip / the rate limiter see the
  // real client IP from X-Forwarded-For instead of 127.0.0.1.
  app.set('trust proxy', 1);

  // Fase-0 M6 — brute-force rate limiting on the SENSITIVE auth paths ONLY
  // (login / magic-link / reset). The rest of the API (incl. dashboard polling)
  // is untouched. Registered before the router so it runs ahead of the handlers.
  const authLimiter = createAuthRateLimiter();
  for (const path of AUTH_RATE_LIMIT_PATHS) app.use(path, authLimiter);

  // Live-HLS static server (wave-3 §1b). Registered before listen() so it runs
  // ahead of the SPA ServeStatic fallback. Not under the API global prefix.
  mountHlsStatic(app, config);
  // wave-4 §3: public sample embeds + the streamhub-adaptor SDK. Registered before
  // listen() so they run ahead of the SPA ServeStatic fallback.
  mountSamplesStatic(app, config);
  mountSdkStatic(app, config);
  // ESP32 WS-ingest playback (ESP32-WS-INGEST.md §4a): /live/<app>/<room>/mjpeg
  // + frame.jpg live OUTSIDE the /api/v1 prefix — same mount pattern as HLS.
  // (The /ingest/ws + /live/ws WebSocket upgrades attach via the gateway.)
  mountLiveHttp(app);

  // `metrics` is excluded from the API prefix so the Prometheus scrape endpoint
  // lives at the conventional root path `/metrics` (observability module).
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: ['metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  // OpenAPI / Swagger (SPEC §6): UI at /api/v1/docs, JSON at /api/v1/openapi.json.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('StreamHub core API')
    .setDescription('Management layer over LiveKit (AntMedia-style). SPEC §6.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${GLOBAL_PREFIX}/docs`, app, document, {
    jsonDocumentUrl: `${GLOBAL_PREFIX}/openapi.json`,
  });
  // Also emit a static copy on boot for tooling/CI if writable.
  try {
    writeFileSync('openapi.json', JSON.stringify(document, null, 2));
  } catch {
    /* non-fatal */
  }

  await app.listen(config.port, config.host);
  app
    .get(Logger)
    .log(
      `streamhub-core listening on http://${config.host}:${config.port}/${GLOBAL_PREFIX}`,
    );
}

void bootstrap();
