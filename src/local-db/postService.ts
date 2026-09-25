import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toSnakeCase } from "@/lib/utils";
import { isVisibleDeliveryLedgerEntry } from "@/lib/postServiceLedgerVisibility";
import { courierHandoverStatusByShipment, courierReimbursementBreakdownByParty, courierReimbursementStatusByShipment, courierSettlementBreakdownByParty, merchantAccountSettlementBreakdownByParty, merchantPayoutStatusByShipment, merchantRepaymentStatusByShipment, merchantSettlementBreakdownByParty } from "@/lib/postServiceSettlementStatus";
import { useViewOwnRecordScope, type ViewOwnRecordScope } from "@/permissions/useViewOwnRecordScope";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import { canAccessBusinessPartnerInLocalCache } from "./businessPartnerAccess";
import { fetchTableFromSupabase } from "./hooks";
import { addToOfflineMutations } from "./offlineMutations";
import { appendPaymentTransaction } from "./payments";
import { getPostponedVoiceReasonCleanupPaths } from "@/services/deliveryVoiceReasons";
import { deleteVoiceStorageObjects } from "@/services/voiceStorage";
import type {
  CurrencyCode,
  DeliveryCustomerPaymentStatus,
  DeliveryFeePayer,
  DeliveryLedgerEntry,
  DeliveryLedgerEntryKind,
  DeliveryMerchantProfile,
  DeliveryPayoutSchedule,
  DeliveryRecipientPayoutFunding,
  DeliveryRun,
  DeliveryRunItem,
  DeliverySettlement,
  DeliverySettlementType,
  DeliveryShipment,
  DeliveryShipmentCodAdjustmentRequest,
  DeliveryShipmentCodCorrection,
  DeliveryShipmentRecipientPayoutCorrection,
  DeliveryShipmentCodAdjustmentRequestStatus,
  DeliveryShipmentRecipientPayoutAdjustmentRequest,
  DeliveryShipmentEvent,
  DeliveryShipmentStatus,
  WorkspacePaymentMethod,
} from "./models";

const PROFILE_TABLE = "delivery_merchant_profiles";
const SHIPMENT_TABLE = "delivery_shipments";
const EVENT_TABLE = "delivery_shipment_events";
const COD_ADJUSTMENT_REQUEST_TABLE = "delivery_shipment_cod_adjustment_requests";
const COD_CORRECTION_TABLE = "delivery_shipment_cod_corrections";
const RECIPIENT_PAYOUT_CORRECTION_TABLE = "delivery_shipment_recipient_payout_corrections";
const RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE = "delivery_shipment_recipient_payout_adjustment_requests";
const RUN_TABLE = "delivery_runs";
const RUN_ITEM_TABLE = "delivery_run_items";
const SETTLEMENT_TABLE = "delivery_settlements";
const LEDGER_TABLE = "delivery_ledger_entries";

type DeliveryTableName =
  | typeof PROFILE_TABLE
  | typeof SHIPMENT_TABLE
  | typeof EVENT_TABLE
  | typeof COD_ADJUSTMENT_REQUEST_TABLE
  | typeof COD_CORRECTION_TABLE
  | typeof RECIPIENT_PAYOUT_CORRECTION_TABLE
  | typeof RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE
  | typeof RUN_TABLE
  | typeof RUN_ITEM_TABLE
  | typeof SETTLEMENT_TABLE
  | typeof LEDGER_TABLE;
type DeliveryEntity =
  | DeliveryMerchantProfile
  | DeliveryShipment
  | DeliveryShipmentEvent
  | DeliveryShipmentCodAdjustmentRequest
  | DeliveryShipmentCodCorrection
  | DeliveryShipmentRecipientPayoutCorrection
  | DeliveryShipmentRecipientPayoutAdjustmentRequest
  | DeliveryRun
  | DeliveryRunItem
  | DeliverySettlement
  | DeliveryLedgerEntry;

export type PostServiceTab = "posts" | "dispatch" | "my-deliveries" | "merchants" | "courier" | "settlements";
type PostServiceRefreshTableName = DeliveryTableName | "business_partners" | "agents" | "fleet_vehicles";

const POST_SERVICE_TAB_REFRESH_TABLES: Record<PostServiceTab, readonly PostServiceRefreshTableName[]> = {
  posts: ["business_partners", PROFILE_TABLE, SHIPMENT_TABLE, EVENT_TABLE, COD_ADJUSTMENT_REQUEST_TABLE, COD_CORRECTION_TABLE, RECIPIENT_PAYOUT_CORRECTION_TABLE, RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE, LEDGER_TABLE],
  dispatch: ["business_partners", "agents", "fleet_vehicles", SHIPMENT_TABLE, RUN_TABLE],
  "my-deliveries": ["business_partners", "agents", SHIPMENT_TABLE, COD_ADJUSTMENT_REQUEST_TABLE, RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE, LEDGER_TABLE],
  merchants: ["business_partners", PROFILE_TABLE, LEDGER_TABLE],
  courier: ["business_partners", "agents", SHIPMENT_TABLE, LEDGER_TABLE],
  settlements: ["business_partners", "agents", PROFILE_TABLE, SETTLEMENT_TABLE, LEDGER_TABLE],
};

export interface DeliveryMerchantProfileInput {
  businessPartnerId: string;
  defaultFeeAmount?: number;
  defaultFeePayer?: DeliveryFeePayer;
  defaultPickupAddress?: string | null;
  payoutSchedule?: DeliveryPayoutSchedule;
  isActive?: boolean;
}

export interface UpdateDeliveryMerchantProfileInput {
  defaultFeeAmount: number;
  defaultFeePayer: DeliveryFeePayer;
  defaultPickupAddress?: string | null;
  payoutSchedule: DeliveryPayoutSchedule;
  isActive: boolean;
}

export interface CreateDeliveryShipmentInput {
  merchantProfileId: string;
  recipientPhone: string;
  recipientAddress: string;
  description?: string | null;
  currency: CurrencyCode;
  codAmount: number;
  customerPaymentStatus?: DeliveryCustomerPaymentStatus;
  recipientPayoutAmount?: number;
  /** Defaults to a courier advance for new posts. */
  recipientPayoutFunding?: DeliveryRecipientPayoutFunding;
  deliveryFee?: number;
  feePayer?: DeliveryFeePayer;
  sourceSalesOrderId?: string | null;
  createdBy?: string | null;
}

export interface CreateDeliveryRunInput {
  agentId: string;
  shipmentIds: string[];
  courierDeliveryFee?: number;
  vehicleId?: string | null;
  dispatchedAt?: string;
  notes?: string | null;
  createdBy?: string | null;
  /** Internal transfer path: permits a returned post to receive a new manifest. */
  allowReturnedShipment?: boolean;
}

/** Creates one post and its first courier manifest under a stable retry key. */
export interface CreateAndDispatchDeliveryShipmentInput {
  operationId: string;
  shipment: CreateDeliveryShipmentInput;
  agentId: string;
  courierDeliveryFee?: number;
  vehicleId?: string | null;
  dispatchedAt?: string;
  notes?: string | null;
  createdBy?: string | null;
}

export interface TransferReturnedDeliveryShipmentInput {
  agentId: string;
  shipmentId: string;
  courierDeliveryFee?: number;
  vehicleId?: string | null;
  dispatchedAt?: string;
  notes?: string | null;
  createdBy?: string | null;
}

/** Confirms that the workspace physically received a returned package. */
export interface ReceiveReturnedDeliveryShipmentInput {
  shipmentId: string;
  expectedVersion: number;
  actorRole: "admin";
  actorUserId?: string | null;
  note?: string | null;
}

/**
 * Administrative correction for a post that has not been completed. Received
 * posts are dispatched; assigned posts are placed on a fresh manifest so the
 * prior courier assignment stays auditable.
 */
export interface AdminEditAndRedispatchDeliveryShipmentInput {
  operationId: string;
  shipmentId: string;
  expectedVersion: number;
  actorRole: "admin";
  actorUserId?: string | null;
  shipment: Omit<CreateDeliveryShipmentInput, "sourceSalesOrderId" | "createdBy">;
  agentId: string;
  courierDeliveryFee?: number;
  vehicleId?: string | null;
  dispatchedAt?: string;
  notes?: string | null;
}

/** Administrative correction for a received post that remains unassigned. */
export interface AdminEditReceivedDeliveryShipmentInput {
  shipmentId: string;
  expectedVersion: number;
  actorRole: "admin";
  actorUserId?: string | null;
  shipment: Omit<CreateDeliveryShipmentInput, "sourceSalesOrderId" | "createdBy">;
}

export interface UpdateDeliveryShipmentStatusInput {
  status: Extract<
    DeliveryShipmentStatus,
    "delivered" | "postponed" | "returned" | "cancelled"
  >;
  note?: string | null;
  voiceReasonPath?: string | null;
  voiceReasonDurationMs?: number | null;
  recipientPayoutPaymentMethod?: WorkspacePaymentMethod;
  recipientPayoutAccountId?: string | null;
  recipientPayoutAccountNameSnapshot?: string | null;
  actorUserId?: string | null;
  actorAgentId?: string | null;
}

export interface SettleCourierInput {
  agentId: string;
  currency: CurrencyCode;
  actualAmount: number;
  paymentMethod: WorkspacePaymentMethod;
  /** When set, settles exactly this post's remaining outstanding amount. */
  shipmentId?: string | null;
  settledAt?: string;
  note?: string | null;
  varianceNote?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
}

export interface PayDeliveryMerchantInput {
  merchantProfileId: string;
  currency: CurrencyCode;
  actualAmount: number;
  paymentMethod: WorkspacePaymentMethod;
  /** When set, pays exactly this post's remaining outstanding amount. */
  shipmentId?: string | null;
  settledAt?: string;
  note?: string | null;
  varianceNote?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
}

export interface RequestDeliveryShipmentCodAdjustmentInput {
  shipmentId: string;
  requesterUserId: string;
  requesterAgentId: string;
  requestedCodAmount: number;
  reason: string;
}

export interface ReviewDeliveryShipmentCodAdjustmentInput {
  reviewerUserId: string;
  decision: Extract<DeliveryShipmentCodAdjustmentRequestStatus, "approved" | "rejected">;
  /** Required for an approval; may differ from the courier's requested amount. */
  approvedCodAmount?: number | null;
  /** Optional audit context for the review decision. */
  reviewNote?: string | null;
}

/** One atomic admin-only correction of a delivered post's COD amount. */
export interface CorrectDeliveredDeliveryShipmentCodInput {
  operationId: string;
  shipmentId: string;
  expectedVersion: number;
  actorRole: "admin";
  actorUserId: string;
  correctedCodAmount: number;
}

/** One atomic admin-only correction of a delivered courier-funded recipient payout. */
export interface CorrectDeliveredDeliveryShipmentRecipientPayoutInput {
  operationId: string;
  shipmentId: string;
  expectedVersion: number;
  actorRole: "admin";
  actorUserId: string;
  correctedRecipientPayoutAmount: number;
}

export interface RequestDeliveryShipmentRecipientPayoutAdjustmentInput {
  shipmentId: string;
  requesterUserId: string;
  requesterAgentId: string;
  requestedRecipientPayoutAmount: number;
  reason: string;
}

export interface ReviewDeliveryShipmentRecipientPayoutAdjustmentInput {
  reviewerUserId: string;
  decision: Extract<DeliveryShipmentCodAdjustmentRequestStatus, "approved" | "rejected">;
  /** Required for an approval; may differ from the courier's requested amount. */
  approvedRecipientPayoutAmount?: number | null;
  /** Optional audit context for the review decision. */
  reviewNote?: string | null;
}

/** Records an outgoing payment when the courier's earned fee exceeds cash held. */
export interface PayDeliveryCourierFeeInput {
  agentId: string;
  currency: CurrencyCode;
  actualAmount: number;
  paymentMethod: WorkspacePaymentMethod;
  /** An optional post link is available for an explicit per-post fee payout. */
  shipmentId?: string | null;
  settledAt?: string;
  note?: string | null;
  varianceNote?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
}

/** Reimburses a courier who advanced their own cash to a recipient. */
export interface PayDeliveryCourierReimbursementInput {
  agentId: string;
  currency: CurrencyCode;
  actualAmount: number;
  paymentMethod: WorkspacePaymentMethod;
  /** An optional post link reimburses this exact delivery advance. */
  shipmentId?: string | null;
  settledAt?: string;
  note?: string | null;
  varianceNote?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
}

/** Records money the merchant pays into the workspace's delivery account. */
export interface ReceiveDeliveryMerchantRepaymentInput {
  merchantProfileId: string;
  currency: CurrencyCode;
  actualAmount: number;
  paymentMethod: WorkspacePaymentMethod;
  /** When set, clears the delivery debt created by this exact post only. */
  shipmentId?: string | null;
  settledAt?: string;
  note?: string | null;
  varianceNote?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
}

export interface DeliveryBalance {
  id: string;
  currency: CurrencyCode;
  amount: number;
  /** Total amount already settled (handed over / paid out) in this currency. */
  paid: number;
}

/** Signed merchant account balance: positive means payable to the merchant. */
export interface DeliveryMerchantAccountBalance {
  id: string;
  currency: CurrencyCode;
  amount: number;
}

/** Signed courier account balance: positive means cash owed by the courier. */
export interface DeliveryCourierAccountBalance {
  id: string;
  currency: CurrencyCode;
  amount: number;
}

export type DeliveryBalanceMetricTotals = {
  weOweMerchants: Array<{ currency: CurrencyCode; amount: number }>;
  merchantsOweUs: Array<{ currency: CurrencyCode; amount: number }>;
  couriersOweUs: Array<{ currency: CurrencyCode; amount: number }>;
  weOweCouriers: Array<{ currency: CurrencyCode; amount: number }>;
};

function aggregateAccountBalanceDirection(
  balances: ReadonlyArray<{ currency: CurrencyCode; amount: number }>,
  direction: "positive" | "negative",
) {
  const totals = new Map<CurrencyCode, number>();
  for (const balance of balances) {
    const amount = Number(balance.amount || 0);
    if ((direction === "positive" && amount <= 0.000001) || (direction === "negative" && amount >= -0.000001)) continue;
    const normalizedAmount = direction === "positive" ? amount : Math.abs(amount);
    totals.set(balance.currency, (totals.get(balance.currency) ?? 0) + normalizedAmount);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round((amount + Number.EPSILON) * 1_000_000) / 1_000_000 }))
    .filter(({ amount }) => amount > 0.000001)
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

/**
 * Splits the signed delivery account balances into the four user-facing
 * counterparty directions. Amounts are aggregated only within the same
 * currency; no implicit currency conversion is performed.
 */
