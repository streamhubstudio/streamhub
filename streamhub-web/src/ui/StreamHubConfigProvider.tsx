/**
 * Brand config for the ported Elstar design system. The dashboard is dark
 * only, so this is static: `mode: 'dark'` (read by <Select/>, which styles
 * react-select via JS), `themeColor: 'primary'`, LTR.
 */
import type { ReactNode } from 'react'
import { ConfigProvider, defaultConfig } from './ConfigProvider'

export function StreamHubConfigProvider({ children }: { children: ReactNode }) {
  return <ConfigProvider value={defaultConfig}>{children}</ConfigProvider>
}
