import type { Sale } from '@/types'
import {
    getActiveTravelBookingPayments,
    toUISale,
    toUISaleFromActivityTransaction,
    toUISaleFromDeliveryShipment,
    toUISaleFromExchangeTransaction,
    toUISaleFromPaidClinicalAppointment,
    toUISaleFromRealEstateCommissionTransaction,
    toUISaleFromRentalContract,
    toUISaleFromTravelBookingPayment,
} from '@/local-db'
import type {
    useActivityTransactionLinesForWorkspace,
    useActivityTransactions,
    useClinicalAppointments,
    useDeliveryMerchantProfiles,
    useDeliveryShipments,
    useExchangeTransactions,
    usePaymentTransactions,
    useRentalContracts,
    useRentalVehicles,
    useSales,
} from '@/local-db'

type Rows<Hook extends (...args: any[]) => unknown> = ReturnType<Hook>

export interface RevenueSourceSalesInput {
    sales: Rows<typeof useSales>
    exchangeTransactions: Rows<typeof useExchangeTransactions>
    realEstateCommissionTransactions: Rows<typeof usePaymentTransactions>
    travelBookingPayments: Rows<typeof usePaymentTransactions>
    clinicalAppointments: Rows<typeof useClinicalAppointments>
    clinicalAppointmentTransactions: Rows<typeof usePaymentTransactions>
    activityTransactions: Rows<typeof useActivityTransactions>
    activityTransactionLines: Rows<typeof useActivityTransactionLinesForWorkspace>
    deliveryShipments: Rows<typeof useDeliveryShipments>
    deliveryMerchantProfiles: Rows<typeof useDeliveryMerchantProfiles>
    rentalContracts: Rows<typeof useRentalContracts>
    rentalVehicles: Rows<typeof useRentalVehicles>
    partnerNameById: ReadonlyMap<string, string>
    userNameById: ReadonlyMap<string, string>
    startDate?: string
    endDate?: string
    t: (key: string, options?: any) => string
}

/** The source projection used by Revenue Analytics and the dashboard. */
export function buildRevenueSourceSales(input: RevenueSourceSalesInput): Sale[] {
    const {
        sales = [],
        exchangeTransactions = [],
        realEstateCommissionTransactions = [],
        travelBookingPayments = [],
        clinicalAppointments = [],
        clinicalAppointmentTransactions = [],
        activityTransactions = [],
        activityTransactionLines = [],
        deliveryShipments = [],
        deliveryMerchantProfiles = [],
        rentalContracts = [],
        rentalVehicles = [],
        partnerNameById,
        userNameById,
        startDate,
        endDate,
        t,
    } = input
    const merchantPartnerByProfile = new Map(
        deliveryMerchantProfiles.map((profile) => [profile.id, profile.businessPartnerId] as const),
    )
    const vehicleById = new Map(rentalVehicles.map((vehicle) => [vehicle.id, vehicle] as const))
    return [
        ...sales.map(toUISale),
        ...exchangeTransactions
            .filter(
                (transaction) =>
                    !transaction.isDeleted &&
                    !transaction.isReversed &&
                    transaction.transactionType === 'sell' &&
                    transaction.profitAmount != null &&
                    transaction.profitAmount > 0,
            )
            .map(toUISaleFromExchangeTransaction),
        ...realEstateCommissionTransactions
            .filter((transaction) => transaction.amount > 0)
            .map(toUISaleFromRealEstateCommissionTransaction),
        ...getActiveTravelBookingPayments(travelBookingPayments).map(toUISaleFromTravelBookingPayment),
        ...clinicalAppointments
            .map((appointment) => toUISaleFromPaidClinicalAppointment(appointment, clinicalAppointmentTransactions))
            .filter((sale): sale is NonNullable<typeof sale> => !!sale),
        ...activityTransactions
            .filter((transaction) => transaction.status === 'completed')
            .map((transaction) =>
                toUISaleFromActivityTransaction(
                    transaction,
                    activityTransactionLines.filter((line) => line.transactionId === transaction.id),
                    transaction.createdBy ? userNameById.get(transaction.createdBy) : undefined,
                ),
            ),
        ...deliveryShipments
            .filter((shipment) => shipment.status === 'delivered' && !!shipment.deliveredAt)
            .filter(
                (shipment) =>
                    (!startDate || shipment.deliveredAt! >= startDate) &&
                    (!endDate || shipment.deliveredAt! <= endDate),
            )
            .map((shipment) => {
                const partnerId = merchantPartnerByProfile.get(shipment.merchantProfileId)
                return toUISaleFromDeliveryShipment(shipment, {
                    merchantName: partnerId ? partnerNameById.get(partnerId) || null : null,
                    merchantBusinessPartnerId: partnerId,
                    serviceName: t('postService.reporting.serviceName'),
                    serviceCategory: t('postService.reporting.serviceCategory'),
                    feePayerNote: t('postService.reporting.feePayerNote', {
                        payer: t(`postService.feePayer.${shipment.feePayer}`),
                    }),
                })
            }),
        ...rentalContracts
            .filter((contract) => ['active', 'returned', 'closed'].includes(contract.status))
            .filter((contract) => {
                const recognitionDate = contract.actualPickupAt || contract.plannedPickupAt
                return (!startDate || recognitionDate >= startDate) && (!endDate || recognitionDate <= endDate)
            })
            .map((contract) =>
                toUISaleFromRentalContract(contract, vehicleById.get(contract.vehicleId), {
                    serviceName: t('carRental.reporting.serviceName'),
                    serviceCategory: t('carRental.reporting.serviceCategory'),
                }),
            ),
    ]
}
