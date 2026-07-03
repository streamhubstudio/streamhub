import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import '@livekit/components-styles'
// Self-hosted Inter (variable) — the brand font. Importing here guarantees it
// actually loads (bundled by Vite) instead of falling back to the system UI
// font. Kept in sync with --font-sans in index.css.
import '@fontsource-variable/inter'
import './index.css'
import '@/i18n' // initialise i18next synchronously before first render (no raw-key flash)
import App from './App.tsx'
import { AuthProvider } from '@/auth/AuthContext'
import { queryClient } from '@/lib/queryClient'
import { ThemeProvider } from '@/theme'
import { StreamHubConfigProvider } from '@/ui/StreamHubConfigProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <StreamHubConfigProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </StreamHubConfigProvider>
    </ThemeProvider>
  </StrictMode>,
)
