import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Component/DOM tests (jsdom + @testing-library/react). Complements the fast
// `node --test` logic suite: this one actually mounts React components and
// exercises their DOM behaviour (events, controlled state) — the layer where
// wiring bugs like the controlled-Switcher regression live and where the
// logic-only suite was blind.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Vidstack ships a separate SSR ("node") build that pulls its server-only
    // internals; force the browser/client build so <MediaPlayer> mounts under
    // jsdom exactly as it does in a real browser.
    conditions: ['browser', 'development', 'import', 'default'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // Transform Vidstack (+ its peers) instead of externalizing them, so the
    // browser export condition above wins over Node's SSR resolution.
    server: {
      deps: {
        inline: [/@vidstack\/react/, /^vidstack/, /maverick\.js/],
      },
    },
  },
})
