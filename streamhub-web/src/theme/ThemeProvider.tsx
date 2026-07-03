import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeContext } from './context'
import {
  applyTheme,
  getStoredMode,
  resolveTheme,
  storeMode,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemeMode,
} from './apply'

/**
 * Provides theme state to the app. On mount it respects the persisted choice
 * (falling back to prefers-color-scheme) and keeps <html> in sync. The initial
 * paint is already correct thanks to the inline script in index.html, so this
 * never causes a flash.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(getStoredMode()),
  )

  const setMode = useCallback((next: ThemeMode) => {
    storeMode(next)
    setModeState(next)
  }, [])

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode = resolveTheme(prev) === 'dark' ? 'light' : 'dark'
      storeMode(next)
      return next
    })
  }, [])

  // Apply whenever the preference changes.
  useEffect(() => {
    const next = resolveTheme(mode)
    setResolved(next)
    applyTheme(next)
  }, [mode])

  // While in 'system', follow live OS changes.
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const next: ResolvedTheme = systemPrefersDark() ? 'dark' : 'light'
      setResolved(next)
      applyTheme(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  const value = useMemo(
    () => ({ mode, resolved, setMode, toggle }),
    [mode, resolved, setMode, toggle],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}
