import { useCallback, useEffect, useState } from 'react'

import { useBusinessPartnerDuplicateMatches } from '@/local-db/businessPartnerDuplicates'
import {
    normalizeBusinessPartnerName,
    normalizeBusinessPartnerPhone,
    type BusinessPartnerDuplicateField,
    type BusinessPartnerDuplicateStatuses,
} from '@/lib/businessPartnerDuplicates'

export {
    getBusinessPartnerDuplicateStatuses,
    normalizeBusinessPartnerName,
    normalizeBusinessPartnerPhone,
    type BusinessPartnerDuplicateStatus,
    type BusinessPartnerDuplicateField,
    type BusinessPartnerDuplicateStatuses,
} from '@/lib/businessPartnerDuplicates'

const DUPLICATE_CHECK_DELAY_MS = 250

export function shouldInterruptDuplicateSave(
    firstDuplicateField: BusinessPartnerDuplicateField | null,
    acknowledgedDuplicateStateKey: string | null,
    duplicateStateKey: string
): firstDuplicateField is BusinessPartnerDuplicateField {
    return Boolean(firstDuplicateField && acknowledgedDuplicateStateKey !== duplicateStateKey)
}

function getFirstDuplicateField(statuses: BusinessPartnerDuplicateStatuses): BusinessPartnerDuplicateField | null {
    return statuses.name === 'duplicate'
        ? 'name'
        : statuses.phone === 'duplicate'
            ? 'phone'
            : null
}

function getDuplicateStateKey(
    statuses: BusinessPartnerDuplicateStatuses,
    normalizedName: string,
    normalizedPhone: string
): string {
    return [
        statuses.name === 'duplicate' ? `name:${normalizedName}` : '',
        statuses.phone === 'duplicate' ? `phone:${normalizedPhone}` : ''
    ].filter(Boolean).join('|')
}

export function useBusinessPartnerDuplicateDetection({
    isOpen,
    workspaceId,
    name,
    phone,
    excludeBusinessPartnerId
}: {
    isOpen: boolean
    workspaceId?: string
    name: string
    phone: string
    excludeBusinessPartnerId?: string
}) {
    const normalizedName = normalizeBusinessPartnerName(name)
    const normalizedPhone = normalizeBusinessPartnerPhone(phone)
    const [checkedValues, setCheckedValues] = useState({ name: '', phone: '' })
    const matches = useBusinessPartnerDuplicateMatches(isOpen ? workspaceId : undefined, {
        ...checkedValues,
        excludeBusinessPartnerId,
    })

    useEffect(() => {
        if (!isOpen || !workspaceId) {
            setCheckedValues({ name: '', phone: '' })
            return
        }

        // Only check the entered identity; opening a form must not hydrate
        // orders, payments, facets, or every business partner summary.
        const timeoutId = window.setTimeout(() => {
            setCheckedValues({ name: normalizedName, phone: normalizedPhone })
        }, DUPLICATE_CHECK_DELAY_MS)

        return () => window.clearTimeout(timeoutId)
    }, [isOpen, normalizedName, normalizedPhone, workspaceId])

    const detectedStatuses: BusinessPartnerDuplicateStatuses = {
        name: checkedValues.name && matches ? matches.name ? 'duplicate' : 'available' : 'unchecked',
        phone: checkedValues.phone && matches ? matches.phone ? 'duplicate' : 'available' : 'unchecked',
    }
    const statuses: BusinessPartnerDuplicateStatuses = {
        name: checkedValues.name === normalizedName ? detectedStatuses.name : 'unchecked',
        phone: checkedValues.phone === normalizedPhone ? detectedStatuses.phone : 'unchecked'
    }
    const checkNow = useCallback(() => {
        setCheckedValues({ name: normalizedName, phone: normalizedPhone })
    }, [normalizedName, normalizedPhone])

    return {
        statuses,
        firstDuplicateField: getFirstDuplicateField(statuses),
        duplicateStateKey: getDuplicateStateKey(statuses, normalizedName, normalizedPhone),
        checkNow
    }
}