export function summarizeDeliveryBalanceMetrics(
  merchantBalances: ReadonlyArray<DeliveryMerchantAccountBalance>,
  courierBalances: ReadonlyArray<DeliveryCourierAccountBalance>,
): DeliveryBalanceMetricTotals {
  return {
    weOweMerchants: aggregateAccountBalanceDirection(merchantBalances, "positive"),
    merchantsOweUs: aggregateAccountBalanceDirection(merchantBalances, "negative"),
    couriersOweUs: aggregateAccountBalanceDirection(courierBalances, "positive"),
    weOweCouriers: aggregateAccountBalanceDirection(courierBalances, "negative"),
  };
}

/**
 * A display-only sale projection for the reporting surfaces. A delivery post
 * is not a POS sale: the COD amount belongs to the merchant. Only the fee
 * earned for a delivered shipment is exposed as revenue.
 */
export interface DeliverySaleProjectionOptions {
  merchantName?: string | null;
  merchantBusinessPartnerId?: string | null;
  serviceName?: string;
  serviceCategory?: string;
  feePayerNote?: string | null;
}

export function toUISaleFromDeliveryShipment(
  shipment: DeliveryShipment,
  options: DeliverySaleProjectionOptions = {},
): any {
  const serviceName = options.serviceName?.trim() || "Delivery service";
  const serviceCategory = options.serviceCategory?.trim() || serviceName;
  const deliveryFee = Number(shipment.deliveryFee || 0);
  // A courier fee is the direct service cost for this delivered post. It is
  // independent from COD, which remains merchant money and never enters sales
  // reporting.
  const courierDeliveryFee = Number(shipment.courierDeliveryFee || 0);
  const notes = [shipment.description?.trim(), options.feePayerNote?.trim()]
    .filter((value): value is string => !!value)
    .join(" | ") || null;

  return {
    id: shipment.id,
    workspace_id: shipment.workspaceId,
    cashier_id: shipment.createdBy || "",
    total_amount: deliveryFee,
    settlement_currency: shipment.currency,
    created_at: shipment.deliveredAt || shipment.updatedAt,
    updated_at: shipment.updatedAt,
    origin: "post_service",
    // Settlement methods can differ from one post to another, so the actual
    // cash method stays on the settlement in the ledger rather than being
    // guessed on this earned-revenue projection.
    payment_method: null,
    cashier_name: serviceName,
    items: [{
      id: `delivery-fee:${shipment.id}`,
      sale_id: shipment.id,
      product_id: "delivery_service_fee",
      product_name: `${serviceName} · ${shipment.trackingNumber}`,
      product_sku: "DELIVERY-FEE",
      product_category: serviceCategory,
      quantity: 1,
      unit_price: deliveryFee,
      total_price: deliveryFee,
      cost_price: courierDeliveryFee,
      converted_cost_price: courierDeliveryFee,
      original_currency: shipment.currency,
      original_unit_price: deliveryFee,
      converted_unit_price: deliveryFee,
      settlement_currency: shipment.currency,
      returned_quantity: 0,
      is_returned: false,
      product: {
        name: `${serviceName} · ${shipment.trackingNumber}`,
        sku: "DELIVERY-FEE",
        category: serviceCategory,
        can_be_returned: false,
      },
    }],
    is_returned: false,
    has_partial_return: false,
    sequenceId: shipment.trackingNumber,
    notes,
    partyName: options.merchantName?.trim() || null,
    business_partner_id: options.merchantBusinessPartnerId ?? null,
    _isPostService: true,
    _deliveryShipmentId: shipment.id,
    _trackingNumber: shipment.trackingNumber,
    _deliveryFeePayer: shipment.feePayer,
  };
}

function shouldUseCloudDeliveryData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId);
}

function isVisibleDeliveryShipment(
  shipment: DeliveryShipment,
  viewOwnScope: ViewOwnRecordScope,
  linkedCourierIds: ReadonlySet<string>,
) {
  return !shipment.isDeleted && (
    !viewOwnScope.isRestricted || (
      !!shipment.assignedAgentId && linkedCourierIds.has(shipment.assignedAgentId)
    )
  );
}

async function getLinkedCourierIds(workspaceId: string, userId: string | undefined) {
  if (!userId) return new Set<string>();
  const couriers = await db.agents
    .where("workspaceId")
    .equals(workspaceId)
    .and((agent) => (
      !agent.isDeleted
      && agent.agentType === "courier"
      && agent.linkedUserId === userId
    ))
    .toArray();
  return new Set(couriers.map((courier) => courier.id));
}

async function getVisibleDeliveryShipmentIds(
  workspaceId: string,
  viewOwnScope: ViewOwnRecordScope,
) {
  const linkedCourierIds = viewOwnScope.isRestricted
    ? await getLinkedCourierIds(workspaceId, viewOwnScope.userId)
    : new Set<string>();
  const shipments = await db.delivery_shipments
    .where("workspaceId")
    .equals(workspaceId)
    .and((shipment) => isVisibleDeliveryShipment(shipment, viewOwnScope, linkedCourierIds))
    .toArray();
  const visibility = await Promise.all(shipments.map((shipment) =>
    canAccessBusinessPartnerInLocalCache(workspaceId, shipment.merchantBusinessPartnerId, "customer")
  ));
  return new Set(shipments.filter((_, index) => visibility[index]).map((shipment) => shipment.id));
}

async function canAccessDeliveryPartner(
  workspaceId: string,
  businessPartnerId: string | null | undefined,
  merchantProfileId?: string | null,
) {
  const profile = !businessPartnerId && merchantProfileId
    ? await db.delivery_merchant_profiles.get(merchantProfileId)
    : undefined;
  return canAccessBusinessPartnerInLocalCache(
    workspaceId,
    businessPartnerId ?? profile?.businessPartnerId,
    "customer",
  );
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
  return shouldUseCloudDeliveryData(workspaceId)
    ? { syncStatus: "pending" as const, lastSyncedAt: null }
    : { syncStatus: "synced" as const, lastSyncedAt: timestamp };
}

function sanitizePayload(entity: DeliveryEntity) {
  const payload = toSnakeCase(entity as unknown as Record<string, unknown>);
  delete payload.sync_status;
  delete payload.last_synced_at;
  // Recipient phone is now the only recipient identifier. Strip these fields
  // from old local rows and queued payloads so upgraded clients can sync to
  // the simplified database schema without losing the shipment itself.
  if ("trackingNumber" in entity && "merchantProfileId" in entity) {
    delete payload.recipient_name;
    delete payload.recipient_alternate_phone;
    delete payload.recipient_city;
  }
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

function getTable(tableName: DeliveryTableName) {
  switch (tableName) {
    case PROFILE_TABLE:
      return db.delivery_merchant_profiles;
    case SHIPMENT_TABLE:
      return db.delivery_shipments;
    case EVENT_TABLE:
      return db.delivery_shipment_events;
    case COD_ADJUSTMENT_REQUEST_TABLE:
      return db.delivery_shipment_cod_adjustment_requests;
    case COD_CORRECTION_TABLE:
      return db.delivery_shipment_cod_corrections;
    case RECIPIENT_PAYOUT_CORRECTION_TABLE:
      return db.delivery_shipment_recipient_payout_corrections;
    case RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE:
      return db.delivery_shipment_recipient_payout_adjustment_requests;
    case RUN_TABLE:
      return db.delivery_runs;
    case RUN_ITEM_TABLE:
      return db.delivery_run_items;
    case SETTLEMENT_TABLE:
      return db.delivery_settlements;
    case LEDGER_TABLE:
      return db.delivery_ledger_entries;
  }
}

function getPostServiceRefreshTable(tableName: PostServiceRefreshTableName) {
  switch (tableName) {
    case "business_partners":
      return db.business_partners;
    case "agents":
      return db.agents;
    case "fleet_vehicles":
      return db.fleet_vehicles;
    default:
      return getTable(tableName);
  }
}

/** Refresh only the records rendered by the selected Post Service tab. */
export async function refreshPostServiceTab(workspaceId: string, tab: PostServiceTab) {
  if (!shouldUseCloudDeliveryData(workspaceId)) return;

  await Promise.all(
    POST_SERVICE_TAB_REFRESH_TABLES[tab].map((tableName) =>
      fetchTableFromSupabase(tableName, getPostServiceRefreshTable(tableName), workspaceId),
    ),
  );
}

async function syncEntities(
  tableName: DeliveryTableName,
  entities: DeliveryEntity[],
  workspaceId: string,
): Promise<boolean> {
  if (entities.length === 0 || !shouldUseCloudDeliveryData(workspaceId)) {
    return true;
  }

  if (!isOnline(workspaceId)) {
    await queueSyncEntities(tableName, entities, workspaceId);
    return false;
  }

  try {
    const client = getSupabaseClientForTable(tableName);
    const receivesTrackingNumber = tableName === SHIPMENT_TABLE;
    let result: { data?: unknown; error?: unknown };
    if (receivesTrackingNumber) {
      result = await runSupabaseAction(`${tableName}.sync`, () =>
        client.from(SHIPMENT_TABLE).upsert(entities.map(sanitizePayload)).select("id, tracking_number"),
      );
    } else {
      result = await runSupabaseAction(`${tableName}.sync`, () =>
        client.from(tableName).upsert(entities.map(sanitizePayload)),
      );
    }
    const { data, error } = result as { data?: unknown; error?: unknown };
    if (error) throw error;

    const trackingNumbers = new Map<string, string>();
    if (receivesTrackingNumber && Array.isArray(data)) {
      for (const row of data) {
        if (!row || typeof row !== "object") continue;
        const remoteShipment = row as { id?: unknown; tracking_number?: unknown };
        if (typeof remoteShipment.id === "string" && typeof remoteShipment.tracking_number === "string") {
          trackingNumbers.set(remoteShipment.id, remoteShipment.tracking_number);
        }
      }
    }

    const syncedAt = new Date().toISOString();
    await getTable(tableName).bulkUpdate(
      entities.map((entity) => {
        const trackingNumber = trackingNumbers.get(entity.id);
        if (trackingNumber && tableName === SHIPMENT_TABLE) {
          (entity as DeliveryShipment).trackingNumber = trackingNumber;
        }
        return {
          key: entity.id,
          changes: {
            ...(trackingNumber ? { trackingNumber } : {}),
            syncStatus: "synced",
            lastSyncedAt: syncedAt,
          },
        };
      }) as never,
    );
    return true;
  } catch (error) {
    console.error(`[Post Service] Failed to sync ${tableName}:`, error);
    await queueSyncEntities(tableName, entities, workspaceId);
    return false;
  }
}

async function queueSyncEntities(
  tableName: DeliveryTableName,
  entities: DeliveryEntity[],
  workspaceId: string,
) {
  await Promise.all(
    entities.map((entity) =>
      addToOfflineMutations(
        tableName,
        entity.id,
        entity.version > 1 ? "update" : "create",
        entity as unknown as Record<string, unknown>,
        workspaceId,
      ),
    ),
  );
}

/**
 * Delivery rows have foreign-key links. Keep their cloud writes in the same
 * order as the relationship graph, and queue dependants without attempting a
 * server write when a parent could not be accepted yet.
 */
async function syncEntitiesInDependencyOrder(
  workspaceId: string,
  operations: Array<readonly [DeliveryTableName, DeliveryEntity[]]>,
) {
  let canSyncDependants = true;

  for (const [tableName, entities] of operations) {
    if (!canSyncDependants) {
      await queueSyncEntities(tableName, entities, workspaceId);
      continue;
    }

    canSyncDependants = await syncEntities(tableName, entities, workspaceId);
  }

  return canSyncDependants;
}

async function queuePostponedVoiceReasonCleanup(input: {
  workspaceId: string;
  shipmentId: string;
  eventIds: string[];
  paths: string[];
}) {
  if (input.paths.length === 0 || !shouldUseCloudDeliveryData(input.workspaceId)) return;
  await addToOfflineMutations(
    "delivery_voice_cleanup",
    input.shipmentId,
    "delete",
    {
      shipmentId: input.shipmentId,
      eventIds: input.eventIds,
      paths: input.paths,
    },
    input.workspaceId,
  );
}

async function syncHardDeleteProfile(profileId: string, workspaceId: string) {
  if (!shouldUseCloudDeliveryData(workspaceId)) return;

  if (!isOnline(workspaceId)) {
    await addToOfflineMutations(PROFILE_TABLE, profileId, "delete", { id: profileId, hardDelete: true }, workspaceId);
    return;
  }

  try {
    const client = getSupabaseClientForTable(PROFILE_TABLE);
    const { error } = (await runSupabaseAction(`${PROFILE_TABLE}.hardDelete`, () =>
      client.from(PROFILE_TABLE).delete().eq("id", profileId),
    )) as { error?: unknown };
    if (error) throw error;
  } catch (error) {
    console.error(`[Post Service] Failed to hard delete ${PROFILE_TABLE}:`, error);
    await addToOfflineMutations(PROFILE_TABLE, profileId, "delete", { id: profileId, hardDelete: true }, workspaceId);
  }
}

async function hydrateTable(tableName: DeliveryTableName, workspaceId: string) {
  if (!shouldUseCloudDeliveryData(workspaceId)) return;
  await fetchTableFromSupabase(tableName, getTable(tableName), workspaceId);
}

function normalizeText(value?: string | null) {
  const result = String(value ?? "").trim();
  return result || null;
}

function positiveMoney(value: number, label: string, allowZero = true) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return amount;
}

function makeReference(prefix: string, timestamp = new Date()) {
  const date = timestamp.toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${date}-${generateId().slice(0, 6).toUpperCase()}`;
}

function getBaghdadDate(timestamp = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}${values.month}${values.day}`;
}

async function getInitialShipmentTrackingNumber(workspaceId: string) {
  if (shouldUseCloudDeliveryData(workspaceId)) {
    // Supabase replaces this during the insert with the authoritative,
    // workspace-wide daily sequence. A non-numeric placeholder cannot be
    // mistaken for a final tracking number while the device is offline.
    return `PST-PENDING-${generateId().toUpperCase()}`;
  }

  const trackingDay = getBaghdadDate();
  const trackingPattern = new RegExp(`^PST-${trackingDay}-(\\d+)$`);
  const shipments = await db.delivery_shipments
    .where("workspaceId")
    .equals(workspaceId)
    .toArray();
  const nextSequence = shipments.reduce((highest, shipment) => {
    const match = shipment.trackingNumber.match(trackingPattern);
    return Math.max(highest, match ? Number(match[1]) : 0);
  }, 0) + 1;

  return `PST-${trackingDay}-${String(nextSequence).padStart(5, "0")}`;
}

function makeBase<T extends Record<string, unknown>>(
  workspaceId: string,
  data: T,
): T & { id: string; workspaceId: string; createdAt: string; updatedAt: string; version: number; isDeleted: false; syncStatus: "pending" | "synced"; lastSyncedAt: string | null } {
  const now = new Date().toISOString();
  return {
    ...data,
    id: generateId(),
    workspaceId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now),
  };
}

