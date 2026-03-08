export type MonthDisplayPreference = 'native' | 'en' | 'ar' | 'ku'

export const MONTH_DISPLAY_PREFERENCE_KEY = 'month_display_preference'

const ARABIC_MONTH_NAMES = [
    'كانون الثاني',
    'شباط',
    'آذار',
    'نيسان',
    'أيار',
    'حزيران',
    'تموز',
    'آب',
    'أيلول',
    'تشرين الأول',
    'تشرين الثاني',
    'كانون الأول',
]

const KURDISH_MONTH_NAMES = [
    'کانوونی دووەم',
    'شوبات',
    'ئازار',
    'نیسان',
    'ئایار',
    'حوزەیران',
    'تەمووز',
    'ئاب',
    'ئەیلوول',
    'تشرینی یەکەم',
    'تشرینی دووەم',
    'کانوونی یەکەم',
]

function isArabicLanguage(language: string) {
    const normalizedLanguage = language.toLowerCase()
    return normalizedLanguage === 'ar' || normalizedLanguage.startsWith('ar-')
}

function isKurdishLanguage(language: string) {
    const normalizedLanguage = language.toLowerCase()
    return normalizedLanguage === 'ku'
        || normalizedLanguage.startsWith('ku-')
        || normalizedLanguage === 'ckb'
        || normalizedLanguage.startsWith('ckb-')
}

export function shouldShowMonthDisplayPreference(language: string) {
    return isArabicLanguage(language) || isKurdishLanguage(language)
}

export function getMonthDisplayPreference(): MonthDisplayPreference {
    if (typeof window === 'undefined') return 'native'
    const pref = localStorage.getItem(MONTH_DISPLAY_PREFERENCE_KEY)
    if (pref === 'en' || pref === 'ar' || pref === 'ku') return pref
    return 'native'
}

export function setMonthDisplayPreference(preference: MonthDisplayPreference) {
    if (typeof window === 'undefined') return
    localStorage.setItem(MONTH_DISPLAY_PREFERENCE_KEY, preference)
}

function getMonthLocale(language: string, preference: MonthDisplayPreference) {
    if (preference === 'en') return 'en-US'
    if (preference === 'ar') return 'ar-IQ'
    if (preference === 'ku') return 'ckb-IQ'

    // 'native' logic
    if (isArabicLanguage(language)) return 'ar-IQ'
    if (isKurdishLanguage(language)) return 'ckb-IQ'
    return language
}

export function formatLocalizedMonthYear(date: Date, language: string, preference = getMonthDisplayPreference()) {
    const locale = getMonthLocale(language, preference)

    // Manual overrides for Arabic and Kurdish to ensure consistency
    if (preference === 'ar' || (preference === 'native' && isArabicLanguage(language))) {
        const monthLabel = ARABIC_MONTH_NAMES[date.getMonth()]
        const yearLabel = new Intl.NumberFormat('ar-IQ', { useGrouping: false }).format(date.getFullYear())
        return `${monthLabel} ${yearLabel}`
    }

    if (preference === 'ku' || (preference === 'native' && isKurdishLanguage(language))) {
        const monthLabel = KURDISH_MONTH_NAMES[date.getMonth()]
        const yearLabel = new Intl.NumberFormat('ar-IQ', { useGrouping: false }).format(date.getFullYear()) // Use standard numerals
        return `${monthLabel} ${yearLabel}`
    }

    // Default English or other languages
    return new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
    }).format(date)
}
