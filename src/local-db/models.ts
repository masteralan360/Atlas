// Data Models for Atlas
// All entities include sync metadata for offline-first architecture

export type SyncStatus = 'pending' | 'synced' | 'conflict'

export type UserRole = 'admin' | 'staff' | 'viewer'

export type CurrencyCode = 'usd' | 'eur' | 'iqd' | 'try'
export type WorkspaceDataMode = 'cloud' | 'local' | 'hybrid' | 'demo'
export type WorkspacePlan = 'basic' | 'business' | 'enterprise'

export type PaymentMethod = 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'loan'
export type LoanPaymentMethod = PaymentMethod | 'loan_adjustment' | 'bank_transfer'
export type WorkspacePaymentMethod = LoanPaymentMethod | 'credit' | 'bank_transfer' | 'unknown'

export type IQDDisplayPreference = 'IQD' | 'د.ع'

export interface SyncMetadata {
  syncStatus: SyncStatus
  lastSyncedAt: string | null
  version: number
  isDeleted: boolean
}

export interface BaseEntity extends SyncMetadata {
  id: string
  workspaceId: string
  createdAt: string
  updatedAt: string
}

export interface User extends BaseEntity {
  email: string
  name: string
  role: UserRole
  profileUrl?: string
  monthlyTarget?: number
  monthlyProgress?: number
}

export interface ProductBarcode extends BaseEntity {
  productId: string
  barcode: string
  label?: string
  isPrimary: boolean
}

export interface Product extends BaseEntity {
  /** Services are sellable catalog items but never inventory-backed. */
  isService?: boolean
  sku: string
  /** Local-only normalized SKU key used by indexed catalog lookups. */
  skuKey?: string
  /**
   * The sellable parent product for this product's variant group. A null value
   * means the product is independent or is itself a parent product.
   */
  parentProductId?: string | null
  name: string
  description: string
  categoryId?: string | null
  category?: string | null
  storageId?: string | null
  storageName?: string
  price: number
  /** Null means no cost has been recorded. Zero remains a valid cost. */
  costPrice: number | null
  quantity: number
  minStockLevel: number
  unit: string
  currency: CurrencyCode
  /** @deprecated Use the product_barcodes table instead. */
  barcode?: string
  barcodes?: string[]
  imageUrl?: string
  canBeReturned: boolean
  returnRules?: string
  createdBy?: string | null
}

export interface PriceBook extends BaseEntity {
  name: string
  createdBy?: string | null
  /** When true, saving without selecting this (or any) Price Book shows a confirmation warning. Absent/true by default. */
  saveWarn?: boolean
}

export interface PriceBookItem extends BaseEntity {
  priceBookId: string
  productId: string
  /** Null means this Price Book has no cost for the product. Zero is valid. */
  costPrice: number | null
  price: number
  currency: CurrencyCode
  createdBy?: string | null
}

export interface Profile {
  id: string
  workspaceId: string
  currentWorkspaceId?: string
  name: string
  role: string
  profile_url?: string | null
  created_at?: string
}

export interface LocalAccountCredential {
  id: string
  workspaceId: string
  userId: string
  email: string
  salt: string
  verifier: string
  iterations: number
  digest: 'SHA-256'
  failedAttempts: number
  lockedUntil: string | null
  createdAt: string
  updatedAt: string
  lastVerifiedAt: string | null
}

export type ModuleLockerAuditAction =
  | 'passkey_set'
  | 'passkey_changed'
  | 'passkey_removed'
  | 'module_locked'
  | 'module_unlocked'
  | 'all_modules_unlocked'
  | 'passkey_failed'

/**
 * Per-workspace, device-local locker configuration. `verifier` is derived
 * from the passkey and is intentionally the only passkey material persisted.
 */
export interface ModuleLockerSettings {
  id: string
  workspaceId: string
  salt: string
  verifier: string
  iterations: number
  digest: 'SHA-256'
  failedAttempts: number
  lockedUntil: string | null
  createdAt: string
  createdByUserId: string
  updatedAt: string
  updatedByUserId: string
}

/** A persistent device-local lock for a top-level sidebar module. */
export interface ModuleLockerLock {
  id: string
  workspaceId: string
  moduleHref: string
  moduleName: string
  lockedAt: string
  lockedByUserId: string
  lockedByName: string
}

/** A capped, device-local security activity record. */
export interface ModuleLockerAuditEvent {
  id: string
  workspaceId: string
  action: ModuleLockerAuditAction
  moduleHref?: string | null
  moduleName?: string | null
  actorUserId: string
  actorName: string
  occurredAt: string
}

export interface Category extends BaseEntity {
  name: string
  description?: string
  createdBy?: string | null
}

export interface Unit extends BaseEntity {
  /** Value stored on products.unit (e.g. "box", "m²"). */
  code: string
  /** Optional lucide icon name used to render this unit. */
  icon?: string | null
  /** Dynamic units allow fractional quantities and POS quantity adjustment. */
  isDynamic: boolean
  createdBy?: string | null
}

/**
 * Built-in units, hardcoded in the app and shared by every workspace.
 * They are NOT stored in the `units` table — that table only holds
 * workspace-created custom units. Codes here are reserved: the data layer
 * and the units page reject custom units that collide with them.
 */
export const DEFAULT_UNITS: ReadonlyArray<{
  code: string
  icon?: string | null
  isDynamic: boolean
}> = [
  { code: 'pcs', icon: 'CircleDot', isDynamic: false },
  { code: 'gram', icon: 'Scale', isDynamic: false },
  { code: 'liter', icon: 'Droplets', isDynamic: false },
  { code: 'bottle', icon: 'BottleWine', isDynamic: false },
  { code: 'can', icon: 'Cylinder', isDynamic: false },
  { code: 'box', icon: 'Box', isDynamic: false },
  { code: 'pack', icon: 'Package', isDynamic: false },
  { code: 'carton', icon: 'Boxes', isDynamic: false },
  { code: 'bag', icon: 'ShoppingBag', isDynamic: false },
  { code: 'm²', icon: 'SquareDashed', isDynamic: true },
  { code: 'Kg', icon: 'Weight', isDynamic: true },
  { code: 'Meter', icon: 'Ruler', isDynamic: true }
]

/**
 * Strips invisible/zero-width characters and surrounding whitespace from a
 * unit code. Unit codes typed or imported through different sources (Excel,
 * renamed units, pasted text) can otherwise carry invisible bytes that make
 * exact string comparisons fail, which hides the unit in dropdowns and prints.
 */
export function normalizeUnitCode(code: string | null | undefined): string {
  if (!code) return ''
  return code.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '').trim()
}

/**
 * True when the code collides with a hardcoded built-in unit. Built-in codes
 * are reserved, so a `units` row matching one is always legacy data seeded by
 * the old auto-seed logic (or a stale pull) and must never be treated as a
 * user-created custom unit.
 */
export function isReservedUnitCode(code: string | null | undefined): boolean {
  if (!code) return false
  const normalized = normalizeUnitCode(code).toLowerCase()
  return DEFAULT_UNITS.some((def) => normalizeUnitCode(def.code).toLowerCase() === normalized)
}

export interface Storage extends BaseEntity {
  name: string
  isSystem: boolean
  isProtected: boolean
  isPrimary: boolean
  isMarketplace: boolean
}

export interface Inventory extends BaseEntity {
  productId: string
  storageId: string
  quantity: number
}

export type StockAdjustmentType = 'increase' | 'decrease'
export type StockAdjustmentReason =
  'purchase' | 'return' | 'correction' | 'damage' | 'theft' | 'expired' | 'production' | 'other'

export interface StockAdjustment extends BaseEntity {
  productId: string
  storageId: string
  adjustmentType: StockAdjustmentType
  quantity: number
  previousQuantity: number
  newQuantity: number
  reason: StockAdjustmentReason
  notes?: string | null
  createdBy?: string | null
}

export type InventoryTransactionType =
  'stock_adjustment' | 'transfer_in' | 'transfer_out' | 'sale' | 'return' | 'initial_stock'

export interface InventoryTransaction extends BaseEntity {
  productId: string
  storageId: string
  transactionType: InventoryTransactionType
  quantityDelta: number
  previousQuantity: number
  newQuantity: number
  adjustmentReason?: StockAdjustmentReason | null
  referenceId?: string | null
  referenceType?: string | null
  notes?: string | null
  createdBy?: string | null
}

export interface StockBatch extends BaseEntity {
  productId: string
  storageId: string
  batchNumber: string
  quantity: number
  price: number
  costPrice: number
  currency: CurrencyCode
  expiryDate?: string | null
  manufacturingDate?: string | null
  notes?: string | null
  sourcePurchaseOrderId?: string | null
  sourcePurchaseOrderItemId?: string | null
}

export interface StockBatchAllocation {
  batchId: string
  batchNumber: string
  quantity: number
  price?: number | null
  costPrice?: number | null
  currency?: CurrencyCode | null
  expiryDate?: string | null
  manufacturingDate?: string | null
}

export interface InventoryTransferBatchAllocation {
  sourceBatchId: string
  destinationBatchId: string
  batchNumber: string
  quantity: number
  price?: number | null
  costPrice?: number | null
  currency?: CurrencyCode | null
  expiryDate?: string | null
  manufacturingDate?: string | null
}

export type DiscountType = 'percentage' | 'fixed_amount'
export type DiscountSource = 'product' | 'category'
export type ProductDiscountPriceScope = 'all' | 'native_only' | 'specific_price_books'

export interface ProductDiscount extends BaseEntity {
  productId: string
  discountType: DiscountType
  discountValue: number
  /** Controls which selling-price source this rule applies to. Legacy rules default to all. */
  priceScope?: ProductDiscountPriceScope
  /** Required only when priceScope is specific_price_books. */
  priceBookIds?: string[]
  /** Required for fixed discounts so an amount is never applied across currencies. */
  discountCurrency?: CurrencyCode | null
  startsAt: string
  endsAt: string
  minStockThreshold?: number | null
  isActive: boolean
  createdBy?: string
}

export interface CategoryDiscount extends BaseEntity {
  categoryId: string
  discountType: DiscountType
  discountValue: number
  startsAt: string
  endsAt: string
  minStockThreshold?: number | null
  isActive: boolean
  createdBy?: string
}

export interface ReorderTransferRule extends BaseEntity {
  productId: string
  sourceStorageId: string
  destinationStorageId: string
  minStockLevel: number
  transferQuantity: number
  expiresOn?: string | null
  isIndefinite: boolean
  lastTriggeredAt?: string | null
}

export type InventoryTransferTransactionType = 'manual' | 'automation'

export interface InventoryTransferTransaction extends BaseEntity {
  productId: string
  sourceStorageId: string
  destinationStorageId: string
  quantity: number
  batchAllocations?: InventoryTransferBatchAllocation[] | null
  transferType: InventoryTransferTransactionType
  reorderRuleId?: string | null
  sourceWorkspaceId?: string | null
  destinationWorkspaceId?: string | null
  sourceWorkspaceName?: string | null
  destinationWorkspaceName?: string | null
  sourceStorageName?: string | null
  destinationStorageName?: string | null
}

