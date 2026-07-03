import { createContext, useContext } from 'react'
import { SIZES } from '../utils/constants'
import type { TypeAttributes, ColorLevel } from '../@types/common'

export type Config = {
    themeColor: string
    mode: 'light' | 'dark'
    locale: string
    primaryColorLevel: ColorLevel
    cardBordered: boolean
    controlSize: TypeAttributes.ControlSize
    navMode: TypeAttributes.MenuVariant
    direction: TypeAttributes.Direction
}

// StreamHub re-skin defaults. `themeColor: 'primary'` maps to the StreamHub
// brand blue scale defined in src/index.css (@theme). Components that build
// dynamic classes like `bg-${themeColor}-${level}` therefore resolve to
// `bg-primary-500` (brand #2f7bff). Kept fixed — we do NOT expose the Elstar
// theme switcher; brand is constant. `mode` is synced from ThemeProvider.
export const defaultConfig = {
    themeColor: 'primary',
    direction: 'ltr',
    mode: 'light',
    locale: 'en',
    primaryColorLevel: 500,
    cardBordered: true,
    controlSize: SIZES.MD,
    navMode: 'transparent',
} as const

export const ConfigContext = createContext<Config>(defaultConfig)

const ConfigProvider = ConfigContext.Provider

export const ConfigConsumer = ConfigContext.Consumer

export function useConfig() {
    return useContext(ConfigContext)
}

export default ConfigProvider
