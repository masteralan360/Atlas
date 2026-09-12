import {
  canCaptureInitialOrderPartnerBalanceSnapshot,
  createPartnerBalanceSnapshotForPostedOrder
} from '@/lib/orderPartnerBalanceSnapshot'
import { isDirectTransactionPartnerAccountEffect } from './payments'

import { db } from './database'
import { isPayableCommissionEntry } from './commissionMode'
import type {
  OrderPartnerBalanceSnapshot,
  OrderType,
  PurchaseOrder,
  SalesOrder
} from './models'
import type { PartnerAccountStatementData } from '@/lib/partnerAccountStatement'

type StatementOrder = SalesOrder | PurchaseOrder

const ALL_TIME_PERIOD: PartnerAccountStatementData['period'] = { type: 'allTime' }

function getOrderPartnerId(order: StatementOrder) {
  return order.businessPartnerId || ('customerId' in order ? order.customerId : order.supplierId) || null
}

/**
 * Loads the same source records and source-selection rules used by the live
 * Partner Account Statement hook. This is intentionally derived from ledger
 * sources rather than the stale/aggregated business-partner balance fields.
 */
async function loadOrderPartnerStatementData(
  workspaceId: string,
  partnerId: string
): Promise<PartnerAccountStatementData | null> {
  const [
    partner,
    agents,
    commissionEntries,
    productCommissionEntries,
    salesOrders,
    salesOrderReturns,
    salesOrderReturnItems,
    purchaseOrders,
    loans,
    loanPayments,
    installmentSales,
    paymentTransactions,
    deliveryMerchantProfiles,
    deliveryLedgerEntries,
    deliveryShipments,
    deliverySettlements
  ] = await Promise.all([
    db.business_partners.get(partnerId),
    db.agents.where('workspaceId').equals(workspaceId).toArray(),
    db.agent_commission_entries.where('workspaceId').equals(workspaceId).toArray(),
    db.agent_product_commission_entries.where('workspaceId').equals(workspaceId).toArray(),
    db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.order_returns.where('workspaceId').equals(workspaceId).toArray(),
    db.order_return_items.where('workspaceId').equals(workspaceId).toArray(),
    db.purchase_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.loans.where('workspaceId').equals(workspaceId).toArray(),
    db.loan_payments.where('workspaceId').equals(workspaceId).toArray(),
    db.installment_sales.where('workspaceId').equals(workspaceId).toArray(),
    db.payment_transactions.where('workspaceId').equals(workspaceId).toArray(),
    db.delivery_merchant_profiles.where('workspaceId').equals(workspaceId).toArray(),
    db.delivery_ledger_entries.where('workspaceId').equals(workspaceId).toArray(),
    db.delivery_shipments.where('workspaceId').equals(workspaceId).toArray(),
    db.delivery_settlements.where('workspaceId').equals(workspaceId).toArray()
  ])

  if (!partner || partner.workspaceId !== workspaceId || partner.isDeleted) {
    return null
  }

  const commissionAgents = agents.filter((agent) => (
    !agent.isDeleted
    && agent.agentType === 'field_agent'
    && agent.businessPartnerId === partnerId
  ))
  const commissionAgentIds = new Set(commissionAgents.map((agent) => agent.id))
  const partnerSalesOrders = salesOrders.filter((order) => (
    order.businessPartnerId === partnerId || order.customerId === partnerId
  ))
  const partnerPurchaseOrders = purchaseOrders.filter((order) => (
    order.businessPartnerId === partnerId || order.supplierId === partnerId
  ))
  const partnerSalesOrderReturns = salesOrderReturns.filter((orderReturn) => (
    partnerSalesOrders.some((order) => order.id === orderReturn.orderId)
  ))
  const partnerSalesOrderReturnItems = salesOrderReturnItems.filter((item) => (
    partnerSalesOrderReturns.some((orderReturn) => orderReturn.id === item.returnId)
  ))
  const partnerLoans = loans.filter((loan) => (
    loan.linkedPartyType === 'business_partner' && loan.linkedPartyId === partnerId
  ))
  const partnerLoanIds = new Set(partnerLoans.map((loan) => loan.id))
  const salesOrderIds = new Set(
    partnerSalesOrders.filter((order) => !order.isDeleted && order.status !== 'cancelled').map((order) => order.id)
  )
  const purchaseOrderIds = new Set(
    partnerPurchaseOrders.filter((order) => !order.isDeleted && order.status !== 'cancelled').map((order) => order.id)
  )
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
  const allOrders = [...partnerSalesOrders, ...partnerPurchaseOrders]

  return {
    partnerId,
    period: ALL_TIME_PERIOD,
    isAgentCommissionStatement: commissionAgents.length > 0,
    salesOrders: partnerSalesOrders,
    salesOrderReturns: partnerSalesOrderReturns,
    salesOrderReturnItems: partnerSalesOrderReturnItems,
    purchaseOrders: partnerPurchaseOrders,
    statementOrders: allOrders,
    loans: partnerLoans,
    loanPayments: loanPayments.filter((payment) => !payment.isDeleted && partnerLoanIds.has(payment.loanId)),
    installmentSales: installmentSales.filter((sale) => sale.customerBusinessPartnerId === partnerId),
    linkedOrderCodes: Object.fromEntries(
      allOrders.filter((order) => !order.isDeleted).map((order) => [order.id, order.orderNumber])
    ),
    settlementTransactions: paymentTransactions.filter((transaction) => {
      if (transaction.isDeleted) return false
      if (transaction.sourceType === 'sales_order') return salesOrderIds.has(transaction.sourceRecordId)
      if (transaction.sourceType === 'purchase_order') return purchaseOrderIds.has(transaction.sourceRecordId)
      if (
        (transaction.sourceType === 'installment_sale_down_payment' ||
          transaction.sourceType === 'installment_sale_installment') &&
        transaction.metadata?.businessPartnerId === partnerId
      ) return true
      if (transaction.sourceType === 'agent_commission_payout' || transaction.sourceType === 'agent_commission_recovery') {
        return commissionAgentIds.has(transaction.sourceRecordId)
          || transaction.metadata?.businessPartnerId === partnerId
      }
      return transaction.sourceType === 'direct_transaction'
        && transaction.metadata?.businessPartnerId === partnerId
        && isDirectTransactionPartnerAccountEffect(transaction.metadata?.partnerAccountEffect)
    }),
    agentCommissionEntries: commissionEntries.filter((entry) => commissionAgentIds.has(entry.agentId) && isPayableCommissionEntry(entry)),
    agentProductCommissionEntries: productCommissionEntries.filter((entry) => commissionAgentIds.has(entry.agentId)),
    deliveryLedgerEntries: deliveryLedgerEntries.filter((entry) => (
      !entry.isDeleted
      && merchantKinds.has(entry.kind)
      && ((entry.merchantProfileId != null && merchantProfileIds.has(entry.merchantProfileId)) || entry.businessPartnerId === partnerId)
    )),
    deliveryShipmentReferences: Object.fromEntries(
      deliveryShipments
        .filter((shipment) => !shipment.isDeleted)
        .map((shipment) => [shipment.id, shipment.trackingNumber])
    ),
    deliverySettlementReferences: Object.fromEntries(
      deliverySettlements
        .filter((settlement) => !settlement.isDeleted)
        .map((settlement) => [settlement.id, settlement.settlementNumber])
    )
  }
}

/**
 * Calculates, but does not persist, the first financial snapshot for an
 * order. The caller owns the order write/sync so snapshot creation stays in
 * the same lifecycle as the order's posting transition.
 */
export async function calculateInitialOrderPartnerBalanceSnapshot(
  orderType: OrderType,
  order: StatementOrder,
  capturedAt: string
): Promise<OrderPartnerBalanceSnapshot | null> {
  if (!canCaptureInitialOrderPartnerBalanceSnapshot(order)) {
    return null
  }

  const partnerId = getOrderPartnerId(order)
  if (!partnerId) return null

  const data = await loadOrderPartnerStatementData(order.workspaceId, partnerId)
  if (!data) return null

  // The order type guard makes accidental use with a mismatched document kind
  // visible during development while retaining a single shared implementation.
  if ((orderType === 'sales') !== ('customerId' in order)) {
    throw new Error('order_partner_balance_snapshot_order_type_mismatch')
  }

  return createPartnerBalanceSnapshotForPostedOrder(data, order, capturedAt)
}
