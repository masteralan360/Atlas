import { describe, expect, it, vi } from 'vitest'
import type { RevenueSourceSalesInput } from './revenueSourceSales'

vi.mock('@/local-db', () => ({
    getActiveTravelBookingPayments: (rows: unknown[]) => rows,
    toUISale: (row: unknown) => row,
    toUISaleFromActivityTransaction: (row: unknown) => row,
    toUISaleFromDeliveryShipment: (row: unknown) => row,
    toUISaleFromExchangeTransaction: (row: unknown) => row,
    toUISaleFromPaidClinicalAppointment: (row: unknown) => row,
    toUISaleFromRealEstateCommissionTransaction: (row: unknown) => row,
    toUISaleFromRentalContract: (row: unknown) => row,
    toUISaleFromTravelBookingPayment: (row: unknown) => row,
}))

import { buildRevenueSourceSales } from './revenueSourceSales'

describe('shared revenue source projection', () => {
    it('handles source hooks that have not loaded yet', () => {
        const input = {
            sales: undefined,
            exchangeTransactions: undefined,
            realEstateCommissionTransactions: undefined,
            travelBookingPayments: undefined,
            clinicalAppointments: undefined,
            clinicalAppointmentTransactions: undefined,
            activityTransactions: undefined,
            activityTransactionLines: undefined,
            deliveryShipments: undefined,
            deliveryMerchantProfiles: undefined,
            rentalContracts: undefined,
            rentalVehicles: undefined,
            partnerNameById: new Map(),
            userNameById: new Map(),
            t: (key: string) => key,
        } as unknown as RevenueSourceSalesInput

        expect(buildRevenueSourceSales(input)).toEqual([])
        input.clinicalAppointments = [{ id: 'appointment-1' }] as RevenueSourceSalesInput['clinicalAppointments']
        expect(buildRevenueSourceSales(input)).toEqual([{ id: 'appointment-1' }])
    })
})