export interface Supplier extends BaseEntity {
  businessPartnerId?: string | null
  partnerName: string
  phone?: string
  address?: string
  city?: string
  defaultCurrency: CurrencyCode
  notes?: string
  totalPurchases: number
  totalSpent: number
  creditLimit: number
  isEcommerce?: boolean
}

export interface Customer extends BaseEntity {
  businessPartnerId?: string | null
  partnerName: string
  phone?: string
  address?: string
  city?: string
  defaultCurrency: CurrencyCode
  notes?: string
  totalOrders: number
  totalSpent: number
  outstandingBalance: number
  creditLimit: number
  isEcommerce?: boolean
}

export type RealEstateBusinessPartnerRole = 'buyer' | 'seller'
export type BusinessPartnerRole =
  'customer' | 'supplier' | 'both' | 'agent' | 'online_customer' | RealEstateBusinessPartnerRole
export type BusinessPartnerStaffVisibility = 'shared' | 'admin_only' | 'owner_private'
export type AgentType = 'driver' | 'field_agent' | 'courier'
export type AgentStatus = 'active' | 'inactive' | 'blocked'

export const REAL_ESTATE_BUSINESS_PARTNER_ROLES: readonly RealEstateBusinessPartnerRole[] = ['buyer', 'seller']

export function isRealEstateBusinessPartnerRole(
  role: BusinessPartnerRole | string | null | undefined
): role is RealEstateBusinessPartnerRole {
  return role === 'buyer' || role === 'seller'
}

export function isAgentBusinessPartnerRole(role: BusinessPartnerRole | string | null | undefined): role is 'agent' {
  return role === 'agent'
}

export interface Agent extends BaseEntity {
  businessPartnerId: string
  zone: string
  agentType: AgentType
  /** Fee the courier keeps for each successfully delivered post. */
  courierDeliveryFee?: number
  carModel?: string | null
  plateNumber?: string | null
  linkedUserId?: string | null
  /** Enables this agent to become the financial counterparty for sales made under its account. */
  salesAccountEnabled?: boolean
  status: AgentStatus
}

/** A product category an agent's linked user may view but cannot select. */
export interface AgentExcludedCategory extends BaseEntity {
  agentId: string
  categoryId: string
}

export interface AgentFacetInput {
  zone: string
  agentType: AgentType
  courierDeliveryFee?: number
  carModel?: string | null
  plateNumber?: string | null
  linkedUserId?: string | null
  salesAccountEnabled?: boolean
  status: AgentStatus
}

export type FleetVehicleStatus = 'active' | 'maintenance' | 'inactive'
export type FleetAssignmentStatus = 'active' | 'ended'

export interface FleetVehicle extends BaseEntity {
  plateNumber: string
  make?: string | null
  model: string
  year?: number | null
  color?: string | null
  vin?: string | null
  status: FleetVehicleStatus
  notes?: string | null
}

export interface FleetVehicleAssignment extends BaseEntity {
  vehicleId: string
  agentId: string
  assignedAt: string
  endedAt?: string | null
  status: FleetAssignmentStatus
  notes?: string | null
}

export type FleetLocationSessionStatus = 'active' | 'stopped' | 'expired'

export interface FleetLocationSession {
  id: string
  workspaceId: string
  agentId: string
  userId: string
  status: FleetLocationSessionStatus
  startedAt: string
  endedAt?: string | null
  lastSeenAt?: string | null
  deviceLabel?: string | null
}

export interface FleetLocationPoint {
  id?: string
  workspaceId: string
  agentId: string
  sessionId: string
  userId: string
  latitude: number
  longitude: number
  accuracy?: number | null
  heading?: number | null
  speed?: number | null
  altitude?: number | null
  recordedAt: string
  receivedAt?: string
  isSharing: boolean
}

/**
 * Delivery profiles extend an existing business partner.  They deliberately do
 * not create a second merchant/customer directory: a merchant is still one
 * of the workspace's commercial partners.
 */
export interface DeliveryMerchantProfile extends BaseEntity {
  businessPartnerId: string
  defaultFeeAmount: number
  defaultFeePayer: DeliveryFeePayer
  defaultPickupAddress?: string | null
  payoutSchedule: DeliveryPayoutSchedule
  isActive: boolean
}

export type DeliveryFeePayer = 'merchant' | 'recipient'
/** Whether the courier must collect the COD amount from the recipient. */
export type DeliveryCustomerPaymentStatus = 'cash_on_delivery' | 'prepaid_electronically'
/** Who advances a recipient payout before the merchant reimburses the workspace. */
export type DeliveryRecipientPayoutFunding = 'courier_advance' | 'workspace_payment'
export type DeliveryPayoutSchedule = 'daily' | 'weekly' | 'on_request'
export type DeliveryShipmentStatus = 'received' | 'assigned' | 'delivered' | 'postponed' | 'returned' | 'cancelled'
export type DeliveryShipmentCodAdjustmentRequestStatus = 'pending' | 'approved' | 'rejected'
export type DeliveryRunStatus = 'open' | 'closed' | 'cancelled'
export type DeliverySettlementType =
  'courier_remittance' | 'courier_fee_payout' | 'courier_reimbursement' | 'merchant_payout' | 'merchant_repayment'

export interface DeliveryShipment extends BaseEntity {
  trackingNumber: string
  merchantProfileId: string
  merchantBusinessPartnerId: string
  /**
   * The recipient's required, primary identifier for a delivery post.
   *
   * Legacy recipient-name, alternate-phone, and city fields were removed
   * from the remote contract. The full location lives in recipientAddress.
   */
  recipientPhone: string
  recipientAddress: string
  recipientLatitude?: number | null
  recipientLongitude?: number | null
  description?: string | null
  currency: CurrencyCode
  /** Zero for an electronically prepaid delivery. */
  codAmount: number
  customerPaymentStatus: DeliveryCustomerPaymentStatus
  /** Amount paid to the recipient when the post is delivered. */
  recipientPayoutAmount: number
  /** Courier advances are reimbursed later; workspace payments are paid immediately. */
  recipientPayoutFunding: DeliveryRecipientPayoutFunding
  recipientPayoutPaymentTransactionId?: string | null
  deliveryFee: number
  /** Courier fee snapshot from the manifest; charged only on delivery. */
  courierDeliveryFee?: number
  feePayer: DeliveryFeePayer
  status: DeliveryShipmentStatus
  assignedAgentId?: string | null
  assignedRunId?: string | null
  deliveredAt?: string | null
  postponedAt?: string | null
  returnedAt?: string | null
  /** When the workspace physically received a returned package from its courier. */
  returnReceivedAt?: string | null
  statusNote?: string | null
  sourceSalesOrderId?: string | null
  createdBy?: string | null
}

export type DeliveryShipmentEventAction = 'status_change' | 'return_received'

/** Immutable log of every operational change to a shipment. */
export interface DeliveryShipmentEvent extends BaseEntity {
  shipmentId: string
  previousStatus?: DeliveryShipmentStatus | null
  status: DeliveryShipmentStatus
  /** Legacy events omit this and are treated as status changes. */
  action?: DeliveryShipmentEventAction
  note?: string | null
  /** Private `voice` bucket path for a returned/postponed reason. */
  voiceReasonPath?: string | null
  /** Duration of the FLAC reason recording, retained for secure playback UX. */
  voiceReasonDurationMs?: number | null
  actorUserId?: string | null
  actorAgentId?: string | null
  occurredAt: string
}

export interface DeliveryRun extends BaseEntity {
  runNumber: string
  agentId: string
  /** Per-delivered-post courier fee captured when the manifest was created. */
  courierDeliveryFee?: number
  vehicleId?: string | null
  status: DeliveryRunStatus
  dispatchedAt: string
  closedAt?: string | null
  notes?: string | null
  createdBy?: string | null
}

/** Retains manifest history even when a shipment is later sent with another courier. */
export interface DeliveryRunItem extends BaseEntity {
  runId: string
  shipmentId: string
  assignedAt: string
  returnedAt?: string | null
}

/**
 * The header represents real cash movement. The associated custody and
 * merchant ledger entries remain the source for the two derived balances.
 */
export interface DeliverySettlement extends BaseEntity {
  settlementNumber: string
  type: DeliverySettlementType
  agentId?: string | null
  merchantProfileId?: string | null
  businessPartnerId?: string | null
  shipmentId?: string | null
  currency: CurrencyCode
  /** Per-post courier cost snapshot; zero for legacy or whole-party settlements. */
  courierDeliveryFee?: number
  expectedAmount: number
  actualAmount: number
  varianceAmount: number
  varianceNote?: string | null
  paymentMethod: WorkspacePaymentMethod
  settledAt: string
  note?: string | null
  paymentTransactionId?: string | null
  createdBy?: string | null
}

export type DeliveryLedgerEntryKind =
  | 'courier_collection'
  | 'courier_cod_correction'
  | 'courier_recipient_payout_correction'
  | 'courier_delivery_fee'
  | 'courier_recipient_advance'
  | 'courier_remittance'
  | 'courier_fee_payout'
  | 'courier_reimbursement'
  | 'merchant_cod_payable'
  | 'merchant_cod_correction'
  | 'merchant_recipient_payout_correction'
  | 'merchant_fee'
  | 'merchant_recipient_payout'
  | 'merchant_payout'
  | 'merchant_repayment'
  | 'adjustment'

/**
 * A signed entry in either the courier-custody or merchant-payable view.
 * Positive `amount` increases what the named party is responsible for;
 * negative entries reduce it. Entries are never edited after creation.
 */
export interface DeliveryLedgerEntry extends BaseEntity {
  kind: DeliveryLedgerEntryKind
  shipmentId?: string | null
  /** Links a delivered-COD adjustment to its immutable audit record. */
  codCorrectionId?: string | null
  /** Links a delivered recipient-payout correction to its immutable audit record. */
  recipientPayoutCorrectionId?: string | null
  settlementId?: string | null
  agentId?: string | null
  merchantProfileId?: string | null
  businessPartnerId?: string | null
  amount: number
  currency: CurrencyCode
  occurredAt: string
  note?: string | null
  createdBy?: string | null
}

export interface BusinessPartner extends BaseEntity {
  /**
   * Canonical, user-facing identity for a business partner.
   *
   * The pre-migration `name` and `contactName` values are intentionally not
   * represented here. They remain in storage as historical metadata only.
   */
  partnerName: string
  phone?: string
  address?: string
  city?: string
  defaultCurrency: CurrencyCode
  notes?: string
  role: BusinessPartnerRole
  /** @deprecated Compatibility field for rows created before directional limits. */
  creditLimit: number
  receivableCreditLimit: number | null
  payableCreditLimit: number | null
  customerFacetId?: string | null
  supplierFacetId?: string | null
  agentFacetId?: string | null
  totalSalesOrders: number
  totalSalesValue: number
  receivableBalance: number
  totalPurchaseOrders: number
  totalPurchaseValue: number
  payableBalance: number
  totalLoanCount: number
  loanOutstandingBalance: number
  netExposure: number
  mergedIntoBusinessPartnerId?: string | null
  isEcommerce?: boolean
  latitude?: number | null
  longitude?: number | null
  priceBookId?: string | null
  /** Controls non-admin visibility. Missing values from old caches are shared. */
  staffVisibility?: BusinessPartnerStaffVisibility
  /** The sole non-admin who may see an owner-private partner. */
  ownerUserId?: string | null
}