/**
 * Produces a stable UUID for a delivery operation that can be replayed from a
 * second device. A status update may arrive twice when two clients have the
 * same assigned post open; using a generated UUID in that situation creates a
 * second Delivered event and repeats every accounting obligation.
 */
async function deliveryOperationId(seed: string) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`atlas:delivery:${seed}`),
  ));
  const bytes = digest.slice(0, 16);
  // Mark the derived value as a RFC 4122 version-5, variant-1 UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeLedgerEntry(
  workspaceId: string,
  input: Omit<DeliveryLedgerEntry, "id" | "workspaceId" | "createdAt" | "updatedAt" | "version" | "isDeleted" | "syncStatus" | "lastSyncedAt">,
) {
  return makeBase(workspaceId, input) as DeliveryLedgerEntry;
}

/** Party-level totals derived from the same per-post FIFO breakdown the dialogs use. */
function partyTotalsFromBreakdown(
  breakdownByParty: ReturnType<typeof courierSettlementBreakdownByParty>,
) {
  const totals = new Map<string, { amount: number; paid: number; currency: CurrencyCode }>();
  for (const [key, posts] of breakdownByParty) {
    const [id, currency] = key.split(":");
    const current = totals.get(id) ?? { amount: 0, paid: 0, currency: currency as CurrencyCode };
    for (const post of posts) {
      current.amount += post.outstanding;
      current.paid += post.paid;
    }
    totals.set(id, current);
  }
  return totals;
}

async function refreshDeliveryPartnerBalances(workspaceId: string, partnerIds: Array<string | null | undefined>) {
  const ids = [...new Set(partnerIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const { recalculateBusinessPartnerSummary } = await import("./businessPartners");
  await Promise.all(ids.map((id) =>
    recalculateBusinessPartnerSummary(workspaceId, id).catch((error) =>
      console.error("[Post Service] Failed to refresh partner balance:", error),
    ),
  ));
}

function assertSettlementAmount(expectedAmount: number, actualAmount: number, varianceNote?: string | null) {
  const expected = Math.max(0, Number(expectedAmount || 0));
  const actual = positiveMoney(actualAmount, "Settlement amount", false);
  if (actual > expected + 0.000001) {
    throw new Error("Settlement amount cannot exceed the outstanding balance");
  }
  if (Math.abs(expected - actual) > 0.000001 && !normalizeText(varianceNote)) {
    throw new Error("Explain a partial settlement before confirming it");
  }
  return { expected, actual };
}

/**
 * The merchant delivery ledger is signed: a positive balance is money that we
 * owe the merchant, while a negative balance is money the merchant owes the
 * workspace.  Repayments only clear the latter and never create a credit.
 */
function merchantDeliveryAccountBalance(
  entries: DeliveryLedgerEntry[],
  merchantProfileId: string | null | undefined,
  currency: CurrencyCode,
  shipmentId?: string | null,
) {
  if (!merchantProfileId) return 0;
  return entries.reduce((total, entry) => {
    if (
      entry.isDeleted
      || entry.merchantProfileId !== merchantProfileId
      || entry.currency !== currency
      || (shipmentId && entry.shipmentId !== shipmentId)
    ) return total;
    return total + Number(entry.amount || 0);
  }, 0);
}

/**
 * Courier delivery accounting is signed: positive cash must be handed over,
 * while a negative amount is money the workspace owes the courier (earned
 * fees and recipient advances paid from the courier's own cash).
 */
function courierDeliveryAccountBalance(
  entries: DeliveryLedgerEntry[],
  agentId: string | null | undefined,
  currency: CurrencyCode,
  shipmentId?: string | null,
) {
  if (!agentId) return 0;
  return entries.reduce((total, entry) => {
    if (
      entry.isDeleted
      || entry.agentId !== agentId
      || entry.currency !== currency
      || (shipmentId && entry.shipmentId !== shipmentId)
    ) return total;
    return total + Number(entry.amount || 0);
  }, 0);
}

/** The legacy fee-only payout is intentionally isolated from recipient advances. */
function courierFeeAccountBalance(
  entries: DeliveryLedgerEntry[],
  agentId: string | null | undefined,
  currency: CurrencyCode,
  shipmentId?: string | null,
) {
  if (!agentId) return 0;
  return entries.reduce((total, entry) => {
    if (
      entry.isDeleted
      || entry.agentId !== agentId
      || entry.currency !== currency
      || (shipmentId && entry.shipmentId !== shipmentId)
      || !["courier_delivery_fee", "courier_fee_payout"].includes(entry.kind)
    ) return total;
    return total + Number(entry.amount || 0);
  }, 0);
}

export function useDeliveryMerchantProfiles(workspaceId?: string) {
  const online = useNetworkStatus();
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const profiles = await db.delivery_merchant_profiles
        .where("workspaceId")
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray();
      const visibility = await Promise.all(profiles.map((profile) =>
        canAccessBusinessPartnerInLocalCache(workspaceId, profile.businessPartnerId, "customer")
      ));
      return profiles.filter((_, index) => visibility[index]);
    },
    [workspaceId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(PROFILE_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate merchant profiles:", error),
      );
    }
  }, [online, workspaceId]);

  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function useDeliveryShipments(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const linkedCourierIds = viewOwnScope.isRestricted
        ? await getLinkedCourierIds(workspaceId, viewOwnScope.userId)
        : new Set<string>();
      const shipments = await db.delivery_shipments
        .where("workspaceId")
        .equals(workspaceId)
        .and((shipment) => isVisibleDeliveryShipment(shipment, viewOwnScope, linkedCourierIds))
        .toArray();
      const visibility = await Promise.all(shipments.map((shipment) =>
        canAccessBusinessPartnerInLocalCache(workspaceId, shipment.merchantBusinessPartnerId, "customer")
      ));
      return shipments.filter((_, index) => visibility[index]);
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(SHIPMENT_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate shipments:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function useDeliveryShipmentEvents(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const events = await db.delivery_shipment_events
        .where("workspaceId")
        .equals(workspaceId)
        .and((event) => !event.isDeleted)
        .toArray();
      const visibleShipmentIds = await getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope);
      return events.filter((event) => visibleShipmentIds.has(event.shipmentId));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(EVENT_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate shipment events:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

/** COD change requests are a separate review trail, not a shipment status. */
export function useDeliveryShipmentCodAdjustmentRequests(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const requests = await db.delivery_shipment_cod_adjustment_requests
        .where("workspaceId")
        .equals(workspaceId)
        .and((request) => !request.isDeleted)
        .toArray();
      const visibleShipmentIds = await getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope);
      return requests.filter((request) => visibleShipmentIds.has(request.shipmentId));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(COD_ADJUSTMENT_REQUEST_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate COD adjustment requests:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Recipient-payout adjustment requests are a separate review trail, not a shipment status. */
export function useDeliveryShipmentRecipientPayoutAdjustmentRequests(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const requests = await db.delivery_shipment_recipient_payout_adjustment_requests
        .where("workspaceId")
        .equals(workspaceId)
        .and((request) => !request.isDeleted)
        .toArray();
      const visibleShipmentIds = await getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope);
      return requests.filter((request) => visibleShipmentIds.has(request.shipmentId));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate recipient payout adjustment requests:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function useDeliveryRuns(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const runs = await db.delivery_runs
        .where("workspaceId")
        .equals(workspaceId)
        .and((run) => !run.isDeleted)
        .toArray();
      const visibleShipmentIds = await getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope);
      if (visibleShipmentIds.size === 0) return [];
      const runItems = await db.delivery_run_items
        .where("workspaceId")
        .equals(workspaceId)
        .and((item) => !item.isDeleted && visibleShipmentIds.has(item.shipmentId))
        .toArray();
      const visibleRunIds = new Set(runItems.map((item) => item.runId));
      return runs.filter((run) => visibleRunIds.has(run.id));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(RUN_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate dispatch runs:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.dispatchedAt.localeCompare(left.dispatchedAt));
}

export function useDeliverySettlements(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const settlements = await db.delivery_settlements
        .where("workspaceId")
        .equals(workspaceId)
        .and((settlement) => !settlement.isDeleted)
        .toArray();
      const visibleShipmentIds = await getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope);
      const directVisibility = await Promise.all(settlements.map((settlement) =>
        canAccessDeliveryPartner(workspaceId, settlement.businessPartnerId, settlement.merchantProfileId)
      ));
      return settlements.filter((settlement, index) => (
        directVisibility[index]
        && (!settlement.shipmentId || visibleShipmentIds.has(settlement.shipmentId))
      ));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(SETTLEMENT_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate settlements:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows.sort((left, right) => right.settledAt.localeCompare(left.settledAt));
}

export function useDeliveryLedgerEntries(workspaceId?: string) {
  const online = useNetworkStatus();
  const viewOwnScope = useViewOwnRecordScope("postService.view_own");
  const rows = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const entries = await db.delivery_ledger_entries
        .where("workspaceId")
        .equals(workspaceId)
        .and((entry) => !entry.isDeleted)
        .toArray();
      const [visibleShipmentIds, linkedCourierIds] = await Promise.all([
        getVisibleDeliveryShipmentIds(workspaceId, viewOwnScope),
        getLinkedCourierIds(workspaceId, viewOwnScope.userId),
      ]);
      const visibility = await Promise.all(entries.map((entry) =>
        canAccessDeliveryPartner(workspaceId, entry.businessPartnerId, entry.merchantProfileId)
      ));
      return entries.filter((entry, index) => (
        visibility[index]
        && (viewOwnScope.isRestricted
          ? isVisibleDeliveryLedgerEntry(entry, visibleShipmentIds, linkedCourierIds)
          : (!entry.shipmentId || visibleShipmentIds.has(entry.shipmentId)))
      ));
    },
    [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId],
  ) ?? [];

  useEffect(() => {
    if (workspaceId && online) {
      void hydrateTable(LEDGER_TABLE, workspaceId).catch((error) =>
        console.error("[Post Service] Failed to hydrate delivery balances:", error),
      );
    }
  }, [online, viewOwnScope.isRestricted, viewOwnScope.userId, workspaceId]);

  return rows;
}

export function useCourierDeliveryBalances(workspaceId?: string) {
  const entries = useDeliveryLedgerEntries(workspaceId);
  return useMemo<DeliveryBalance[]>(() => {
    return [...partyTotalsFromBreakdown(courierSettlementBreakdownByParty(entries)).entries()]
      .map(([id, item]) => ({ id, currency: item.currency, amount: item.amount, paid: item.paid }))
      .filter((item) => Math.abs(item.amount) > 0.000001);
  }, [entries]);
}

export function useMerchantDeliveryBalances(workspaceId?: string) {
  const entries = useDeliveryLedgerEntries(workspaceId);
  return useMemo<DeliveryBalance[]>(() => {
    return [...partyTotalsFromBreakdown(merchantSettlementBreakdownByParty(entries)).entries()]
      .map(([id, item]) => ({ id, currency: item.currency, amount: item.amount, paid: item.paid }))
      .filter((item) => Math.abs(item.amount) > 0.000001);
  }, [entries]);
}

/**
 * Preserves negative courier balances so earned fees and recipient advances
 * that cannot be retained from collected cash become payable instead of
 * silently disappearing.
 */
export function useCourierDeliveryAccountBalances(workspaceId?: string) {
  const entries = useDeliveryLedgerEntries(workspaceId);
  return useMemo<DeliveryCourierAccountBalance[]>(() => {
    const totals = new Map<string, DeliveryCourierAccountBalance>();
    for (const entry of entries) {
      if (!entry.agentId || entry.isDeleted) continue;
      const key = `${entry.agentId}:${entry.currency}`;
      const total = totals.get(key) ?? { id: entry.agentId, currency: entry.currency, amount: 0 };
      total.amount += Number(entry.amount || 0);
      totals.set(key, total);
    }
    return [...totals.values()].filter((item) => Math.abs(item.amount) > 0.000001);
  }, [entries]);
}

/**
 * Preserves a negative merchant balance for account visibility. Payout flows
 * intentionally use `useMerchantDeliveryBalances`, which only returns money
 * currently payable to the merchant.
 */
export function useMerchantDeliveryAccountBalances(workspaceId?: string) {
  const entries = useDeliveryLedgerEntries(workspaceId);
  return useMemo<DeliveryMerchantAccountBalance[]>(() => {
    const totals = new Map<string, DeliveryMerchantAccountBalance>();
    for (const entry of entries) {
      if (!entry.merchantProfileId) continue;
      const key = `${entry.merchantProfileId}:${entry.currency}`;
      const total = totals.get(key) ?? {
        id: entry.merchantProfileId,
        currency: entry.currency,
        amount: 0,
      };
      total.amount += Number(entry.amount || 0);
      totals.set(key, total);
    }
    return [...totals.values()].filter((item) => Math.abs(item.amount) > 0.000001);
  }, [entries]);
}

export async function createDeliveryMerchantProfile(
  workspaceId: string,
  input: DeliveryMerchantProfileInput,
) {
  const partner = await db.business_partners.get(input.businessPartnerId);
  if (!partner || partner.isDeleted || partner.workspaceId !== workspaceId) {
    throw new Error("Select a business partner in this workspace");
  }
  const current = await db.delivery_merchant_profiles
    .where("[workspaceId+businessPartnerId]")
    .equals([workspaceId, input.businessPartnerId])
    .and((row) => !row.isDeleted)
    .first();
  if (current) return current;

  const profile = makeBase(workspaceId, {
    businessPartnerId: input.businessPartnerId,
    defaultFeeAmount: positiveMoney(input.defaultFeeAmount ?? 0, "Default delivery fee"),
    defaultFeePayer: input.defaultFeePayer ?? "merchant",
    defaultPickupAddress: normalizeText(input.defaultPickupAddress),
    payoutSchedule: input.payoutSchedule ?? "daily",
    isActive: input.isActive ?? true,
  }) as DeliveryMerchantProfile;
  await db.delivery_merchant_profiles.put(profile);
  await syncEntities(PROFILE_TABLE, [profile], workspaceId);
  return profile;
}

export async function updateDeliveryMerchantProfile(
  profileId: string,
  input: UpdateDeliveryMerchantProfileInput,
) {
  const profile = await db.delivery_merchant_profiles.get(profileId);
  if (!profile || profile.isDeleted) throw new Error("Merchant not found");

  const now = new Date().toISOString();
  const updated: DeliveryMerchantProfile = {
    ...profile,
    defaultFeeAmount: positiveMoney(input.defaultFeeAmount, "Default delivery fee"),
    defaultFeePayer: input.defaultFeePayer,
    defaultPickupAddress: normalizeText(input.defaultPickupAddress),
    payoutSchedule: input.payoutSchedule,
    isActive: input.isActive,
    updatedAt: now,
    version: profile.version + 1,
    ...getSyncMetadata(profile.workspaceId, now),
  };
  await db.delivery_merchant_profiles.put(updated);
  await syncEntities(PROFILE_TABLE, [updated], profile.workspaceId);
  return updated;
}

export async function hardDeleteDeliveryMerchantProfile(profileId: string) {
  const profile = await db.delivery_merchant_profiles.get(profileId);
  if (!profile || profile.isDeleted) return;

  const [shipment, ledgerEntry] = await Promise.all([
    db.delivery_shipments.where("merchantProfileId").equals(profile.id).first(),
    db.delivery_ledger_entries.where("merchantProfileId").equals(profile.id).first(),
  ]);
  if (shipment || ledgerEntry) {
    throw new Error("A merchant with delivery history cannot be permanently deleted. Make it inactive instead.");
  }

  await db.delivery_merchant_profiles.delete(profile.id);
  await syncHardDeleteProfile(profile.id, profile.workspaceId);
}

export async function createDeliveryShipment(
  workspaceId: string,
  input: CreateDeliveryShipmentInput,
) {
  return createDeliveryShipmentWithId(workspaceId, input);
}

async function createDeliveryShipmentWithId(
  workspaceId: string,
  input: CreateDeliveryShipmentInput,
  shipmentId?: string,
) {
  const profile = await db.delivery_merchant_profiles.get(input.merchantProfileId);
  if (!profile || profile.isDeleted || !profile.isActive || profile.workspaceId !== workspaceId) {
    throw new Error("Select an active delivery merchant");
  }
  if (!input.recipientPhone.trim() || !input.recipientAddress.trim()) {
    throw new Error("Recipient phone and delivery address are required");
  }
  const customerPaymentStatus = input.customerPaymentStatus ?? "cash_on_delivery";
  const now = new Date().toISOString();
  const trackingNumber = await getInitialShipmentTrackingNumber(workspaceId);
  const shipment = {
    ...makeBase(workspaceId, {
    trackingNumber,
    merchantProfileId: profile.id,
    merchantBusinessPartnerId: profile.businessPartnerId,
    recipientPhone: input.recipientPhone.trim(),
    recipientAddress: input.recipientAddress.trim(),
    recipientLatitude: null,
    recipientLongitude: null,
    description: normalizeText(input.description),
    currency: input.currency,
    // A prepaid post cannot accidentally create courier custody. It may still
    // carry a merchant-funded delivery fee or recipient payout.
    codAmount: customerPaymentStatus === "prepaid_electronically" ? 0 : positiveMoney(input.codAmount, "COD amount", false),
    customerPaymentStatus,
    recipientPayoutAmount: positiveMoney(input.recipientPayoutAmount ?? 0, "Recipient payout amount"),
    // New posts are normally handed to the courier, who advances any recipient
    // payout. Existing cloud rows are deliberately read as workspace-funded in
    // the delivery workflow below so historical payments retain their meaning.
    recipientPayoutFunding: input.recipientPayoutFunding ?? "courier_advance",
    recipientPayoutPaymentTransactionId: null,
    deliveryFee: positiveMoney(input.deliveryFee ?? profile.defaultFeeAmount, "Delivery fee"),
    feePayer: input.feePayer ?? profile.defaultFeePayer,
    status: "received" as const,
    assignedAgentId: null,
    assignedRunId: null,
    deliveredAt: null,
    postponedAt: null,
    returnedAt: null,
    returnReceivedAt: null,
    statusNote: null,
    sourceSalesOrderId: input.sourceSalesOrderId ?? null,
    createdBy: input.createdBy ?? null,
    }),
    ...(shipmentId ? { id: shipmentId } : {}),
  } as DeliveryShipment;
  const event = makeBase(workspaceId, {
    shipmentId: shipment.id,
    previousStatus: null,
    status: "received" as const,
    note: null,
    actorUserId: input.createdBy ?? null,
    actorAgentId: null,
    occurredAt: now,
  }) as DeliveryShipmentEvent;

  await db.transaction("rw", [db.delivery_shipments, db.delivery_shipment_events], async () => {
    await db.delivery_shipments.put(shipment);
    await db.delivery_shipment_events.put(event);
  });
  await syncEntitiesInDependencyOrder(workspaceId, [
    [PROFILE_TABLE, [profile]],
    [SHIPMENT_TABLE, [shipment]],
    [EVENT_TABLE, [event]],
  ]);
  return shipment;
}

export async function createDeliveryRun(workspaceId: string, input: CreateDeliveryRunInput) {
  return createDeliveryRunWithId(workspaceId, input);
}

type DeliveryShipmentRedispatchEdit = Pick<
  DeliveryShipment,
  | "merchantProfileId"
  | "merchantBusinessPartnerId"
  | "recipientPhone"
  | "recipientAddress"
  | "description"
  | "currency"
  | "codAmount"
  | "customerPaymentStatus"
  | "recipientPayoutAmount"
  | "recipientPayoutFunding"
  | "deliveryFee"
  | "feePayer"
>;

type CreateDeliveryRunOptions = {
  /** Used only by the admin correction flow to replace an active manifest. */
  allowActiveManifestShipment?: boolean;
  shipmentEdits?: ReadonlyMap<string, DeliveryShipmentRedispatchEdit>;
  eventNotes?: ReadonlyMap<string, string | null>;
};

async function createDeliveryRunWithId(
  workspaceId: string,
  input: CreateDeliveryRunInput,
  runId?: string,
  options?: CreateDeliveryRunOptions,
) {
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.status !== "active" || agent.agentType !== "courier") {
    throw new Error("Select an active courier");
  }
  const courierDeliveryFee = positiveMoney(
    input.courierDeliveryFee ?? agent.courierDeliveryFee ?? 0,
    "Courier delivery fee",
  );
  const shipmentIds = [...new Set(input.shipmentIds.filter(Boolean))];
  if (shipmentIds.length === 0) throw new Error("Select at least one shipment");
  const shipments = await db.delivery_shipments.bulkGet(shipmentIds);
  const dispatchableStatuses = [
    "received",
    "postponed",
    ...(input.allowReturnedShipment ? ["returned"] : []),
    ...(options?.allowActiveManifestShipment ? ["assigned"] : []),
  ];
  if (shipments.some((shipment) => !shipment || shipment.isDeleted || shipment.workspaceId !== workspaceId || !dispatchableStatuses.includes(shipment.status))) {
    throw new Error("Only unassigned, received, or postponed shipments can be dispatched");
  }

  const postponedVoiceReasonsByShipment = new Map<string, { eventIds: string[]; paths: string[] }>();
  await Promise.all((shipments as DeliveryShipment[])
    .filter((shipment) => shipment.status === "postponed")
    .map(async (shipment) => {
      const events = await db.delivery_shipment_events
        .where("[workspaceId+shipmentId]")
        .equals([workspaceId, shipment.id])
        .toArray();
      const postponedEvents = events.filter((event) => !event.isDeleted && event.status === "postponed");
      const paths = getPostponedVoiceReasonCleanupPaths({
        workspaceId,
        shipmentId: shipment.id,
        paths: postponedEvents.map((event) => event.voiceReasonPath),
      });
      if (paths.length > 0) {
        postponedVoiceReasonsByShipment.set(shipment.id, {
          eventIds: postponedEvents
            .filter((event) => typeof event.voiceReasonPath === "string" && paths.includes(event.voiceReasonPath))
            .map((event) => event.id),
          paths,
        });
      }
    }));

  const now = input.dispatchedAt ? new Date(input.dispatchedAt).toISOString() : new Date().toISOString();
  const returnedRunItems = (await Promise.all((shipments as DeliveryShipment[])
    .filter((shipment) => (
      shipment.assignedRunId
      && (shipment.status === "returned" || (options?.allowActiveManifestShipment && ["assigned", "postponed"].includes(shipment.status)))
    ))
    .map(async (shipment) => {
      const previousItem = await db.delivery_run_items
        .where("[runId+shipmentId]")
        .equals([shipment.assignedRunId!, shipment.id])
        .first();
      if (!previousItem || previousItem.isDeleted) return null;
      return {
        ...previousItem,
        returnedAt: now,
        updatedAt: now,
        version: previousItem.version + 1,
        ...getSyncMetadata(workspaceId, now),
      } as DeliveryRunItem;
    }))).filter((item): item is DeliveryRunItem => item !== null);
  const run = {
    ...makeBase(workspaceId, {
    runNumber: makeReference("RUN", new Date(now)),
    agentId: agent.id,
    courierDeliveryFee,
    vehicleId: input.vehicleId ?? null,
    status: "open" as const,
    dispatchedAt: now,
    closedAt: null,
    notes: normalizeText(input.notes),
    createdBy: input.createdBy ?? null,
    }),
    ...(runId ? { id: runId } : {}),
  } as DeliveryRun;
  const updates: DeliveryShipment[] = [];
  const items: DeliveryRunItem[] = [];
  const events: DeliveryShipmentEvent[] = [];
  for (const original of shipments as DeliveryShipment[]) {
    const shipmentEdit = options?.shipmentEdits?.get(original.id);
    const updated: DeliveryShipment = {
      ...original,
      ...shipmentEdit,
      status: "assigned",
      assignedAgentId: agent.id,
      assignedRunId: run.id,
      courierDeliveryFee,
      statusNote: null,
      updatedAt: now,
      version: original.version + 1,
      ...getSyncMetadata(workspaceId, now),
    };
    updates.push(updated);
    items.push(makeBase(workspaceId, {
      runId: run.id,
      shipmentId: original.id,
      assignedAt: now,
      returnedAt: null,
    }) as DeliveryRunItem);
    events.push(makeBase(workspaceId, {
      shipmentId: original.id,
      previousStatus: original.status,
      status: "assigned",
      note: options?.eventNotes?.get(original.id) ?? normalizeText(input.notes),
      actorUserId: input.createdBy ?? null,
      actorAgentId: agent.id,
      occurredAt: now,
    }) as DeliveryShipmentEvent);
  }

  await db.transaction("rw", [db.delivery_runs, db.delivery_shipments, db.delivery_run_items, db.delivery_shipment_events], async () => {
    await db.delivery_runs.put(run);
    await db.delivery_shipments.bulkPut(updates);
    await db.delivery_run_items.bulkPut([...returnedRunItems, ...items]);
    await db.delivery_shipment_events.bulkPut(events);
  });
  const synced = await syncEntitiesInDependencyOrder(workspaceId, [
    [RUN_TABLE, [run]],
    [SHIPMENT_TABLE, updates],
    [RUN_ITEM_TABLE, [...returnedRunItems, ...items]],
    [EVENT_TABLE, events],
  ]);
  for (const [shipmentId, cleanup] of postponedVoiceReasonsByShipment) {
    if (!synced) {
      await queuePostponedVoiceReasonCleanup({ workspaceId, shipmentId, ...cleanup });
      continue;
    }
    try {
      // Every run item and status event is synced before this point. The
      // recording is now irrelevant and can safely be removed through the
      // authenticated Storage API.
      await deleteVoiceStorageObjects(cleanup.paths);
    } catch {
      await queuePostponedVoiceReasonCleanup({ workspaceId, shipmentId, ...cleanup });
    }
  }
  return run;
}

