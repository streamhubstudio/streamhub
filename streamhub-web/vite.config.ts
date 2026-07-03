import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Served from the domain root.
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
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
        target: 'https://streamhub.example.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