export type BusinessPartnerMergeType = 'customer_supplier'
export type BusinessPartnerMergeStatus = 'pending' | 'accepted' | 'dismissed'

export interface BusinessPartnerMergeCandidate extends BaseEntity {
  primaryPartnerId: string
  secondaryPartnerId: string
  mergeType: BusinessPartnerMergeType
  reason: string
  confidence: number
  status: BusinessPartnerMergeStatus
}

export type SalesOrderStatus = 'draft' | 'pending' | 'completed' | 'cancelled'
export type PurchaseOrderStatus = 'draft' | 'ordered' | 'received' | 'completed' | 'cancelled'
export type OrderType = 'sales' | 'purchase'
export type OrderApprovalStatus = 'requested' | 'approved' | 'rejected'
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid'
export type OrderPaymentMethod = PaymentMethod | 'bank_transfer' | 'loan' | 'installments'
export type OrderAdjustmentType = 'addition' | 'deduction'
export type OrderAdjustmentScope = 'order' | 'post_return'
export type WorkspaceVisibility = 'private' | 'public' | 'link_only'
export type MarketplaceOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled'

export interface ExchangeRateSnapshot {
  pair: string
  rate: number
  source: string
  timestamp: string
  side?: ExchangeTransactionType
  priceBasisAmount?: number
  priceRowId?: string | null
  priceUpdatedAt?: string | null
}

export interface SalesExchange {
  id: string
  saleId: string
  workspaceId: string
  baseCurrency: CurrencyCode
  quoteCurrency: CurrencyCode
  baseAmount: number
  quoteAmount: number
  source: string
  capturedAt: string
  rateSide: 'buy' | 'sell' | 'mid'
  sourcePriceId?: string | null
  sourcePriceUpdatedAt?: string | null
  createdAt: string
}

export interface OrderLineItem {
  id: string
  productId: string
  /** Optional note recorded for this individual order line. */
  note?: string | null
  priceBookId?: string | null
  priceBookItemId?: string | null
  storageId?: string | null
  productName: string
  productSku: string
  /** Product unit at the time this line was added, retained for accurate historical prints. */
  unit?: string | null
  /** Display-only unit override for the free bonus quantity. Never affects logic, which always uses `unit`. */
  freeBonusUnit?: string | null
  quantity: number
  freeBonusQuantity?: number | null
  lineTotal: number
  originalCurrency: CurrencyCode
  originalUnitPrice: number
  convertedUnitPrice: number
  settlementCurrency: CurrencyCode
}

export interface SalesOrderItem extends OrderLineItem {
  costPrice: number
  convertedCostPrice: number
  /** Cumulative quantity returned from this line. The immutable return rows remain the source of truth. */
  returnedQuantity?: number
  reservedQuantity?: number
  fulfilledQuantity?: number
  batchAllocations?: StockBatchAllocation[] | null
}

export interface PurchaseOrderItem extends OrderLineItem {
  receivedQuantity?: number
  batchNumber?: string | null
  batchSalePrice?: number | null
  batchExpiryDate?: string | null
  batchManufacturingDate?: string | null
}

/**
 * A confirmed commercial adjustment applied to an order total. `amount` is
 * kept in the currency selected by the user, while `convertedAmount` is the
 * locked value that is applied to the order total in `orderCurrency`.
 */
export interface OrderAdjustment {
  id: string
  type: OrderAdjustmentType
  name: string
  currency: CurrencyCode
  amount: number
  orderCurrency: CurrencyCode
  convertedAmount: number
  /** The applied amount in order currency for one unit of `currency`. */
  exchangeRate: number
  exchangeRateSource: string
  exchangeRateTimestamp: string
  /** The rate snapshot(s) used to lock this adjustment's conversion. */
  exchangeRates: ExchangeRateSnapshot[]
  /**
   * Standard adjustments belong to the sale itself. A post-return adjustment
   * is immutable and tied to one posted return record.
   */
  scope?: OrderAdjustmentScope
  returnId?: string | null
  notes?: string | null
  createdAt?: string | null
  createdBy?: string | null
}

/** Stable, user-defined commission-level key. The plan name is its visible label. */
export type CommissionPlanLevel = string
export type CommissionCalculationBasis = 'net_profit' | 'net_revenue'
export type CommissionPlanType = 'fixed_amount' | 'percentage'
/** A workspace-wide presentation structure for the sales-agent commission sheet. */
export type SalesAgentCommissionSheetType = 'normal' | 'tier_based'
export type ManualSalesAgentCommissionType = CommissionPlanType
/** Product rules use the same fixed/percentage terms as commission plans. */
export type ProductCommissionRecipientScope = 'all_assigned' | 'selected_assigned'
export type CommissionEntryKind = 'estimate' | 'accrual' | 'approval' | 'reversal' | 'payout' | 'adjustment'
export type CommissionEntryStatus = 'estimated' | 'earned' | 'approved' | 'paid' | 'reversed'
export type SalesOrderAgentAssignmentSource = 'manual' | 'sales_account' | 'order_creator_product'

/** Effective-dated commission terms. No commission fields are added to Agent. */
export interface AgentCommissionPlan extends BaseEntity {
  name: string
  level: CommissionPlanLevel
  /** Legacy plans without this field are treated as percentage plans. */
  commissionType?: CommissionPlanType
  ratePercent: number
  /** Required for fixed-amount plans and stored in the selected source currency. */
  fixedAmount?: number | null
  fixedCurrency?: CurrencyCode | null
  /** Informational workspace tier. It does not change commission calculations yet. */
  tierName?: string | null
  calculationBasis: CommissionCalculationBasis
  includeTax: boolean
  includeDeliveryCharge: boolean
  effectiveFrom: string
  effectiveTo?: string | null
  isActive: boolean
  notes?: string | null
  createdBy?: string | null
}

/** Effective-dated link between an existing field agent and a commission plan. */
export interface AgentCommissionMembership extends BaseEntity {
  agentId: string
  planId: string
  effectiveFrom: string
  effectiveTo?: string | null
  assignedBy?: string | null
  endedBy?: string | null
  notes?: string | null
}

/**
 * Product-level commission terms. Rules are effective-dated and are never
 * rewritten after they have been used by an order: editing creates a new
 * revision so historical sales retain their original terms.
 */
export interface ProductCommissionRule extends BaseEntity {
  productId: string
  commissionType: CommissionPlanType
  /** Percentage uses net line revenue; fixed amounts use `fixedCurrency`. */
  ratePercent: number
  fixedAmount?: number | null
  fixedCurrency?: CurrencyCode | null
  recipientScope: ProductCommissionRecipientScope
  effectiveFrom: string
  effectiveTo?: string | null
  isActive: boolean
  notes?: string | null
  createdBy?: string | null
}

/** Selected recipients for a product rule. All-assigned rules deliberately have no rows here. */
export interface ProductCommissionRuleAgent extends BaseEntity {
  ruleId: string
  agentId: string
}

/** Historical sales attribution; an order can have one active assignment per field agent. */
export interface SalesOrderAgentAssignment extends BaseEntity {
  orderId: string
  agentId: string
  /** Whether a user selected this beneficiary or it was derived from order attribution. */
  assignmentSource?: SalesOrderAgentAssignmentSource
  assignedAt: string
  unassignedAt?: string | null
  assignedBy?: string | null
  unassignedBy?: string | null
  reassignmentReason?: string | null
  previousAssignmentId?: string | null
  customerCitySnapshot?: string | null
  deliveryChargeAmount: number
  internalDeliveryCostAmount: number
  /**
   * Optional order-only commission fallback or plan-amount override. Fixed
   * amounts retain the original input currency and a locked conversion into
   * the order currency without changing the workspace commission plan.
   */
  manualCommissionType?: ManualSalesAgentCommissionType | null
  manualCommissionSourceAmount?: number | null
  manualCommissionSourceCurrency?: CurrencyCode | null
  manualCommissionConvertedAmount?: number | null
  manualCommissionExchangeRate?: number | null
  manualCommissionExchangeRateSource?: string | null
  manualCommissionExchangeRateTimestamp?: string | null
  manualCommissionExchangeRates?: ExchangeRateSnapshot[] | null
}

// Car Rental Service
// Rental vehicles intentionally live apart from Fleet Management: Fleet is an
// internal assignment and location domain, while these records are rented to
// customers and must carry availability and contract history.
export type RentalVehicleStatus = 'available' | 'maintenance' | 'inactive'
export type RentalRequestStatus = 'new' | 'contacted' | 'offered' | 'converted' | 'rejected' | 'cancelled' | 'expired'
export type RentalContractStatus = 'draft' | 'reserved' | 'active' | 'returned' | 'closed' | 'cancelled'
export type RentalPaymentKind = 'rental' | 'deposit' | 'deposit_refund'

export interface RentalVehicle extends BaseEntity {
  plateNumber: string
  make?: string | null
  model: string
  year?: number | null
  color?: string | null
  vin?: string | null
  category?: string | null
  dailyRate: number
  currency: CurrencyCode
  currentOdometer?: number | null
  currentFuelLevel?: string | null
  status: RentalVehicleStatus
  notes?: string | null
}

export interface RentalRequest extends BaseEntity {
  requestNo: string
  customerName: string
  customerPhone: string
  businessPartnerId?: string | null
  preferredVehicleId?: string | null
  requestedStartAt: string
  requestedEndAt: string
  status: RentalRequestStatus
  notes?: string | null
  convertedContractId?: string | null
  createdBy?: string | null
}

export interface RentalContract extends BaseEntity {
  contractNo: string
  requestId?: string | null
  vehicleId: string
  customerName: string
  customerPhone: string
  businessPartnerId?: string | null
  driverLicenseNo?: string | null
  plannedPickupAt: string
  plannedReturnAt: string
  actualPickupAt?: string | null
  actualReturnAt?: string | null
  dailyRate: number
  rentalDays: number
  discountAmount: number
  rentalAmount: number
  returnAdjustmentAmount: number
  finalAmount: number
  depositAmount: number
  currency: CurrencyCode
  status: RentalContractStatus
  handoverOdometer?: number | null
  handoverFuelLevel?: string | null
  handoverCondition?: string | null
  returnOdometer?: number | null
  returnFuelLevel?: string | null
  returnCondition?: string | null
  notes?: string | null
  createdBy?: string | null
}

