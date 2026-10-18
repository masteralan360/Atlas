import { useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useClinicalRegistryType } from '@/local-db/clinicalPresets'
import { applyClinicalRegistryLocale } from '@/i18n/clinicalRegistryLocales'

export function ClinicalRegistryLocaleSync() {
    const { i18n } = useTranslation()
    const { user } = useAuth()
    const registryType = useClinicalRegistryType(user?.workspaceId)

    useLayoutEffect(() => {
        applyClinicalRegistryLocale(registryType)
    }, [i18n.language, registryType])

    return null
}
