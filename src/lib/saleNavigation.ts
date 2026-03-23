const PENDING_SALE_DETAILS_KEY = 'atlas:pending-sale-details-id'

export function setPendingSaleDetailsId(saleId: string) {
    if (typeof window === 'undefined') {
        return
    }

    window.sessionStorage.setItem(PENDING_SALE_DETAILS_KEY, saleId)
}

export function readPendingSaleDetailsId() {
    if (typeof window === 'undefined') {
        return null
    }

    return window.sessionStorage.getItem(PENDING_SALE_DETAILS_KEY)
}

export function clearPendingSaleDetailsId() {
    if (typeof window === 'undefined') {
        return
    }

    window.sessionStorage.removeItem(PENDING_SALE_DETAILS_KEY)
}