/** Append-only commission event. Financial events use signed `amount` values. */
export interface AgentCommissionEntry extends BaseEntity {
  orderId?: string | null
  assignmentId?: string | null
  agentId: string
  membershipId?: string | null
  planId?: string | null
  orderReturnId?: string | null
  relatedEntryId?: string | null
  kind: CommissionEntryKind
  status: CommissionEntryStatus
  currency: CurrencyCode
  calculationBasis: CommissionCalculationBasis
  includeTax: boolean
  includeDeliveryCharge: boolean
  basisAmount: number
  revenueAmount: number
  costAmount: number
  taxAmount: number
  deliveryChargeAmount: number
  ratePercent: number
  /** Split snapshots keep product incentives explainable without changing the payable amount. */
  planCommissionAmount?: number | null
  productCommissionAmount?: number | null
  amount: number
  occurredAt: string
  payoutReference?: string | null
  /** Payouts are either historical/manual records or generated once an order is fully paid. */
  settlementSource?: 'manual' | 'automatic'
  notes?: string | null
  createdBy?: string | null
}

/**
 * Immutable commission snapshot for one order item and one credited agent.
 * It is the explanation layer for product commission; the aggregate
 * `AgentCommissionEntry` remains the payable liability/payout ledger.
 */
export interface AgentProductCommissionEntry extends BaseEntity {
  orderId: string
  assignmentId: string
  agentId: string
  orderItemId: string
  productId: string
  productNameSnapshot: string
  productSkuSnapshot?: string | null
  unitSnapshot?: string | null
  ruleId?: string | null
  orderReturnId?: string | null
  relatedEntryId?: string | null
  kind: 'accrual' | 'reversal' | 'adjustment'
  status: 'earned' | 'reversed'
  currency: CurrencyCode
  commissionType: CommissionPlanType
  ratePercent: number
  fixedSourceAmount?: number | null
  fixedSourceCurrency?: CurrencyCode | null
  fixedConversionRate?: number | null
  fixedExchangeRateSource?: string | null
  fixedExchangeRateTimestamp?: string | null
  fixedExchangeRates?: ExchangeRateSnapshot[] | null
  /** Signed quantity: sold is positive, returned/reversed is negative. */
  quantity: number
  /** Locked net line-revenue basis for exactly one product unit. */
  basisAmountPerUnit: number
  /** Locked commission amount for exactly one product unit. */
  commissionPerUnit: number
  /** Signed `quantity * commissionPerUnit`, retained for audit and statements. */
  amount: number
  occurredAt: string
  notes?: string | null
  createdBy?: string | null
}

export interface CommissionCalculation {
  currency: CurrencyCode
  revenueAmount: number
  costAmount: number
  taxAmount: number
  deliveryChargeAmount: number
  basisAmount: number
  ratePercent: number
  commissionAmount: number
}

export interface SalesOrder extends BaseEntity {
  orderNumber: string
  businessPartnerId?: string | null
  customerId: string
  customerName: string
  /** Agent whose enabled sales account is the financial counterparty for this order. */
  salesAccountAgentId?: string | null
  /**
   * Whether this order should create commission attribution. Sales-account
   * orders can still be recorded without crediting a commission beneficiary.
   * Older orders intentionally behave as enabled.
   */
  commissionEnabled?: boolean
  sourceStorageId?: string | null
  items: SalesOrderItem[]
  subtotal: number
  discount: number
  tax: number
  total: number
  currency: CurrencyCode
  orderAdjustments?: OrderAdjustment[]
  exchangeRate: number | null
  exchangeRateSource: string | null
  exchangeRateTimestamp: string | null
  exchangeRates?: ExchangeRateSnapshot[] | null
  status: SalesOrderStatus
  approvalStatus?: OrderApprovalStatus | null
  approvalRequestedBy?: string | null
  approvalRequestedAt?: string | null
  approvalReviewedBy?: string | null
  approvalReviewedAt?: string | null
  expectedDeliveryDate?: string | null
  actualDeliveryDate?: string | null
  isPaid: boolean
  paymentStatus: OrderPaymentStatus
  paidAmount: number
  balanceAmount: number
  paidAt?: string | null
  paymentMethod?: OrderPaymentMethod
  initialPaymentAmount: number
  /** Account selected for the first posted order payment, if any. */
  initialPaymentAccountId?: string | null
  initialPaymentAccountNameSnapshot?: string | null
  linkedLoanId?: string | null
  isInstallmentBased: boolean
  installmentCount: number
  installmentFrequency?: InstallmentFrequency | null
  firstDueDate?: string | null
  nextDueDate?: string | null
  reservedAt?: string | null
  shippingAddress?: string
  notes?: string
  isLocked?: boolean
  sourceChannel?: 'manual' | 'marketplace' | null
  marketplaceOrderId?: string | null
  /** Original monetary total retained after the first posted return. */
  originalTotalAmount?: number | null
  /** Cumulative monetary value of all posted returns. */
  returnedAmount?: number
  returnStatus?: 'none' | 'partial' | 'full'
  returnedAt?: string | null
  returnedBy?: string | null
  createdBy?: string | null
}

export interface PurchaseOrder extends BaseEntity {
  orderNumber: string
  businessPartnerId?: string | null
  supplierId: string
  supplierName: string
  destinationStorageId?: string | null
  items: PurchaseOrderItem[]
  subtotal: number
  discount: number
  total: number
  currency: CurrencyCode
  orderAdjustments?: OrderAdjustment[]
  exchangeRate: number | null
  exchangeRateSource: string | null
  exchangeRateTimestamp: string | null
  exchangeRates?: ExchangeRateSnapshot[] | null
  status: PurchaseOrderStatus
  approvalStatus?: OrderApprovalStatus | null
  approvalRequestedBy?: string | null
  approvalRequestedAt?: string | null
  approvalReviewedBy?: string | null
  approvalReviewedAt?: string | null
  expectedDeliveryDate?: string | null
  actualDeliveryDate?: string | null
  isPaid: boolean
  paymentStatus: OrderPaymentStatus
  paidAmount: number
  balanceAmount: number
  paidAt?: string | null
  paymentMethod?: OrderPaymentMethod
  initialPaymentAmount: number
  /** Account selected for the first posted order payment, if any. */
  initialPaymentAccountId?: string | null
  initialPaymentAccountNameSnapshot?: string | null
  linkedLoanId?: string | null
  isInstallmentBased: boolean
  installmentCount: number
  installmentFrequency?: InstallmentFrequency | null
  firstDueDate?: string | null
  nextDueDate?: string | null
  notes?: string
  isLocked?: boolean
  createdBy?: string | null
}

export interface OrderInstallment extends BaseEntity {
  orderType: OrderType
  orderId: string
  installmentNo: number
  dueDate: string
  plannedAmount: number
  paidAmount: number
  balanceAmount: number
  status: InstallmentStatus
  paidAt?: string | null
}

export interface MarketplaceOrderItem {
  productId: string
  storageId?: string | null
  name: string
  sku: string
  unitPrice: number
  currency: CurrencyCode
  quantity: number
  lineTotal: number
  imageUrl?: string | null
}

export interface MarketplaceOrder extends BaseEntity {
  orderNumber: string
  orderSequence: number
  customerName: string
  customerPhone: string
  customerEmail?: string | null
  customerAddress?: string | null
  customerCity?: string | null
  customerNotes?: string | null
  items: MarketplaceOrderItem[]
  subtotal: number
  total: number
  currency: CurrencyCode
  status: MarketplaceOrderStatus
  confirmedAt?: string | null
  processingAt?: string | null
  shippedAt?: string | null
  deliveredAt?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  inventoryDeducted: boolean
  businessPartnerId?: string | null
  customerId?: string | null
  salesOrderId?: string | null
}

export type RealEstateTransactionType = 'sell' | 'buy' | 'rent' | 'lease' | 'exchange'

export type RealEstatePropertyType =
  'house' | 'apartment' | 'land' | 'commercial' | 'villa' | 'office' | 'warehouse' | 'other'
export type RealEstateTransactionStatus = 'active' | 'overdue' | 'completed'
export type RealEstatePaymentKind = 'down_payment' | 'installment' | 'manual'

export interface RealEstateTransaction extends BaseEntity {
  transactionNo: string
  transactionType: RealEstateTransactionType
  propertyType?: RealEstatePropertyType | null
  location: string
  landAreaM2: number
  currency: CurrencyCode
  totalAmount: number
  paidAmount: number
  balanceAmount: number
  profitAmount: number
  buyerName: string
  buyerBusinessPartnerId?: string | null
  buyerWitnessName?: string | null
  buyerWitnessAddress?: string | null
  buyerWitnessPhone?: string | null
  sellerName: string
  sellerBusinessPartnerId?: string | null
  sellerWitnessName?: string | null
  sellerWitnessAddress?: string | null
  sellerWitnessPhone?: string | null
  isInstallmentBased: boolean
  installmentCount: number
  installmentFrequency?: InstallmentFrequency | null
  firstDueDate?: string | null
  nextDueDate?: string | null
  status: RealEstateTransactionStatus
  exchangeRateSnapshot?: ExchangeRateSnapshot[] | null
  notes?: string | null
  createdBy?: string | null
}

export interface RealEstateInstallment extends BaseEntity {
  transactionId: string
  installmentNo: number
  dueDate: string
  plannedAmount: number
  paidAmount: number
  balanceAmount: number
  status: InstallmentStatus
  paidAt?: string | null
}

export interface RealEstatePayment extends BaseEntity {
  transactionId: string
  installmentId?: string | null
  amount: number
  paymentMethod: WorkspacePaymentMethod
  paymentKind: RealEstatePaymentKind
  paidAt: string
  note?: string | null
  createdBy?: string | null
}

/** Workflow states for a Travel & Transportation booking. */
export type TravelBookingStatus = 'draft' | 'booked' | 'partially_paid' | 'completed' | 'cancelled'
export type TravelTransportationType = 'flight' | 'bus'

/**
 * The booking header deliberately keeps passenger value separate from profit.
 * `passengerTotal` and `bookingTotal` are the raw sum of passenger prices.
 * `adjustedBookingTotal` is the separate result after confirmed booking
 * adjustments. None of these values is a cash collection.
 */
export interface TravelBooking extends BaseEntity {
  bookingNumber: string
  currency: CurrencyCode
  travelDate?: string | null
  passengerTotal: number
  bookingTotal: number
  adjustedBookingTotal: number
  bookingAdjustments?: OrderAdjustment[] | null
  profitAmount: number
  paidProfitAmount: number
  outstandingProfitAmount: number
  paymentMethod: WorkspacePaymentMethod
  status: TravelBookingStatus
  notes?: string | null
  createdBy?: string | null
}

/** A passenger belongs to exactly one Travel & Transportation booking. */
export interface TravelPassenger extends BaseEntity {
  bookingId: string
  name: string
  transportationType: TravelTransportationType
  price: number
}

export type ActivityTransactionStatus = 'completed' | 'cancelled' | 'refunded'

/** A workspace-owned activity/service that can be sold from the Activities module. */
export interface ActivityCatalogItem extends BaseEntity {
  name: string
  /** Optional activity image, stored as a local path, data URL, or cloud path. */
  imageUrl?: string | null
  defaultUnitPrice: number
  /** Stored with the price so a later workspace-currency change is explicit. */
  currency: CurrencyCode
  /** Infinite activities never consume availability. */
  isInfinite: boolean
  /** Required for finite activities and null for infinite activities. */
  availableQuantity?: number | null
  isActive: boolean
  createdBy?: string | null
}

