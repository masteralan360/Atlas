import { describe, expect, it } from 'vitest'

import { getCommerceOperationsPartnerLabels } from './commerceOperationsPartnerLabels'

const englishLabels: Record<string, string> = {
    'businessPartners.form.partnerName': 'Partner Name',
    'businessPartners.form.partnerPhone': 'Partner Phone Number',
    'businessPartners.form.phoneForPartner': "{{name}}'s Phone Number",
    'businessPartners.form.partnerAddress': 'Partner Address',
    'businessPartners.form.addressForPartner': "{{name}}'s Address",
}

function translate(key: string, options?: Record<string, unknown>) {
    return (englishLabels[key] || key).replace('{{name}}', String(options?.name || ''))
}

describe('getCommerceOperationsPartnerLabels', () => {
    it('uses the current name for partner-specific phone and address labels', () => {
        expect(getCommerceOperationsPartnerLabels('John', translate)).toEqual({
            name: 'Partner Name',
            phone: "John's Phone Number",
            address: "John's Address",
        })
        expect(getCommerceOperationsPartnerLabels('Acme Trading', translate)).toEqual({
            name: 'Partner Name',
            phone: "Acme Trading's Phone Number",
            address: "Acme Trading's Address",
        })
    })

    it('uses localized fallback labels when the name is empty', () => {
        expect(getCommerceOperationsPartnerLabels('  ', translate)).toEqual({
            name: 'Partner Name',
            phone: 'Partner Phone Number',
            address: 'Partner Address',
        })
    })

    it('lets the active locale supply its own partner-name grammar', () => {
        const arabicTranslate = (key: string, options?: Record<string, unknown>) => ({
            'businessPartners.form.partnerName': 'اسم الشريك',
            'businessPartners.form.phoneForPartner': 'رقم هاتف {{name}}',
            'businessPartners.form.addressForPartner': 'عنوان {{name}}',
            'businessPartners.form.partnerPhone': 'رقم هاتف الشريك',
            'businessPartners.form.partnerAddress': 'عنوان الشريك',
        }[key] || key).replace('{{name}}', String(options?.name || ''))

        expect(getCommerceOperationsPartnerLabels('سارة', arabicTranslate)).toEqual({
            name: 'اسم الشريك',
            phone: 'رقم هاتف سارة',
            address: 'عنوان سارة',
        })
    })
})
