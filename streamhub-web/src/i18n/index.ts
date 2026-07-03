import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

/**
 * i18n foundation for streamhub-web.
 *
 * Resource auto-loading:
 *   Every JSON file under src/locales/<lng>/<ns>.json is picked up automatically
 *   via Vite's import.meta.glob (eager). Adding a new namespace = just drop a new
 *   file at src/locales/en/<ns>.json (and its es/ twin). No edits to this file.
 *
 * Convention:
 *   - one namespace  == one JSON file (filename minus .json == namespace name)
 *   - keys are section-scoped:  t('<ns>:<section>.<key>')  or  useTranslation('<ns>')
 *   - es/ holds the current Spanish UI text (source of truth)
 *   - en/ holds the natural English translation
 *   - variables via interpolation: t('key', { count, name }); plurals via _one/_other
 */

export const SUPPORTED_LNGS = ['en', 'es'] as const
export type SupportedLng = (typeof SUPPORTED_LNGS)[number]

export const DEFAULT_NS = 'common'
export const LANG_STORAGE_KEY = 'streamhub-lang'

type ResourceModule = { default: Record<string, unknown> }

// Eagerly load every locale JSON. Paths look like: ../locales/en/common.json
const modules = import.meta.glob<ResourceModule>('../locales/*/*.json', {
  eager: true,
})

// Shape into i18next resources: { [lng]: { [ns]: {...} } }
const resources: Record<string, Record<string, Record<string, unknown>>> = {}

for (const [path, mod] of Object.entries(modules)) {
  const match = path.match(/\/locales\/([^/]+)\/([^/]+)\.json$/)
  if (!match) continue
  const [, lng, ns] = match
  resources[lng] ??= {}
  resources[lng][ns] = mod.default
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LNGS as unknown as string[],
    nonExplicitSupportedLngs: true, // es-AR, en-US -> es, en
    defaultNS: DEFAULT_NS,
    ns: Object.keys(resources.en ?? resources.es ?? {}),
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
  })

export { LanguageSwitcher } from './LanguageSwitcher'

export default i18n