export interface ActivityTransaction extends BaseEntity {
  transactionNo: string
  name: string
  customerName?: string | null
  occurredAt: string
  currency: CurrencyCode
  paymentMethod: WorkspacePaymentMethod
  subtotalAmount: number
  totalAmount: number
  status: ActivityTransactionStatus
  notes?: string | null
  createdBy?: string | null
  cancelledAt?: string | null
  refundedAt?: string | null
}

export interface ActivityTransactionLine extends BaseEntity {
  transactionId: string
  activityId: string
  activityNameSnapshot: string
  catalogUnitPriceSnapshot: number
  unitPrice: number
  priceOverridden: boolean
  quantity: number
  lineTotal: number
}

export type ExchangeTransactionType = 'buy' | 'sell'
export type ExchangeFeeType = 'fixed' | 'percentage'
export type ExchangeFeeRuleTransactionScope = 'buy' | 'sell' | 'both'
export type ExchangeAcquisitionRateSource = 'last_buy' | 'manual'
export type ExchangeSafeMovementType = 'opening_balance' | 'adjustment' | 'exchange_in' | 'exchange_out'
export type ExchangeSafeMovementSourceType = 'opening_balance' | 'adjustment' | 'exchange_transaction'
export type ExchangePaymentMethod = 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay'

export interface ExchangeFeeRuleSnapshot {
  id: string
  name: string
  transactionScope: ExchangeFeeRuleTransactionScope
  feeType: ExchangeFeeType
  currency: CurrencyCode
  value: number
  customerGivesBasisAmount: number
  effectiveStartDate: string
  effectiveEndDate?: string | null
  isLocked: boolean
}

export interface ExchangeFeeRule extends BaseEntity {
  name: string
  transactionScope: ExchangeFeeRuleTransactionScope
  feeType: ExchangeFeeType
  currency: CurrencyCode
  value: number
  customerGivesBasisAmount: number
  effectiveStartDate: string
  effectiveEndDate?: string | null
  isActive: boolean
  isLocked: boolean
  notes?: string | null
  createdBy?: string | null
}

export interface ExchangePairPrice extends BaseEntity {
  baseCurrency: CurrencyCode
  quoteCurrency: CurrencyCode
  buyPrice: number
  sellPrice: number
  priceBasisAmount: number
  createdBy?: string | null
  updatedBy?: string | null
}

export interface ExchangeTransaction extends BaseEntity {
  transactionNo: string
  transactionType: ExchangeTransactionType
  transactionDate: string
  fromCurrency: CurrencyCode
  toCurrency: CurrencyCode
  customerGivesAmount: number
  customerReceivesAmount: number
  exchangeRateUsed: number
  exchangeRateSource: string
  exchangeRateManuallyEdited: boolean
  marketRateSnapshot: ExchangeRateSnapshot[]
  feeRuleId?: string | null
  feeRuleSnapshot?: ExchangeFeeRuleSnapshot | null
  feeType?: ExchangeFeeType | null
  feeCurrency?: CurrencyCode | null
  originalFeeValue?: number | null
  finalFeeValue: number
  feeAmount: number
  feeEdited: boolean
  safeId?: string | null
  safeNameSnapshot?: string | null
  acquisitionRate?: number | null
  acquisitionRateSource?: ExchangeAcquisitionRateSource | null
  acquisitionRateSnapshot?: ExchangeRateSnapshot[] | null
  profitAmount?: number | null
  profitCurrency?: CurrencyCode | null
  paymentMethod: ExchangePaymentMethod
  employeeUserId?: string | null
  employeeName?: string | null
  notes?: string | null
  createdBy?: string | null
  isReversed: boolean
  reversalTransactionId?: string | null
  reversedTransactionId?: string | null
}

export interface ExchangeSafe extends BaseEntity {
  name: string
  isActive: boolean
  notes?: string | null
  createdBy?: string | null
}

export interface ExchangeSafeBalance extends BaseEntity {
  safeId: string
  currency: CurrencyCode
  balanceAmount: number
}

export interface ExchangeSafeMovement extends BaseEntity {
  safeId: string
  safeNameSnapshot: string
  currency: CurrencyCode
  movementType: ExchangeSafeMovementType
  sourceType: ExchangeSafeMovementSourceType
  sourceId?: string | null
  deltaAmount: number
  balanceBefore: number
  balanceAfter: number
  notes?: string | null
  createdBy?: string | null
}

export type ClinicalAppointmentStatus =
  'draft' | 'booked' | 'arrived' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'

export type ClinicalConfirmationMethod = 'phone' | 'sms' | 'whatsapp' | 'email' | 'other'

export type ClinicalAppointmentPriority = 'normal' | 'urgent' | 'emergency'

export type ClinicalAppointmentPaymentStatus = 'no_fee' | 'unpaid' | 'partial' | 'paid'

export type ClinicalAppointmentType = 'consultation' | 'follow_up' | 'emergency' | 'checkup' | 'procedure' | 'treatment'

export type ClinicalPatientType = 'new' | 'existing'

export type ClinicalPresetCategory = 'reason_for_visit' | 'appointment_type' | 'registry_type'

export type ClinicalRegistryType = 'medical' | 'beauty' | 'beauty2'
export type UserSelectableClinicalRegistryType = Exclude<ClinicalRegistryType, 'beauty2'>

export interface ClinicalPreset extends BaseEntity {
  category: ClinicalPresetCategory
  name: string
  consultationFee: number
  sortOrder: number
  isActive: boolean
  createdBy?: string | null
}

export type ManualEntryTemplateStatus = 'active' | 'inactive'

export interface ManualEntryTemplateRow {
  id: string
  label: string
  sortOrder: number
}

export interface ManualEntryTemplate extends BaseEntity {
  name: string
  headerName?: string
  headerPhone1?: string
  headerPhone2?: string
  detailsLabel1?: string
  detailsLabel2?: string
  detailsLabel3?: string
  rows: ManualEntryTemplateRow[]
  status: ManualEntryTemplateStatus
  createdBy?: string | null
}

export interface ManualEntry extends BaseEntity {
  templateId: string
  templateName: string
  rows: ManualEntryTemplateRow[]
  data: Record<string, string[]>
  detailValues: Record<string, string>
}

export interface ClinicalPatient extends BaseEntity {
  name: string
  phone?: string | null
  email?: string | null
  isNewPatient: boolean
  notes?: string | null
  createdBy?: string | null
  birthYear?: number | null
}

export interface ClinicalAppointment extends BaseEntity {
  appointmentNumber?: string | null
  issueDate?: string | null
  nextVisitDate?: string | null
  receivedFromName?: string | null
  amountIqd?: number | null
  amountUsd?: number | null
  calculatedAmount?: number | null
  calculatedAmountCurrency?: Extract<CurrencyCode, 'iqd' | 'usd'> | null
  patientId: string
  patientName: string
  patientPhone?: string | null
  isNewPatient: boolean
  appointmentDate: string
  startTime: string
  appointmentType: ClinicalAppointmentType
  reasonForVisit?: string | null
  serviceProcedure?: string | null
  consultationFee: number
  estimatedPrice: number
  currency: CurrencyCode
  paidAmount: number
  paymentStatus: ClinicalAppointmentPaymentStatus
  status: ClinicalAppointmentStatus
  confirmationMethod?: ClinicalConfirmationMethod | null
  priority: ClinicalAppointmentPriority
  internalNotes?: string | null
  createdBy?: string | null
  sentByName?: string | null
  sentByPartnerId?: string | null
}

export interface ClinicalAttachment extends BaseEntity {
  appointmentId: string
  fileName: string
  fileType: string
  fileSize: number
  r2Path?: string | null
  localPath?: string | null
  createdBy?: string | null
}

export interface Employee extends BaseEntity {
  name: string
  email?: string
  phone?: string
  gender?: 'male' | 'female' | 'other'
  role: string // Internal labeling role. Format: "Category:Role" (e.g. "Management:Manager", "Staff:Salesman")
  location?: string
  joiningDate: string
  salary: number
  salaryCurrency: CurrencyCode
  hasDividends?: boolean
  dividendType?: 'fixed' | 'percentage'
  dividendAmount?: number
  dividendCurrency?: CurrencyCode
  salaryPayday?: number
  dividendPayday?: number
  isFired?: boolean
  linkedUserId?: string
}

export type BudgetStatus = 'pending' | 'snoozed' | 'paid'
export type ExpenseRecurrence = 'monthly' | 'one_time'

export interface BudgetSettings extends BaseEntity {
  startMonth: string
}

export interface BudgetAllocation extends BaseEntity {
  month: string
  currency: CurrencyCode
  allocationType?: 'fixed' | 'percentage'
  allocationValue?: number
}

export interface ExpenseCategory extends BaseEntity {
  name: string
}

export interface ExpenseSeries extends BaseEntity {
  name: string
  amount: number
  currency: CurrencyCode
  dueDay: number
  recurrence: ExpenseRecurrence
  startMonth: string
  endMonth?: string | null
  categoryId?: string | null
  category?: string | null
  /** @deprecated Kept so existing expense records remain readable. */
  subcategory?: string | null
}

export interface ExpenseItem extends BaseEntity {
  seriesId: string
  month: string
  dueDate: string
  amount: number
  currency: CurrencyCode
  status: BudgetStatus
  snoozedUntil?: string | null
  snoozedIndefinite?: boolean
  snoozeCount?: number
  paidAt?: string | null
  isLocked?: boolean
}

export interface PayrollStatus extends BaseEntity {
  employeeId: string
  month: string
  status: BudgetStatus
  snoozedUntil?: string | null
  snoozedIndefinite?: boolean
  snoozeCount?: number
  paidAt?: string | null
  isLocked?: boolean
}

export interface DividendStatus extends BaseEntity {
  employeeId: string
  month: string
  status: BudgetStatus
  snoozedUntil?: string | null
  snoozedIndefinite?: boolean
  snoozeCount?: number
  paidAt?: string | null
  isLocked?: boolean
}

// Order Items (Unified logic for base items, but separated for type safety)

// Legacy OrderItem for Invoice compatibility (to be refactored or kept for snapshots)
export interface OrderItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  total: number
  currency: CurrencyCode
}

export type InvoiceStatus = 'sent' | 'paid' | 'overdue' | 'cancelled' | 'draft'

export type InvoiceOrigin =
  | 'pos'
  | 'instant_pos'
  | 'revenue'
  | 'inventory'
  | 'manual'
  | 'exchange'
  | 'accounting'
  | 'loans'
  | 'Loans'
  | 'loan_report'
  | 'real_estate'
  | 'sales_order'
  | 'purchase_order'
  | 'order_report'
  | 'business_partner'
  | 'clinical_appointment'
  | 'activities'
  | 'post_service'
  | 'car_rental'
  | 'travel_transportation'
  | 'upload'

