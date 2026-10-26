#!/usr/bin/env node
/**
 * Offline OpenAPI (Swagger) spec exporter.
 *
 * Boots the NestJS app graph in **preview mode** (`NestFactory.create(AppModule,
 * { preview: true })`) so the SwaggerModule can walk every controller/route/DTO
 * WITHOUT instantiating providers. That is what makes this run **offline**: in
 * preview mode the BullMQ queues, ioredis clients and LiveKit clients are never
 * constructed, so no Redis/network connection is attempted and the process exits
 * cleanly. It mirrors the `DocumentBuilder` config in `src/main.ts` and the
 * `api/v1` global prefix, then writes the snapshot to
 * `streamhub-docs/api/openapi.json`.
 *
 * Runs against the COMPILED output, same convention as `scripts/mqtt-proof.js`:
 *
 *   cd streamhub-core && npm run build && node scripts/export-openapi.js
 *   # or simply: npm run export:openapi   (builds first)
 *
 * Test-style env is set BEFORE the app module is required (mirrors
 * test/helpers/env.ts) so config parsing never needs real secrets/creds. Exits 0
 * on success, 1 on failure.
 */
'use strict';

// --- test-style env, applied before anything reads process.env ---------------
// (mirrors streamhub-core/test/helpers/env.ts — dummy secret, log-only authz,
// empty LiveKit creds; harmless in preview mode but keeps config parsing happy).
function def(key, value) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}
def('NODE_ENV', 'production'); // silences the pino-pretty transport at module load
def('LOG_LEVEL', 'silent');
def('STREAMHUB_JWT_SECRET', 'export-openapi-dummy-secret');
def('STREAMHUB_AUTHZ_ENFORCE', 'log');
def('ADMIN_USER', '');
def('ADMIN_PASS', '');
def('LIVEKIT_URL', 'ws://127.0.0.1:7880');
def('LIVEKIT_API_KEY', '');
def('LIVEKIT_API_SECRET', '');
def('PUBLIC_WS_URL', '');
def('REDIS_URL', 'redis://127.0.0.1:6379');

require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { NestFactory } = require('@nestjs/core');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');
const { AppModule } = require('../dist/app.module');

const GLOBAL_PREFIX = 'api/v1';
const OUT_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'streamhub-docs',
  'api',
  'openapi.json',
);

async function main() {
  // preview:true → build the module graph WITHOUT instantiating providers, so
  // no Redis/BullMQ/LiveKit client is ever constructed (fully offline).
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: ['metrics'] });

  const config = new DocumentBuilder()
    .setTitle('StreamHub core API')
    .setDescription(
      'Management layer over LiveKit (AntMedia-style). REST API under /api/v1. ' +
        'Every response is a {data,error} envelope. SPEC §6.',
    )
    .setVersion(require('../package.json').version)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'sk_ / clt_ token' },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`);

  const pathCount = Object.keys(document.paths || {}).length;
  const schemaCount = Object.keys(
    (document.components && document.components.schemas) || {},
  ).length;
  // eslint-disable-next-line no-console
  console.log(
    `openapi.json written: ${OUT_FILE}\n  paths: ${pathCount}, schemas: ${schemaCount}, openapi: ${document.openapi}`,
  );

  await app.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error('export-openapi failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
