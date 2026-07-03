import { createContext } from 'react'
import type { ResolvedTheme, ThemeMode } from './apply'

export interface ThemeContextValue {
  /** The user's stored preference: 'light' | 'dark' | 'system'. */
  mode: ThemeMode
  /** The concrete theme currently applied to <html>. */
  resolved: ResolvedTheme
  /** Set an explicit preference (persisted). */
  setMode: (mode: ThemeMode) => void
  /** Flip between light and dark (persists the concrete choice). */
  toggle: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)
