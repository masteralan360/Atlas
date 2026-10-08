import "@supabase/functions-js/edge-runtime.d.ts"

import {
  buildPartnerAccountStatementLedger,
  type PartnerAccountStatementData,
  type PartnerAccountStatementPeriod
} from "../../../src/lib/partnerAccountStatement.ts"
import { getPosServiceDisplayName } from "../../../src/lib/posServiceName.ts"
import { corsHeaders, errorResponse, jsonResponse, readJson } from "../_shared/http.ts"
import { createRequestClient, getAuthenticatedUser } from "../_shared/supabase.ts"

const PAGE_SIZE = 1000
const ID_BATCH_SIZE = 100
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MERCHANT_LEDGER_KINDS = [
  "merchant_cod_payable",
  "merchant_cod_correction",
  "merchant_recipient_payout_correction",
  "merchant_fee",
  "merchant_recipient_payout",
  "merchant_payout",
  "merchant_repayment",
  "adjustment"
]

type StatementRequest = {
  workspaceId?: unknown
  partnerId?: unknown
  period?: unknown
  itemizeSalesOrders?: unknown
  itemizePosSaleLoans?: unknown
}

type SupabaseClient = ReturnType<typeof createRequestClient>
type Query = any

function isUuid(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}

function camelKey(value: string) {
  return value.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase())
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [camelKey(key), camelize(nested)]))
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : []
}

function remoteTable(client: SupabaseClient, schema: string, table: string) {
  return schema === "public" ? client.from(table) : client.schema(schema).from(table)
}

async function readAll(
  client: SupabaseClient,
  schema: string,
  table: string,
  workspaceId: string,
  configure: (query: Query) => Query = (query) => query,
  columns = "*"
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await configure(
      remoteTable(client, schema, table).select(columns).eq("workspace_id", workspaceId)
    )
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw error
    if (!data) throw new Error(`No rows returned from ${schema}.${table}`)
    rows.push(...data as Record<string, unknown>[])
    if (data.length < PAGE_SIZE) return rows
  }
}

async function readIds(
  client: SupabaseClient,
  schema: string,
  table: string,
  workspaceId: string,
  column: string,
  ids: string[],
  configure: (query: Query) => Query = (query) => query,
  columns = "*"
): Promise<Record<string, unknown>[]> {
  const uniqueIds = [...new Set(ids.filter(isUuid))]
  const batches: string[][] = []
  for (let offset = 0; offset < uniqueIds.length; offset += ID_BATCH_SIZE) {
    batches.push(uniqueIds.slice(offset, offset + ID_BATCH_SIZE))
  }
  const result: Record<string, unknown>[] = []
  for (let offset = 0; offset < batches.length; offset += 4) {
    const batchRows = await Promise.all(batches.slice(offset, offset + 4).map((batch) => readAll(
      client,
      schema,
      table,
      workspaceId,
      (query) => configure(query.in(column, batch)),
      columns
    )))
    result.push(...batchRows.flat())
  }
  return result
}

async function loadStorageAccess(client: SupabaseClient, workspaceId: string) {
  const [{ data: role, error: roleError }, { data: exclusionRows, error: exclusionsError }] = await Promise.all([
    client.rpc("current_user_role"),
    client.from("storage_member_exclusions").select("storage_id")
      .eq("workspace_id", workspaceId).eq("is_deleted", false)
  ])
  if (roleError) throw roleError
  if (exclusionsError) throw exclusionsError
  return {
    isAdmin: role === "admin",
    excludedStorageIds: new Set<string>(role === "admin"
      ? []
      : (exclusionRows || []).map((row: Record<string, unknown>) => String(row.storage_id)))
  }
}

