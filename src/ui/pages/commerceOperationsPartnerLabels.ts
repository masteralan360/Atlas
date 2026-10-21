type PartnerLabelTranslator = (key: string, options?: Record<string, unknown>) => string

export function getCommerceOperationsPartnerLabels(
    partnerName: string,
    t: PartnerLabelTranslator,
) {
    const name = partnerName.trim()

    return {
        name: t('businessPartners.form.partnerName'),
        phone: name
            ? t('businessPartners.form.phoneForPartner', { name })
            : t('businessPartners.form.partnerPhone'),
        address: name
            ? t('businessPartners.form.addressForPartner', { name })
            : t('businessPartners.form.partnerAddress'),
    }
}