export interface Invoice extends BaseEntity {
  invoiceid: string
  /** UUID of the source record that produced this invoice. */
  sourceId?: string
  orderId?: string
  customerId?: string
  status?: InvoiceStatus
  // Total amount in settlement currency
  totalAmount: number
  settlementCurrency: CurrencyCode
  // Print-to-Invoice tracking
  origin?: InvoiceOrigin
  /** @deprecated Use cashierName for the name string. createdBy might map to system UUID. */
  createdBy?: string
  /** Auth user that owns legacy and uploaded invoice records. */
  userId?: string
  cashierName?: string
  createdByName?: string
  sequenceId?: number
  printFormat?: 'a4' | 'receipt'
  // PDF Storage (R2)
  r2PathA4?: string
  r2PathReceipt?: string
  // Local PDF Storage (AppData)
  localPathA4?: string
  localPathReceipt?: string
  // Local PDF Blob (pending upload)
  pdfBlobA4?: Blob
  pdfBlobReceipt?: Blob
  fileSize?: number
  fileMimeType?: string | null
  latestVersionId?: string
  latestVersionNumber?: number
}

/** Immutable PDF snapshot created each time an invoice is printed and saved. */
export interface InvoiceVersion {
  id: string
  invoiceId: string
  workspaceId: string
  sourceId: string
  origin: InvoiceOrigin
  versionNumber: number
  format: 'a4' | 'receipt'
  r2Path?: string
  localPath?: string
  pdfBlob?: Blob
  fileSize: number
  createdBy?: string
  createdByName?: string
  createdAt: string
  syncStatus: SyncStatus
  lastSyncedAt: string | null
  metadata?: Record<string, unknown>
}

export interface Sale extends BaseEntity {
  cashierId: string
  totalAmount: number
  originalTotalAmount?: number
  returnedAmount?: number
  returnStatus?: 'none' | 'partial' | 'full'
  settlementCurrency: CurrencyCode
  /** Whether this sale was converted to the workspace currency at checkout. */
  currencyConversionApplied?: boolean
  origin: string
  payment_method?: PaymentMethod
  // Sequential ID (generated by server)
  sequenceId?: number
  // System Verification (offline-first, immutable)
  systemVerified: boolean
  systemReviewStatus: 'approved' | 'flagged' | 'inconsistent'
  systemReviewReason: string | null
  isReturned?: boolean
  returnReason?: string | null
  returnedAt?: string | null
  returnedBy?: string | null
  notes?: string
  /** Local cache of the related Instant POS table-assignment record. */
  tableNumber?: string | null
}

export interface SaleItem {
  id: string
  /**
   * Copied from the parent sale so line items can be scoped, synchronized,
   * and mirrored independently without relying on process-global state.
   */
  workspaceId: string
  saleId: string
  /** Immutable checkout time, retained when local sales later synchronize. */
  createdAt: string
  /** Updated whenever a return, exchange, or other line-level change occurs. */
  updatedAt: string
  productId: string
  storageId?: string | null
  quantity: number
  unitPrice: number
  totalPrice: number
  costPrice: number
  convertedCostPrice: number
  originalCurrency: CurrencyCode
  originalUnitPrice: number
  convertedUnitPrice: number
  settlementCurrency: CurrencyCode
  negotiatedPrice?: number
  /** Price Book that priced this line at checkout, when one was selected in POS. */
  priceBookId?: string | null
  // Immutable inventory snapshot at checkout (null for service items)
  inventorySnapshot: number | null
  batchAllocations?: StockBatchAllocation[] | null
  originalBatchAllocations?: StockBatchAllocation[] | null
  returnedQuantity?: number
  isReturned?: boolean
  returnReason?: string | null
  returnedAt?: string | null
  returnedBy?: string | null
}

export interface SaleReturn extends BaseEntity {
  saleId: string
  reason: string
  status: 'posted' | 'voided'
  refundMethod?: string | null
  refundAmount: number
  returnedBy?: string | null
  returnedAt: string
  source: 'app' | 'exchange' | 'legacy_backfill' | 'system'
}

export interface SaleReturnItem extends BaseEntity {
  returnId: string
  saleId: string
  saleItemId: string
  quantity: number
  unitRefundAmount: number
  refundAmount: number
  restoredStorageId?: string | null
  restoredBatchAllocations?: StockBatchAllocation[] | null
}

/**
 * Immutable inventory and settlement record for one product exchanged against
 * a POS sale line.  The returned side is also represented in the normal sale
 * return ledger through `returnId`; this record captures the replacement side
 * and makes the two operations auditable as a single business action.
 */
export interface SaleProductExchange extends BaseEntity {
  saleId: string
  returnId: string
  returnSaleItemId: string
  returnProductId: string
  returnQuantity: number
  returnUnitAmount: number
  returnAmount: number
  returnStorageId?: string | null
  replacementProductId: string
  replacementStorageId: string
  replacementQuantity: number
  replacementUnitAmount: number
  replacementAmount: number
  replacementBatchAllocations?: StockBatchAllocation[] | null
  settlementCurrency: CurrencyCode
  /** Replacement total minus returned total. Positive means the customer owes more. */
  differenceAmount: number
  /** The part of a negative difference that could not be credited to the linked loan. */
  cashSettlementAmount: number
  settlementDirection?: PaymentTransactionDirection | null
  settlementMethod?: WorkspacePaymentMethod | null
  settlementTransactionId?: string | null
  loanId?: string | null
  loanCreditAmount: number
  reason: string
  notes?: string | null
  exchangedBy?: string | null
  exchangedAt: string
  status: 'posted' | 'voided'
}

/** Immutable header for a return posted against a completed sales order. */
export interface OrderReturn extends BaseEntity {
  orderId: string
  reason: string
  status: 'posted' | 'voided'
  refundAmount: number
  returnedBy?: string | null
  returnedAt: string
}

/** One returned quantity from a sales-order JSON line item. */
export interface OrderReturnItem extends BaseEntity {
  returnId: string
  orderId: string
  orderItemId: string
  quantity: number
  unitRefundAmount: number
  refundAmount: number
  restoredStorageId?: string | null
  restoredBatchAllocations?: StockBatchAllocation[] | null
}

export type LoanSource = 'pos' | 'manual' | 'order'
export type LoanCategory = 'standard' | 'simple'
export type LoanDirection = 'lent' | 'borrowed'
export type LoanOrderType = 'sales' | 'purchase'
export type LoanStatus = 'active' | 'overdue' | 'completed' | 'cancelled'
export type InstallmentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue' | 'cancelled'
export type InstallmentFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly'
export type InstallmentSaleFrequency = InstallmentFrequency | 'no_frequency'
export type LoanLinkedPartyType = 'business_partner'

export interface Loan extends BaseEntity {
  saleId?: string | null
  orderId?: string | null
  orderType?: LoanOrderType | null
  loanNo: string
  source: LoanSource
  loanCategory?: LoanCategory
  direction?: LoanDirection
  linkedPartyType?: LoanLinkedPartyType | null
  linkedPartyId?: string | null
  linkedPartyName?: string | null
  borrowerName: string
  borrowerPhone: string
  borrowerAddress: string
  borrowerNationalId: string
  principalAmount: number
  totalPaidAmount: number
  balanceAmount: number
  settlementCurrency: CurrencyCode
  exchangeRateSnapshot?: ExchangeRateSnapshot[] | null
  installmentCount: number
  installmentFrequency: InstallmentFrequency
  firstDueDate: string | null
  nextDueDate?: string | null
  status: LoanStatus
  notes?: string
  createdBy?: string
}

export interface LoanInstallment extends BaseEntity {
  loanId: string
  installmentNo: number
  dueDate: string | null
  plannedAmount: number
  paidAmount: number
  balanceAmount: number
  status: InstallmentStatus
  paidAt?: string | null
}

export interface LoanPayment extends BaseEntity {
  loanId: string
  amount: number
  paymentMethod: LoanPaymentMethod
  paidAt: string
  note?: string
  createdBy?: string
}

/** A generic, off-catalog sale with either a fixed schedule or an open customer balance. */
export type InstallmentSaleStatus = 'active' | 'overdue' | 'completed' | 'cancelled'

export interface InstallmentSale extends BaseEntity {
  saleNo: string
  customerBusinessPartnerId: string
  customerNameSnapshot: string
  description: string
  notes?: string | null
  currency: CurrencyCode
  acquisitionCost: number
  totalSalePrice: number
  grossProfit: number
  downPaymentAmount: number
  customerPaidAmount: number
  customerBalanceAmount: number
  installmentCount: number
  /** False when repayments are frequency-based but have no fixed ending count. */
  hasInstallmentCount: boolean
  installmentFrequency: InstallmentSaleFrequency
  firstDueDate: string | null
  nextDueDate?: string | null
  status: InstallmentSaleStatus
  cancelledAt?: string | null
  cancelledBy?: string | null
  cancellationReason?: string | null
  createdBy?: string | null
}

export interface InstallmentSaleInstallment extends BaseEntity {
  installmentSaleId: string
  installmentNo: number
  dueDate: string | null
  plannedAmount: number
  paidAmount: number
  balanceAmount: number
  status: InstallmentStatus
  paidAt?: string | null
}

export interface InstallmentSalePayment extends BaseEntity {
  installmentSaleId: string
  installmentId?: string | null
  amount: number
  paymentMethod: WorkspacePaymentMethod
  paidAt: string
  note?: string | null
  createdBy?: string | null
}

export type PaymentTransactionSourceModule =
  | 'sales'
  | 'loans'
  | 'orders'
  | 'budget'
  | 'real_estate'
  | 'activities'
  | 'clinical_appointments'
  | 'currency_exchange'
  | 'post_service'
  | 'car_rental'
  | 'travel_transportation'
  | 'payments'
  | 'payment_accounts'
  | 'installment_sales'
export type PaymentTransactionSourceType =
  | 'sale_exchange'
  | 'pos_sale'
  | 'loan_origination'
  | 'loan_payment'
  | 'simple_loan'
  | 'loan_installment'
  | 'real_estate_payment'
  | 'real_estate_installment'
  | 'real_estate_commission'
  | 'agent_commission_payout'
  | 'activity_transaction'
  | 'activity_refund'
  | 'clinical_appointment'
  | 'sales_order'
  | 'purchase_order'
  | 'order_return'
  | 'expense_item'
  | 'payroll_status'
  | 'direct_transaction'
  | 'payment_account_opening_balance'
  | 'payment_account_deposit'
  | 'payment_account_withdrawal'
  | 'payment_account_adjustment'
  | 'exchange_transaction'
  | 'delivery_courier_remittance'
  | 'delivery_courier_fee_payout'
  | 'delivery_courier_reimbursement'
  | 'delivery_merchant_payout'
  | 'delivery_recipient_payout'
  | 'delivery_merchant_repayment'
  | 'rental_payment'
  | 'rental_deposit'
  | 'rental_deposit_refund'
  | 'travel_booking_payment'
  | 'installment_sale_down_payment'
  | 'installment_sale_installment'
export type PaymentTransactionDirection = 'incoming' | 'outgoing'

