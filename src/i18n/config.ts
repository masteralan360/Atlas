import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { BackendModule, ResourceKey } from 'i18next'
import en from './locales/en.json'
import { getLanguageDirection, parseLangFromHash } from '@/lib/i18nRouting'

// Utility modules also use localized formatters in server-side tooling and
// node-only tests. Derive browser state when it exists, but keep i18n safe to
// import outside a rendered browser document.
const hash = typeof window !== 'undefined'
    ? window.location.hash.replace(/^#/, '') || '/'
    : '/'
const { lang: urlLang } = parseLangFromHash(hash)
const savedLanguage = (typeof localStorage !== 'undefined'
    ? localStorage.getItem('i18nextLng')
    : null) || urlLang || 'en'
const direction = getLanguageDirection(savedLanguage)
if (typeof document !== 'undefined') {
    document.dir = direction
    document.documentElement.lang = savedLanguage
    document.documentElement.dir = direction
}

const localeBackend: BackendModule = {
    type: 'backend',
    init() {},
    read(language, namespace, callback) {
        if (namespace !== 'translation') {
            callback(null, {})
            return
        }

        const languageCode = language.toLowerCase().split('-')[0]
        const loader = languageCode === 'ar'
            ? () => import('./locales/ar.json')
            : languageCode === 'ku'
                ? () => import('./locales/ku.json')
                : null

        if (!loader) {
            callback(null, {})
            return
        }

        void loader()
            .then(({ default: translations }) => callback(null, translations as ResourceKey))
            .catch((error: unknown) => callback(error instanceof Error ? error : String(error), false))
    }
}

export const i18nReady = i18n
    .use(localeBackend)
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en }
        },
        lng: savedLanguage,
        fallbackLng: 'en',
        supportedLngs: ['en', 'ar', 'ku'],
        load: 'languageOnly',
        // English is bundled with the app; Arabic and Kurdish come from the
        // lazy backend. Keep backend loading active alongside inline resources.
        partialBundledLanguages: true,
        ns: ['translation'],
        defaultNS: 'translation',
        interpolation: {
            escapeValue: false
        },
        react: {
            useSuspense: false
        }
    })

export default i18n
