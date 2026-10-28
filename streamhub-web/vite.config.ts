import { fileURLToPath, URL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig, version as viteVersion } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Build stamp of THIS SPA bundle, shown in the About / Build panel next to the
 * core's own (GET /system/build). Injected as the `__SH_WEB_BUILD__` constant.
 *  - version: repo-root VERSION (or /VERSION inside the Docker build stage)
 *  - commit:  $STREAMHUB_GIT_COMMIT (Docker / bundle builds), else `git rev-parse`
 *  - toolchain: the Node and Vite that produced the bundle, + the React it ships
 */
function readFirstLine(paths: string[]): string {
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8').split('\n')[0].trim()
    } catch {
      /* next */
    }
  }
  return ''
}

function gitCommit(): string {
  if (process.env.STREAMHUB_GIT_COMMIT) return process.env.STREAMHUB_GIT_COMMIT.trim()
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

function webBuild() {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
  const react = JSON.parse(readFileSync(here('./node_modules/react/package.json'), 'utf8')) as {
    version: string
  }
  return {
    version: readFirstLine([here('../VERSION'), '/VERSION']),
    commit: gitCommit(),
    builtAt: new Date().toISOString(),
    node: process.version,
    vite: viteVersion,
    react: react.version,
  }
}

// Served from the domain root.
export default defineConfig(({ command }) => ({
  base: '/',
  plugins: [react(), tailwindcss()],
  define: {
    __SH_WEB_BUILD__: JSON.stringify(command === 'build' ? webBuild() : { ...webBuild(), commit: 'dev' }),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // Dev convenience: proxy API calls to the live core so localhost can talk to it.
      '/api': {
        target: 'https://streamhub.digitalhub.com.ar',
        changeOrigin: true,
        secure: true,
      },
    },
  },
}))