export interface PaymentTransaction extends BaseEntity {
  sourceModule: PaymentTransactionSourceModule
  sourceType: PaymentTransactionSourceType
  sourceRecordId: string
  sourceSubrecordId?: string | null
  direction: PaymentTransactionDirection
  amount: number
  currency: CurrencyCode
  paymentMethod: WorkspacePaymentMethod
  paidAt: string
  counterpartyName?: string | null
  referenceLabel?: string | null
  note?: string | null
  createdBy?: string | null
  /** Optional payment-account context. Undefined/null preserves legacy flows. */
  accountId?: string | null
  accountNameSnapshot?: string | null
  /** The active cashier-shift occurrence that owned this payment when it was posted. */
  cashierShiftOccurrenceId?: string | null
  reversalOfTransactionId?: string | null
  metadata?: Record<string, unknown> | null
}

export type PaymentAccountType = 'cash_drawer' | 'bank_account' | 'digital_wallet' | 'other'

/** Immutable, audited manual movements recorded against a payment account. */
export const PAYMENT_ACCOUNT_MANUAL_OPERATION_KINDS = ['deposit', 'withdrawal', 'adjustment'] as const
export type PaymentAccountManualOperationKind = (typeof PAYMENT_ACCOUNT_MANUAL_OPERATION_KINDS)[number]

/** Why a counted balance did not match the posted balance. */
export const PAYMENT_ACCOUNT_ADJUSTMENT_REASONS = [
  'cash_shortage',
  'cash_overage',
  'count_correction',
  'opening_balance_correction',
  'bank_statement_correction',
  'other'
] as const
export type PaymentAccountAdjustmentReason = (typeof PAYMENT_ACCOUNT_ADJUSTMENT_REASONS)[number]

/** Digital payment methods that may resolve to one linked Digital Wallet account. */
export const DIGITAL_WALLET_PAYMENT_METHODS = ['fib', 'qicard', 'zaincash', 'fastpay'] as const
export type DigitalWalletPaymentMethod = (typeof DIGITAL_WALLET_PAYMENT_METHODS)[number]

/** A reusable visual marker for an account, independent of its functional type. */
export type PaymentAccountIconKey =
  | 'cash_drawer'
  | 'bank'
  | 'wallet'
  | 'card'
  | 'phone'
  | 'transfer'
  | 'coins'
  | 'receipt'
  | 'building'
  | 'store'
  | 'fib'
  | 'qicard'
  | 'zaincash'
  | 'fastpay'

export interface PaymentAccount extends BaseEntity {
  name: string
  accountType: PaymentAccountType
  /** Optional branded payment method this Digital Wallet should preselect for. */
  linkedPaymentMethod?: DigitalWalletPaymentMethod | null
  /** User-selected visual marker. Older records fall back from accountType. */
  iconKey?: PaymentAccountIconKey | null
  notes?: string | null
  isActive: boolean
  /** The one main account for this workspace. */
  isPrimary?: boolean
  /** Whether a new payment form should start with this account selected. */
  isDefaultForPaymentSelector?: boolean
  createdBy?: string | null
}

export interface PaymentAccountBalance extends BaseEntity {
  accountId: string
  currency: CurrencyCode
  balanceAmount: number
}

export interface PaymentAccountMovement extends BaseEntity {
  accountId: string
  paymentTransactionId: string
  accountNameSnapshot: string
  direction: PaymentTransactionDirection
  amount: number
  deltaAmount: number
  currency: CurrencyCode
  occurredAt: string
}

/**
 * A live, single-currency reporting group for payment accounts. The selected
 * account IDs are configuration only; capital amounts are always derived from
 * PaymentAccountBalance at read time.
 */
export interface CapitalPool extends BaseEntity {
  name: string
  currency: CurrencyCode
  accountIds: string[]
  createdBy?: string | null
}

/**
 * A courier's auditable request to change the cash-on-delivery amount before
 * the post is completed. The post itself remains unchanged until an admin
 * reviews and approves the request.
 */
export interface DeliveryShipmentCodAdjustmentRequest extends BaseEntity {
  shipmentId: string
  requesterUserId: string
  requesterAgentId: string
  currency: CurrencyCode
  originalCodAmount: number
  requestedCodAmount: number
  reason: string | null
  status: DeliveryShipmentCodAdjustmentRequestStatus
  reviewedCodAmount?: number | null
  reviewNote?: string | null
  reviewedBy?: string | null
  reviewedAt?: string | null
}

/**
 * Immutable audit record for an administrator's correction of a COD amount
 * after delivery and before either settlement side has started.
 */
export interface DeliveryShipmentCodCorrection extends BaseEntity {
  shipmentId: string
  currency: CurrencyCode
  originalCodAmount: number
  correctedCodAmount: number
  correctedBy: string
  correctedAt: string
  courierLedgerEntryId: string
  merchantLedgerEntryId: string
}

/**
 * Immutable audit record for an administrator's correction of a courier-funded
 * recipient payout after delivery and before either linked settlement starts.
 */
export interface DeliveryShipmentRecipientPayoutCorrection extends BaseEntity {
  shipmentId: string
  currency: CurrencyCode
  originalRecipientPayoutAmount: number
  correctedRecipientPayoutAmount: number
  correctedBy: string
  correctedAt: string
  courierLedgerEntryId: string
  merchantLedgerEntryId: string
}

/**
 * A courier's auditable request to change the amount paid out to a recipient
 * for a prepaid post. The payout funding method is deliberately unchanged.
 */
export interface DeliveryShipmentRecipientPayoutAdjustmentRequest extends BaseEntity {
  shipmentId: string
  requesterUserId: string
  requesterAgentId: string
  currency: CurrencyCode
  originalRecipientPayoutAmount: number
  requestedRecipientPayoutAmount: number
  reason: string | null
  status: DeliveryShipmentCodAdjustmentRequestStatus
  reviewedRecipientPayoutAmount?: number | null
  reviewNote?: string | null
  reviewedBy?: string | null
  reviewedAt?: string | null
}

export type CashierShiftStatus = 'open' | 'closed'

export type CashierShiftOccurrenceStatus = 'active' | 'paused' | 'completed' | 'terminated'

export type CashierShiftPauseRequestStatus = 'pending' | 'approved' | 'rejected'

export type CashierShiftPauseKind = 'cashier_request' | 'admin' | 'emergency'

export type CashierShiftEarlyFinishPolicy =
  'scheduled_end' | 'time_before_end' | 'request_approval' | 'free_with_reason'

/** How an assignment creates a real cashier-shift occurrence. */
export type CashierShiftAssignmentMode = 'scheduled' | 'manual' | 'login_logout'

export type CashierShiftEarlyFinishRequestStatus = 'not_requested' | 'requested' | 'approved' | 'rejected'

export interface CashierShift extends BaseEntity {
  accountId: string
  accountNameSnapshot: string
  cashierUserId?: string | null
  cashierNameSnapshot?: string | null
  status: CashierShiftStatus
  openedAt: string
  closedAt?: string | null
  closedBy?: string | null
  openingNote?: string | null
  closingNote?: string | null
}

export interface CashierShiftCurrencyCount extends BaseEntity {
  shiftId: string
  currency: CurrencyCode
  openingAmount: number
  expectedAmount: number
  countedAmount?: number | null
  varianceAmount?: number | null
}

/** A reusable named schedule, independent from a cashier or cash drawer. */
export interface CashierShiftTemplate extends BaseEntity {
  name: string
  startTime: string
  endTime: string
  isActive: boolean
}

/** A recurring weekday schedule assigned to one cashier and cash drawer. */
export interface CashierShiftAssignment extends BaseEntity {
  /** Scheduled shifts retain their window; manual and login/logout are unscheduled. */
  assignmentMode?: CashierShiftAssignmentMode | null
  templateId?: string | null
  templateNameSnapshot?: string | null
  accountId: string
  accountNameSnapshot: string
  cashierUserId: string
  cashierNameSnapshot: string
  startTime?: string | null
  endTime?: string | null
  /** JavaScript weekday numbers: Sunday 0 through Saturday 6. */
  workingDays?: number[] | null
  /** Controls whether and how the cashier may formally finish before schedule end. */
  earlyFinishPolicy?: CashierShiftEarlyFinishPolicy | null
  /** Required only for the `time_before_end` policy. */
  earlyFinishOffsetMinutes?: number | null
  isActive: boolean
}

/** A real dated shift occurrence once its assigned cashier has started it. */
export interface CashierShiftOccurrence extends BaseEntity {
  /** Immutable snapshot of the assignment mode at the moment the shift starts. */
  assignmentMode?: CashierShiftAssignmentMode | null
  assignmentId: string
  templateId?: string | null
  templateNameSnapshot?: string | null
  accountId: string
  accountNameSnapshot: string
  cashierUserId: string
  cashierNameSnapshot: string
  /** Present only for scheduled occurrences. */
  scheduledStartAt?: string | null
  /** Present only for scheduled occurrences. */
  scheduledEndAt?: string | null
  startedAt: string
  /** Immutable snapshot of the assigned early-finish policy. */
  earlyFinishPolicy?: CashierShiftEarlyFinishPolicy | null
  earlyFinishOffsetMinutes?: number | null
  /** Present only for scheduled occurrences. */
  earlyFinishRequestStatus: CashierShiftEarlyFinishRequestStatus | null
  earlyFinishRequestReason?: string | null
  earlyFinishRequestedAt?: string | null
  earlyFinishRequestedBy?: string | null
  earlyFinishReviewedAt?: string | null
  earlyFinishReviewedBy?: string | null
  earlyFinishReviewNote?: string | null
  status: CashierShiftOccurrenceStatus
  /** Persisted only when the assigned cashier formally completes the occurrence. */
  completedAt?: string | null
  completedBy?: string | null
  /** Required when a cashier uses the free early-finish policy before schedule end. */
  completionReason?: string | null
  /** Terminal administrative close metadata. */
  terminatedAt?: string | null
  terminatedBy?: string | null
  terminationReason?: string | null
}

/** A cashier's request to temporarily pause one already-started occurrence. */
export interface CashierShiftPauseRequest extends BaseEntity {
  occurrenceId: string
  cashierUserId: string
  reason: string
  requestedDurationMinutes?: number | null
  requestedResumeAt?: string | null
  status: CashierShiftPauseRequestStatus
  requestedAt: string
  reviewedAt?: string | null
  reviewedBy?: string | null
  reviewNote?: string | null
  approvedPausePeriodId?: string | null
}

/** One immutable pause interval. It is closed by setting resume metadata, never overwritten. */
export interface CashierShiftPausePeriod extends BaseEntity {
  occurrenceId: string
  kind: CashierShiftPauseKind
  startedAt: string
  initiatedBy: string
  note?: string | null
  pauseRequestId?: string | null
  resumedAt?: string | null
  resumedBy?: string | null
}

export interface PaymentObligation {
  id: string
  workspaceId: string
  sourceModule: PaymentTransactionSourceModule
  sourceType: PaymentTransactionSourceType
  sourceRecordId: string
  sourceSubrecordId?: string | null
  direction: PaymentTransactionDirection
  amount: number
  currency: CurrencyCode
  dueDate: string
  createdAt?: string
  counterpartyName?: string | null
  referenceLabel?: string | null
  title: string
  subtitle?: string | null
  status: 'open' | 'overdue'
  routePath: string
  metadata?: Record<string, unknown> | null
}

