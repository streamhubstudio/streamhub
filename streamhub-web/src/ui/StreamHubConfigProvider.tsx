/**
 * Bridges the StreamHub ThemeProvider into the ported Elstar design system.
 *
 * Most components theme themselves through Tailwind's `.dark` class, but a few
 * (notably <Select/>, which styles react-select via JS) read `mode` from the
 * design-system config. This provider keeps that `mode` in sync with the
 * resolved StreamHub theme so those components look right in dark mode. The
 * rest of the config is fixed to the brand (`themeColor: 'primary'`, LTR).
 */
import { useMemo, type ReactNode } from 'react'
import { useTheme } from '@/theme'
import { ConfigProvider, defaultConfig, type Config } from './ConfigProvider'

export function StreamHubConfigProvider({ children }: { children: ReactNode }) {
  const { resolved } = useTheme()
  const value = useMemo<Config>(
    () => ({ ...defaultConfig, mode: resolved }),
    [resolved],
  )
  return <ConfigProvider value={value}>{children}</ConfigProvider>
}
