/**
 * Cockpit — localStorage-backed persistence hooks.
 *
 * Keeps the drag-drop order + the live grid tweaks (grid size / auto-play /
 * labels) sticky per app, WITHOUT needing the (optional) plugins backend. Pure
 * reducing logic lives in grid.ts; this file only wires it to `window`.
 *
 * All access is guarded so SSR / private-mode / disabled-storage never throws.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type CockpitSettings,
} from './grid.ts'

const NS = 'streamhub.cockpit'
const SELECTED_APP_KEY = `${NS}.selectedApp`
const settingsKey = (app: string) => `${NS}.settings.${app}`
const orderKey = (app: string) => `${NS}.order.${app}`

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — settings simply don't persist */
  }
}

function readString(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeString(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* noop */
  }
}

/** Remembered app selection (falls back to the first available app). */
export function useSelectedApp(
  available: string[],
): [string, (app: string) => void] {
  const [app, setApp] = useState<string>(() => readString(SELECTED_APP_KEY) ?? '')

  // Once the app list loads, ensure the selection is valid (or default to #1).
  useEffect(() => {
    if (available.length === 0) return
    if (!app || !available.includes(app)) {
      setApp(available[0])
    }
  }, [available, app])

  const select = useCallback((next: string) => {
    setApp(next)
    writeString(SELECTED_APP_KEY, next)
  }, [])

  return [app, select]
}

/**
 * Per-app settings. `defaults` (from the plugin config) seed the values; the
 * user's live tweaks are layered on top and persisted. Changing app re-reads.
 */
export function useCockpitSettings(
  app: string,
  defaults: CockpitSettings = DEFAULT_SETTINGS,
): [CockpitSettings, (patch: Partial<CockpitSettings>) => void] {
  const [settings, setSettings] = useState<CockpitSettings>(() =>
    normalizeSettings(readJSON(settingsKey(app), undefined), defaults),
  )

  // Re-hydrate when the app (or the configured defaults) change.
  useEffect(() => {
    setSettings(normalizeSettings(readJSON(settingsKey(app), undefined), defaults))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, defaults.gridSize, defaults.autoPlay, defaults.showLabels, defaults.refreshSeconds])

  const update = useCallback(
    (patch: Partial<CockpitSettings>) => {
      setSettings((prev) => {
        const next = normalizeSettings({ ...prev, ...patch }, defaults)
        if (app) writeJSON(settingsKey(app), next)
        return next
      })
    },
    [app, defaults],
  )

  return [settings, update]
}

/** Per-app camera order (array of stream ids). */
export function useCockpitOrder(
  app: string,
): [string[], (order: string[]) => void] {
  const [order, setOrder] = useState<string[]>(() => readJSON(orderKey(app), []))

  useEffect(() => {
    setOrder(readJSON(orderKey(app), []))
  }, [app])

  const save = useCallback(
    (next: string[]) => {
      setOrder(next)
      if (app) writeJSON(orderKey(app), next)
    },
    [app],
  )

  return [order, save]
}