function visibleOrderForStorage<T extends Record<string, unknown>>(
  order: T,
  isSalesOrder: boolean,
  access: { isAdmin: boolean; excludedStorageIds: Set<string> }
): T | null {
  if (access.isAdmin || access.excludedStorageIds.size === 0) return order
  const items = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : []
  const fallbackStorageId = String(isSalesOrder ? order.sourceStorageId || "" : order.destinationStorageId || "")
  const visibleItems = items.filter((item) => {
    const storageId = String(item.storageId || fallbackStorageId || "")
    return !storageId || !access.excludedStorageIds.has(storageId)
  })
  if (items.length > 0 && visibleItems.length === 0) return null

  const subtotal = roundVisibleAmount(visibleItems.reduce((sum, item) => sum + numberValue(item.lineTotal), 0))
  const originalSubtotal = numberValue(order.subtotal)
  const ratio = originalSubtotal <= 0 ? 0 : Math.min(1, Math.max(0, subtotal / originalSubtotal))
  const discount = roundVisibleAmount(numberValue(order.discount) * ratio)
  const tax = isSalesOrder ? roundVisibleAmount(numberValue(order.tax) * ratio) : 0
  const total = roundVisibleAmount(Math.max(0, subtotal - discount + tax))
  const paidAmount = roundVisibleAmount(Math.min(total, numberValue(order.paidAmount) * ratio))
  const redacted = {
    ...order,
    ...(isSalesOrder
      ? { sourceStorageId: fallbackStorageId && !access.excludedStorageIds.has(fallbackStorageId) ? fallbackStorageId : null }
      : { destinationStorageId: fallbackStorageId && !access.excludedStorageIds.has(fallbackStorageId) ? fallbackStorageId : null }),
    items: visibleItems,
    subtotal,
    discount,
    ...(isSalesOrder ? { tax } : {}),
    total,
    paidAmount,
    balanceAmount: roundVisibleAmount(Math.max(0, total - paidAmount)),
    ...(isSalesOrder
      ? {
        initialPaymentAmount: roundVisibleAmount(Math.min(total, numberValue(order.initialPaymentAmount) * ratio)),
        ...(order.returnedAmount !== undefined
          ? { returnedAmount: roundVisibleAmount(numberValue(order.returnedAmount) * ratio) }
          : {})
      }
      : {})
  }
  return redacted as T
}

function roundVisibleAmount(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 1_000_000) / 1_000_000
}

function uniqueRows(...collections: Record<string, unknown>[][]) {
  const unique = new Map<string, Record<string, unknown>>()
  for (const row of collections.flat()) {
    const id = typeof row.id === "string" ? row.id : null
    if (id) unique.set(id, row)
  }
  return [...unique.values()]
}

function chunks(values: string[]) {
  const result: string[][] = []
  for (let offset = 0; offset < values.length; offset += ID_BATCH_SIZE) {
    result.push(values.slice(offset, offset + ID_BATCH_SIZE))
  }
  return result
}

function periodEndExclusive(period: PartnerAccountStatementPeriod) {
  if (!period.end) return null
  const end = new Date(period.end)
  if (!Number.isFinite(end.getTime())) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(period.end)) end.setDate(end.getDate() + 1)
  else end.setTime(end.getTime() + 1)
  return end.toISOString()
}

function parsePeriod(value: unknown): PartnerAccountStatementPeriod | null {
  if (!value || typeof value !== "object") return null
  const period = value as Record<string, unknown>
  const allowedTypes = new Set(["today", "month", "lastMonth", "allTime", "custom"])
  if (typeof period.type !== "string" || !allowedTypes.has(period.type)) return null
  if (period.start != null && (typeof period.start !== "string" || !Number.isFinite(new Date(period.start).getTime()))) return null
  if (period.end != null && (typeof period.end !== "string" || !Number.isFinite(new Date(period.end).getTime()))) return null
  return {
    type: period.type as PartnerAccountStatementPeriod["type"],
    ...(typeof period.start === "string" ? { start: period.start } : {}),
    ...(typeof period.end === "string" ? { end: period.end } : {})
  }
}

