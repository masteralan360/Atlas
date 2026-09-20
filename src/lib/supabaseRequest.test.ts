import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/connectionManager', () => ({
    connectionManager: { reportConnectivityFailure: vi.fn() }
}))

import i18n from '@/i18n/config'

import { normalizeSupabaseActionError } from './supabaseRequest'

describe('normalizeSupabaseActionError', () => {
    afterEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('localizes an insufficient-inventory error while preserving product and storage names', () => {
        const error = normalizeSupabaseActionError({
            message: 'Insufficient inventory for Arabica Coffee in storage Main Warehouse'
        })

        expect(error.message).toBe('Arabica Coffee does not have enough inventory in Main Warehouse.')
    })

    it('uses the active language for an insufficient-inventory error', async () => {
        await i18n.changeLanguage('ar')

        const error = normalizeSupabaseActionError({
            message: 'Insufficient inventory for قهوة عربية in storage المستودع الرئيسي'
        })

        expect(error.message).toBe('لا يتوفر مخزون كافٍ من قهوة عربية في المستودع الرئيسي.')
        expect(normalizeSupabaseActionError({
            message: 'Insufficient inventory for قهوة عربية in storage Unknown storage'
        }).message).toBe('لا يتوفر مخزون كافٍ من قهوة عربية في مخزن غير معروف.')
    })

    it('preserves unrelated server validation messages', () => {
        const error = normalizeSupabaseActionError({ message: 'Marketplace order not found' })

        expect(error.message).toBe('Marketplace order not found')
    })
})
