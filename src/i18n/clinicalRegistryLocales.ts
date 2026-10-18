import i18n from '@/i18n/config'
import type { ClinicalRegistryType } from '@/i18n/clinicalRegistry'
import {
    getClinicalRegistryLocaleBundle,
    type ClinicalRegistryLanguage,
    type MedicalClinicalRegistryLocaleBundle,
} from '@/i18n/clinicalRegistryLocaleBundles'

const medicalBundles = new Map<ClinicalRegistryLanguage, MedicalClinicalRegistryLocaleBundle>()

function getMedicalBundle(language: ClinicalRegistryLanguage): MedicalClinicalRegistryLocaleBundle {
    const cached = medicalBundles.get(language)
    if (cached) return cached

    const english = i18n.getResource('en', 'translation', 'clinicalAppointments')
        ? {
            clinicalAppointments: i18n.getResource('en', 'translation', 'clinicalAppointments'),
            clinicalPresets: i18n.getResource('en', 'translation', 'clinicalPresets'),
        }
        : null
    const bundle = {
        clinicalAppointments: i18n.getResource(language, 'translation', 'clinicalAppointments')
            ?? english?.clinicalAppointments,
        clinicalPresets: i18n.getResource(language, 'translation', 'clinicalPresets')
            ?? english?.clinicalPresets,
    } as MedicalClinicalRegistryLocaleBundle

    medicalBundles.set(language, bundle)
    return bundle
}

export function applyClinicalRegistryLocale(registryType: ClinicalRegistryType): void {
    const languageCode = (i18n.resolvedLanguage || i18n.language || 'en').toLowerCase().split('-')[0]
    const language: ClinicalRegistryLanguage = languageCode === 'ar' || languageCode === 'ku'
        ? languageCode
        : 'en'
    const bundle = getClinicalRegistryLocaleBundle(language, registryType, getMedicalBundle(language))

    i18n.addResourceBundle(language, 'translation', bundle, true, true)

    i18n.emit('languageChanged', i18n.language)
}
