import type {
    TravelAgencyPaymentMethod,
    TravelAgencyReceiver,
    TravelAgencySale,
    TravelAgencySaleStatus,
    TravelAgencyTravelMethod
} from '@/local-db/models'

export const travelMethodOptions: Array<{ value: TravelAgencyTravelMethod; label: string }> = [
    { value: 'plane', label: 'Plane' },
    { value: 'bus', label: 'Bus' },
    { value: 'hotel', label: 'Hotel' },
    { value: 'train', label: 'Train' },
    { value: 'car', label: 'Car' },
    { value: 'ship', label: 'Ship' },
    { value: 'other', label: 'Other' }
]

export const travelPaymentMethodOptions: Array<{ value: TravelAgencyPaymentMethod; label: string }> = [
    { value: 'cash', label: 'Cash' },
    { value: 'fib', label: 'FIB' },
    { value: 'qicard', label: 'QiCard' },
    { value: 'hawala', label: 'Money Transfer (Hawala)' },
    { value: 'fastpay', label: 'FastPay' }
]

export const travelReceiverOptions: Array<{ value: TravelAgencyReceiver; label: string }> = [
    { value: 'office', label: 'Received in Office' },
    { value: 'erbil', label: 'Received By Erbil' }
]

export const travelStatusOptions: Array<{ value: TravelAgencySaleStatus; label: string }> = [
    { value: 'completed', label: 'Completed' },
    { value: 'draft', label: 'Draft (On-hold)' }
]

export function getTravelMethodLabel(method?: TravelAgencyTravelMethod | null) {
    return travelMethodOptions.find((option) => option.value === method)?.label || 'Not set'
}

export function getTravelPaymentMethodLabel(method: TravelAgencyPaymentMethod) {
    return travelPaymentMethodOptions.find((option) => option.value === method)?.label || method
}

export function getTravelReceiverLabel(receiver: TravelAgencyReceiver) {
    return travelReceiverOptions.find((option) => option.value === receiver)?.label || receiver
}

export function getTravelStatusLabel(status: TravelAgencySaleStatus) {
    return travelStatusOptions.find((option) => option.value === status)?.label || status
}

export function getTravelSaleRevenue(sale: TravelAgencySale) {
    if (sale.snapshotRevenue != null) return sale.snapshotRevenue
    return sale.groupRevenue + sale.tourists.reduce((sum, tourist) => sum + tourist.revenue, 0)
}

export function getTravelSaleCost(sale: TravelAgencySale) {
    if (sale.snapshotCost != null) return sale.snapshotCost
    return sale.supplierCost
}

export function getTravelSaleNet(sale: TravelAgencySale) {
    if (sale.snapshotProfit != null) return sale.snapshotProfit
    return getTravelSaleRevenue(sale) - getTravelSaleCost(sale)
}
