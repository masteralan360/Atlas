import medicalEn from '@/i18n/locales/en.json'
import beautyEn from '@/i18n/locales/beauty-center/en.json'
import beautyKu from '@/i18n/locales/beauty-center/ku.json'
import type { ClinicalRegistryType } from '@/i18n/clinicalRegistry'
import { isBeautyClinicalRegistryType } from '@/local-db/clinicalRegistryPreset'

export type ClinicalRegistryLanguage = 'en' | 'ar' | 'ku'

function cloneBundle<T>(bundle: T): T {
    return JSON.parse(JSON.stringify(bundle)) as T
}

const medicalEnBundle = cloneBundle({
    clinicalAppointments: medicalEn.clinicalAppointments,
    clinicalPresets: medicalEn.clinicalPresets,
})
export type MedicalClinicalRegistryLocaleBundle = typeof medicalEnBundle

const beautyEnBundle = cloneBundle(beautyEn)
const beautyKuBundle = cloneBundle(beautyKu)

const beautyBundles = {
    en: beautyEnBundle,
    ar: beautyEnBundle,
    ku: beautyKuBundle,
} as const

export function getClinicalRegistryLocaleBundle(
    language: ClinicalRegistryLanguage,
    registryType: ClinicalRegistryType,
    medicalBundle: MedicalClinicalRegistryLocaleBundle = medicalEnBundle,
) {
    return isBeautyClinicalRegistryType(registryType) ? beautyBundles[language] : medicalBundle
}