/**
 * Creates and assigns a post as one recoverable client operation. The stable
 * entity IDs mean a retry resumes a post that was already persisted locally,
 * instead of creating a duplicate after a manifest error or interrupted sync.
 */
export async function createAndDispatchDeliveryShipment(
  workspaceId: string,
  input: CreateAndDispatchDeliveryShipmentInput,
) {
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("A delivery operation ID is required");

  const shipmentId = await deliveryOperationId(`create-and-dispatch:${operationId}:shipment`);
  const runId = await deliveryOperationId(`create-and-dispatch:${operationId}:run`);
  let shipment = await db.delivery_shipments.get(shipmentId);
  if (shipment && (shipment.workspaceId !== workspaceId || shipment.isDeleted)) {
    throw new Error("This create-and-dispatch operation cannot be resumed");
  }
  if (!shipment) {
    shipment = await createDeliveryShipmentWithId(workspaceId, input.shipment, shipmentId);
  }

  const existingRun = await db.delivery_runs.get(runId);
  if (existingRun) {
    if (existingRun.workspaceId !== workspaceId || existingRun.isDeleted) {
      throw new Error("This create-and-dispatch operation cannot be resumed");
    }
    return { shipment, run: existingRun };
  }

  if (shipment.assignedRunId) {
    const assignedRun = await db.delivery_runs.get(shipment.assignedRunId);
    if (assignedRun && !assignedRun.isDeleted && assignedRun.workspaceId === workspaceId) {
      return { shipment, run: assignedRun };
    }
  }
  if (shipment.status !== "received") {
    throw new Error("This post is no longer available for create and dispatch");
  }

  try {
    const run = await createDeliveryRunWithId(workspaceId, {
      agentId: input.agentId,
      shipmentIds: [shipment.id],
      courierDeliveryFee: input.courierDeliveryFee,
      vehicleId: input.vehicleId,
      dispatchedAt: input.dispatchedAt,
      notes: input.notes,
      createdBy: input.createdBy,
    }, runId);
    const assignedShipment = await db.delivery_shipments.get(shipment.id) ?? shipment;
    return { shipment: assignedShipment, run };
  } catch {
    throw new Error("Post created but assignment could not be completed. Retry to finish assigning the same post.");
  }
}

export async function transferReturnedDeliveryShipment(workspaceId: string, input: TransferReturnedDeliveryShipmentInput) {
  const shipment = await db.delivery_shipments.get(input.shipmentId);
  if (!shipment || shipment.isDeleted || shipment.workspaceId !== workspaceId || shipment.status !== "returned") {
    throw new Error("Only returned shipments can be transferred");
  }
  if (shipment.returnReceivedAt) {
    throw new Error("A received return cannot be transferred");
  }
  if (!shipment.assignedAgentId || shipment.assignedAgentId === input.agentId) {
    throw new Error("Select a different courier");
  }
  return createDeliveryRun(workspaceId, {
    agentId: input.agentId,
    shipmentIds: [shipment.id],
    courierDeliveryFee: input.courierDeliveryFee,
    vehicleId: input.vehicleId,
    dispatchedAt: input.dispatchedAt,
    notes: input.notes,
    createdBy: input.createdBy,
    allowReturnedShipment: true,
  });
}

