/**
 * Playwright config for the streamhub-web BEHAVIORAL e2e suite.
 *
 * These specs drive the real dashboard SPA served by a locally-booted
 * streamhub-core (NOT the vite dev server). They assert real behaviour —
 * persisted state, network responses — not just visibility.
 *
 * HOW TO RUN (the core must be booted first — the COMPLETE recipe):
 *   1. cd streamhub-core && npm run build
 *   2. cd streamhub-web && npm run build && rm -rf ../streamhub-core/web && \
 *        cp -R dist ../streamhub-core/web
 *   3. boot the core on :3216 (every var below is REQUIRED — login 401s
 *      without the JWT secret; token minting fails without LiveKit creds):
 *        PORT=3216 HOST=127.0.0.1 DATA_DIR=<scratch-dir> \
 *        STREAMHUB_JWT_SECRET=devsecretdevsecretdevsecret \
 *        ADMIN_USER=admin ADMIN_PASS=admin123 \
 *        LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey \
 *        LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdev \
 *        REDIS_URL=redis://127.0.0.1:6399 NODE_ENV=production \
 *        STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on \
 *        node dist/main.js
 *   4. seed the global token the 07-tokens spec revokes:
 *        cd streamhub-core && NODE_PATH=$PWD/node_modules DATA_DIR=<scratch-dir> \
 *          node ../deploy/seed-token.js sk_e2e_disposable_xxxxxxxxxxxx e2e-disposable
 *   5. cd streamhub-web && npm run test:e2e
 *   6. kill the core and delete the scratch dir.
 *
 * Point at a different origin with E2E_BASE_URL. Redis/LiveKit SERVICES are
 * optional (the env vars above are not): flows that need them live (streams,
 * meeting, regular ingress) are skipped.
 */
import { defineConfig, devices } from '@playwright/test'

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3216'

export default defineConfig({
  testDir: './e2e',
  // Keep node --test / vitest from ever colliding: e2e specs use the `.e2e.ts`
  // suffix and live outside src/, which both other runners are scoped to.
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Authenticated storage state produced by global-setup (admin break-glass
    // login). The login spec opts OUT of this to drive the real form.
    storageState: 'e2e/.auth/state.json',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