// Sync Queue Item for tracking pending changes
export interface SyncQueueItem {
  id: string
  entityType:
    | 'products'
    | 'product_barcodes'
    | 'price_books'
    | 'price_book_items'
    | 'activity_catalog'
    | 'activity_transactions'
    | 'activity_transaction_lines'
    | 'inventory'
    | 'inventory_transactions'
    | 'stock_batches'
    | 'reorder_transfer_rules'
    | 'inventory_transfer_transactions'
    | 'invoices'
    | 'users'
    | 'sales'
    | 'sale_product_exchanges'
    | 'order_returns'
    | 'order_return_items'
    | 'categories'
    | 'units'
    | 'product_discounts'
    | 'category_discounts'
    | 'storages'
    | 'employees'
    | 'workspace_contacts'
    | 'loans'
    | 'loan_installments'
    | 'loan_payments'
    | 'installment_sales'
    | 'installment_sale_installments'
    | 'installment_sale_payments'
    | 'payment_transactions'
    | 'payment_accounts'
    | 'capital_pools'
    | 'payment_account_balances'
    | 'payment_account_movements'
    | 'cashier_shifts'
    | 'cashier_shift_currency_counts'
    | 'cashier_shift_templates'
    | 'cashier_shift_assignments'
    | 'cashier_shift_occurrences'
    | 'cashier_shift_pause_requests'
    | 'cashier_shift_pause_periods'
    | 'budget_settings'
    | 'budget_allocations'
    | 'expense_categories'
    | 'expense_series'
    | 'expense_items'
    | 'payroll_statuses'
    | 'dividend_statuses'
    | 'customers'
    | 'suppliers'
    | 'agents'
    | 'agent_excluded_categories'
    | 'agent_commission_plans'
    | 'agent_commission_memberships'
    | 'product_commission_rules'
    | 'product_commission_rule_agents'
    | 'sales_order_agent_assignments'
    | 'agent_commission_entries'
    | 'agent_product_commission_entries'
    | 'sales_agent_commission_reconciliation'
    | 'fleet_vehicles'
    | 'fleet_vehicle_assignments'
    | 'delivery_merchant_profiles'
    | 'delivery_shipments'
    | 'delivery_shipment_events'
    | 'delivery_shipment_cod_adjustment_requests'
    | 'delivery_shipment_cod_corrections'
    | 'delivery_shipment_recipient_payout_corrections'
    | 'delivery_shipment_recipient_payout_adjustment_requests'
    | 'delivery_runs'
    | 'delivery_run_items'
    | 'delivery_settlements'
    | 'delivery_ledger_entries'
    | 'delivery_voice_cleanup'
    | 'rental_vehicles'
    | 'rental_requests'
    | 'rental_contracts'
    | 'business_partners'
    | 'business_partner_merge_candidates'
    | 'sales_orders'
    | 'purchase_orders'
    | 'order_installments'
    | 'real_estate_transactions'
    | 'real_estate_installments'
    | 'real_estate_payments'
    | 'travel_bookings'
    | 'travel_passengers'
    | 'exchange_pair_prices'
    | 'exchange_transactions'
    | 'exchange_fee_rules'
    | 'fx_safes'
    | 'fx_safe_balances'
    | 'fx_safe_movements'
    | 'clinical_appointments'
    | 'clinical_patients'
    | 'clinical_attachments'
    | 'clinical_presets'
  entityId: string
  operation: 'create' | 'update' | 'delete'
  data: Record<string, unknown>
  timestamp: string
  retryCount: number
}

// Offline Mutation for manual sync queue
export type MutationStatus = 'pending' | 'syncing' | 'failed' | 'synced'

export interface Workspace extends BaseEntity {
  name: string
  code: string
  plan?: WorkspacePlan
  data_mode: WorkspaceDataMode
  is_configured?: boolean
  // Module toggles
  pos?: boolean
  sales_history?: boolean
  crm?: boolean
  orders?: boolean
  real_estate?: boolean
  activities?: boolean
  currency_exchange?: boolean
  agents?: boolean
  post_service?: boolean
  car_rental?: boolean
  clinical_appointments?: boolean
  loans?: boolean
  installments?: boolean
  net_revenue?: boolean
  budget?: boolean
  monthly_comparison?: boolean
  team_performance?: boolean
  products?: boolean
  services?: boolean
  discounts?: boolean
  storages?: boolean
  inventory_transfer?: boolean
  inventory_transactions?: boolean
  stock_adjustments?: boolean
  invoices_history?: boolean
  hr?: boolean
  ecommerce?: boolean
  // Settings
  default_currency: CurrencyCode
  pos_convert_to_workspace_currency?: boolean
  iqd_display_preference: IQDDisplayPreference
  locked_workspace: boolean
  allow_whatsapp?: boolean
  logo_url?: string | null
  coordination?: string | null
  syncStatus: SyncStatus
  max_discount_percent?: number
  print_lang?: 'auto' | 'en' | 'ar' | 'ku'
  print_qr?: boolean
  receipt_template?: 'primary' | 'modern'
  a4_template?: 'primary' | 'modern' | 'professional'
  thermal_printing?: boolean
  subscription_expires_at?: string | null
  renewal_due_at?: string | null
  has_usage_limits?: boolean
  upload_limit_mb?: number | null
  visibility?: WorkspaceVisibility
  store_slug?: string | null
  store_description?: string | null
  sales_agent_commission_sheet_type?: SalesAgentCommissionSheetType
  /** Shared per-workspace presentation preferences for the Ledger cash summary. */
  ledger_dashboard_config?: {
    version: 1
    hiddenGroups: Array<'operating' | 'borrowing' | 'lending'>
    groupOrder: Array<'operating' | 'borrowing' | 'lending'>
  }
  /** Opt-in: new non-admin customer partners are private to their creator. */
  private_staff_customers?: boolean
  /** Opt-in: new non-admin supplier partners are private to their creator. */
  private_staff_suppliers?: boolean
  /** Opt-in: supplier data and supplier workflows are administrator-only. */
  suppliers_admin_only?: boolean
}

export interface WorkspaceContact extends Omit<BaseEntity, 'isDeleted'> {
  type: 'phone' | 'email' | 'address'
  value: string
  label?: string
  isPrimary: boolean
}

export type RestaurantPosTicketStatus = 'pending' | 'preparing' | 'ready' | 'served'

export interface RestaurantPosTicketItem {
  productId: string
  storageId?: string
  name: string
  sku: string
  baseUnitPrice: number
  unitPrice: number
  quantity: number
  currency: string
  discountType?: 'percentage' | 'fixed_amount'
  discountValue?: number
  discountSource?: 'product' | 'category'
  discountEndsAt?: string
  note?: string
}

export interface RestaurantTableSettings extends BaseEntity {
  enabled: boolean
  liveSyncEnabled: boolean
  tableCount: number
  vipTableNumbers: number[]
}

export interface RestaurantPosTicket extends BaseEntity {
  tableNumber: number
  number: string
  status: RestaurantPosTicketStatus
  items: RestaurantPosTicketItem[]
  note?: string
  kitchenRoutedAt?: string
  createdBy?: string | null
}

export interface OfflineMutation {
  id: string
  workspaceId: string
  entityType:
    | 'products'
    | 'product_barcodes'
    | 'price_books'
    | 'price_book_items'
    | 'activity_catalog'
    | 'activity_transactions'
    | 'activity_transaction_lines'
    | 'inventory'
    | 'inventory_transactions'
    | 'stock_batches'
    | 'reorder_transfer_rules'
    | 'inventory_transfer_transactions'
    | 'invoices'
    | 'users'
    | 'sales'
    | 'sale_product_exchanges'
    | 'order_returns'
    | 'order_return_items'
    | 'categories'
    | 'units'
    | 'product_discounts'
    | 'category_discounts'
    | 'workspaces'
    | 'workspace_branches'
    | 'storages'
    | 'employees'
    | 'workspace_contacts'
    | 'loans'
    | 'loan_installments'
    | 'loan_payments'
    | 'installment_sales'
    | 'installment_sale_installments'
    | 'installment_sale_payments'
    | 'payment_transactions'
    | 'payment_accounts'
    | 'capital_pools'
    | 'payment_account_balances'
    | 'payment_account_movements'
    | 'cashier_shifts'
    | 'cashier_shift_currency_counts'
    | 'cashier_shift_templates'
    | 'cashier_shift_assignments'
    | 'cashier_shift_occurrences'
    | 'cashier_shift_pause_requests'
    | 'cashier_shift_pause_periods'
    | 'budget_settings'
    | 'budget_allocations'
    | 'expense_categories'
    | 'expense_series'
    | 'expense_items'
    | 'payroll_statuses'
    | 'dividend_statuses'
    | 'customers'
    | 'suppliers'
    | 'agents'
    | 'agent_excluded_categories'
    | 'agent_commission_plans'
    | 'agent_commission_memberships'
    | 'product_commission_rules'
    | 'product_commission_rule_agents'
    | 'sales_order_agent_assignments'
    | 'agent_commission_entries'
    | 'agent_product_commission_entries'
    | 'sales_agent_commission_reconciliation'
    | 'fleet_vehicles'
    | 'fleet_vehicle_assignments'
    | 'delivery_merchant_profiles'
    | 'delivery_shipments'
    | 'delivery_shipment_events'
    | 'delivery_shipment_cod_adjustment_requests'
    | 'delivery_shipment_cod_corrections'
    | 'delivery_shipment_recipient_payout_corrections'
    | 'delivery_shipment_recipient_payout_adjustment_requests'
    | 'delivery_runs'
    | 'delivery_run_items'
    | 'delivery_settlements'
    | 'delivery_ledger_entries'
    | 'delivery_voice_cleanup'
    | 'rental_vehicles'
    | 'rental_requests'
    | 'rental_contracts'
    | 'business_partners'
    | 'business_partner_merge_candidates'
    | 'sales_orders'
    | 'purchase_orders'
    | 'order_installments'
    | 'real_estate_transactions'
    | 'real_estate_installments'
    | 'real_estate_payments'
    | 'travel_bookings'
    | 'travel_passengers'
    | 'exchange_pair_prices'
    | 'exchange_transactions'
    | 'exchange_fee_rules'
    | 'fx_safes'
    | 'fx_safe_balances'
    | 'fx_safe_movements'
    | 'clinical_appointments'
    | 'clinical_patients'
    | 'clinical_attachments'
    | 'clinical_presets'
    | 'manual_entry_templates'
    | 'manual_entries'
    | 'restaurant_table_settings'
    | 'restaurant_pos_tickets'
  entityId: string
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  createdAt: string
  status: MutationStatus
  error?: string
}

export interface AppSetting {
  key: string
  value: string
}

export interface WorkspacePermission {
  id: string
  workspaceId: string
  userUuid: string
  key: string
  module: string
}

// Type guards
export function isProduct(entity: BaseEntity): entity is Product {
  return 'sku' in entity && 'price' in entity && 'currency' in entity
}

export function isInvoice(entity: BaseEntity): entity is Invoice {
  return 'invoiceid' in entity && 'items' in entity
}
