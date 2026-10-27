const JUMLA_KHALEEJ_STOREFRONT_KEY = 'jumla-khaleej'
const JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE = 'jumla_khaleej_delivery_fee'

export function getJumlaKhaleejMarketplaceDeliveryFee(items: unknown[], storefrontKey: string | null) {
    if (storefrontKey !== JUMLA_KHALEEJ_STOREFRONT_KEY) return null
    const metadata = items.find((item) => Boolean(
        item
        && typeof item === 'object'
        && (item as { metadata_type?: unknown }).metadata_type === JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE
    )) as { delivery_fee?: unknown } | undefined
    const fee = Number(metadata?.delivery_fee)
    return Number.isInteger(fee) && fee >= 0 ? fee : null
}
