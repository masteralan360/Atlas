import { convertArabicIndicToLatin } from '@/lib/utils'

export type BusinessPartnerDuplicateStatus = 'unchecked' | 'available' | 'duplicate'
export type BusinessPartnerDuplicateField = 'name' | 'phone'
export type BusinessPartnerDuplicateStatuses = Record<BusinessPartnerDuplicateField, BusinessPartnerDuplicateStatus>
export type BusinessPartnerDuplicateMatches = Record<BusinessPartnerDuplicateField, boolean>

export function normalizeBusinessPartnerName(value: string): string {
    return value.trim().toLocaleLowerCase()
}

export function normalizeBusinessPartnerPhone(value: string): string {
    return convertArabicIndicToLatin(value).replace(/\D/g, '')
}

export function getBusinessPartnerDuplicateStatuses(
    partners: readonly { id: string; partnerName: string; phone?: string }[],
    { name, phone, excludeBusinessPartnerId }: { name: string; phone: string; excludeBusinessPartnerId?: string }
): BusinessPartnerDuplicateStatuses {
    const normalizedName = normalizeBusinessPartnerName(name)
    const normalizedPhone = normalizeBusinessPartnerPhone(phone)
    const candidates = partners.filter((partner) => partner.id !== excludeBusinessPartnerId)
    return {
        name: normalizedName
            ? candidates.some((partner) => normalizeBusinessPartnerName(partner.partnerName) === normalizedName) ? 'duplicate' : 'available'
            : 'unchecked',
        phone: normalizedPhone
            ? candidates.some((partner) => normalizeBusinessPartnerPhone(partner.phone || '') === normalizedPhone) ? 'duplicate' : 'available'
            : 'unchecked'
    }
}
