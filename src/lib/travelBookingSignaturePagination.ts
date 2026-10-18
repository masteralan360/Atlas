const TRAVEL_BOOKING_PRINT_SELECTOR = '[data-travel-booking-print]'
const TRAVEL_BOOKING_SIGNATURE_SELECTOR = '[data-travel-booking-signatures]'
const TRAVEL_BOOKING_SIGNATURE_SPACER_SELECTOR = '[data-travel-booking-signature-spacer]'
const PAGE_ALIGNMENT_EPSILON_MM = 0.05

export function alignTravelBookingSignaturesToPageBottom(
    root: HTMLElement,
    options: {
        pageHeightMm: number
        pageWidthMm: number
        pagePaddingMm?: number
        pageStarts?: readonly number[]
    }
) {
    const printRoot = root.matches(TRAVEL_BOOKING_PRINT_SELECTOR)
        ? root
        : root.querySelector<HTMLElement>(TRAVEL_BOOKING_PRINT_SELECTOR)
    const signatures = printRoot?.querySelector<HTMLElement>(TRAVEL_BOOKING_SIGNATURE_SELECTOR)
    const spacer = printRoot?.querySelector<HTMLElement>(TRAVEL_BOOKING_SIGNATURE_SPACER_SELECTOR)
    if (!printRoot || !signatures || !spacer) return

    spacer.style.height = '0mm'

    const rootRect = root.getBoundingClientRect()
    if (rootRect.width <= 0 || options.pageHeightMm <= 0 || options.pageWidthMm <= 0) return

    const pixelsToMm = options.pageWidthMm / rootRect.width
    const signatureRect = signatures.getBoundingClientRect()
    const signatureTopMm = (signatureRect.top - rootRect.top) * pixelsToMm
    const signatureBottomMm = (signatureRect.bottom - rootRect.top) * pixelsToMm
    if (!Number.isFinite(signatureTopMm) || !Number.isFinite(signatureBottomMm)) return

    const pagePaddingMm = Math.max(0, options.pagePaddingMm ?? 10)
    let priorPageStart: number | undefined
    options.pageStarts?.forEach((pageStart) => {
        if (pageStart <= signatureTopMm + PAGE_ALIGNMENT_EPSILON_MM) priorPageStart = pageStart
    })
    let pageStartMm = priorPageStart
        ?? Math.floor(Math.max(0, signatureTopMm) / options.pageHeightMm) * options.pageHeightMm
    let pageBottomMm = pageStartMm + options.pageHeightMm - pagePaddingMm

    if (signatureTopMm < pageStartMm + pagePaddingMm - PAGE_ALIGNMENT_EPSILON_MM
        || signatureBottomMm > pageBottomMm + PAGE_ALIGNMENT_EPSILON_MM) {
        pageStartMm += options.pageHeightMm
        pageBottomMm = pageStartMm + options.pageHeightMm - pagePaddingMm
    }

    while (signatureBottomMm > pageBottomMm + PAGE_ALIGNMENT_EPSILON_MM) {
        pageStartMm += options.pageHeightMm
        pageBottomMm = pageStartMm + options.pageHeightMm - pagePaddingMm
    }

    spacer.style.height = `${Math.max(0, pageBottomMm - signatureBottomMm)}mm`
}