export async function receiveReturnedDeliveryShipment(
  workspaceId: string,
  input: ReceiveReturnedDeliveryShipmentInput,
) {
  if (input.actorRole !== "admin") {
    throw new Error("Only an administrator can receive a returned post");
  }
  const original = await db.delivery_shipments.get(input.shipmentId);
  if (!original || original.isDeleted || original.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (original.status !== "returned") {
    throw new Error("Only returned posts can be received");
  }
  if (original.returnReceivedAt) {
    throw new Error("This returned post has already been received");
  }
  if (original.version !== input.expectedVersion) {
    throw new Error("This post has changed. Refresh it before receiving its return");
  }

  const now = new Date().toISOString();
  const updated: DeliveryShipment = {
    ...original,
    returnReceivedAt: now,
    updatedAt: now,
    version: original.version + 1,
    ...getSyncMetadata(workspaceId, now),
  };
  const event = makeBase(workspaceId, {
    shipmentId: original.id,
    previousStatus: "returned" as const,
    status: "returned" as const,
    action: "return_received" as const,
    note: normalizeText(input.note),
    actorUserId: input.actorUserId ?? null,
    actorAgentId: original.assignedAgentId ?? null,
    occurredAt: now,
  }) as DeliveryShipmentEvent;

  await db.transaction("rw", [db.delivery_shipments, db.delivery_shipment_events], async () => {
    await db.delivery_shipments.put(updated);
    await db.delivery_shipment_events.put(event);
  });
  await syncEntitiesInDependencyOrder(workspaceId, [
    [SHIPMENT_TABLE, [updated]],
    [EVENT_TABLE, [event]],
  ]);
  return updated;
}

export async function adminEditAndRedispatchDeliveryShipment(
  workspaceId: string,
  input: AdminEditAndRedispatchDeliveryShipmentInput,
) {
  if (input.actorRole !== "admin") {
    throw new Error("Only an administrator can edit and redispatch a post");
  }
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("A delivery operation ID is required");

  const runId = await deliveryOperationId(`admin-redispatch:${operationId}:run`);
  const existingRun = await db.delivery_runs.get(runId);
  if (existingRun) {
    if (existingRun.workspaceId !== workspaceId || existingRun.isDeleted) {
      throw new Error("This admin redispatch operation cannot be resumed");
    }
    return existingRun;
  }

  const original = await db.delivery_shipments.get(input.shipmentId);
  if (!original || original.isDeleted || original.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (original.version !== input.expectedVersion) {
    throw new Error("This post has changed. Refresh it before editing and redispatching");
  }
  if (!( ["received", "assigned", "postponed"] as DeliveryShipmentStatus[]).includes(original.status)) {
    throw new Error("Only received, assigned, or postponed posts can be edited and redispatched");
  }

  const profile = await db.delivery_merchant_profiles.get(input.shipment.merchantProfileId);
  if (!profile || profile.isDeleted || !profile.isActive || profile.workspaceId !== workspaceId) {
    throw new Error("Select an active delivery merchant");
  }
  if (!input.shipment.recipientPhone.trim() || !input.shipment.recipientAddress.trim()) {
    throw new Error("Recipient phone and delivery address are required");
  }

  const customerPaymentStatus = input.shipment.customerPaymentStatus ?? "cash_on_delivery";
  const edit: DeliveryShipmentRedispatchEdit = {
    merchantProfileId: profile.id,
    merchantBusinessPartnerId: profile.businessPartnerId,
    recipientPhone: input.shipment.recipientPhone.trim(),
    recipientAddress: input.shipment.recipientAddress.trim(),
    description: normalizeText(input.shipment.description),
    currency: input.shipment.currency,
    codAmount: customerPaymentStatus === "prepaid_electronically"
      ? 0
      : positiveMoney(input.shipment.codAmount, "COD amount", false),
    customerPaymentStatus,
    recipientPayoutAmount: positiveMoney(input.shipment.recipientPayoutAmount ?? 0, "Recipient payout amount"),
    recipientPayoutFunding: input.shipment.recipientPayoutFunding ?? original.recipientPayoutFunding ?? "courier_advance",
    deliveryFee: positiveMoney(input.shipment.deliveryFee ?? profile.defaultFeeAmount, "Delivery fee"),
    feePayer: input.shipment.feePayer ?? profile.defaultFeePayer,
  };
  const pendingCodAdjustment = await db.delivery_shipment_cod_adjustment_requests
    .where("[workspaceId+shipmentId+status]")
    .equals([workspaceId, original.id, "pending"])
    .and((request) => !request.isDeleted)
    .first();
  const pendingRecipientPayoutAdjustment = await db.delivery_shipment_recipient_payout_adjustment_requests
    .where("[workspaceId+shipmentId+status]")
    .equals([workspaceId, original.id, "pending"])
    .and((request) => !request.isDeleted)
    .first();
  if (pendingCodAdjustment && (
    edit.codAmount !== original.codAmount
    || edit.currency !== original.currency
    || edit.customerPaymentStatus !== original.customerPaymentStatus
  )) {
    throw new Error("Review the pending COD change before changing the post COD details");
  }
  if (pendingRecipientPayoutAdjustment && (
    edit.recipientPayoutAmount !== original.recipientPayoutAmount
    || edit.recipientPayoutFunding !== original.recipientPayoutFunding
    || edit.currency !== original.currency
    || edit.customerPaymentStatus !== original.customerPaymentStatus
  )) {
    throw new Error("Review the pending recipient payout change before changing the post payout details");
  }
  const changedFields = (Object.keys(edit) as Array<keyof DeliveryShipmentRedispatchEdit>)
    .filter((key) => original[key] !== edit[key])
    .map((key) => key.replace(/([A-Z])/g, " $1").toLowerCase());
  const priorAssignment = original.assignedRunId
    ? ` Previous manifest ${original.assignedRunId} was closed for redispatch.`
    : "";
  const auditAction = original.status === "received" ? "dispatched" : "redispatched";
  const auditNote = `Admin edited and ${auditAction} this post${changedFields.length ? `: ${changedFields.join(", ")}.` : "."}${priorAssignment}`;

  return createDeliveryRunWithId(workspaceId, {
    agentId: input.agentId,
    shipmentIds: [original.id],
    courierDeliveryFee: input.courierDeliveryFee,
    vehicleId: input.vehicleId,
    dispatchedAt: input.dispatchedAt,
    notes: input.notes,
    createdBy: input.actorUserId,
  }, runId, {
    allowActiveManifestShipment: true,
    shipmentEdits: new Map([[original.id, edit]]),
    eventNotes: new Map([[original.id, auditNote]]),
  });
}

export async function adminEditReceivedDeliveryShipment(
  workspaceId: string,
  input: AdminEditReceivedDeliveryShipmentInput,
) {
  if (input.actorRole !== "admin") {
    throw new Error("Only an administrator can edit a received post");
  }

  const original = await db.delivery_shipments.get(input.shipmentId);
  if (!original || original.isDeleted || original.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (original.version !== input.expectedVersion) {
    throw new Error("This post has changed. Refresh it before editing");
  }
  if (original.status !== "received") {
    throw new Error("Only received posts can be edited without dispatch");
  }

  const profile = await db.delivery_merchant_profiles.get(input.shipment.merchantProfileId);
  if (!profile || profile.isDeleted || !profile.isActive || profile.workspaceId !== workspaceId) {
    throw new Error("Select an active delivery merchant");
  }
  if (!input.shipment.recipientPhone.trim() || !input.shipment.recipientAddress.trim()) {
    throw new Error("Recipient phone and delivery address are required");
  }

  const customerPaymentStatus = input.shipment.customerPaymentStatus ?? "cash_on_delivery";
  const edit: DeliveryShipmentRedispatchEdit = {
    merchantProfileId: profile.id,
    merchantBusinessPartnerId: profile.businessPartnerId,
    recipientPhone: input.shipment.recipientPhone.trim(),
    recipientAddress: input.shipment.recipientAddress.trim(),
    description: normalizeText(input.shipment.description),
    currency: input.shipment.currency,
    codAmount: customerPaymentStatus === "prepaid_electronically"
      ? 0
      : positiveMoney(input.shipment.codAmount, "COD amount", false),
    customerPaymentStatus,
    recipientPayoutAmount: positiveMoney(input.shipment.recipientPayoutAmount ?? 0, "Recipient payout amount"),
    recipientPayoutFunding: input.shipment.recipientPayoutFunding ?? original.recipientPayoutFunding ?? "courier_advance",
    deliveryFee: positiveMoney(input.shipment.deliveryFee ?? profile.defaultFeeAmount, "Delivery fee"),
    feePayer: input.shipment.feePayer ?? profile.defaultFeePayer,
  };
  const changedFields = (Object.keys(edit) as Array<keyof DeliveryShipmentRedispatchEdit>)
    .filter((key) => original[key] !== edit[key])
    .map((key) => key.replace(/([A-Z])/g, " $1").toLowerCase());
  const now = new Date().toISOString();
  const updated: DeliveryShipment = {
    ...original,
    ...edit,
    updatedAt: now,
    version: original.version + 1,
    ...getSyncMetadata(workspaceId, now),
  };
  const event = makeBase(workspaceId, {
    shipmentId: original.id,
    previousStatus: "received" as const,
    status: "received" as const,
    note: `Admin edited this received post${changedFields.length ? `: ${changedFields.join(", ")}.` : "."}`,
    actorUserId: input.actorUserId ?? null,
    actorAgentId: null,
    occurredAt: now,
  }) as DeliveryShipmentEvent;

  await db.transaction("rw", [db.delivery_shipments, db.delivery_shipment_events], async () => {
    await db.delivery_shipments.put(updated);
    await db.delivery_shipment_events.put(event);
  });
  await syncEntitiesInDependencyOrder(workspaceId, [
    [SHIPMENT_TABLE, [updated]],
    [EVENT_TABLE, [event]],
  ]);
  return updated;
}

export async function updateDeliveryShipmentStatus(
  shipmentId: string,
  input: UpdateDeliveryShipmentStatusInput,
) {
  const original = await db.delivery_shipments.get(shipmentId);
  if (!original || original.isDeleted) throw new Error("Shipment not found");
  if (["delivered", "returned", "cancelled"].includes(original.status)) {
    throw new Error("A completed shipment cannot be changed. Record an adjustment instead.");
  }
  const note = normalizeText(input.note);
  const voiceReasonPath = normalizeText(input.voiceReasonPath);
  const allowsVoiceReason = ["postponed", "returned"].includes(input.status);
  if (input.status === "cancelled" && !note) {
    throw new Error("A reason is required for this status");
  }
  if (voiceReasonPath && !allowsVoiceReason) {
    throw new Error("Voice reasons are only supported for returned or postponed posts");
  }
  const voiceReasonDurationMs = voiceReasonPath ? Number(input.voiceReasonDurationMs) : null;
  if (voiceReasonPath && (voiceReasonDurationMs === null || !Number.isInteger(voiceReasonDurationMs) || voiceReasonDurationMs < 1 || voiceReasonDurationMs > 1_800_000)) {
    throw new Error("Voice reason duration is invalid");
  }
  if (["delivered", "postponed", "returned"].includes(input.status) && !original.assignedAgentId) {
    throw new Error("Assign the shipment to a courier first");
  }
  if (input.actorAgentId && original.assignedAgentId && input.actorAgentId !== original.assignedAgentId) {
    throw new Error("A courier can only update shipments assigned to them");
  }
  if (input.status === "delivered") {
    const [pendingCodAdjustment, pendingRecipientPayoutAdjustment] = await Promise.all([
      db.delivery_shipment_cod_adjustment_requests
        .where("[workspaceId+shipmentId+status]")
        .equals([original.workspaceId, original.id, "pending"])
        .and((request) => !request.isDeleted)
        .first(),
      db.delivery_shipment_recipient_payout_adjustment_requests
        .where("[workspaceId+shipmentId+status]")
        .equals([original.workspaceId, original.id, "pending"])
        .and((request) => !request.isDeleted)
        .first(),
    ]);
    if (pendingCodAdjustment) {
      throw new Error("Review the pending COD change before marking the post delivered");
    }
    if (pendingRecipientPayoutAdjustment) {
      throw new Error("Review the pending recipient payout change before marking the post delivered");
    }
  }

  const operationKey = `${original.id}:${original.version}:${input.status}`;
  const now = new Date().toISOString();
  const recipientPayoutAmount = positiveMoney(original.recipientPayoutAmount ?? 0, "Recipient payout amount");
  // Rows created before this field existed recorded an immediate workspace
  // payment, so preserve that historical accounting treatment by default.
  const recipientPayoutFunding = original.recipientPayoutFunding ?? "workspace_payment";
  let recipientPayoutPaymentTransactionId: string | null = null;
  if (input.status === "delivered" && recipientPayoutAmount > 0 && recipientPayoutFunding === "workspace_payment") {
    const payment = await appendPaymentTransaction(original.workspaceId, {
      sourceModule: "post_service",
      sourceType: "delivery_recipient_payout",
      sourceRecordId: original.id,
      id: await deliveryOperationId(`recipient-payout:${operationKey}`),
      idempotent: true,
      direction: "outgoing",
      amount: recipientPayoutAmount,
      currency: original.currency,
      paymentMethod: input.recipientPayoutPaymentMethod ?? "cash",
      paidAt: now,
      counterpartyName: original.recipientPhone,
      referenceLabel: original.trackingNumber,
      note: `Recipient payout for ${original.trackingNumber}`,
      createdBy: input.actorUserId ?? null,
      accountId: input.recipientPayoutAccountId ?? null,
      accountNameSnapshot: input.recipientPayoutAccountNameSnapshot ?? null,
      metadata: {
        deliveryShipmentId: original.id,
        deliveryMerchantProfileId: original.merchantProfileId,
        businessPartnerId: original.merchantBusinessPartnerId,
        recipientPayoutAmount,
      },
    });
    recipientPayoutPaymentTransactionId = payment.id;
  }
  const updated: DeliveryShipment = {
    ...original,
    status: input.status,
    statusNote: note,
    deliveredAt: input.status === "delivered" ? now : null,
    postponedAt: input.status === "postponed" ? now : original.postponedAt ?? null,
    returnedAt: input.status === "returned" ? now : null,
    recipientPayoutPaymentTransactionId: input.status === "delivered"
      ? recipientPayoutPaymentTransactionId
      : original.recipientPayoutPaymentTransactionId ?? null,
    updatedAt: now,
    version: original.version + 1,
    ...getSyncMetadata(original.workspaceId, now),
  };
  const event = {
    ...(makeBase(original.workspaceId, {
    shipmentId: original.id,
    previousStatus: original.status,
    status: input.status,
    note,
    voiceReasonPath,
    voiceReasonDurationMs: voiceReasonPath ? voiceReasonDurationMs! : null,
    actorUserId: input.actorUserId ?? null,
    actorAgentId: input.actorAgentId ?? original.assignedAgentId ?? null,
    occurredAt: now,
    }) as DeliveryShipmentEvent),
    id: await deliveryOperationId(`status:${operationKey}`),
  };
  const ledgerEntries: DeliveryLedgerEntry[] = [];
  if (input.status === "delivered") {
    const collected = original.codAmount + (original.feePayer === "recipient" ? original.deliveryFee : 0);
    if (collected > 0) {
      ledgerEntries.push(
        makeLedgerEntry(original.workspaceId, {
          kind: "courier_collection",
          shipmentId: original.id,
          settlementId: null,
          agentId: original.assignedAgentId,
          merchantProfileId: null,
          businessPartnerId: null,
          amount: collected,
          currency: original.currency,
          occurredAt: now,
          note: `Collected on ${original.trackingNumber}`,
          createdBy: input.actorUserId ?? null,
        }),
      );
    }
    const courierDeliveryFee = positiveMoney(original.courierDeliveryFee ?? 0, "Courier delivery fee");
    if (courierDeliveryFee > 0) {
      ledgerEntries.push(
        makeLedgerEntry(original.workspaceId, {
          kind: "courier_delivery_fee",
          shipmentId: original.id,
          settlementId: null,
          agentId: original.assignedAgentId,
          merchantProfileId: null,
          businessPartnerId: null,
          amount: -courierDeliveryFee,
          currency: original.currency,
          occurredAt: now,
          note: `Courier delivery fee for ${original.trackingNumber}`,
          createdBy: input.actorUserId ?? null,
        }),
      );
    }
    if (recipientPayoutAmount > 0 && recipientPayoutFunding === "courier_advance") {
      ledgerEntries.push(
        makeLedgerEntry(original.workspaceId, {
          kind: "courier_recipient_advance",
          shipmentId: original.id,
          settlementId: null,
          agentId: original.assignedAgentId,
          merchantProfileId: null,
          businessPartnerId: null,
          amount: -recipientPayoutAmount,
          currency: original.currency,
          occurredAt: now,
          note: `Courier recipient advance for ${original.trackingNumber}`,
          createdBy: input.actorUserId ?? null,
        }),
      );
    }
    if (original.codAmount > 0) {
      ledgerEntries.push(
        makeLedgerEntry(original.workspaceId, {
          kind: "merchant_cod_payable",
          shipmentId: original.id,
          settlementId: null,
          agentId: null,
          merchantProfileId: original.merchantProfileId,
          businessPartnerId: original.merchantBusinessPartnerId,
          amount: original.codAmount,
          currency: original.currency,
          occurredAt: now,
          note: `COD from ${original.trackingNumber}`,
          createdBy: input.actorUserId ?? null,
        }),
      );
    }
    if (original.feePayer === "merchant" && original.deliveryFee > 0) {
      ledgerEntries.push(makeLedgerEntry(original.workspaceId, {
        kind: "merchant_fee",
        shipmentId: original.id,
        settlementId: null,
        agentId: null,
        merchantProfileId: original.merchantProfileId,
        businessPartnerId: original.merchantBusinessPartnerId,
        amount: -original.deliveryFee,
        currency: original.currency,
        occurredAt: now,
        note: `Delivery fee for ${original.trackingNumber}`,
        createdBy: input.actorUserId ?? null,
      }));
    }
    if (recipientPayoutAmount > 0) {
      ledgerEntries.push(makeLedgerEntry(original.workspaceId, {
        kind: "merchant_recipient_payout",
        shipmentId: original.id,
        settlementId: null,
        agentId: null,
        merchantProfileId: original.merchantProfileId,
        businessPartnerId: original.merchantBusinessPartnerId,
        amount: -recipientPayoutAmount,
        currency: original.currency,
        occurredAt: now,
        note: `Recipient payout for ${original.trackingNumber}`,
        createdBy: input.actorUserId ?? null,
      }));
    }

    await Promise.all(ledgerEntries.map(async (entry) => {
      entry.id = await deliveryOperationId(`obligation:${operationKey}:${entry.kind}`);
    }));
  }
  await db.transaction("rw", [db.delivery_shipments, db.delivery_shipment_events, db.delivery_ledger_entries], async () => {
    await db.delivery_shipments.put(updated);
    await db.delivery_shipment_events.put(event);
    if (ledgerEntries.length > 0) await db.delivery_ledger_entries.bulkPut(ledgerEntries);
  });
  await syncEntitiesInDependencyOrder(original.workspaceId, [
    [SHIPMENT_TABLE, [updated]],
    [EVENT_TABLE, [event]],
    [LEDGER_TABLE, ledgerEntries],
  ]);
  if (input.status === "delivered") {
    const courierAgent = original.assignedAgentId ? await db.agents.get(original.assignedAgentId) : null;
    await refreshDeliveryPartnerBalances(original.workspaceId, [
      original.merchantBusinessPartnerId,
      courierAgent?.businessPartnerId,
    ]);
  }
  return updated;
}

/**
 * Creates a reviewable COD correction request without changing the shipment.
 * This is deliberately limited to the courier currently assigned to an
 * in-progress cash-on-delivery post.
 */
export async function requestDeliveryShipmentCodAdjustment(
  workspaceId: string,
  input: RequestDeliveryShipmentCodAdjustmentInput,
) {
  const shipment = await db.delivery_shipments.get(input.shipmentId);
  if (!shipment || shipment.isDeleted || shipment.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (shipment.customerPaymentStatus !== "cash_on_delivery") {
    throw new Error("Only cash-on-delivery posts can have a COD change requested");
  }
  if (!(["assigned", "postponed"] as DeliveryShipmentStatus[]).includes(shipment.status)) {
    throw new Error("COD changes can only be requested for an assigned or postponed post");
  }
  if (shipment.assignedAgentId !== input.requesterAgentId) {
    throw new Error("A courier can only request a COD change for posts assigned to them");
  }

  const requester = await db.agents.get(input.requesterAgentId);
  if (!requester
    || requester.isDeleted
    || requester.workspaceId !== workspaceId
    || requester.agentType !== "courier"
    || requester.linkedUserId !== input.requesterUserId) {
    throw new Error("A courier can only request a COD change for posts assigned to them");
  }

  const requestedCodAmount = positiveMoney(input.requestedCodAmount, "Requested COD amount", false);
  if (Math.abs(requestedCodAmount - shipment.codAmount) <= 0.000001) {
    throw new Error("Requested COD amount must differ from the current COD amount");
  }
  const reason = normalizeText(input.reason);

  const existing = await db.delivery_shipment_cod_adjustment_requests
    .where("[workspaceId+shipmentId+status]")
    .equals([workspaceId, shipment.id, "pending"])
    .and((request) => !request.isDeleted)
    .first();
  if (existing) throw new Error("This post already has a pending COD change request");

  const request = makeBase(workspaceId, {
    shipmentId: shipment.id,
    requesterUserId: input.requesterUserId,
    requesterAgentId: input.requesterAgentId,
    currency: shipment.currency,
    originalCodAmount: shipment.codAmount,
    requestedCodAmount,
    reason,
    status: "pending" as const,
    reviewedCodAmount: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  }) as DeliveryShipmentCodAdjustmentRequest;

  await db.delivery_shipment_cod_adjustment_requests.put(request);
  await syncEntitiesInDependencyOrder(workspaceId, [
    [COD_ADJUSTMENT_REQUEST_TABLE, [request]],
  ]);
  return request;
}

/**
 * An administrator approves the final COD amount or rejects the request. No
 * payment or ledger row is created here because delivery has not completed;
 * the normal delivered flow will calculate its obligations from the approved
 * shipment amount exactly once.
 */
export async function reviewDeliveryShipmentCodAdjustment(
  requestId: string,
  input: ReviewDeliveryShipmentCodAdjustmentInput,
) {
  const originalRequest = await db.delivery_shipment_cod_adjustment_requests.get(requestId);
  if (!originalRequest || originalRequest.isDeleted) throw new Error("COD change request not found");
  if (originalRequest.status !== "pending") throw new Error("This COD change request has already been reviewed");
  if (!input.reviewerUserId) throw new Error("Only an administrator can review a COD change request");

  const shipment = await db.delivery_shipments.get(originalRequest.shipmentId);
  if (!shipment || shipment.isDeleted || shipment.workspaceId !== originalRequest.workspaceId) {
    throw new Error("Shipment not found");
  }
  const reviewNote = normalizeText(input.reviewNote);
  const now = new Date().toISOString();

  const approvedCodAmount = input.decision === "approved"
    ? positiveMoney(input.approvedCodAmount ?? NaN, "Approved COD amount", false)
    : null;
  const shipmentAlreadyHasApprovedCod = input.decision === "approved"
    && Math.abs(shipment.codAmount - approvedCodAmount!) <= 0.000001;
  if (input.decision === "approved" && (
    shipment.customerPaymentStatus !== "cash_on_delivery"
    || !(["assigned", "postponed"] as DeliveryShipmentStatus[]).includes(shipment.status)
    || (
      Math.abs(shipment.codAmount - originalRequest.originalCodAmount) > 0.000001
      && !shipmentAlreadyHasApprovedCod
    )
  )) {
    throw new Error("This COD change request can no longer be approved");
  }

  const reviewedRequest: DeliveryShipmentCodAdjustmentRequest = {
    ...originalRequest,
    status: input.decision,
    reviewedCodAmount: approvedCodAmount,
    reviewNote,
    reviewedBy: input.reviewerUserId,
    reviewedAt: now,
    updatedAt: now,
    version: originalRequest.version + 1,
    ...getSyncMetadata(originalRequest.workspaceId, now),
  };
  const adjustedShipment: DeliveryShipment | null = input.decision === "approved" && !shipmentAlreadyHasApprovedCod
    ? {
      ...shipment,
      codAmount: approvedCodAmount!,
      updatedAt: now,
      version: shipment.version + 1,
      ...getSyncMetadata(shipment.workspaceId, now),
    }
    : null;

  await db.transaction(
    "rw",
    [db.delivery_shipment_cod_adjustment_requests, db.delivery_shipments],
    async () => {
      await db.delivery_shipment_cod_adjustment_requests.put(reviewedRequest);
      if (adjustedShipment) await db.delivery_shipments.put(adjustedShipment);
    },
  );
  const syncOperations: Array<readonly [DeliveryTableName, DeliveryEntity[]]> = [
    [COD_ADJUSTMENT_REQUEST_TABLE, [reviewedRequest]],
  ];
  if (adjustedShipment) syncOperations.push([SHIPMENT_TABLE, [adjustedShipment]]);
  await syncEntitiesInDependencyOrder(originalRequest.workspaceId, syncOperations);
  return { request: reviewedRequest, shipment: adjustedShipment };
}

/**
 * Corrects a delivered cash-on-delivery amount before either side of that
 * post's settlement has started. This is an accounting adjustment, not a
 * payment: the delivery's custody and merchant payable obligations receive
 * matching signed deltas and no payment transaction is created.
 */
export async function correctDeliveredDeliveryShipmentCod(
  workspaceId: string,
  input: CorrectDeliveredDeliveryShipmentCodInput,
) {
  if (input.actorRole !== "admin") {
    throw new Error("Only an administrator can correct a delivered COD amount");
  }
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("A delivered COD correction operation ID is required");
  if (!input.actorUserId) throw new Error("Only an administrator can correct a delivered COD amount");
  const correctedCodAmount = positiveMoney(input.correctedCodAmount, "Corrected COD amount", false);

  if (shouldUseCloudDeliveryData(workspaceId)) {
    if (!isOnline(workspaceId)) {
      throw new Error("Connect to the internet before correcting a delivered COD amount");
    }
    const client = getSupabaseClientForTable(SHIPMENT_TABLE);
    const { error } = (await runSupabaseAction("delivery.correctDeliveredCod", () =>
      client.rpc("correct_delivered_shipment_cod", {
        p_workspace_id: workspaceId,
        p_shipment_id: input.shipmentId,
        p_expected_version: input.expectedVersion,
        p_corrected_cod_amount: correctedCodAmount,
        p_operation_id: operationId,
      }),
    )) as { error?: unknown };
    if (error) throw error;

    // The remote procedure is the atomic source of truth. Hydrate its three
    // changed entity types together rather than creating separately syncable
    // local mutations that could drift from the correction transaction.
    await Promise.all([
      hydrateTable(SHIPMENT_TABLE, workspaceId),
      hydrateTable(COD_CORRECTION_TABLE, workspaceId),
      hydrateTable(LEDGER_TABLE, workspaceId),
    ]);
    const correctedShipment = await db.delivery_shipments.get(input.shipmentId);
    if (!correctedShipment || correctedShipment.isDeleted || correctedShipment.workspaceId !== workspaceId) {
      throw new Error("Could not load the corrected post");
    }
    const courier = correctedShipment.assignedAgentId
      ? await db.agents.get(correctedShipment.assignedAgentId)
      : null;
    await refreshDeliveryPartnerBalances(workspaceId, [
      correctedShipment.merchantBusinessPartnerId,
      courier?.businessPartnerId,
    ]);
    return correctedShipment;
  }

  const existingCorrection = await db.delivery_shipment_cod_corrections.get(operationId);
  if (existingCorrection) {
    if (
      existingCorrection.workspaceId !== workspaceId
      || existingCorrection.shipmentId !== input.shipmentId
      || Math.abs(existingCorrection.correctedCodAmount - correctedCodAmount) > 0.000001
    ) {
      throw new Error("This delivered COD correction operation cannot be reused");
    }
    const correctedShipment = await db.delivery_shipments.get(input.shipmentId);
    if (!correctedShipment || correctedShipment.isDeleted) throw new Error("Shipment not found");
    return correctedShipment;
  }

  const original = await db.delivery_shipments.get(input.shipmentId);
  if (!original || original.isDeleted || original.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (original.version !== input.expectedVersion) {
    throw new Error("This post has changed. Refresh it before correcting the COD");
  }
  if (original.status !== "delivered" || original.customerPaymentStatus !== "cash_on_delivery") {
    throw new Error("Only delivered cash-on-delivery posts can have their COD corrected");
  }
  if (!original.assignedAgentId) {
    throw new Error("A delivered post must have a courier assignment");
  }
  if (Math.abs(original.codAmount - correctedCodAmount) <= 0.000001) {
    throw new Error("Corrected COD amount must differ from the current COD amount");
  }

  const activeEntries = (await db.delivery_ledger_entries
    .where("workspaceId")
    .equals(workspaceId)
    .toArray())
    .filter((entry) => !entry.isDeleted);
  const courierStatus = courierHandoverStatusByShipment(activeEntries).get(original.id)
    ?? courierReimbursementStatusByShipment(activeEntries).get(original.id);
  const merchantStatus = merchantPayoutStatusByShipment(activeEntries).get(original.id)
    ?? merchantRepaymentStatusByShipment(activeEntries).get(original.id);
  if (courierStatus !== "outstanding" || merchantStatus !== "outstanding") {
    throw new Error("Both related settlement obligations must still be fully outstanding");
  }

  const now = new Date().toISOString();
  const delta = correctedCodAmount - original.codAmount;
  const courierLedgerEntry = makeLedgerEntry(workspaceId, {
    kind: "courier_cod_correction",
    shipmentId: original.id,
    codCorrectionId: operationId,
    settlementId: null,
    agentId: original.assignedAgentId,
    merchantProfileId: null,
    businessPartnerId: null,
    amount: delta,
    currency: original.currency,
    occurredAt: now,
    note: null,
    createdBy: input.actorUserId,
  });
  const merchantLedgerEntry = makeLedgerEntry(workspaceId, {
    kind: "merchant_cod_correction",
    shipmentId: original.id,
    codCorrectionId: operationId,
    settlementId: null,
    agentId: null,
    merchantProfileId: original.merchantProfileId,
    businessPartnerId: original.merchantBusinessPartnerId,
    amount: delta,
    currency: original.currency,
    occurredAt: now,
    note: null,
    createdBy: input.actorUserId,
  });
  const correction: DeliveryShipmentCodCorrection = {
    ...(makeBase(workspaceId, {
      shipmentId: original.id,
      currency: original.currency,
      originalCodAmount: original.codAmount,
      correctedCodAmount,
      correctedBy: input.actorUserId,
      correctedAt: now,
      courierLedgerEntryId: courierLedgerEntry.id,
      merchantLedgerEntryId: merchantLedgerEntry.id,
    }) as DeliveryShipmentCodCorrection),
    id: operationId,
  };
  const correctedShipment: DeliveryShipment = {
    ...original,
    codAmount: correctedCodAmount,
    updatedAt: now,
    version: original.version + 1,
    ...getSyncMetadata(workspaceId, now),
  };

  await db.transaction(
    "rw",
    [db.delivery_shipments, db.delivery_shipment_cod_corrections, db.delivery_ledger_entries],
    async () => {
      await db.delivery_shipments.put(correctedShipment);
      await db.delivery_shipment_cod_corrections.put(correction);
      await db.delivery_ledger_entries.bulkPut([courierLedgerEntry, merchantLedgerEntry]);
    },
  );

  const courier = await db.agents.get(original.assignedAgentId);
  await refreshDeliveryPartnerBalances(workspaceId, [
    original.merchantBusinessPartnerId,
    courier?.businessPartnerId,
  ]);
  return correctedShipment;
}

/**
 * Corrects what a courier advanced to the recipient for a delivered prepaid
 * post. It is deliberately limited to courier-funded payouts: no real
 * workspace payment exists to amend, so the two unpaid obligations can be
 * corrected atomically without creating or changing a payment transaction.
 */
export async function correctDeliveredDeliveryShipmentRecipientPayout(
  workspaceId: string,
  input: CorrectDeliveredDeliveryShipmentRecipientPayoutInput,
) {
  if (input.actorRole !== "admin" || !input.actorUserId) {
    throw new Error("Only an administrator can correct a delivered recipient payout amount");
  }
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("A delivered recipient payout correction operation ID is required");
  const correctedRecipientPayoutAmount = positiveMoney(
    input.correctedRecipientPayoutAmount,
    "Corrected recipient payout amount",
  );

  if (shouldUseCloudDeliveryData(workspaceId)) {
    if (!isOnline(workspaceId)) {
      throw new Error("Connect to the internet before correcting a delivered recipient payout");
    }
    const client = getSupabaseClientForTable(SHIPMENT_TABLE);
    const { error } = (await runSupabaseAction("delivery.correctDeliveredRecipientPayout", () =>
      client.rpc("correct_delivered_shipment_recipient_payout", {
        p_workspace_id: workspaceId,
        p_shipment_id: input.shipmentId,
        p_expected_version: input.expectedVersion,
        p_corrected_recipient_payout_amount: correctedRecipientPayoutAmount,
        p_operation_id: operationId,
      }),
    )) as { error?: unknown };
    if (error) throw error;

    await Promise.all([
      hydrateTable(SHIPMENT_TABLE, workspaceId),
      hydrateTable(RECIPIENT_PAYOUT_CORRECTION_TABLE, workspaceId),
      hydrateTable(LEDGER_TABLE, workspaceId),
    ]);
    const correctedShipment = await db.delivery_shipments.get(input.shipmentId);
    if (!correctedShipment || correctedShipment.isDeleted || correctedShipment.workspaceId !== workspaceId) {
      throw new Error("Could not load the corrected post");
    }
    const courier = correctedShipment.assignedAgentId
      ? await db.agents.get(correctedShipment.assignedAgentId)
      : null;
    await refreshDeliveryPartnerBalances(workspaceId, [
      correctedShipment.merchantBusinessPartnerId,
      courier?.businessPartnerId,
    ]);
    return correctedShipment;
  }

  const existingCorrection = await db.delivery_shipment_recipient_payout_corrections.get(operationId);
  if (existingCorrection) {
    if (
      existingCorrection.workspaceId !== workspaceId
      || existingCorrection.shipmentId !== input.shipmentId
      || Math.abs(existingCorrection.correctedRecipientPayoutAmount - correctedRecipientPayoutAmount) > 0.000001
    ) {
      throw new Error("This delivered recipient payout correction operation cannot be reused");
    }
    const correctedShipment = await db.delivery_shipments.get(input.shipmentId);
    if (!correctedShipment || correctedShipment.isDeleted) throw new Error("Shipment not found");
    return correctedShipment;
  }

  const original = await db.delivery_shipments.get(input.shipmentId);
  if (!original || original.isDeleted || original.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (original.version !== input.expectedVersion) {
    throw new Error("This post has changed. Refresh it before correcting the recipient payout");
  }
  if (
    original.status !== "delivered"
    || original.customerPaymentStatus !== "prepaid_electronically"
    || original.recipientPayoutFunding !== "courier_advance"
  ) {
    throw new Error("Only delivered courier-funded electronically prepaid posts can have their recipient payout corrected");
  }
  if (!original.assignedAgentId) {
    throw new Error("A delivered post must have a courier assignment");
  }
  const originalRecipientPayoutAmount = original.recipientPayoutAmount ?? 0;
  if (Math.abs(originalRecipientPayoutAmount - correctedRecipientPayoutAmount) <= 0.000001) {
    throw new Error("Corrected recipient payout amount must differ from the current recipient payout amount");
  }

  const activeEntries = (await db.delivery_ledger_entries
    .where("workspaceId")
    .equals(workspaceId)
    .toArray())
    .filter((entry) => !entry.isDeleted);
  const courierStatus = courierReimbursementStatusByShipment(activeEntries).get(original.id);
  const merchantStatus = merchantRepaymentStatusByShipment(activeEntries).get(original.id);
  if (courierStatus !== "outstanding" || merchantStatus !== "outstanding") {
    throw new Error("Courier reimbursement and merchant repayment must still be fully outstanding");
  }

  const now = new Date().toISOString();
  const correctionDelta = correctedRecipientPayoutAmount - originalRecipientPayoutAmount;
  const courierLedgerEntry = makeLedgerEntry(workspaceId, {
    kind: "courier_recipient_payout_correction",
    shipmentId: original.id,
    codCorrectionId: null,
    recipientPayoutCorrectionId: operationId,
    settlementId: null,
    agentId: original.assignedAgentId,
    merchantProfileId: null,
    businessPartnerId: null,
    amount: -correctionDelta,
    currency: original.currency,
    occurredAt: now,
    note: null,
    createdBy: input.actorUserId,
  });
  const merchantLedgerEntry = makeLedgerEntry(workspaceId, {
    kind: "merchant_recipient_payout_correction",
    shipmentId: original.id,
    codCorrectionId: null,
    recipientPayoutCorrectionId: operationId,
    settlementId: null,
    agentId: null,
    merchantProfileId: original.merchantProfileId,
    businessPartnerId: original.merchantBusinessPartnerId,
    amount: -correctionDelta,
    currency: original.currency,
    occurredAt: now,
    note: null,
    createdBy: input.actorUserId,
  });
  const correction: DeliveryShipmentRecipientPayoutCorrection = {
    ...(makeBase(workspaceId, {
      shipmentId: original.id,
      currency: original.currency,
      originalRecipientPayoutAmount,
      correctedRecipientPayoutAmount,
      correctedBy: input.actorUserId,
      correctedAt: now,
      courierLedgerEntryId: courierLedgerEntry.id,
      merchantLedgerEntryId: merchantLedgerEntry.id,
    }) as DeliveryShipmentRecipientPayoutCorrection),
    id: operationId,
  };
  const correctedShipment: DeliveryShipment = {
    ...original,
    recipientPayoutAmount: correctedRecipientPayoutAmount,
    updatedAt: now,
    version: original.version + 1,
    ...getSyncMetadata(workspaceId, now),
  };

  await db.transaction(
    "rw",
    [db.delivery_shipments, db.delivery_shipment_recipient_payout_corrections, db.delivery_ledger_entries],
    async () => {
      await db.delivery_shipments.put(correctedShipment);
      await db.delivery_shipment_recipient_payout_corrections.put(correction);
      await db.delivery_ledger_entries.bulkPut([courierLedgerEntry, merchantLedgerEntry]);
    },
  );

  const courier = await db.agents.get(original.assignedAgentId);
  await refreshDeliveryPartnerBalances(workspaceId, [
    original.merchantBusinessPartnerId,
    courier?.businessPartnerId,
  ]);
  return correctedShipment;
}

/**
 * Creates a reviewable recipient-payout correction for an in-progress
 * electronically prepaid post. It never changes the payout funding method.
 */
export async function requestDeliveryShipmentRecipientPayoutAdjustment(
  workspaceId: string,
  input: RequestDeliveryShipmentRecipientPayoutAdjustmentInput,
) {
  const shipment = await db.delivery_shipments.get(input.shipmentId);
  if (!shipment || shipment.isDeleted || shipment.workspaceId !== workspaceId) {
    throw new Error("Shipment not found");
  }
  if (shipment.customerPaymentStatus !== "prepaid_electronically") {
    throw new Error("Only electronically prepaid posts can have a recipient payout change requested");
  }
  if (!( ["assigned", "postponed"] as DeliveryShipmentStatus[]).includes(shipment.status)) {
    throw new Error("Recipient payout changes can only be requested for an assigned or postponed post");
  }
  if (shipment.assignedAgentId !== input.requesterAgentId) {
    throw new Error("A courier can only request a recipient payout change for posts assigned to them");
  }

  const requester = await db.agents.get(input.requesterAgentId);
  if (!requester
    || requester.isDeleted
    || requester.workspaceId !== workspaceId
    || requester.agentType !== "courier"
    || requester.linkedUserId !== input.requesterUserId) {
    throw new Error("A courier can only request a recipient payout change for posts assigned to them");
  }

  const requestedRecipientPayoutAmount = positiveMoney(input.requestedRecipientPayoutAmount, "Requested recipient payout amount");
  const originalRecipientPayoutAmount = shipment.recipientPayoutAmount ?? 0;
  if (Math.abs(requestedRecipientPayoutAmount - originalRecipientPayoutAmount) <= 0.000001) {
    throw new Error("Requested recipient payout amount must differ from the current recipient payout amount");
  }
  const reason = normalizeText(input.reason);

  const existing = await db.delivery_shipment_recipient_payout_adjustment_requests
    .where("[workspaceId+shipmentId+status]")
    .equals([workspaceId, shipment.id, "pending"])
    .and((request) => !request.isDeleted)
    .first();
  if (existing) throw new Error("This post already has a pending recipient payout change request");

  const request = makeBase(workspaceId, {
    shipmentId: shipment.id,
    requesterUserId: input.requesterUserId,
    requesterAgentId: input.requesterAgentId,
    currency: shipment.currency,
    originalRecipientPayoutAmount,
    requestedRecipientPayoutAmount,
    reason,
    status: "pending" as const,
    reviewedRecipientPayoutAmount: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  }) as DeliveryShipmentRecipientPayoutAdjustmentRequest;

  await db.delivery_shipment_recipient_payout_adjustment_requests.put(request);
  await syncEntitiesInDependencyOrder(workspaceId, [
    [RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE, [request]],
  ]);
  return request;
}

/**
 * An administrator approves the final recipient payout or rejects the
 * request. Approval creates an auditable, non-cash settlement projection;
 * delivery later recognizes it through the normal payment and ledger rows.
 */
export async function reviewDeliveryShipmentRecipientPayoutAdjustment(
  requestId: string,
  input: ReviewDeliveryShipmentRecipientPayoutAdjustmentInput,
) {
  const originalRequest = await db.delivery_shipment_recipient_payout_adjustment_requests.get(requestId);
  if (!originalRequest || originalRequest.isDeleted) throw new Error("Recipient payout change request not found");
  if (originalRequest.status !== "pending") throw new Error("This recipient payout change request has already been reviewed");
  if (!input.reviewerUserId) throw new Error("Only an administrator can review a recipient payout change request");

  const shipment = await db.delivery_shipments.get(originalRequest.shipmentId);
  if (!shipment || shipment.isDeleted || shipment.workspaceId !== originalRequest.workspaceId) {
    throw new Error("Shipment not found");
  }
  const reviewNote = normalizeText(input.reviewNote);
  const now = new Date().toISOString();
  const approvedRecipientPayoutAmount = input.decision === "approved"
    ? positiveMoney(input.approvedRecipientPayoutAmount ?? NaN, "Approved recipient payout amount")
    : null;
  const currentRecipientPayoutAmount = shipment.recipientPayoutAmount ?? 0;
  const shipmentAlreadyHasApprovedRecipientPayout = input.decision === "approved"
    && Math.abs(currentRecipientPayoutAmount - approvedRecipientPayoutAmount!) <= 0.000001;
  if (input.decision === "approved" && (
    shipment.customerPaymentStatus !== "prepaid_electronically"
    || !( ["assigned", "postponed"] as DeliveryShipmentStatus[]).includes(shipment.status)
    || (
      Math.abs(currentRecipientPayoutAmount - originalRequest.originalRecipientPayoutAmount) > 0.000001
      && !shipmentAlreadyHasApprovedRecipientPayout
    )
  )) {
    throw new Error("This recipient payout change request can no longer be approved");
  }

  const reviewedRequest: DeliveryShipmentRecipientPayoutAdjustmentRequest = {
    ...originalRequest,
    status: input.decision,
    reviewedRecipientPayoutAmount: approvedRecipientPayoutAmount,
    reviewNote,
    reviewedBy: input.reviewerUserId,
    reviewedAt: now,
    updatedAt: now,
    version: originalRequest.version + 1,
    ...getSyncMetadata(originalRequest.workspaceId, now),
  };
  const adjustedShipment: DeliveryShipment | null = input.decision === "approved" && !shipmentAlreadyHasApprovedRecipientPayout
    ? {
      ...shipment,
      recipientPayoutAmount: approvedRecipientPayoutAmount!,
      updatedAt: now,
      version: shipment.version + 1,
      ...getSyncMetadata(shipment.workspaceId, now),
    }
    : null;
  await db.transaction(
    "rw",
    [db.delivery_shipment_recipient_payout_adjustment_requests, db.delivery_shipments],
    async () => {
      await db.delivery_shipment_recipient_payout_adjustment_requests.put(reviewedRequest);
      if (adjustedShipment) await db.delivery_shipments.put(adjustedShipment);
    },
  );
  const syncOperations: Array<readonly [DeliveryTableName, DeliveryEntity[]]> = [
    [RECIPIENT_PAYOUT_ADJUSTMENT_REQUEST_TABLE, [reviewedRequest]],
  ];
  if (adjustedShipment) syncOperations.push([SHIPMENT_TABLE, [adjustedShipment]]);
  await syncEntitiesInDependencyOrder(originalRequest.workspaceId, syncOperations);
  return { request: reviewedRequest, shipment: adjustedShipment };
}

async function createSettlement(
  workspaceId: string,
  type: DeliverySettlementType,
  options: {
    agentId?: string | null;
    merchantProfileId?: string | null;
    businessPartnerId?: string | null;
    currency: CurrencyCode;
    actualAmount: number;
    paymentMethod: WorkspacePaymentMethod;
    shipmentId?: string | null;
    settledAt?: string;
    note?: string | null;
    varianceNote?: string | null;
    createdBy?: string | null;
    accountId?: string | null;
    accountNameSnapshot?: string | null;
  },
) {
  const entries = await db.delivery_ledger_entries.where("workspaceId").equals(workspaceId).toArray();
  const settlementShipment = options.shipmentId
    ? await db.delivery_shipments.get(options.shipmentId)
    : null;
  const isCourierRemittance = type === "courier_remittance";
  const isCourierFeePayout = type === "courier_fee_payout";
  const isCourierReimbursement = type === "courier_reimbursement";
  const isCourierSettlement = isCourierRemittance || isCourierFeePayout || isCourierReimbursement;
  const isMerchantRepayment = type === "merchant_repayment";
  let expectedAmount: number;
  if (options.shipmentId) {
    if (isCourierFeePayout) {
      const balance = courierFeeAccountBalance(
        entries,
        options.agentId,
        options.currency,
        options.shipmentId,
      );
      expectedAmount = balance < -0.000001 ? -balance : 0;
    } else if (isCourierReimbursement) {
      const balance = courierDeliveryAccountBalance(
        entries,
        options.agentId,
        options.currency,
        options.shipmentId,
      );
      expectedAmount = balance < -0.000001 ? -balance : 0;
    } else if (isMerchantRepayment) {
      const balance = merchantDeliveryAccountBalance(
        entries,
        options.merchantProfileId,
        options.currency,
        options.shipmentId,
      );
      expectedAmount = balance < -0.000001 ? -balance : 0;
    } else {
      const breakdown = isCourierRemittance
        ? courierSettlementBreakdownByParty(entries).get(`${options.agentId}:${options.currency}`)
        : merchantSettlementBreakdownByParty(entries).get(`${options.merchantProfileId}:${options.currency}`);
      const post = breakdown?.find((row) => row.shipmentId === options.shipmentId);
      expectedAmount = post?.outstanding ?? 0;
    }
    if (expectedAmount <= 0.000001) {
      throw new Error("The post has no outstanding amount to settle");
    }
  } else {
    if (isCourierFeePayout) {
      const balance = courierFeeAccountBalance(entries, options.agentId, options.currency);
      expectedAmount = balance < -0.000001 ? -balance : 0;
    } else if (isCourierReimbursement) {
      expectedAmount = (courierReimbursementBreakdownByParty(entries)
        .get(`${options.agentId}:${options.currency}`) ?? [])
        .reduce((total, post) => total + post.amount, 0);
    } else if (isMerchantRepayment) {
      expectedAmount = (merchantAccountSettlementBreakdownByParty(entries)
        .get(`${options.merchantProfileId}:${options.currency}`) ?? [])
        .filter((post) => post.direction === "repayment")
        .reduce((total, post) => total + post.outstanding, 0);
    } else {
      const partyTotals = isCourierRemittance
        ? partyTotalsFromBreakdown(courierSettlementBreakdownByParty(entries)).get(options.agentId ?? "")
        : partyTotalsFromBreakdown(merchantSettlementBreakdownByParty(entries)).get(options.merchantProfileId ?? "");
      expectedAmount = partyTotals && options.currency === partyTotals.currency ? partyTotals.amount : 0;
    }
  }
  const { expected, actual } = assertSettlementAmount(expectedAmount, options.actualAmount, options.varianceNote);
  const settledAt = options.settledAt ? new Date(options.settledAt).toISOString() : new Date().toISOString();
  const settlement = makeBase(workspaceId, {
    settlementNumber: makeReference(
      isCourierRemittance ? "CR" : isCourierFeePayout ? "CF" : isCourierReimbursement ? "CP" : isMerchantRepayment ? "MR" : "MP",
      new Date(settledAt),
    ),
    type,
    agentId: options.agentId ?? null,
    merchantProfileId: options.merchantProfileId ?? null,
    businessPartnerId: options.businessPartnerId ?? null,
    shipmentId: options.shipmentId ?? null,
    currency: options.currency,
    // A per-post settlement keeps the courier fee that was snapshotted on
    // dispatch. Whole-party settlements have no single shipment fee, so they
    // retain the explicit zero default instead of guessing an allocation.
    courierDeliveryFee: settlementShipment && !settlementShipment.isDeleted && settlementShipment.workspaceId === workspaceId
      ? positiveMoney(settlementShipment.courierDeliveryFee ?? 0, "Courier delivery fee")
      : 0,
    expectedAmount: expected,
    actualAmount: actual,
    varianceAmount: actual - expected,
    varianceNote: normalizeText(options.varianceNote),
    paymentMethod: options.paymentMethod,
    settledAt,
    note: normalizeText(options.note),
    paymentTransactionId: null,
    createdBy: options.createdBy ?? null,
  }) as DeliverySettlement;
  const entryKind: DeliveryLedgerEntryKind = isCourierRemittance
    ? "courier_remittance"
    : isCourierFeePayout
      ? "courier_fee_payout"
    : isCourierReimbursement
      ? "courier_reimbursement"
    : isMerchantRepayment
      ? "merchant_repayment"
      : "merchant_payout";
  const makeSettlementLedgerEntry = (shipmentId: string | null, amount: number) => makeLedgerEntry(workspaceId, {
    kind: entryKind,
    shipmentId,
    settlementId: settlement.id,
    agentId: isCourierSettlement ? options.agentId ?? null : null,
    merchantProfileId: isCourierSettlement ? null : options.merchantProfileId ?? null,
    businessPartnerId: isCourierSettlement ? null : options.businessPartnerId ?? null,
    amount,
    currency: options.currency,
    occurredAt: settledAt,
    note: normalizeText(options.note),
    createdBy: options.createdBy ?? null,
  });

  // Collective payouts, reimbursements, and merchant receipts are each one
  // real payment, but their ledger lines must be assigned to the posts they
  // clear. That keeps each courier's limited view accurate without disclosing
  // other posts.
  const ledgerEntries: DeliveryLedgerEntry[] = [];
  if ((type === "merchant_payout" || isCourierReimbursement || isMerchantRepayment) && !options.shipmentId) {
    const outstandingPosts = type === "merchant_payout"
      ? merchantSettlementBreakdownByParty(entries)
        .get(`${options.merchantProfileId}:${options.currency}`)
        ?.filter((post) => post.outstanding > 0.000001)
        .map((post) => ({ shipmentId: post.shipmentId, amount: post.outstanding })) ?? []
      : isCourierReimbursement
        ? courierReimbursementBreakdownByParty(entries)
          .get(`${options.agentId}:${options.currency}`) ?? []
        : merchantAccountSettlementBreakdownByParty(entries)
          .get(`${options.merchantProfileId}:${options.currency}`)
          ?.filter((post) => post.direction === "repayment" && post.outstanding > 0.000001)
          .map((post) => ({ shipmentId: post.shipmentId, amount: post.outstanding })) ?? [];
    let unallocatedAmount = actual;
    for (const post of outstandingPosts) {
      if (unallocatedAmount <= 0.000001) break;
      const allocation = Math.min(post.amount, unallocatedAmount);
      ledgerEntries.push(makeSettlementLedgerEntry(post.shipmentId, isCourierReimbursement || isMerchantRepayment ? allocation : -allocation));
      unallocatedAmount -= allocation;
    }
    // This should only be reached for a legacy/inconsistent balance. Retain a
    // party-level line rather than losing part of a real payment.
    if (unallocatedAmount > 0.000001) {
      ledgerEntries.push(makeSettlementLedgerEntry(null, isCourierReimbursement || isMerchantRepayment ? unallocatedAmount : -unallocatedAmount));
    }
  } else {
    ledgerEntries.push(makeSettlementLedgerEntry(
      options.shipmentId ?? null,
      isMerchantRepayment || isCourierFeePayout || isCourierReimbursement ? actual : -actual,
    ));
  }

  const linkedBusinessPartnerId = isCourierSettlement
    ? (options.agentId ? (await db.agents.get(options.agentId))?.businessPartnerId ?? null : null)
    : options.businessPartnerId ?? (options.merchantProfileId
      ? (await db.delivery_merchant_profiles.get(options.merchantProfileId))?.businessPartnerId ?? null
      : null);
  const counterparty = linkedBusinessPartnerId
    ? await db.business_partners.get(linkedBusinessPartnerId)
    : null;

  // A payout must be funded before its settlement can be recorded. The
  // payment table has no foreign key to the settlement, so this makes the
  // availability check atomic from the user's point of view.
  const payment = await appendPaymentTransaction(workspaceId, {
    sourceModule: "post_service",
    sourceType: isCourierRemittance
      ? "delivery_courier_remittance"
      : isCourierFeePayout
        ? "delivery_courier_fee_payout"
      : isCourierReimbursement
        ? "delivery_courier_reimbursement"
      : isMerchantRepayment
        ? "delivery_merchant_repayment"
        : "delivery_merchant_payout",
    sourceRecordId: settlement.id,
    direction: isMerchantRepayment || isCourierRemittance ? "incoming" : "outgoing",
    amount: actual,
    currency: options.currency,
    paymentMethod: options.paymentMethod,
    paidAt: settledAt,
    counterpartyName: counterparty?.partnerName ?? null,
    referenceLabel: settlement.settlementNumber,
    note: normalizeText(options.note),
    createdBy: options.createdBy ?? null,
    accountId: options.accountId ?? null,
    accountNameSnapshot: options.accountNameSnapshot ?? null,
    metadata: {
      deliverySettlementId: settlement.id,
      deliverySettlementType: type,
      deliveryAgentId: options.agentId ?? null,
      deliveryMerchantProfileId: options.merchantProfileId ?? null,
      deliveryShipmentId: options.shipmentId ?? null,
      businessPartnerId: linkedBusinessPartnerId,
      expectedAmount: expected,
      varianceAmount: actual - expected,
    },
  });

  try {
    await db.transaction("rw", [db.delivery_settlements, db.delivery_ledger_entries], async () => {
      await db.delivery_settlements.put(settlement);
      await db.delivery_ledger_entries.bulkPut(ledgerEntries);
    });
  } catch (error) {
    try {
      const { softDeletePaymentTransaction } = await import("./payments");
      await softDeletePaymentTransaction(payment);
    } catch (cleanupError) {
      console.error("[Post Service] Failed to roll back the settlement payment after settlement creation failed:", cleanupError);
    }
    throw error;
  }

  await syncEntitiesInDependencyOrder(workspaceId, [
    [SETTLEMENT_TABLE, [settlement]],
    [LEDGER_TABLE, ledgerEntries],
  ]);

  const settlementWithPayment: DeliverySettlement = {
    ...settlement,
    paymentTransactionId: payment.id,
    updatedAt: new Date().toISOString(),
    version: settlement.version + 1,
    ...getSyncMetadata(workspaceId, new Date().toISOString()),
  };
  await db.delivery_settlements.put(settlementWithPayment);
  await syncEntities(SETTLEMENT_TABLE, [settlementWithPayment], workspaceId);
  await refreshDeliveryPartnerBalances(workspaceId, [linkedBusinessPartnerId]);
  return settlementWithPayment;
}

export async function settleDeliveryCourier(workspaceId: string, input: SettleCourierInput) {
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId) {
    throw new Error("Courier not found");
  }
  return createSettlement(workspaceId, "courier_remittance", input);
}

export async function payDeliveryCourierFee(workspaceId: string, input: PayDeliveryCourierFeeInput) {
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.agentType !== "courier") {
    throw new Error("Courier not found");
  }
  return createSettlement(workspaceId, "courier_fee_payout", input);
}

/** Records the real outgoing payment that reimburses a courier's own advance. */
export async function payDeliveryCourierReimbursement(
  workspaceId: string,
  input: PayDeliveryCourierReimbursementInput,
) {
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.agentType !== "courier") {
    throw new Error("Courier not found");
  }
  return createSettlement(workspaceId, "courier_reimbursement", input);
}

export async function payDeliveryMerchant(workspaceId: string, input: PayDeliveryMerchantInput) {
  const profile = await db.delivery_merchant_profiles.get(input.merchantProfileId);
  if (!profile || profile.isDeleted || profile.workspaceId !== workspaceId) {
    throw new Error("Merchant not found");
  }
  return createSettlement(workspaceId, "merchant_payout", {
    ...input,
    businessPartnerId: profile.businessPartnerId,
  });
}

export async function receiveDeliveryMerchantRepayment(
  workspaceId: string,
  input: ReceiveDeliveryMerchantRepaymentInput,
) {
  const profile = await db.delivery_merchant_profiles.get(input.merchantProfileId);
  if (!profile || profile.isDeleted || profile.workspaceId !== workspaceId) {
    throw new Error("Merchant not found");
  }
  return createSettlement(workspaceId, "merchant_repayment", {
    ...input,
    businessPartnerId: profile.businessPartnerId,
  });
}

export async function closeDeliveryRun(runId: string) {
  const current = await db.delivery_runs.get(runId);
  if (!current || current.isDeleted || current.status !== "open") return current;
  const now = new Date().toISOString();
  const updated: DeliveryRun = {
    ...current,
    status: "closed",
    closedAt: now,
    updatedAt: now,
    version: current.version + 1,
    ...getSyncMetadata(current.workspaceId, now),
  };
  await db.delivery_runs.put(updated);
  await syncEntities(RUN_TABLE, [updated], current.workspaceId);
  return updated;
}
