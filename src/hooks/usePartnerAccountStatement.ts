import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import {
  db,
  useAgents,
  useAgentCommissionEntries,
  useAgentProductCommissionEntries,
  useBusinessPartner,
  useDeliveryLedgerEntries,
  useDeliveryMerchantProfiles,
  useDeliverySettlements,
  useDeliveryShipments,
  useLoans,
  useInstallmentSales,
  usePaymentTransactions,
  usePurchaseOrders,
  useSalesOrderReturnItemsForWorkspace,
  useSalesOrderReturnsForWorkspace,
  useSales,
  useSalesOrders
} from '@/local-db'
import type { PurchaseOrder, Sale, SalesOrder } from '@/local-db/models'
import { isDirectTransactionPartnerAccountEffect } from '@/local-db/payments'
import { deriveLegacyOrderPartnerBalanceSnapshot } from '@/lib/orderPartnerBalanceSnapshot'
import {
  getPartnerAccountStatementClosingBalances,
  type PartnerAccountStatementClosingBalance,
  type PartnerAccountStatementData,
  type PartnerAccountStatementPosSaleItem
} from '@/lib/partnerAccountStatement'

const EMPTY_LOAN_PAYMENTS: NonNullable<PartnerAccountStatementData['loanPayments']> = []
const ALL_TIME_PERIOD: PartnerAccountStatementData['period'] = {
  type: 'allTime'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readRecordNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function posSaleItemsForStatement(sale: Sale): PartnerAccountStatementPosSaleItem[] {
  const rawItems = (sale as Sale & { _enrichedItems?: unknown })._enrichedItems
  if (!Array.isArray(rawItems)) return []

  return rawItems.flatMap((rawItem, index) => {
    const item = asRecord(rawItem)
    if (!item) return []
    const quantity = readRecordNumber(item, 'quantity') ?? 0
    if (quantity <= 0) return []
    const product = asRecord(item.product)
    const productName =
      readRecordString(item, 'product_name')
      || readRecordString(item, 'productName')
      || readRecordString(product || {}, 'name')
      || null
    const unit =
      readRecordString(item, 'product_unit')
      || readRecordString(item, 'unit')
      || readRecordString(product || {}, 'unit')
      || null
    const storedLineTotal = readRecordNumber(item, 'total_price') ?? readRecordNumber(item, 'totalPrice')
    const unitPrice =
      readRecordNumber(item, 'converted_unit_price')
      ?? readRecordNumber(item, 'convertedUnitPrice')
      ?? readRecordNumber(item, 'unit_price')
      ?? readRecordNumber(item, 'unitPrice')

    return [{
      id: readRecordString(item, 'id') || `line-${index + 1}`,
      productName,
      quantity,
      unit,
      lineTotal: Math.abs(storedLineTotal ?? (unitPrice ?? 0) * quantity)
    }]
  })
}

/**
 * Loads the source documents for one business partner's derived subledger.
 * Order and loan hooks intentionally use the application's existing view-own
 * filtering; this page must not bypass the visibility rules of its sources.
 */
export function usePartnerAccountStatement(
  workspaceId: string | undefined,
  partnerId: string | null | undefined,
  period: PartnerAccountStatementData['period']
) {
  const rawPartner = useBusinessPartner(partnerId || undefined)
  const agents = useAgents(workspaceId)
  const commissionEntries = useAgentCommissionEntries(workspaceId)
  const productCommissionEntries = useAgentProductCommissionEntries(workspaceId)
  const salesOrders = useSalesOrders(workspaceId)
  const sales = useSales(workspaceId)
  const salesOrderReturns = useSalesOrderReturnsForWorkspace(workspaceId)
  const salesOrderReturnItems = useSalesOrderReturnItemsForWorkspace(workspaceId)
  const purchaseOrders = usePurchaseOrders(workspaceId)
  const loans = useLoans(workspaceId)
  const installmentSales = useInstallmentSales(workspaceId)
  const paymentTransactions = usePaymentTransactions(workspaceId)
  const deliveryMerchantProfiles = useDeliveryMerchantProfiles(workspaceId)
  const deliveryLedgerEntries = useDeliveryLedgerEntries(workspaceId)
  const deliveryShipments = useDeliveryShipments(workspaceId)
  const deliverySettlements = useDeliverySettlements(workspaceId)

  const partner = rawPartner && rawPartner.workspaceId === workspaceId && !rawPartner.isDeleted ? rawPartner : undefined
  const commissionAgents = useMemo(
    () => partnerId
      ? agents.filter((agent) => (
        !agent.isDeleted
        && agent.workspaceId === workspaceId
        && agent.agentType === 'field_agent'
        && agent.businessPartnerId === partnerId
      ))
      : [],
    [agents, partnerId, workspaceId]
  )
  const commissionAgentIds = useMemo(
    () => new Set(commissionAgents.map((agent) => agent.id)),
    [commissionAgents]
  )
  const partnerSalesOrders = useMemo(
    () =>
      partnerId
        ? salesOrders.filter((order) => order.businessPartnerId === partnerId || order.customerId === partnerId)
        : [],
    [partnerId, salesOrders]
  )
  const partnerPurchaseOrders = useMemo(
    () =>
      partnerId
        ? purchaseOrders.filter((order) => order.businessPartnerId === partnerId || order.supplierId === partnerId)
        : [],
    [partnerId, purchaseOrders]
  )
  const partnerSalesOrderReturns = useMemo(() => {
    const orderIds = new Set(partnerSalesOrders.map((order) => order.id))
    return salesOrderReturns.filter((orderReturn) => orderIds.has(orderReturn.orderId))
  }, [partnerSalesOrders, salesOrderReturns])
  const partnerSalesOrderReturnItems = useMemo(() => {
    const returnIds = new Set(partnerSalesOrderReturns.map((orderReturn) => orderReturn.id))
    return salesOrderReturnItems.filter((item) => returnIds.has(item.returnId))
  }, [partnerSalesOrderReturns, salesOrderReturnItems])
  const partnerLoans = useMemo(
    () =>
      partnerId
        ? loans.filter((loan) => loan.linkedPartyType === 'business_partner' && loan.linkedPartyId === partnerId)
        : [],
    [loans, partnerId]
  )
  const partnerLoanIds = useMemo(() => partnerLoans.map((loan) => loan.id), [partnerLoans])
  const loanIdKey = partnerLoanIds.join('|')
  const queriedLoanPayments = useLiveQuery(
    () =>
      partnerLoanIds.length > 0
        ? db.loan_payments
            .where('loanId')
            .anyOf(partnerLoanIds)
            .and((payment) => !payment.isDeleted)
            .toArray()
        : [],
    [loanIdKey]
  )
  const loanPayments = useMemo(() => queriedLoanPayments ?? EMPTY_LOAN_PAYMENTS, [queriedLoanPayments])
  const salesAccountCommissionEntries = useMemo(
    () => commissionEntries.filter((entry) => commissionAgentIds.has(entry.agentId)),
    [commissionAgentIds, commissionEntries]
  )
  const partnerInstallmentSales = useMemo(
    () => (partnerId ? installmentSales.filter((sale) => sale.customerBusinessPartnerId === partnerId) : []),
    [installmentSales, partnerId]
  )
  const salesAccountProductCommissionEntries = useMemo(
    () => productCommissionEntries.filter((entry) => commissionAgentIds.has(entry.agentId)),
    [commissionAgentIds, productCommissionEntries]
  )
  const posSaleItemsBySaleId = useMemo<Record<string, PartnerAccountStatementPosSaleItem[]>>(
    () => Object.fromEntries(sales.flatMap((sale) => (
      !sale.isDeleted ? [[sale.id, posSaleItemsForStatement(sale)]] : []
    ))),
    [sales]
  )

  const settlementTransactions = useMemo(() => {
    const salesOrderIds = new Set(
      partnerSalesOrders.filter((order) => !order.isDeleted && order.status !== 'cancelled').map((order) => order.id)
    )
    const purchaseOrderIds = new Set(
      partnerPurchaseOrders.filter((order) => !order.isDeleted && order.status !== 'cancelled').map((order) => order.id)
    )

    return paymentTransactions.filter((transaction) => {
      if (transaction.isDeleted) return false
      if (transaction.sourceType === 'sales_order') return salesOrderIds.has(transaction.sourceRecordId)
      if (transaction.sourceType === 'purchase_order') return purchaseOrderIds.has(transaction.sourceRecordId)
      if (
        (transaction.sourceType === 'installment_sale_down_payment' ||
          transaction.sourceType === 'installment_sale_installment') &&
        transaction.metadata?.businessPartnerId === partnerId
      )
        return true
      if (transaction.sourceType === 'agent_commission_payout' || transaction.sourceType === 'agent_commission_recovery') {
        return commissionAgentIds.has(transaction.sourceRecordId)
          || transaction.metadata?.businessPartnerId === partnerId
      }
      return (
        transaction.sourceType === 'direct_transaction' &&
        transaction.metadata?.businessPartnerId === partnerId &&
        isDirectTransactionPartnerAccountEffect(transaction.metadata?.partnerAccountEffect)
      )
    })
  }, [commissionAgentIds, partnerId, partnerPurchaseOrders, partnerSalesOrders, paymentTransactions])

  const merchantDeliveryEntries = useMemo(() => {
    if (!partnerId) return []
    const merchantProfileIds = new Set(
      deliveryMerchantProfiles
        .filter((profile) => !profile.isDeleted && profile.businessPartnerId === partnerId)
        .map((profile) => profile.id)
    )
    const merchantKinds = new Set([
      'merchant_cod_payable',
      'merchant_cod_correction',
      'merchant_recipient_payout_correction',
      'merchant_fee',
      'merchant_recipient_payout',
      'merchant_payout',
      'merchant_repayment',
      'adjustment'
    ])

    return deliveryLedgerEntries.filter(
      (entry) =>
        !entry.isDeleted &&
        merchantKinds.has(entry.kind) &&
        ((entry.merchantProfileId != null && merchantProfileIds.has(entry.merchantProfileId)) ||
          entry.businessPartnerId === partnerId)
    )
  }, [deliveryLedgerEntries, deliveryMerchantProfiles, partnerId])

  const deliveryShipmentReferences = useMemo(
    () =>
      Object.fromEntries(
        deliveryShipments
          .filter((shipment) => !shipment.isDeleted)
          .map((shipment) => [shipment.id, shipment.trackingNumber])
      ),
    [deliveryShipments]
  )
  const deliverySettlementReferences = useMemo(
    () =>
      Object.fromEntries(
        deliverySettlements
          .filter((settlement) => !settlement.isDeleted)
          .map((settlement) => [settlement.id, settlement.settlementNumber])
      ),
    [deliverySettlements]
  )

  const statementData = useMemo<PartnerAccountStatementData | null>(() => {
    if (!partner) return null

    const allOrders = [...partnerSalesOrders, ...partnerPurchaseOrders]
    return {
      partnerId: partner.id,
      period,
      isAgentCommissionStatement: commissionAgents.length > 0,
      salesOrders: partnerSalesOrders,
      salesOrderReturns: partnerSalesOrderReturns,
      salesOrderReturnItems: partnerSalesOrderReturnItems,
      purchaseOrders: partnerPurchaseOrders,
      statementOrders: allOrders,
      loans: partnerLoans,
      loanPayments,
      installmentSales: partnerInstallmentSales,
      linkedOrderCodes: Object.fromEntries(
        allOrders.filter((order) => !order.isDeleted).map((order) => [order.id, order.orderNumber])
      ),
      linkedPosSaleCodes: Object.fromEntries(
        sales
          .filter((sale) => !sale.isDeleted)
          .map((sale) => [
            sale.id,
            sale.sequenceId
              ? `SALE-${sale.sequenceId}`
              : `SALE-${sale.id.slice(0, 8).toUpperCase()}`
          ])
      ),
      posSaleItemsBySaleId,
      settlementTransactions,
      agentCommissionEntries: salesAccountCommissionEntries,
      agentProductCommissionEntries: salesAccountProductCommissionEntries,
      deliveryLedgerEntries: merchantDeliveryEntries,
      deliveryShipmentReferences,
      deliverySettlementReferences
    }
  }, [
    deliverySettlementReferences,
    deliveryShipmentReferences,
    loanPayments,
    merchantDeliveryEntries,
    commissionAgents,
    partner,
    partnerInstallmentSales,
    partnerLoans,
    partnerPurchaseOrders,
    partnerSalesOrderReturnItems,
    partnerSalesOrderReturns,
    partnerSalesOrders,
    period,
    posSaleItemsBySaleId,
    salesAccountCommissionEntries,
    salesAccountProductCommissionEntries,
    sales,
    settlementTransactions
  ])

  return {
    partner,
    statementData,
    sourceCounts: {
      orders: partnerSalesOrders.length + partnerPurchaseOrders.length + partnerInstallmentSales.length,
      loans: partnerLoans.length,
      payments: settlementTransactions.length + loanPayments.length + merchantDeliveryEntries.length
    }
  }
}

/**
 * Supplies invoice and print views with the Account Statement's current
 * all-time balances without collapsing currencies or falling back to cached
 * partner summary fields.
 */
export function usePartnerAccountStatementClosingBalances(
  workspaceId: string | undefined,
  partnerId: string | null | undefined
): PartnerAccountStatementClosingBalance[] | undefined {
  const { statementData } = usePartnerAccountStatement(workspaceId, partnerId, ALL_TIME_PERIOD)

  return useMemo(
    () => (statementData ? getPartnerAccountStatementClosingBalances(statementData) : undefined),
    [statementData]
  )
}

/**
 * Supplies an invoice with both the live closing balance and a read-only
 * account-statement reconstruction for legacy orders that predate immutable
 * partner-balance snapshots.
 */
export function usePartnerAccountStatementPrintBalances(
  workspaceId: string | undefined,
  partnerId: string | null | undefined,
  order: SalesOrder | PurchaseOrder | null | undefined
) {
  const { statementData } = usePartnerAccountStatement(workspaceId, partnerId, ALL_TIME_PERIOD)

  return useMemo(() => ({
    currentBalances: statementData
      ? getPartnerAccountStatementClosingBalances(statementData)
      : undefined,
    legacyOrderBalanceSnapshot: statementData && order && !order.partnerBalanceSnapshot
      ? deriveLegacyOrderPartnerBalanceSnapshot(statementData, order)
      : null
  }), [order, statementData])
}
