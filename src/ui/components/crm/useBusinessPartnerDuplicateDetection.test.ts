import { describe, expect, it, vi } from 'vitest'

vi.mock('@/local-db/businessPartnerDuplicates', () => ({
    useBusinessPartnerDuplicateMatches: () => ({ name: false, phone: false })
}))

import {
    getBusinessPartnerDuplicateStatuses,
    normalizeBusinessPartnerName,
    normalizeBusinessPartnerPhone,
    shouldInterruptDuplicateSave
} from './useBusinessPartnerDuplicateDetection'

const partners = [
    { id: 'partner-1', partnerName: '  Acme Trading  ', phone: '+964 (770) 123-4567' },
    { id: 'partner-2', partnerName: 'North Star', phone: '0750-555-0000' }
]

describe('business partner duplicate detection', () => {
    it('normalizes names and phone formatting before comparing', () => {
        expect(normalizeBusinessPartnerName('  ACME TRADING  ')).toBe('acme trading')
        expect(normalizeBusinessPartnerPhone('+964 (770) 123-4567')).toBe('9647701234567')
        expect(normalizeBusinessPartnerPhone('٠٧٧٠-١٢٣-٤٥٦٧')).toBe('07701234567')

        expect(getBusinessPartnerDuplicateStatuses(partners, {
            name: 'acme trading',
            phone: '+964 770 123 4567'
        })).toEqual({ name: 'duplicate', phone: 'duplicate' })
    })

    it('checks name and phone independently and omits empty values', () => {
        expect(getBusinessPartnerDuplicateStatuses(partners, {
            name: 'New Partner',
            phone: '07505550000'
        })).toEqual({ name: 'available', phone: 'duplicate' })

        expect(getBusinessPartnerDuplicateStatuses(partners, {
            name: '   ',
            phone: ''
        })).toEqual({ name: 'unchecked', phone: 'unchecked' })
    })

    it('excludes the partner currently being edited', () => {
        expect(getBusinessPartnerDuplicateStatuses(partners, {
            name: 'Acme Trading',
            phone: '9647701234567',
            excludeBusinessPartnerId: 'partner-1'
        })).toEqual({ name: 'available', phone: 'available' })
    })

    it('interrupts only the first save for each duplicate state', () => {
        expect(shouldInterruptDuplicateSave('name', null, 'name:acme')).toBe(true)
        expect(shouldInterruptDuplicateSave('name', 'name:acme', 'name:acme')).toBe(false)
        expect(shouldInterruptDuplicateSave('name', 'name:acme', 'name:acme|phone:0770')).toBe(true)
    })
})