function valueText(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function mapPosSaleItems(sales: Record<string, unknown>[], excludedStorageIds: Set<string>) {
  const itemsBySaleId: Record<string, Array<{
    id: string
    productName: string | null
    quantity: number
    unit: string | null
    lineTotal: number
  }>> = {}
  const codesBySaleId: Record<string, string> = {}

  for (const sale of sales) {
    const saleId = typeof sale.id === "string" ? sale.id : ""
    if (!saleId) continue
    const allRows = Array.isArray(sale.saleItems) ? sale.saleItems as Record<string, unknown>[] : []
    const rows = allRows.filter((item) => {
      const storageId = valueText(item, "storageId", "storage_id")
      return !storageId || !excludedStorageIds.has(storageId)
    })
    if (excludedStorageIds.size > 0 && (allRows.length === 0 || rows.length === 0)) continue
    codesBySaleId[saleId] = sale.sequenceId
      ? `SALE-${sale.sequenceId}`
      : `SALE-${saleId.slice(0, 8).toUpperCase()}`
    itemsBySaleId[saleId] = rows.flatMap((item, index) => {
      const quantity = numberValue(item.quantity)
      if (quantity <= 0) return []
      const product = item.product && typeof item.product === "object"
        ? item.product as Record<string, unknown>
        : {}
      const storedTotal = item.totalPrice ?? item.total_price
      const unitPrice = item.convertedUnitPrice ?? item.converted_unit_price
        ?? item.unitPrice ?? item.unit_price
      const baseProductName = valueText(item, "productName", "product_name") || valueText(product, "name") || "Unknown Product"
      const productName = getPosServiceDisplayName(baseProductName,
        item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : null)
      return [{
        id: valueText(item, "id") || `line-${index + 1}`,
        productName,
        quantity,
        unit: valueText(item, "productUnit", "product_unit", "unit") || valueText(product, "unit"),
        lineTotal: Math.abs(numberValue(storedTotal ?? numberValue(unitPrice) * quantity))
      }]
    })
  }
  return { itemsBySaleId, codesBySaleId }
}

async function loadPartnerStatement(
  client: SupabaseClient,
  workspaceId: string,
  partnerId: string,
  period: PartnerAccountStatementPeriod,
  itemizeSalesOrders: boolean,
  itemizePosSaleLoans: boolean
) {
  const crm = "crm"
  const [partnerResult, agentsRaw, salesByPartner, salesByCustomer, purchasesByPartner, purchasesBySupplier,
    loansRaw, installmentSalesRaw, settlementOperationsRaw, merchantProfilesRaw, storageAccess] = await Promise.all([
    client.schema(crm).rpc("list_visible_business_partners", { p_workspace_id: workspaceId }),
    readAll(client, crm, "agents", workspaceId, (query) => query
      .eq("business_partner_id", partnerId).eq("agent_type", "field_agent").eq("is_deleted", false)),
    readAll(client, crm, "sales_orders", workspaceId, (query) => query
      .eq("business_partner_id", partnerId).eq("is_deleted", false)),
    readAll(client, crm, "sales_orders", workspaceId, (query) => query
      .eq("customer_id", partnerId).eq("is_deleted", false)),
    readAll(client, crm, "purchase_orders", workspaceId, (query) => query
      .eq("business_partner_id", partnerId).eq("is_deleted", false)),
    readAll(client, crm, "purchase_orders", workspaceId, (query) => query
      .eq("supplier_id", partnerId).eq("is_deleted", false)),
    readAll(client, "public", "loans", workspaceId, (query) => query
      .eq("linked_party_type", "business_partner").eq("linked_party_id", partnerId).eq("is_deleted", false)),
    readAll(client, "public", "installment_sales", workspaceId, (query) => query
      .eq("customer_business_partner_id", partnerId).eq("is_deleted", false)),
    readAll(client, "public", "partner_settlement_operations", workspaceId, (query) => query
      .eq("partner_id", partnerId).eq("is_deleted", false)),
    readAll(client, "delivery", "delivery_merchant_profiles", workspaceId, (query) => query
      .eq("business_partner_id", partnerId).eq("is_deleted", false)),
    loadStorageAccess(client, workspaceId)
  ])
  if (partnerResult.error) throw partnerResult.error
  const partnerRaw = asRows(partnerResult.data).find((row) => row.id === partnerId)
  if (!partnerRaw) return null

  const salesOrdersRaw = uniqueRows(salesByPartner, salesByCustomer)
    .map((row) => visibleOrderForStorage(camelize(row) as Record<string, unknown>, true, storageAccess))
    .filter((row): row is Record<string, unknown> => Boolean(row))
  const purchaseOrdersRaw = uniqueRows(purchasesByPartner, purchasesBySupplier)
    .map((row) => visibleOrderForStorage(camelize(row) as Record<string, unknown>, false, storageAccess))
    .filter((row): row is Record<string, unknown> => Boolean(row))
  const agents = agentsRaw.map((row) => camelize(row) as Record<string, unknown>)
  const agentIds = agents.map((agent) => String(agent.id))
  const salesOrderIds = salesOrdersRaw.map((order) => String(order.id))
  const purchaseOrderIds = purchaseOrdersRaw.map((order) => String(order.id))
  const directOrderIds = [...salesOrderIds, ...purchaseOrderIds]
  const loanIds = loansRaw.map((loan) => String(loan.id))
  const settlementOperationIds = settlementOperationsRaw.map((operation) => String(operation.id))
  const merchantProfileIds = merchantProfilesRaw.map((profile) => String(profile.id))
  const periodEnd = periodEndExclusive(period)

  const productCommissionForPeriod = agentIds.length
    ? readAll(client, crm, "agent_product_commission_entries", workspaceId, (query) => {
      let filtered = query.in("agent_id", agentIds).eq("is_deleted", false)
      if (period.start) filtered = filtered.gte("occurred_at", period.start)
      if (periodEnd) filtered = filtered.lt("occurred_at", periodEnd)
      return filtered
    })
    : Promise.resolve([])
  const productCommissionForOrders = agentIds.length
    ? readIds(
      client, crm, "agent_product_commission_entries", workspaceId, "order_id", salesOrderIds,
      (query) => query.in("agent_id", agentIds).eq("is_deleted", false)
    )
    : Promise.resolve([])
  const commissionRowsPromise = agentIds.length
    ? readAll(client, crm, "agent_commission_entries", workspaceId, (query) => query
      .in("agent_id", agentIds).eq("is_deleted", false))
    : Promise.resolve([])
  const assignmentsByAgentPromise = agentIds.length
    ? readAll(client, crm, "sales_order_agent_assignments", workspaceId, (query) => query
      .in("agent_id", agentIds).eq("is_deleted", false))
    : Promise.resolve([])
  const assignmentsByOrderPromise = readIds(
    client, crm, "sales_order_agent_assignments", workspaceId, "order_id", salesOrderIds,
    (query) => query.eq("is_deleted", false)
  )
  const orderIdsForReferences = [...new Set([...salesOrderIds, ...purchaseOrderIds])]
  const referencesPromise = Promise.all([
    readIds(client, crm, "sales_orders", workspaceId, "id", orderIdsForReferences,
      (query) => query.eq("is_deleted", false), "id,order_number"),
    readIds(client, crm, "purchase_orders", workspaceId, "id", orderIdsForReferences,
      (query) => query.eq("is_deleted", false), "id,order_number")
  ])
  const paymentReads: Promise<Record<string, unknown>[]>[] = []
  if (directOrderIds.length) {
    for (const batch of chunks(directOrderIds)) {
      paymentReads.push(readAll(client, "public", "payment_transactions", workspaceId, (query) => query
        .in("source_type", ["sales_order", "purchase_order"]).in("source_record_id", batch).eq("is_deleted", false)))
    }
  }
  if (loanIds.length) {
    for (const batch of chunks(loanIds)) {
      paymentReads.push(readAll(client, "public", "payment_transactions", workspaceId, (query) => query
        .eq("source_module", "loans").in("source_record_id", batch).eq("is_deleted", false)))
    }
  }
  if (settlementOperationIds.length) {
    for (const batch of chunks(settlementOperationIds)) {
      paymentReads.push(readAll(client, "public", "payment_transactions", workspaceId, (query) => query
        .in("settlement_operation_id", batch).eq("is_deleted", false)))
    }
  }
  if (agentIds.length) {
    for (const batch of chunks(agentIds)) {
      paymentReads.push(readAll(client, "public", "payment_transactions", workspaceId, (query) => query
        .in("source_type", ["agent_commission_payout", "agent_commission_recovery"])
        .in("source_record_id", batch).eq("is_deleted", false)))
    }
  }
  paymentReads.push(
    readAll(client, "public", "payment_transactions", workspaceId, (query) => query
      .eq("source_type", "direct_transaction").eq("metadata->>businessPartnerId", partnerId).eq("is_deleted", false)),
    readAll(client, "public", "payment_transactions", workspaceId, (query) => query
      .in("source_type", ["installment_sale_down_payment", "installment_sale_installment"])
      .eq("metadata->>businessPartnerId", partnerId).eq("is_deleted", false)),
    readAll(client, "public", "payment_transactions", workspaceId, (query) => query
      .in("source_type", ["agent_commission_payout", "agent_commission_recovery"])
      .eq("metadata->>businessPartnerId", partnerId).eq("is_deleted", false))
  )
  for (const batch of chunks(salesOrderIds)) {
    paymentReads.push(readAll(client, "public", "payment_transactions", workspaceId, (query) => query
      .eq("source_type", "order_return").in("metadata->>orderId", batch).eq("is_deleted", false)))
  }
  const paymentTransactionsPromise = Promise.all(paymentReads).then((sets) => uniqueRows(...sets))
  const saleIds = itemizePosSaleLoans
    ? loansRaw.map((loan) => valueText(loan, "sale_id")).filter((id): id is string => Boolean(id) && isUuid(id))
    : []
  const posSaleRowsPromise = saleIds.length
    ? readIds(client, "public", "sales", workspaceId, "id", saleIds,
      (query) => query.eq("is_deleted", false), "*, sale_items(*, product:product_id(name, unit))")
    : Promise.resolve([])
  const [returnsRaw, returnItemsRaw, loanPaymentsRaw, installmentSalesFetchedRaw,
    commissionRaw, assignmentsRaw, assignmentsByOrderRaw, productCommissionRaw,
    trackedProductExistsResult, merchantLedgerByPartner, merchantLedgerByProfile, paymentTransactionsRaw,
    posSaleRows, referenceRows] = await Promise.all([
    readIds(client, "public", "order_returns", workspaceId, "order_id", salesOrderIds,
      (query) => query.eq("is_deleted", false)),
    readIds(client, "public", "order_return_items", workspaceId, "order_id", salesOrderIds,
      (query) => query.eq("is_deleted", false)),
    readIds(client, "public", "loan_payments", workspaceId, "loan_id", loanIds,
      (query) => query.eq("is_deleted", false)),
    Promise.resolve(installmentSalesRaw),
    commissionRowsPromise,
    assignmentsByAgentPromise,
    assignmentsByOrderPromise,
    Promise.all([productCommissionForPeriod, productCommissionForOrders]).then((sets) => uniqueRows(...sets)),
    agentIds.length
      ? remoteTable(client, crm, "agent_product_commission_entries").select("id")
        .eq("workspace_id", workspaceId).in("agent_id", agentIds).eq("is_deleted", false)
        .eq("commission_mode", "tracked").limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readAll(client, "delivery", "delivery_ledger_entries", workspaceId, (query) => query
      .eq("business_partner_id", partnerId).in("kind", MERCHANT_LEDGER_KINDS).eq("is_deleted", false)),
    merchantProfileIds.length
      ? readIds(client, "delivery", "delivery_ledger_entries", workspaceId, "merchant_profile_id", merchantProfileIds,
        (query) => query.in("kind", MERCHANT_LEDGER_KINDS).eq("is_deleted", false))
      : Promise.resolve([]),
    paymentTransactionsPromise,
    posSaleRowsPromise,
    referencesPromise
  ])
  if (trackedProductExistsResult.error) throw trackedProductExistsResult.error

  const returnIds = returnsRaw.map((orderReturn) => String(orderReturn.id))
  const returnItemsByReturnId = returnIds.length
    ? await readIds(client, "public", "order_return_items", workspaceId, "return_id", returnIds,
      (query) => query.eq("is_deleted", false))
    : []
  const salesReturns = returnsRaw.map((row) => camelize(row) as Record<string, unknown>)
  const salesReturnItems = uniqueRows(returnItemsRaw, returnItemsByReturnId)
    .map((row) => camelize(row) as Record<string, unknown>)
  const loans = loansRaw.map((row) => camelize(row) as Record<string, unknown>)
  const loanPayments = loanPaymentsRaw.map((row) => camelize(row) as Record<string, unknown>)
  const installmentSales = installmentSalesFetchedRaw.map((row) => camelize(row) as Record<string, unknown>)
  const commissionEntries = commissionRaw.map((row) => camelize(row) as Record<string, unknown>)
  const assignments = uniqueRows(assignmentsRaw, assignmentsByOrderRaw)
    .map((row) => camelize(row) as Record<string, unknown>)
  const agentProductCommissionEntries = productCommissionRaw.map((row) => camelize(row) as Record<string, unknown>)
  const merchantLedgerEntries = uniqueRows(merchantLedgerByPartner, merchantLedgerByProfile)
    .map((row) => camelize(row) as Record<string, unknown>)

  const [referencedSalesOrders, referencedPurchaseOrders] = referenceRows
  const linkedOrderCodes = Object.fromEntries(uniqueRows(referencedSalesOrders, referencedPurchaseOrders)
    .flatMap((order) => typeof order.id === "string" && typeof order.order_number === "string"
      ? [[order.id, order.order_number]]
      : []))

  const settlementOperations = settlementOperationsRaw.map((row) => camelize(row) as Record<string, unknown>)
  const settlementOperationIdSet = new Set(settlementOperations.map((operation) => String(operation.id)))
  const salesOrderIdSet = new Set(salesOrderIds)
  const purchaseOrderIdSet = new Set(purchaseOrderIds)
  const agentIdSet = new Set(agentIds)
  const paymentTransactions = paymentTransactionsRaw.map((row) => camelize(row) as Record<string, unknown>)
  const loanPaymentTransactions = paymentTransactions.filter((transaction) => (
    transaction.sourceModule === "loans" && loanIds.includes(String(transaction.sourceRecordId))
  ))
  const settlementTransactions = paymentTransactions.filter((transaction) => {
    if (transaction.isDeleted) return false
    if (transaction.settlementOperationId && settlementOperationIdSet.has(String(transaction.settlementOperationId))
      && transaction.sourceModule !== "loans") return true
    if (transaction.sourceType === "sales_order") return salesOrderIdSet.has(String(transaction.sourceRecordId))
    if (transaction.sourceType === "purchase_order") return purchaseOrderIdSet.has(String(transaction.sourceRecordId))
    const metadata = transaction.metadata && typeof transaction.metadata === "object"
      ? transaction.metadata as Record<string, unknown>
      : {}
    if (agentIds.length === 0 && transaction.sourceType === "order_return"
      && typeof metadata.orderId === "string" && salesOrderIdSet.has(metadata.orderId)
      && (metadata.loanRepaymentRefund === true || metadata.financingInitialPaymentRefund === true)) return true
    if ((transaction.sourceType === "installment_sale_down_payment"
      || transaction.sourceType === "installment_sale_installment")
      && metadata.businessPartnerId === partnerId) return true
    if (transaction.sourceType === "agent_commission_payout" || transaction.sourceType === "agent_commission_recovery") {
      return agentIdSet.has(String(transaction.sourceRecordId)) || metadata.businessPartnerId === partnerId
    }
    return transaction.sourceType === "direct_transaction"
      && metadata.businessPartnerId === partnerId
      && ["increase_receivable", "decrease_receivable", "increase_payable", "decrease_payable"]
        .includes(String(metadata.partnerAccountEffect))
  })

  const agentProductRowsById = new Map(agentProductCommissionEntries.map((entry) => [String(entry.id), entry]))
  const assignmentIds = new Set(assignments.map((assignment) => String(assignment.id)))
  const marketplaceDeliveryOrderIds = new Set([...agentProductRowsById.values()]
    .filter((entry) => assignmentIds.has(String(entry.assignmentId))
      && assignments.some((assignment) => assignment.id === entry.assignmentId
        && assignment.assignmentSource === "marketplace_delivery_product"))
    .map((entry) => String(entry.orderId)))
  const marketplaceShippingOrderIds = new Set([...agentProductRowsById.values()]
    .filter((entry) => assignmentIds.has(String(entry.assignmentId))
      && assignments.some((assignment) => assignment.id === entry.assignmentId
        && assignment.assignmentSource === "marketplace_shipping_product"))
    .map((entry) => String(entry.orderId)))
  const directOrderIdSet = new Set(salesOrderIds)
  let marketplaceDeliveryIds = [...marketplaceDeliveryOrderIds].filter((id) => !directOrderIdSet.has(id))
  let marketplaceShippingIds = [...marketplaceShippingOrderIds].filter((id) => !directOrderIdSet.has(id))
  const marketplaceReferencedOrders = await readIds(
    client, crm, "sales_orders", workspaceId, "id", [...new Set([...marketplaceDeliveryIds, ...marketplaceShippingIds])],
    (query) => query.eq("source_channel", "marketplace").eq("is_deleted", false), "id,order_number"
  )
  const confirmedMarketplaceOrderIds = new Set(marketplaceReferencedOrders
    .filter((order) => order.source_channel === "marketplace")
    .map((order) => String(order.id)))
  marketplaceDeliveryIds = marketplaceDeliveryIds.filter((id) => confirmedMarketplaceOrderIds.has(id))
  marketplaceShippingIds = marketplaceShippingIds.filter((id) => confirmedMarketplaceOrderIds.has(id))
  for (const order of marketplaceReferencedOrders) {
    if (typeof order.id === "string" && typeof order.order_number === "string") {
      linkedOrderCodes[order.id] = order.order_number
    }
  }

  const allSalesOrders = uniqueRows(salesOrdersRaw).map((row) => camelize(row) as Record<string, unknown>)
  const purchaseOrders = purchaseOrdersRaw.map((row) => camelize(row) as Record<string, unknown>)
  let posSaleItemsBySaleId: Record<string, unknown> = {}
  let linkedPosSaleCodes: Record<string, string> = {}
  if (itemizePosSaleLoans) {
    const mapped = mapPosSaleItems(
      posSaleRows.map((row) => camelize(row) as Record<string, unknown>),
      storageAccess.excludedStorageIds
    )
    posSaleItemsBySaleId = mapped.itemsBySaleId
    linkedPosSaleCodes = mapped.codesBySaleId
  }

  const linkedShipmentIds = [...new Set(merchantLedgerEntries
    .map((entry) => valueText(entry, "shipmentId")).filter((id): id is string => Boolean(id) && isUuid(id)))]
  const linkedSettlementIds = [...new Set(merchantLedgerEntries
    .map((entry) => valueText(entry, "settlementId")).filter((id): id is string => Boolean(id) && isUuid(id)))]
  const [shipmentRows, deliverySettlementRows] = await Promise.all([
    readIds(client, "delivery", "delivery_shipments", workspaceId, "id", linkedShipmentIds,
      (query) => query.eq("is_deleted", false), "id,tracking_number"),
    readIds(client, "delivery", "delivery_settlements", workspaceId, "id", linkedSettlementIds,
      (query) => query.eq("is_deleted", false), "id,settlement_number")
  ])
  const deliveryShipmentReferences = Object.fromEntries(shipmentRows.flatMap((row) => (
    typeof row.id === "string" && typeof row.tracking_number === "string"
      ? [[row.id, row.tracking_number]]
      : []
  )))
  const deliverySettlementReferences = Object.fromEntries(deliverySettlementRows.flatMap((row) => (
    typeof row.id === "string" && typeof row.settlement_number === "string"
      ? [[row.id, row.settlement_number]]
      : []
  )))

  const hasTrackedProductCommission = Boolean(trackedProductExistsResult.data)
  const trackedCommissionEntries = commissionEntries.filter((entry) => entry.commissionMode === "tracked")
  const productCommissionEntries = agentProductCommissionEntries
  const data: PartnerAccountStatementData = {
    partnerId,
    period,
    itemizeSalesOrders,
    itemizePosSaleLoans,
    isAgentCommissionStatement: agents.length > 0,
    salesOrders: allSalesOrders as unknown as PartnerAccountStatementData["salesOrders"],
    salesOrderReturns: salesReturns as unknown as PartnerAccountStatementData["salesOrderReturns"],
    salesOrderReturnItems: salesReturnItems as unknown as PartnerAccountStatementData["salesOrderReturnItems"],
    salesAccountAgentIds: agentIds,
    purchaseOrders: purchaseOrders as unknown as PartnerAccountStatementData["purchaseOrders"],
    statementOrders: [...allSalesOrders, ...purchaseOrders] as unknown as PartnerAccountStatementData["statementOrders"],
    loans: loans as unknown as PartnerAccountStatementData["loans"],
    loanPayments: loanPayments as unknown as PartnerAccountStatementData["loanPayments"],
    loanPaymentTransactions: loanPaymentTransactions as unknown as PartnerAccountStatementData["loanPaymentTransactions"],
    installmentSales: installmentSales as unknown as PartnerAccountStatementData["installmentSales"],
    linkedOrderCodes,
    linkedPosSaleCodes,
    posSaleItemsBySaleId: posSaleItemsBySaleId as PartnerAccountStatementData["posSaleItemsBySaleId"],
    settlementTransactions: settlementTransactions as unknown as PartnerAccountStatementData["settlementTransactions"],
    settlementOperations: settlementOperations as unknown as PartnerAccountStatementData["settlementOperations"],
    agentCommissionEntries: commissionEntries as unknown as PartnerAccountStatementData["agentCommissionEntries"],
    trackedCommissionEntries: trackedCommissionEntries.length || hasTrackedProductCommission
      ? trackedCommissionEntries as unknown as PartnerAccountStatementData["trackedCommissionEntries"]
      : undefined,
    agentProductCommissionEntries: productCommissionEntries as unknown as PartnerAccountStatementData["agentProductCommissionEntries"],
    marketplaceDeliveryProductCommissionOrderIds: marketplaceDeliveryIds,
    marketplaceShippingProductCommissionOrderIds: marketplaceShippingIds,
    deliveryLedgerEntries: merchantLedgerEntries as unknown as PartnerAccountStatementData["deliveryLedgerEntries"],
    deliveryShipmentReferences,
    deliverySettlementReferences
  }
  const ledgers = buildPartnerAccountStatementLedger(data)
  const visiblePartner = camelize(partnerRaw) as Record<string, unknown>
  return {
    partner: {
      id: visiblePartner.id,
      workspaceId: visiblePartner.workspaceId,
      partnerName: visiblePartner.partnerName,
      phone: visiblePartner.phone,
      address: visiblePartner.address,
      city: visiblePartner.city,
      role: visiblePartner.role,
      netExposure: visiblePartner.netExposure,
      defaultCurrency: visiblePartner.defaultCurrency
    },
    ledgers,
    isAgentCommissionStatement: agents.length > 0
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return errorResponse("Method not allowed", 405)

  try {
    const authHeader = req.headers.get("Authorization")
    const { user, error: authError } = await getAuthenticatedUser(req)
    if (!user || authError) return errorResponse("Authentication required", 401)

    const input = await readJson<StatementRequest>(req)
    if (!input || !isUuid(input.workspaceId) || !isUuid(input.partnerId)) {
      return errorResponse("A valid workspace and business partner are required")
    }
    const period = parsePeriod(input.period)
    if (!period) return errorResponse("A valid statement date range is required")
    if (period.type === "allTime" && (period.start || period.end)) {
      return errorResponse("All Time cannot include date boundaries")
    }

    const client = createRequestClient(authHeader || "")
    const result = await loadPartnerStatement(
      client,
      input.workspaceId,
      input.partnerId,
      period,
      input.itemizeSalesOrders === true,
      input.itemizePosSaleLoans === true
    )
    if (!result) return errorResponse("Business partner was not found or is not visible", 404)
    return jsonResponse(result)
  } catch (error) {
    console.error("Partner account statement period read failed", error)
    return errorResponse("Partner account statement could not be loaded", 500)
  }
})
