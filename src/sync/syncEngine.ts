import { supabase, isSupabaseConfigured } from "@/auth/supabase";
import { db } from "@/local-db";
import { syncProductStockSnapshot } from "@/local-db/inventory";
import type { Inventory } from "@/local-db/models";
import { syncProductBarcodeCachesForWorkspace } from "@/local-db/productBarcodes";
import { rekeyPriceBookItemReferences } from "@/local-db/priceBookReferences";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { getPartnerSyncWriteRpc, getSupabaseClientForTable, getSupabaseRemoteTableName, getVisibilityScopedTableRpc } from "@/lib/supabaseSchema";
import {
  getSchemaMismatchError,
  getSyncIntegrityError,
  isSyncIntegrityError,
} from "@/sync/syncErrors";
import { prepareRemoteMutationPayload } from "@/sync/syncPayloadContract";
import {
  finishSyncProgress,
  startSyncProgress,
  type SyncProgressDetail,
  updateSyncProgress,
} from "@/sync/syncProgress";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";
import { recordWorkspaceDataFetch } from "@/workspace/workspaceDataFreshness";
import { getPostponedVoiceReasonCleanupPaths } from "@/lib/deliveryVoiceReasonPaths";
// import { getPendingItems, removeFromQueue, incrementRetry } from './syncQueue'

export type SyncState = "idle" | "syncing" | "error" | "offline";

export interface SyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  errors: string[];
}

const PULL_PAGE_SIZE = 1000;
const PULL_WRITE_BATCH_SIZE = 250;
const SALE_ITEM_PARENT_BATCH_SIZE = 250;
const PULL_FETCH_CONCURRENCY = 6;

async function deleteQueuedDeliveryVoiceReasons(paths: readonly string[]) {
  const uniquePaths = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
  if (uniquePaths.length === 0) return;
  const { error } = await supabase.storage.from("voice").remove(uniquePaths);
  if (error) throw error;
}

const SYNC_PULL_TABLES = [
  "products",
  "product_barcodes",
  "price_books",
  "price_book_items",
  "inventory",
  "stock_batches",
  "storages",
  "product_discounts",
  "category_discounts",
  "reorder_transfer_rules",
  "categories",
  "units",
  "customers",
  "suppliers",
  "agents",
  "agent_excluded_categories",
  "agent_commission_plans",
  "agent_commission_memberships",
  "product_commission_rules",
  "product_commission_rule_agents",
  "sales_order_agent_assignments",
  "agent_commission_entries",
  "agent_product_commission_entries",
  "fleet_vehicles",
  "fleet_vehicle_assignments",
  "rental_vehicles",
  "rental_requests",
  "rental_contracts",
  "delivery_merchant_profiles",
  "delivery_shipments",
  "delivery_shipment_events",
  "delivery_shipment_cod_adjustment_requests",
  "delivery_shipment_cod_corrections",
  "delivery_shipment_recipient_payout_corrections",
  "delivery_shipment_recipient_payout_adjustment_requests",
  "delivery_runs",
  "delivery_run_items",
  "delivery_settlements",
  "delivery_ledger_entries",
  "business_partners",
  "invoices",
  "invoice_versions",
  "workspaces",
  "employees",
  "workspace_contacts",
  "sales",
  "sale_items",
  "sale_returns",
  "sale_return_items",
  "sale_product_exchanges",
  "order_returns",
  "order_return_items",
  "sales_orders",
  "purchase_orders",
  "order_installments",
  "real_estate_transactions",
  "real_estate_installments",
  "real_estate_payments",
  "travel_bookings",
  "travel_passengers",
  "activity_catalog",
  "activity_transactions",
  "activity_transaction_lines",
  "exchange_pair_prices",
  "exchange_transactions",
  "exchange_fee_rules",
  "fx_safes",
  "fx_safe_balances",
  "fx_safe_movements",
  "budget_settings",
  "budget_allocations",
  "expense_series",
  "expense_items",
  "payroll_statuses",
  "dividend_statuses",
  "loans",
  "loan_installments",
  "loan_payments",
  "payment_accounts",
  "capital_pools",
  "payment_account_balances",
  "payment_account_movements",
  "cashier_shifts",
  "cashier_shift_currency_counts",
  "cashier_shift_templates",
  "cashier_shift_assignments",
  "cashier_shift_occurrences",
  "cashier_shift_pause_requests",
  "cashier_shift_pause_periods",
  "payment_transactions",
  "financial_transaction_voids",
  "clinical_presets",
  "manual_entry_templates",
  "manual_entries",
] as const;

const TABLES_WITHOUT_VERSION = new Set<string>([
  "sales",
  "sale_items",
  "sale_returns",
  "sale_return_items",
  "invoice_versions",
]);
const ROW_WISE_PULL_TABLES = new Set<string>([
  "price_book_items",
  "inventory",
  "workspaces",
]);
const PROCESSABLE_MUTATION_STATUSES = ["pending", "syncing"] as const;
const SALE_CREATE_RESULT_SELECT =
  "id, sequence_id, system_verified, system_review_status, system_review_reason";

function isSaleCreateMutation(mutation: {
  entityType: string;
  operation: string;
  error?: string;
}) {
  return (
    mutation.entityType === "sales" &&
    mutation.operation === "create" &&
    !isSyncIntegrityError(mutation.error)
  );
}

function isRetriableSaleReturnMutation(mutation: {
  entityType: string;
  operation: string;
  payload?: Record<string, unknown>;
  error?: string;
}) {
  return (
    mutation.entityType === "sales" &&
    mutation.operation === "update" &&
    mutation.payload?.__rpc_action === "process_sale_return" &&
    /network|fetch|timeout|timed out|connection|abort/i.test(
      mutation.error ?? "",
    )
  );
}

function isPriceBookMutation(mutation: { entityType: string }) {
  return mutation.entityType === "price_books" || mutation.entityType === "price_book_items";
}

function isRecoverableProductSkuKeyMutation(mutation: {
  entityType: string;
  error?: string;
}) {
  return (
    mutation.entityType === "products" &&
    /pgrst204|could not find.*sku_key|sku_key.*schema cache/i.test(
      mutation.error ?? "",
    )
  );
}

export function isRecoverablePriceBookMutation(mutation: {
  entityType: string;
  error?: string;
}) {
  return isPriceBookMutation(mutation) &&
    !isSyncIntegrityError(mutation.error) &&
    /network|fetch|timeout|timed out|connection|abort|permission|row-level|capability|42501|duplicate|unique|23505|23503|23514|foreign key|same workspace|must reference/i.test(
      mutation.error ?? "",
    );
}

export function isRecoverableCashierShiftTerminalReplayMutation(mutation: {
  entityType: string;
  operation: string;
  payload?: Record<string, unknown>;
  error?: string;
}) {
  const status = mutation.payload?.status;
  return (
    mutation.entityType === "cashier_shift_occurrences" &&
    mutation.operation !== "delete" &&
    (status === "completed" || status === "terminated") &&
    /cashier shift occurrence must start as active|occurrence policy must match its assignment|finalized cashier shift occurrence is immutable/i.test(
      mutation.error ?? "",
    )
  );
}

function isStockAdjustmentMutation(mutation: {
  entityType: string;
  operation: string;
  payload?: Record<string, unknown>;
  error?: string;
}) {
  const transactionType = mutation.payload?.transactionType
    ?? mutation.payload?.transaction_type;
  return (
    mutation.entityType === "inventory_transactions"
    && mutation.operation === "create"
    && transactionType === "stock_adjustment"
    && !isSyncIntegrityError(mutation.error)
  );
}

export function isExistingCommissionEntryRetry(
  error: { code?: unknown } | null | undefined,
  existingId: unknown,
  requestedId: string,
) {
  return error?.code === "23505" && existingId === requestedId;
}

function isDerivedSalesOrderAssignment(payload: Record<string, unknown>) {
  const source = payload.assignmentSource ?? payload.assignment_source;
  return source === "sales_account" || source === "order_creator_product";
}

interface MutationSyncOrderItem {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const QUANTITY_REPLAY_EPSILON = 0.0000005;

function mutationPayloadNumber(
  payload: Record<string, unknown>,
  ...fieldNames: string[]
) {
  for (const fieldName of fieldNames) {
    const value = Number(payload[fieldName]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function quantitiesMatchForReplay(left: number, right: number) {
  return Math.abs(left - right) <= QUANTITY_REPLAY_EPSILON;
}

function saleItemsFromMutation(mutation: MutationSyncOrderItem) {
  if (mutation.entityType !== "sales" || mutation.operation !== "create") {
    return [];
  }
  return Array.isArray(mutation.payload.items)
    ? mutation.payload.items.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object",
    )
    : [];
}

/**
 * Older app versions queued the final local inventory/batch snapshot and also
 * queued the stock-changing sale or adjustment. Replaying that final snapshot
 * before the RPC made the RPC apply the same movement again. Convert only
 * snapshots that can be proven to be derived from the following operation
 * back to that operation's pre-movement quantity.
 */
export function prepareLegacyStockProjectionsForReplay<
  T extends MutationSyncOrderItem,
>(mutations: T[]): T[] {
  return mutations.map((mutation, mutationIndex) => {
    if (mutation.entityType !== "inventory" && mutation.entityType !== "stock_batches") {
      return mutation;
    }

    const finalQuantity = mutationPayloadNumber(mutation.payload, "quantity");
    const productId = payloadReference(mutation.payload, "productId", "product_id");
    const storageId = payloadReference(mutation.payload, "storageId", "storage_id");
    if (finalQuantity === null || !productId || !storageId) return mutation;

    for (let ownerIndex = mutationIndex + 1; ownerIndex < mutations.length; ownerIndex++) {
      const owner = mutations[ownerIndex];
      if (owner.workspaceId !== mutation.workspaceId) continue;

      if (mutation.entityType === "inventory") {
        const matchingSaleItems = saleItemsFromMutation(owner).filter((item) => (
          payloadReference(item, "productId", "product_id") === productId
          && payloadReference(item, "storageId", "storage_id") === storageId
        ));
        if (matchingSaleItems.length > 0) {
          const inventorySnapshot = mutationPayloadNumber(
            matchingSaleItems[0],
            "inventorySnapshot",
            "inventory_snapshot",
          );
          const soldQuantity = matchingSaleItems.reduce((total, item) => (
            total + (mutationPayloadNumber(item, "quantity") ?? 0)
          ), 0);
          if (
            inventorySnapshot !== null
            && matchingSaleItems.every((item) => quantitiesMatchForReplay(
              mutationPayloadNumber(item, "inventorySnapshot", "inventory_snapshot") ?? Number.NaN,
              inventorySnapshot,
            ))
            && quantitiesMatchForReplay(finalQuantity, inventorySnapshot - soldQuantity)
          ) {
            return {
              ...mutation,
              payload: {
                ...mutation.payload,
                quantity: inventorySnapshot,
                isDeleted: false,
                is_deleted: false,
              },
            };
          }
        }

        const ownerType = owner.payload.transactionType ?? owner.payload.transaction_type;
        const ownerProductId = payloadReference(owner.payload, "productId", "product_id");
        const ownerStorageId = payloadReference(owner.payload, "storageId", "storage_id");
        const ownerNewQuantity = mutationPayloadNumber(
          owner.payload,
          "newQuantity",
          "new_quantity",
        );
        const ownerPreviousQuantity = mutationPayloadNumber(
          owner.payload,
          "previousQuantity",
          "previous_quantity",
        );
        if (
          owner.entityType === "inventory_transactions"
          && owner.operation === "create"
          && ownerType === "stock_adjustment"
          && ownerProductId === productId
          && ownerStorageId === storageId
          && ownerNewQuantity !== null
          && ownerPreviousQuantity !== null
          && quantitiesMatchForReplay(finalQuantity, ownerNewQuantity)
        ) {
          return {
            ...mutation,
            payload: {
              ...mutation.payload,
              quantity: ownerPreviousQuantity,
              isDeleted: ownerPreviousQuantity <= QUANTITY_REPLAY_EPSILON,
              is_deleted: ownerPreviousQuantity <= QUANTITY_REPLAY_EPSILON,
            },
          };
        }
      } else {
        for (const item of saleItemsFromMutation(owner)) {
          if (
            payloadReference(item, "productId", "product_id") !== productId
            || payloadReference(item, "storageId", "storage_id") !== storageId
          ) {
            continue;
          }
          const allocations = Array.isArray(item.batchAllocations ?? item.batch_allocations)
            ? (item.batchAllocations ?? item.batch_allocations) as unknown[]
            : [];
          const allocatedQuantity = allocations.reduce((total: number, allocation) => {
            if (!allocation || typeof allocation !== "object") return total;
            const allocationPayload = allocation as Record<string, unknown>;
            const batchId = payloadReference(allocationPayload, "batchId", "batch_id");
            return batchId === mutation.entityId
              ? total + (mutationPayloadNumber(allocationPayload, "quantity") ?? 0)
              : total;
          }, 0);
          if (allocatedQuantity > QUANTITY_REPLAY_EPSILON) {
            return {
              ...mutation,
              payload: {
                ...mutation.payload,
                quantity: finalQuantity + allocatedQuantity,
                isDeleted: false,
                is_deleted: false,
              },
            };
          }
        }
      }
    }

    return mutation;
  });
}

function compareMutationCreation(
  left: Pick<MutationSyncOrderItem, "createdAt" | "id">,
  right: Pick<MutationSyncOrderItem, "createdAt" | "id">,
) {
  return String(left.createdAt).localeCompare(String(right.createdAt)) ||
    String(left.id).localeCompare(String(right.id));
}

function mutationEntityKey(workspaceId: string, entityType: string, entityId: string) {
  return `${workspaceId}:${entityType}:${entityId}`;
}

function payloadReference(
  payload: Record<string, unknown>,
  ...fieldNames: string[]
) {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function getMutationParentKeys(mutation: MutationSyncOrderItem) {
  const { workspaceId, entityType, payload } = mutation;
  const parentKeys: string[] = [];
  const addParent = (parentType: string, ...fieldNames: string[]) => {
    const parentId = payloadReference(payload, ...fieldNames);
    if (parentId) {
      parentKeys.push(mutationEntityKey(workspaceId, parentType, parentId));
    }
  };

  switch (entityType) {
    case "agents":
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      break;
    case "agent_commission_memberships":
      addParent("agents", "agentId", "agent_id");
      addParent("agent_commission_plans", "planId", "plan_id");
      break;
    case "product_commission_rules":
      addParent("products", "productId", "product_id");
      break;
    case "product_commission_rule_agents":
      addParent("product_commission_rules", "ruleId", "rule_id");
      addParent("agents", "agentId", "agent_id");
      break;
    case "sales_order_agent_assignments":
      addParent("sales_orders", "orderId", "order_id");
      addParent("agents", "agentId", "agent_id");
      addParent("sales_order_agent_assignments", "previousAssignmentId", "previous_assignment_id");
      break;
    case "agent_commission_entries":
      addParent("sales_orders", "orderId", "order_id");
      addParent("sales_order_agent_assignments", "assignmentId", "assignment_id");
      addParent("agents", "agentId", "agent_id");
      addParent("agent_commission_memberships", "membershipId", "membership_id");
      addParent("agent_commission_plans", "planId", "plan_id");
      addParent("order_returns", "orderReturnId", "order_return_id");
      addParent("agent_commission_entries", "relatedEntryId", "related_entry_id");
      break;
    case "agent_product_commission_entries":
      addParent("sales_orders", "orderId", "order_id");
      addParent("sales_order_agent_assignments", "assignmentId", "assignment_id");
      addParent("agents", "agentId", "agent_id");
      addParent("products", "productId", "product_id");
      addParent("product_commission_rules", "ruleId", "rule_id");
      addParent("order_returns", "orderReturnId", "order_return_id");
      addParent("agent_product_commission_entries", "relatedEntryId", "related_entry_id");
      break;
    case "sales_agent_commission_reconciliation":
      addParent("sales_orders", "orderId", "order_id");
      addParent("sales_order_agent_assignments", "assignmentId", "assignment_id");
      addParent("agent_commission_memberships", "membershipId", "membership_id");
      addParent("agent_commission_plans", "planId", "plan_id");
      addParent("order_returns", "orderReturnId", "order_return_id");
      break;
    case "delivery_merchant_profiles":
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      break;
    case "delivery_shipments":
      addParent("delivery_merchant_profiles", "merchantProfileId", "merchant_profile_id");
      addParent("business_partners", "merchantBusinessPartnerId", "merchant_business_partner_id");
      addParent("agents", "assignedAgentId", "assigned_agent_id");
      addParent("delivery_runs", "assignedRunId", "assigned_run_id");
      break;
    case "delivery_shipment_events":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("agents", "actorAgentId", "actor_agent_id");
      break;
    case "delivery_shipment_cod_adjustment_requests":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("agents", "requesterAgentId", "requester_agent_id");
      break;
    case "delivery_shipment_cod_corrections":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("delivery_ledger_entries", "courierLedgerEntryId", "courier_ledger_entry_id");
      addParent("delivery_ledger_entries", "merchantLedgerEntryId", "merchant_ledger_entry_id");
      break;
    case "delivery_shipment_recipient_payout_corrections":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("delivery_ledger_entries", "courierLedgerEntryId", "courier_ledger_entry_id");
      addParent("delivery_ledger_entries", "merchantLedgerEntryId", "merchant_ledger_entry_id");
      break;
    case "delivery_shipment_recipient_payout_adjustment_requests":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("agents", "requesterAgentId", "requester_agent_id");
      break;
    case "delivery_runs":
      addParent("agents", "agentId", "agent_id");
      addParent("fleet_vehicles", "vehicleId", "vehicle_id");
      break;
    case "delivery_run_items":
      addParent("delivery_runs", "runId", "run_id");
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      break;
    case "delivery_settlements":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("agents", "agentId", "agent_id");
      addParent("delivery_merchant_profiles", "merchantProfileId", "merchant_profile_id");
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      addParent("payment_transactions", "paymentTransactionId", "payment_transaction_id");
      break;
    case "payment_transactions":
      addParent("payment_accounts", "accountId", "account_id");
      break;
    case "capital_pools": {
      const rawAccountIds = payload.accountIds ?? payload.account_ids;
      const accountIds = Array.isArray(rawAccountIds) ? rawAccountIds : [];
      for (const accountId of accountIds) {
        if (typeof accountId === "string" && accountId) {
          parentKeys.push(mutationEntityKey(workspaceId, "payment_accounts", accountId));
        }
      }
      break;
    }
    case "travel_passengers":
      addParent("travel_bookings", "bookingId", "booking_id");
      break;
    case "cashier_shifts":
      addParent("payment_accounts", "accountId", "account_id");
      break;
    case "cashier_shift_currency_counts":
      addParent("cashier_shifts", "shiftId", "shift_id");
      break;
    case "cashier_shift_assignments":
      addParent("cashier_shift_templates", "templateId", "template_id");
      addParent("payment_accounts", "accountId", "account_id");
      break;
    case "cashier_shift_occurrences":
      addParent("cashier_shift_assignments", "assignmentId", "assignment_id");
      break;
    case "cashier_shift_pause_requests":
      addParent("cashier_shift_occurrences", "occurrenceId", "occurrence_id");
      break;
    case "cashier_shift_pause_periods":
      addParent("cashier_shift_occurrences", "occurrenceId", "occurrence_id");
      addParent("cashier_shift_pause_requests", "pauseRequestId", "pause_request_id");
      break;
    case "delivery_ledger_entries":
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      addParent("delivery_settlements", "settlementId", "settlement_id");
      addParent("agents", "agentId", "agent_id");
      addParent("delivery_merchant_profiles", "merchantProfileId", "merchant_profile_id");
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      break;
    case "rental_requests":
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      addParent("rental_vehicles", "preferredVehicleId", "preferred_vehicle_id");
      break;
    case "rental_contracts":
      addParent("rental_requests", "requestId", "request_id");
      addParent("rental_vehicles", "vehicleId", "vehicle_id");
      addParent("business_partners", "businessPartnerId", "business_partner_id");
      break;
    case "delivery_voice_cleanup": {
      addParent("delivery_shipments", "shipmentId", "shipment_id");
      const rawEventIds: unknown = payload.eventIds ?? payload.event_ids;
      const eventIds: unknown[] = Array.isArray(rawEventIds) ? rawEventIds : [];
      for (const eventId of eventIds) {
        if (typeof eventId === "string" && eventId) {
          parentKeys.push(mutationEntityKey(workspaceId, "delivery_shipment_events", eventId));
        }
      }
      break;
    }
  }

  return parentKeys;
}

/**
 * Retain chronological queue order except where a queued record explicitly
 * references another queued parent. This is a small topological sort, so a
 * shipment is always pushed before its event even if parallel work created the
 * event's offline mutation first.
 */
export function orderMutationsForSync<T extends MutationSyncOrderItem>(mutations: T[]): T[] {
  const chronological = [...mutations].sort(compareMutationCreation);
  const indicesByEntity = new Map<string, number[]>();
  const edges = new Map<number, Set<number>>();
  const indegree = new Array<number>(chronological.length).fill(0);

  const addEdge = (parentIndex: number, childIndex: number) => {
    if (parentIndex === childIndex) return;
    const children = edges.get(parentIndex) ?? new Set<number>();
    if (children.has(childIndex)) return;
    children.add(childIndex);
    edges.set(parentIndex, children);
    indegree[childIndex]++;
  };

  chronological.forEach((mutation, index) => {
    const key = mutationEntityKey(mutation.workspaceId, mutation.entityType, mutation.entityId);
    const indices = indicesByEntity.get(key) ?? [];
    if (indices.length > 0) addEdge(indices[indices.length - 1], index);
    indices.push(index);
    indicesByEntity.set(key, indices);
  });

  chronological.forEach((mutation, index) => {
    for (const parentKey of getMutationParentKeys(mutation)) {
      const parentIndices = indicesByEntity.get(parentKey);
      if (!parentIndices) continue;

      if (mutation.operation === "delete") {
        // A soft-deleted child must reach Supabase before its deleted parent.
        // This is the reverse of the create/update relationship above and is
        // necessary even when both mutations share one timestamp.
        parentIndices
          .filter((parentIndex) => chronological[parentIndex].operation === "delete")
          .forEach((parentIndex) => addEdge(index, parentIndex));
        continue;
      }

      const activeParentIndices = parentIndices.filter(
        (parentIndex) => chronological[parentIndex].operation !== "delete",
      );
      const parentIndex = activeParentIndices.find(
        (candidateIndex) => chronological[candidateIndex].operation === "create",
      ) ?? activeParentIndices[0];
      if (parentIndex !== undefined) addEdge(parentIndex, index);
    }
  });

  // Effective-dated commission revisions must close the previous open row
  // before inserting its replacement. Offline writes can share the same
  // millisecond timestamp, so make this ordering explicit instead of relying
  // on random mutation ids to satisfy the partial unique indexes.
  chronological.forEach((closingMutation, closingIndex) => {
    const closesPlan = closingMutation.entityType === "agent_commission_plans"
      && closingMutation.operation === "update"
      && !!payloadReference(closingMutation.payload, "effectiveTo", "effective_to");
    const closesMembership = closingMutation.entityType === "agent_commission_memberships"
      && closingMutation.operation === "update"
      && !!payloadReference(closingMutation.payload, "effectiveTo", "effective_to");
    if (!closesPlan && !closesMembership) return;

    chronological.forEach((replacementMutation, replacementIndex) => {
      if (replacementMutation.workspaceId !== closingMutation.workspaceId
        || replacementMutation.entityType !== closingMutation.entityType
        || replacementMutation.operation !== "create") return;
      if (closesPlan) {
        const closingLevel = payloadReference(closingMutation.payload, "level");
        const replacementLevel = payloadReference(replacementMutation.payload, "level");
        if (closingLevel && closingLevel === replacementLevel) {
          addEdge(closingIndex, replacementIndex);
        }
        return;
      }
      const closingAgentId = payloadReference(closingMutation.payload, "agentId", "agent_id");
      const replacementAgentId = payloadReference(replacementMutation.payload, "agentId", "agent_id");
      if (closingAgentId && closingAgentId === replacementAgentId) {
        addEdge(closingIndex, replacementIndex);
      }
    });
  });

  const available = chronological
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0);
  const orderedIndices: number[] = [];

  while (available.length > 0) {
    const index = available.shift()!;
    orderedIndices.push(index);
    for (const childIndex of edges.get(index) ?? []) {
      indegree[childIndex]--;
      if (indegree[childIndex] !== 0) continue;

      const insertionIndex = available.findIndex((candidate) => candidate > childIndex);
      if (insertionIndex === -1) available.push(childIndex);
      else available.splice(insertionIndex, 0, childIndex);
    }
  }

  // A cycle should not happen in the delivery graph. If a malformed queued
  // payload creates one, preserve the original order instead of dropping work.
  return orderedIndices.length === chronological.length
    ? orderedIndices.map((index) => chronological[index])
    : chronological;
}

// Convert snake_case to camelCase
function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    result[camelKey] = obj[key];
  }
  return result;
}

// Get table name for entity type
function getTableName(entityType: string): string {
  return entityType;
}

// Timeout helper
async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number = 15000,
): Promise<T> {
  return runSupabaseAction("sync.request", () => promise, {
    timeoutMs: ms,
    platform: "all",
  });
}

function getSaleSequenceId(result: unknown): number | null {
  const raw =
    (result as { sequence_id?: unknown; sequenceId?: unknown } | null)
      ?.sequence_id ??
    (result as { sequenceId?: unknown } | null)?.sequenceId;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getSaleReviewUpdate(result: unknown): Record<string, unknown> {
  const source = result as
    | {
        system_verified?: unknown;
        system_review_status?: unknown;
        system_review_reason?: unknown;
        systemVerified?: unknown;
        systemReviewStatus?: unknown;
        systemReviewReason?: unknown;
      }
    | null;
  const update: Record<string, unknown> = {};

  const systemVerified = source?.system_verified ?? source?.systemVerified;
  const systemReviewStatus =
    source?.system_review_status ?? source?.systemReviewStatus;
  const systemReviewReason =
    source?.system_review_reason ?? source?.systemReviewReason;

  if (systemVerified !== undefined) {
    update.systemVerified = systemVerified;
  }
  if (systemReviewStatus !== undefined) {
    update.systemReviewStatus = systemReviewStatus;
  }
  if (systemReviewReason !== undefined) {
    update.systemReviewReason = systemReviewReason;
  }

  return update;
}

async function fetchSaleCreateResult(
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = (await withTimeout(
    supabase
      .from("sales")
      .select(SALE_CREATE_RESULT_SELECT)
      .eq("id", entityId)
      .maybeSingle(),
    30000,
  )) as any;

  if (error) {
    throw error;
  }

  return (data ?? null) as Record<string, unknown> | null;
}

async function fetchPullRows(
  table: (typeof SYNC_PULL_TABLES)[number],
  workspaceId: string,
  since: string,
): Promise<Array<Record<string, unknown>>> {
  const client = getSupabaseClientForTable(table);
  const remoteTableName = getSupabaseRemoteTableName(table);
  const visibilityScopedRpc = getVisibilityScopedTableRpc(table);

  if (table === "workspaces") {
    const { data, error } = (await withTimeout(
      client.from(remoteTableName).select("*").eq("id", workspaceId),
      30000,
    )) as any;

    if (error) {
      throw error;
    }

    return (data ?? []) as Array<Record<string, unknown>>;
  }

  if (table === "sale_items") {
    return fetchSaleItemsForWorkspace(workspaceId, since);
  }

  const rows: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    const to = from + PULL_PAGE_SIZE - 1;
    const { data, error } = (await withTimeout(
      ((visibilityScopedRpc
        ? client.rpc(visibilityScopedRpc, { p_workspace_id: workspaceId })
        : client
          .from(remoteTableName)
          .select("*")
          .eq("workspace_id", workspaceId))
        .gt("updated_at", since)
        .order("updated_at", { ascending: true })
        .range(from, to) as any),
      30000,
    )) as any;

    if (error) {
      throw error;
    }

    const page = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...page);

    if (page.length < PULL_PAGE_SIZE) {
      break;
    }

    from += PULL_PAGE_SIZE;
  }

  return rows;
}

async function fetchSaleIdsForWorkspace(
  workspaceId: string,
  since: string,
): Promise<string[]> {
  const saleIds: string[] = [];
  let from = 0;

  while (true) {
    const to = from + PULL_PAGE_SIZE - 1;
    const { data, error } = (await withTimeout(
      supabase
        .from("sales")
        .select("id")
        .eq("workspace_id", workspaceId)
        .gt("updated_at", since)
        .order("updated_at", { ascending: true })
        .range(from, to),
      30000,
    )) as any;

    if (error) {
      throw error;
    }

    const page = (data ?? []) as Array<{ id?: unknown }>;
    saleIds.push(
      ...page
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string"),
    );

    if (page.length < PULL_PAGE_SIZE) {
      break;
    }

    from += PULL_PAGE_SIZE;
  }

  return saleIds;
}

async function fetchSaleItemsForWorkspace(
  workspaceId: string,
  since: string,
): Promise<Array<Record<string, unknown>>> {
  const saleIds = await fetchSaleIdsForWorkspace(workspaceId, since);
  const rows: Array<Record<string, unknown>> = [];

  for (
    let index = 0;
    index < saleIds.length;
    index += SALE_ITEM_PARENT_BATCH_SIZE
  ) {
    const saleIdBatch = saleIds.slice(index, index + SALE_ITEM_PARENT_BATCH_SIZE);
    let from = 0;

    while (true) {
      const to = from + PULL_PAGE_SIZE - 1;
      const { data, error } = (await withTimeout(
        supabase
          .from("sale_items")
          .select("*")
          .in("sale_id", saleIdBatch)
          .order("id", { ascending: true })
          .range(from, to),
        30000,
      )) as any;

      if (error) {
        throw error;
      }

      const page = (data ?? []) as Array<Record<string, unknown>>;
      rows.push(...page);

      if (page.length < PULL_PAGE_SIZE) {
        break;
      }

      from += PULL_PAGE_SIZE;
    }
  }

  return rows;
}

export function shouldApplyRemoteItem(
  table: (typeof SYNC_PULL_TABLES)[number],
  localItem: unknown,
  remoteData: Record<string, unknown>,
) {
  if (!localItem) {
    return true;
  }

  // The local mutation is the source of truth until it has completed. This
  // prevents a failed push (including a schema mismatch) from being followed
  // by a pull that replaces the local record with an older server snapshot.
  const localSyncStatus = (localItem as { syncStatus?: unknown }).syncStatus;
  if (localSyncStatus === "pending" || localSyncStatus === "conflict") {
    return false;
  }

  if (
    (table === "price_books" || table === "price_book_items") &&
    (localItem as { syncStatus?: unknown }).syncStatus === "pending"
  ) {
    return false;
  }

  if (TABLES_WITHOUT_VERSION.has(table)) {
    return true;
  }

  const localVersion = Number((localItem as any).version ?? 0);
  const remoteVersion = Number((remoteData as any).version ?? 0);
  if (localVersion !== remoteVersion) {
    return localVersion < remoteVersion;
  }

  const localUpdatedAt = Date.parse(String((localItem as any).updatedAt ?? ""));
  const remoteUpdatedAt = Date.parse(String((remoteData as any).updatedAt ?? ""));
  return Number.isFinite(remoteUpdatedAt) &&
    (!Number.isFinite(localUpdatedAt) || remoteUpdatedAt > localUpdatedAt);
}

function removeRetiredPartnerFields(
  table: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (table !== "business_partners" && table !== "customers" && table !== "suppliers") {
    return record;
  }

  const { email: _email, country: _country, ...retained } = record;
  return retained;
}

async function persistRemoteRowsInBatches(
  table: (typeof SYNC_PULL_TABLES)[number],
  dbTable: any,
  remoteItems: Array<Record<string, unknown>>,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  let applied = 0;

  for (let index = 0; index < remoteItems.length; index += PULL_WRITE_BATCH_SIZE) {
    const chunk = remoteItems.slice(index, index + PULL_WRITE_BATCH_SIZE);
    const ids = chunk.map((item) => item.id);
    const localItems = typeof dbTable.bulkGet === "function"
      ? await dbTable.bulkGet(ids)
      : await Promise.all(ids.map((id) => dbTable.get(id)));
    const syncedAt = new Date().toISOString();
    const rowsToWrite: Array<Record<string, unknown>> = [];

    chunk.forEach((remoteItem, chunkIndex) => {
      const remoteData = removeRetiredPartnerFields(
        table,
        toCamelCase(remoteItem) as Record<string, unknown>,
      );
      if (!shouldApplyRemoteItem(table, localItems[chunkIndex], remoteData)) {
        return;
      }
      rowsToWrite.push({
        ...remoteData,
        syncStatus: "synced",
        lastSyncedAt: syncedAt,
      });
    });

    if (rowsToWrite.length > 0) {
      if (typeof dbTable.bulkPut === "function") {
        await dbTable.bulkPut(rowsToWrite);
      } else {
        for (const row of rowsToWrite) await dbTable.put(row);
      }
      applied += rowsToWrite.length;
    }

    onProgress?.(
      Math.min(index + chunk.length, remoteItems.length),
      remoteItems.length,
    );
  }

  return applied;
}

// Process offline mutation queue
export async function processMutationQueue(
  _userId: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ success: number; failed: number; errors: string[] }> {
  if (!isSupabaseConfigured) {
    return { success: 0, failed: 1, errors: ["Supabase not configured"] };
  }

  const mutationGroups = await Promise.all(
    PROCESSABLE_MUTATION_STATUSES.map((status) =>
      db.offline_mutations.where("status").equals(status).sortBy("createdAt"),
    ),
  );
  const failedRetriableMutations = await db.offline_mutations
    .where("status")
    .equals("failed")
    .filter(
      (mutation) =>
        isSaleCreateMutation(mutation) ||
        isStockAdjustmentMutation(mutation) ||
        isRetriableSaleReturnMutation(mutation) ||
        isRecoverableProductSkuKeyMutation(mutation) ||
        isRecoverablePriceBookMutation(mutation) ||
        isRecoverableCashierShiftTerminalReplayMutation(mutation),
    )
    .sortBy("createdAt");
  const mutations = mutationGroups
    .flat()
    .concat(failedRetriableMutations)
    .sort((left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt)),
    );
  const orderedMutations = prepareLegacyStockProjectionsForReplay(
    orderMutationsForSync(mutations),
  );

  let completedCount = 0;
  const reportCompleted = () => {
    completedCount++;
    onProgress?.(completedCount, orderedMutations.length);
  };

  onProgress?.(0, orderedMutations.length);

  console.log(
    `[Sync] processMutationQueue: Found ${orderedMutations.length} pending mutations`,
  );

  let successCount = 0;
  let failedCount = 0;
  const errors: string[] = [];
  const failedPriceBookIds = new Set<string>();
  const integrityBlockedEntities = new Map<string, string>();
  const deferredCommissionReconciliations: typeof orderedMutations = [];
  const touchedCommissionOrders = new Map<string, {
    workspaceId: string;
    orderId: string;
    orderReturnId: string | null;
  }>();

  for (const mutation of orderedMutations) {
    // The duplicate detector was retired. A prior version may have queued
    // suggestions while offline, so retire those local-only mutations without
    // contacting the removed CRM endpoint.
    if (mutation.entityType === "business_partner_merge_candidates") {
      await db.offline_mutations.update(mutation.id, {
        status: "synced",
        error: undefined,
      });
      successCount++;
      reportCompleted();
      continue;
    }
    // Reconcile only after every order/return/assignment/plan mutation in this
    // batch has committed. Offline entity compaction then converges directly
    // to the final server state without replaying stale ledger snapshots.
    if (mutation.entityType === "sales_agent_commission_reconciliation") {
      deferredCommissionReconciliations.push(mutation);
      continue;
    }
    if (
      mutation.entityType === "agent_commission_entries"
      && (
        mutation.payload.kind === "accrual"
        || mutation.payload.kind === "reversal"
        || (
          mutation.payload.kind === "adjustment"
          && Boolean(mutation.payload.relatedEntryId ?? mutation.payload.related_entry_id)
        )
      )
    ) {
      const orderId = mutation.payload.orderId ?? mutation.payload.order_id;
      if (typeof orderId === "string" && orderId) {
        touchedCommissionOrders.set(`${mutation.workspaceId}:${orderId}`, {
          workspaceId: mutation.workspaceId,
          orderId,
          orderReturnId: typeof (mutation.payload.orderReturnId ?? mutation.payload.order_return_id) === "string"
            ? String(mutation.payload.orderReturnId ?? mutation.payload.order_return_id)
            : null,
        });
      }
      await db.offline_mutations.update(mutation.id, { status: "synced", error: undefined });
      const legacyEntryTable = (db as any).agent_commission_entries;
      if (legacyEntryTable) await legacyEntryTable.delete(mutation.entityId);
      successCount++;
      reportCompleted();
      continue;
    }
    const mutationKey = `${mutation.entityType}:${mutation.entityId}`;
    const priorIntegrityIssue = integrityBlockedEntities.get(mutationKey);
    if (priorIntegrityIssue) {
      await db.offline_mutations.update(mutation.id, {
        status: "failed",
        error: `${priorIntegrityIssue} This later change was blocked to preserve record order.`,
      });
      failedCount++;
      reportCompleted();
      continue;
    }

    if (mutation.entityType === "price_book_items") {
      const referencedPriceBookId = mutation.payload.priceBookId ?? mutation.payload.price_book_id;
      if (typeof referencedPriceBookId === "string" && failedPriceBookIds.has(referencedPriceBookId)) {
        reportCompleted();
        continue;
      }
    }

    // Mark active attempts, and retry rows that were interrupted while syncing.
    await db.offline_mutations.update(mutation.id, {
      status: "syncing",
      error: undefined,
    });

    try {
      const { entityType, operation, payload, entityId, workspaceId, id } =
        mutation;
      if (entityType === "delivery_voice_cleanup") {
        const shipmentId = payload.shipmentId ?? payload.shipment_id;
        if (typeof shipmentId !== "string" || !shipmentId || shipmentId !== entityId) {
          throw new Error("Voice recording cleanup has an invalid shipment reference.");
        }
        const rawEventIds: unknown = payload.eventIds ?? payload.event_ids;
        const eventIds = Array.isArray(rawEventIds)
          ? rawEventIds.filter((eventId): eventId is string => typeof eventId === "string" && !!eventId)
          : [];
        const events = eventIds.length > 0
          ? await db.delivery_shipment_events.bulkGet(eventIds)
          : [];
        if (events.some((event) => !event || event.workspaceId !== workspaceId || event.syncStatus !== "synced")) {
          throw new Error("Voice recording cleanup is waiting for the postponed status event to sync.");
        }
        const voiceReasonPaths = getPostponedVoiceReasonCleanupPaths({
          workspaceId,
          shipmentId,
          paths: payload.paths,
        });
        await deleteQueuedDeliveryVoiceReasons(voiceReasonPaths);
        await db.offline_mutations.update(id, { status: "synced", error: undefined });
        successCount++;
        reportCompleted();
        continue;
      }
      const tableName = getTableName(entityType);
      const client = getSupabaseClientForTable(tableName);
      const remoteTableName = getSupabaseRemoteTableName(tableName);
      const partnerSyncWriteRpc = getPartnerSyncWriteRpc(entityType);
      let syncedEntityId = entityId;
      let entityHandledInline = false;
      const shouldHardDelete =
        operation === "delete" &&
        (entityType === "loans" || payload.hardDelete === true);

      // Prepare only fields Atlas has deliberately classified as remote-safe.
      // Unknown fields are intentionally not removed: a server rejection must
      // remain visible so that business data cannot be lost silently.
      const dbPayload = prepareRemoteMutationPayload(entityType, payload);
      // Ensure workspace scope is present for workspace-bound rows.
      if (
        entityType !== "workspaces" &&
        entityType !== "workspace_branches" &&
        dbPayload.workspace_id === undefined
      ) {
        dbPayload.workspace_id = workspaceId;
      }

      if (partnerSyncWriteRpc) {
        const { error } = await client.rpc(partnerSyncWriteRpc, {
          p_operation: operation === "delete" ? "soft_delete" : "upsert",
          p_entity_id: entityId,
          p_workspace_id: workspaceId,
          p_payload: dbPayload,
        });
        if (error) throw error;
      } else if (operation === "create" || operation === "update") {
        if (entityType === "sales") {
          const rpcAction =
            typeof dbPayload.__rpc_action === "string"
              ? String(dbPayload.__rpc_action)
              : null;
          delete dbPayload.__rpc_action;

          if (operation === "create") {
            const { data: serverResult, error } = await supabase.rpc(
              "complete_sale",
              { payload: dbPayload },
            );

            let result = serverResult as Record<string, unknown> | null;
            if (error) {
              const recoveredResult = await fetchSaleCreateResult(entityId).catch(
                () => null,
              );
              if (!recoveredResult) {
                throw error;
              }
              result = recoveredResult;
            }

            if (!getSaleSequenceId(result)) {
              const fetchedResult = await fetchSaleCreateResult(entityId);
              if (fetchedResult) {
                result = {
                  ...(result ?? {}),
                  ...fetchedResult,
                };
              }
            }

            const sequenceId = getSaleSequenceId(result);
            if (!sequenceId) {
              throw new Error(
                "Sale synced but Supabase did not return a sequence ID.",
              );
            }

            const syncedAt = new Date().toISOString();
            const formattedInvoiceId = `#${String(sequenceId).padStart(5, "0")}`;
            const saleReviewUpdate = getSaleReviewUpdate(result);

            await db.sales.update(entityId, {
              sequenceId,
              ...saleReviewUpdate,
              syncStatus: "synced",
              lastSyncedAt: syncedAt,
            });
            await db.invoices.update(entityId, {
              sequenceId,
              invoiceid: formattedInvoiceId,
              syncStatus: "synced",
              lastSyncedAt: syncedAt,
            });
            entityHandledInline = true;
          } else if (rpcAction === "process_sale_return") {
            const { error } = await supabase.rpc("process_sale_return", {
              p_return_id: dbPayload.p_return_id,
              p_sale_id: dbPayload.p_sale_id,
              p_items: dbPayload.p_items,
              p_return_reason: dbPayload.p_return_reason,
              p_refund_method: dbPayload.p_refund_method,
            });
            if (error) throw error;

            const returnId =
              typeof dbPayload.p_return_id === "string"
                ? dbPayload.p_return_id
                : null;
            if (returnId) {
              const syncedAt = new Date().toISOString();
              await db.sale_returns.update(returnId, {
                syncStatus: "synced",
                lastSyncedAt: syncedAt,
              });
              await db.sale_return_items
                .where("returnId")
                .equals(returnId)
                .modify({
                  syncStatus: "synced",
                  lastSyncedAt: syncedAt,
                });
            }
          } else if (rpcAction === "process_sale_product_exchange") {
            const { error } = await supabase.rpc("process_sale_product_exchange", {
              p_exchange_id: dbPayload.p_exchange_id,
              p_return_id: dbPayload.p_return_id,
              p_sale_id: dbPayload.p_sale_id,
              p_return_sale_item_id: dbPayload.p_return_sale_item_id,
              p_return_quantity: dbPayload.p_return_quantity,
              p_replacement_product_id: dbPayload.p_replacement_product_id,
              p_replacement_storage_id: dbPayload.p_replacement_storage_id,
              p_replacement_quantity: dbPayload.p_replacement_quantity,
              p_replacement_unit_amount: dbPayload.p_replacement_unit_amount,
              p_settlement_method: dbPayload.p_settlement_method,
              p_note: dbPayload.p_note,
              p_return_reason: dbPayload.p_return_reason,
            });
            if (error) throw error;

            const exchangeId = typeof dbPayload.p_exchange_id === "string"
              ? dbPayload.p_exchange_id
              : null;
            if (exchangeId) {
              const syncedAt = new Date().toISOString();
              await db.sale_product_exchanges.update(exchangeId, {
                syncStatus: "synced",
                lastSyncedAt: syncedAt,
              });
            }
          } else if (rpcAction === "return_sale_items") {
            const { error } = await supabase.rpc("return_sale_items", {
              p_sale_item_ids: dbPayload.p_sale_item_ids,
              p_return_quantities: dbPayload.p_return_quantities,
              p_return_reason: dbPayload.p_return_reason,
            });
            if (error) throw error;
          } else if (rpcAction === "return_whole_sale") {
            const { error } = await supabase.rpc("return_whole_sale", {
              p_sale_id: dbPayload.p_sale_id,
              p_return_reason: dbPayload.p_return_reason,
            });
            if (error) throw error;
          } else {
            const { error } = await client
              .from(remoteTableName)
              .update(dbPayload)
              .eq("id", entityId);
            if (error) throw error;
          }
        } else if (entityType === "inventory_transactions") {
          if (dbPayload.transaction_type !== "stock_adjustment") {
            throw new Error("Only stock adjustments may sync to the cloud inventory ledger");
          }

          const { data: adjustmentResult, error } = await client.rpc(
            "apply_stock_adjustment",
            { p_transaction: dbPayload },
          );
          if (error) throw error;

          const remoteTransaction = (
            adjustmentResult as { transaction?: Record<string, unknown> } | null
          )?.transaction;
          if (!remoteTransaction) {
            throw new Error("Stock adjustment RPC returned no transaction");
          }

          const syncedAt = new Date().toISOString();
          await db.inventory_transactions.put({
            ...toCamelCase(remoteTransaction),
            syncStatus: "synced",
            lastSyncedAt: syncedAt,
          } as never);
          entityHandledInline = true;
        } else if (
          entityType === "workspaces" ||
          entityType === "workspace_branches"
        ) {
          // Remove workspace_id from payload for workspace table update itself
          delete dbPayload.workspace_id;
          delete dbPayload.user_id;
          const { error } = await client
            .from(remoteTableName)
            .update(dbPayload)
            .eq("id", entityId);
          if (error) throw error;
        } else if (entityType === "inventory") {
          const { data: remoteInventoryRow, error } = await client
            .from(remoteTableName)
            .upsert(dbPayload, {
              onConflict: "workspace_id,product_id,storage_id",
            })
            .select("*")
            .single();

          if (error) throw error;

          const syncedAt = new Date().toISOString();
          const localInventoryRow = toCamelCase(
            remoteInventoryRow as Record<string, unknown>,
          ) as unknown as Inventory;
          localInventoryRow.syncStatus = "synced";
          localInventoryRow.lastSyncedAt = syncedAt;
          syncedEntityId = localInventoryRow.id;

          if (syncedEntityId !== entityId) {
            await db.inventory.delete(entityId);
          }

          await db.inventory.put(localInventoryRow);
          entityHandledInline = true;
        } else if (entityType === "agent_commission_entries") {
          if (operation !== "create") {
            throw new Error("Commission ledger entries are immutable and cannot be updated");
          }

          // The database enforces that a payout cannot exceed the commission
          // currently earned for its order. Accruals are derived by the
          // reconciliation RPC rather than uploaded as ledger rows, so make
          // that derivation current immediately before the payout insert. This
          // also covers offline payouts whose queued reconciliation mutation
          // is deliberately processed at the end of this batch.
          if (dbPayload.kind === "payout") {
            const payoutOrderId = dbPayload.order_id;
            if (typeof payoutOrderId !== "string" || !payoutOrderId) {
              throw new Error("Commission payout is missing its sales order reference");
            }
            const { error: reconciliationError } = await supabase.rpc(
              "reconcile_sales_agent_commission",
              {
                p_order_id: payoutOrderId,
                p_order_return_id: null,
              },
            );
            if (reconciliationError) throw reconciliationError;
          }

          const { error } = await client.from(remoteTableName).insert(dbPayload);
          if (error) {
            const { data: existingEntry, error: lookupError } = await client
              .from(remoteTableName)
              .select("id")
              .eq("id", entityId)
              .maybeSingle();
            if (lookupError || !isExistingCommissionEntryRetry(
              error as { code?: unknown },
              (existingEntry as { id?: unknown } | null)?.id,
              entityId,
            )) {
              throw error;
            }
          }
        } else if (entityType === "price_book_items") {
          const priceBookId = dbPayload.price_book_id;
          const productId = dbPayload.product_id;
          if (typeof priceBookId !== "string" || typeof productId !== "string") {
            throw new Error("Price Book item is missing its Price Book or product reference");
          }

          const { data: remoteExistingPriceBookItem, error: lookupError } = await client
            .from(remoteTableName)
            .select("*")
            .eq("price_book_id", priceBookId)
            .eq("product_id", productId)
            .maybeSingle();
          if (lookupError) throw lookupError;

          if (remoteExistingPriceBookItem) {
            const remoteExisting = remoteExistingPriceBookItem as Record<string, unknown>;
            dbPayload.id = remoteExisting.id;
            dbPayload.created_at = remoteExisting.created_at;
            dbPayload.created_by = remoteExisting.created_by;
            const remoteVersion = Number(remoteExisting.version ?? 0);
            const localVersion = Number(dbPayload.version ?? 0);
            dbPayload.version = Math.max(localVersion, remoteVersion + 1);
          }

          const { data: remotePriceBookItem, error } = await client
            .from(remoteTableName)
            .upsert(dbPayload, {
              onConflict: "price_book_id,product_id",
            })
            .select("*")
            .single();

          if (error) throw error;

          const syncedAt = new Date().toISOString();
          const localPriceBookItem = toCamelCase(
            remotePriceBookItem as Record<string, unknown>,
          ) as Record<string, unknown>;
          localPriceBookItem.syncStatus = "synced";
          localPriceBookItem.lastSyncedAt = syncedAt;
          syncedEntityId = String(localPriceBookItem.id);

          if (syncedEntityId !== entityId) {
            await rekeyPriceBookItemReferences(entityId, syncedEntityId);
            await db.price_book_items.delete(entityId);
          }

          await db.price_book_items.put(localPriceBookItem as never);
          entityHandledInline = true;
        } else if (
          entityType === "sales_orders" ||
          entityType === "purchase_orders"
        ) {
          const { data: remoteOrders, error } = await client
            .from(remoteTableName)
            .upsert(dbPayload)
            .select("id, order_number");

          if (error) throw error;

          const remoteOrder = Array.isArray(remoteOrders)
            ? remoteOrders.find(
              (row) =>
                row &&
                typeof row === "object" &&
                (row as { id?: unknown }).id === entityId,
            ) as { order_number?: unknown } | undefined
            : undefined;
          const orderNumber = remoteOrder?.order_number;

          if (typeof orderNumber === "string" && orderNumber.length > 0) {
            const syncedAt = new Date().toISOString();
            const localOrderTable = (db as any)[entityType];
            await localOrderTable.update(entityId, {
              orderNumber,
              syncStatus: "synced",
              lastSyncedAt: syncedAt,
            });
            const { synchronizeOrderPaymentReferences } = await import("@/local-db/payments");
            const updatedPayments = await synchronizeOrderPaymentReferences(
              workspaceId,
              entityType === "sales_orders" ? "sales" : "purchase",
              entityId,
              orderNumber,
              { deferRemoteSync: true },
            );
            const updatedPaymentsById = new Map(
              (updatedPayments ?? []).map((payment) => [payment.id, payment]),
            );
            for (const queuedMutation of orderedMutations) {
              if (
                queuedMutation.entityType !== "payment_transactions"
                || queuedMutation.workspaceId !== workspaceId
              ) {
                continue;
              }
              const payment = updatedPaymentsById.get(queuedMutation.entityId);
              if (!payment) continue;
              queuedMutation.payload = {
                ...queuedMutation.payload,
                referenceLabel: payment.referenceLabel,
                updatedAt: payment.updatedAt,
                version: payment.version,
                syncStatus: payment.syncStatus,
                lastSyncedAt: payment.lastSyncedAt,
              };
            }
            entityHandledInline = true;
          }
        } else if (entityType === "delivery_shipments") {
          const { data: remoteShipments, error } = await client
            .from(remoteTableName)
            .upsert(dbPayload)
            .select("id, tracking_number");

          if (error) throw error;

          const remoteShipment = Array.isArray(remoteShipments)
            ? remoteShipments.find(
              (row) =>
                row &&
                typeof row === "object" &&
                (row as { id?: unknown }).id === entityId,
            ) as { tracking_number?: unknown } | undefined
            : undefined;
          const trackingNumber = remoteShipment?.tracking_number;

          if (typeof trackingNumber === "string" && trackingNumber.length > 0) {
            const syncedAt = new Date().toISOString();
            await db.delivery_shipments.update(entityId, {
              trackingNumber,
              syncStatus: "synced",
              lastSyncedAt: syncedAt,
            });
            entityHandledInline = true;
          }
        } else if (entityType === "sales_order_agent_assignments") {
          const { error } = await client.from(remoteTableName).upsert(dbPayload);
          if (!error) {
            // Normal assignment insert/update completed.
          } else if (
            (error as { code?: unknown }).code === "23505"
            && isDerivedSalesOrderAssignment(dbPayload)
          ) {
            const orderId = dbPayload.order_id;
            const agentId = dbPayload.agent_id;
            if (typeof orderId !== "string" || typeof agentId !== "string") {
              throw error;
            }

            // Multiple clients can enqueue the same derived beneficiary.
            // An existing active row for that order and agent means the
            // desired server state already exists, so retain the authoritative
            // row and remove only the duplicate local record.
            const { data: existingAssignment, error: lookupError } = await client
              .from(remoteTableName)
              .select("*")
              .eq("workspace_id", workspaceId)
              .eq("order_id", orderId)
              .eq("agent_id", agentId)
              .eq("is_deleted", false)
              .is("unassigned_at", null)
              .maybeSingle();
            if (lookupError || !existingAssignment) throw error;

            const syncedAt = new Date().toISOString();
            const localAssignment = toCamelCase(
              existingAssignment as Record<string, unknown>,
            );
            await db.sales_order_agent_assignments.delete(entityId);
            await db.sales_order_agent_assignments.put({
              ...localAssignment,
              syncStatus: "synced",
              lastSyncedAt: syncedAt,
            } as never);
            entityHandledInline = true;
          } else {
            throw error;
          }
        } else {
          const { error } = await client.from(remoteTableName).upsert(dbPayload);
          if (error) throw error;
        }
      } else if (operation === "delete") {
        if (shouldHardDelete) {
          const { error } = await client
            .from(remoteTableName)
            .delete()
            .eq("id", entityId);
          if (error) throw error;
        } else {
          const { error } = await client
            .from(remoteTableName)
            .update({ is_deleted: true, updated_at: new Date().toISOString() })
            .eq("id", entityId);
          if (error) throw error;
        }
      }

      // Success: Mark as synced
      await db.offline_mutations.update(id, { status: "synced" }); // Or delete if preferred, but synced is good for history
      if (isPriceBookMutation(mutation)) {
        failedPriceBookIds.delete(entityId);
        const supersededFailures = await db.offline_mutations
          .where("status")
          .equals("failed")
          .filter((candidate) =>
            candidate.id !== id &&
            candidate.entityType === entityType &&
            candidate.entityId === entityId &&
            (
              candidate.createdAt < mutation.createdAt ||
              (candidate.createdAt === mutation.createdAt && candidate.id < id)
            ),
          )
          .primaryKeys();
        if (supersededFailures.length > 0) {
          await db.offline_mutations.bulkUpdate(
            supersededFailures.map((failureId) => ({
              key: failureId,
              changes: { status: "synced" as const, error: undefined },
            })),
          );
        }
      }

      // Also update the actual entity sync status to 'synced'
      const table = (db as any)[entityType];
      if (table) {
        if (shouldHardDelete && entityType === "loans") {
          await db.transaction(
            "rw",
            [db.loans, db.loan_installments, db.loan_payments],
            async () => {
              await db.loans.delete(entityId);
              await db.loan_installments
                .where("loanId")
                .equals(entityId)
                .delete();
              await db.loan_payments.where("loanId").equals(entityId).delete();
            },
          );
        } else if (shouldHardDelete) {
          await table.delete(syncedEntityId);
        } else if (!entityHandledInline) {
          await table.update(syncedEntityId, {
            syncStatus: "synced",
            lastSyncedAt: new Date().toISOString(),
          });
        }
      }

      if (entityType === "product_barcodes" && workspaceId) {
        await syncProductBarcodeCachesForWorkspace(workspaceId);
      }

      if (entityType === "sales_orders") {
        touchedCommissionOrders.set(`${workspaceId}:${entityId}`, {
          workspaceId,
          orderId: entityId,
          orderReturnId: null,
        });
      } else if (entityType === "order_returns" || entityType === "sales_order_agent_assignments") {
        const orderId = payload.orderId ?? payload.order_id;
        if (typeof orderId === "string" && orderId) {
          const key = `${workspaceId}:${orderId}`;
          const previous = touchedCommissionOrders.get(key);
          touchedCommissionOrders.set(key, {
            workspaceId,
            orderId,
            orderReturnId: entityType === "order_returns"
              ? entityId
              : previous?.orderReturnId ?? null,
          });
        }
      }

      successCount++;
      reportCompleted();
    } catch (err: any) {
      console.error(`[Sync] Failed mutation ${mutation.id}:`, err);
      const errorMessage = err.message || "Unknown error";
      const schemaMismatchError = getSchemaMismatchError(
        getTableName(mutation.entityType),
        err,
      );
      const syncIntegrityError = schemaMismatchError ?? getSyncIntegrityError(
        getTableName(mutation.entityType),
        err,
      );
      const storedError = syncIntegrityError ?? errorMessage;
      await db.offline_mutations.update(mutation.id, {
        status: "failed",
        error: storedError,
      });
      if (syncIntegrityError) {
        const table = (db as any)[mutation.entityType];
        if (table) {
          await table.update(mutation.entityId, { syncStatus: "conflict" });
        }
        if (mutation.entityType === "price_books") {
          failedPriceBookIds.add(mutation.entityId);
        }
        integrityBlockedEntities.set(mutationKey, syncIntegrityError);
        errors.push(syncIntegrityError);
        failedCount++;
        reportCompleted();
        continue;
      }
      if (isPriceBookMutation(mutation)) {
        if (mutation.entityType === "price_books") {
          failedPriceBookIds.add(mutation.entityId);
        }
        failedCount++;
        errors.push(errorMessage);
        reportCompleted();
        continue;
      }
      // Stop processing on first error to maintain order integrity
      reportCompleted();
      return { success: successCount, failed: failedCount + 1, errors: [...errors, errorMessage] };
    }
  }

  const explicitlyReconciledOrderKeys = new Set<string>();
  for (const mutation of deferredCommissionReconciliations) {
    await db.offline_mutations.update(mutation.id, {
      status: "syncing",
      error: undefined,
    });
    try {
      const orderId = mutation.payload.orderId ?? mutation.payload.order_id ?? mutation.entityId;
      const orderReturnId = mutation.payload.orderReturnId ?? mutation.payload.order_return_id ?? null;
      if (typeof orderId !== "string" || !orderId) {
        throw new Error("Commission reconciliation is missing its sales order reference");
      }
      explicitlyReconciledOrderKeys.add(`${mutation.workspaceId}:${orderId}`);
      const { error } = await supabase.rpc("reconcile_sales_agent_commission", {
        p_order_id: orderId,
        p_order_return_id: typeof orderReturnId === "string" ? orderReturnId : null,
      });
      if (error) throw error;
      await db.offline_mutations.update(mutation.id, {
        status: "synced",
        error: undefined,
      });
      successCount++;
      reportCompleted();
    } catch (err: any) {
      const errorMessage = err?.message || "Commission reconciliation failed";
      console.error(`[Sync] Failed commission reconciliation ${mutation.id}:`, err);
      await db.offline_mutations.update(mutation.id, {
        status: "pending",
        error: errorMessage,
      });
      failedCount++;
      errors.push(errorMessage);
      reportCompleted();
    }
  }

  // A safety net for older clients or a crash between the business mutation
  // and queuing its explicit request. This is still deferred until the full
  // batch is committed, and the RPC is state-derived/idempotent.
  for (const touched of touchedCommissionOrders.values()) {
    if (explicitlyReconciledOrderKeys.has(`${touched.workspaceId}:${touched.orderId}`)) continue;
    try {
      const { error } = await supabase.rpc("reconcile_sales_agent_commission", {
        p_order_id: touched.orderId,
        p_order_return_id: touched.orderReturnId,
      });
      if (error) throw error;
    } catch (error) {
      console.error(`[Sync] Deferred commission safety reconciliation failed for ${touched.orderId}:`, error);
    }
  }

  return {
    success: successCount,
    failed: failedCount,
    errors,
  };
}

// Deprecated: Old pushChanges (kept for reference or fallback if needed during transition)
export async function pushChanges(
  _userId: string,
  _workspaceId: string,
): Promise<{ success: number; failed: number }> {
  // Redirect to new logic? Or just leave as legacy.
  // For now, let's leave it but maybe logs warning.
  console.warn("[Sync] pushChanges is deprecated. Use processMutationQueue.");
  return { success: 0, failed: 0 };
}

// Pull changes from Supabase
export async function pullChanges(
  workspaceId: string,
  lastSyncTime: string | null,
  onProgress?: (
    completed: number,
    total: number,
    detail?: SyncProgressDetail,
  ) => void,
): Promise<{ pulled: number; errors: string[] }> {
  if (isLocalWorkspaceMode(workspaceId)) {
    return { pulled: 0, errors: [] };
  }

  if (!isSupabaseConfigured) {
    console.log("[Sync] pullChanges: Supabase not configured");
    return { pulled: 0, errors: ["Supabase is not configured."] };
  }

  const since = lastSyncTime || "1970-01-01T00:00:00Z";
  console.log(
    `[Sync] pullChanges START: Workspace ${workspaceId}, since ${since}`,
  );

  let totalPulled = 0;
  const errors: string[] = [];

  for (
    let batchStart = 0;
    batchStart < SYNC_PULL_TABLES.length;
    batchStart += PULL_FETCH_CONCURRENCY
  ) {
    const tableBatch = SYNC_PULL_TABLES.slice(
      batchStart,
      batchStart + PULL_FETCH_CONCURRENCY,
    );
    const fetchedRows = await Promise.all(
      tableBatch.map(async (table, batchIndex) => {
        try {
          return {
            index: batchStart + batchIndex,
            table,
            data: await fetchPullRows(table, workspaceId, since),
            error: null,
          };
        } catch (error) {
          return {
            index: batchStart + batchIndex,
            table,
            data: null,
            error,
          };
        }
      }),
    );

    for (const { index, table, data, error } of fetchedRows) {
      try {
        if (error) {
          throw error;
        }

        const affectedInventoryProducts = new Set<string>();

        if (data && data.length > 0) {
          console.log(
            `[Sync] pullChanges: Processing ${data.length} items for ${table}`,
          );
          const dbTable = (db as any)[table];

          if (!ROW_WISE_PULL_TABLES.has(table)) {
            totalPulled += await persistRemoteRowsInBatches(
              table,
              dbTable,
              data,
              (completed, total) => onProgress?.(
                index,
                SYNC_PULL_TABLES.length,
                { table, completed, total },
              ),
            );
          } else {
            for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
              const remoteItem = data[rowIndex];
              const localItem = await dbTable.get(remoteItem.id);
              const remoteData = removeRetiredPartnerFields(
                table,
                toCamelCase(remoteItem) as Record<string, unknown>,
              );

              if (table === "price_book_items") {
                const priceBookId = (remoteData as { priceBookId?: unknown }).priceBookId;
                const productId = (remoteData as { productId?: unknown }).productId;
                if (typeof priceBookId === "string" && typeof productId === "string") {
                  const naturalKeyConflict = await db.price_book_items
                    .where("[priceBookId+productId]")
                    .equals([priceBookId, productId])
                    .first();
                  if (naturalKeyConflict && naturalKeyConflict.id !== remoteItem.id) {
                    if (naturalKeyConflict.syncStatus === "pending") {
                      continue;
                    }
                    await db.price_book_items.delete(naturalKeyConflict.id);
                  }
                }
              }

              // Version control: Last Write Wins based on updated_at.
              // Pending local intent remains protected by shouldApplyRemoteItem.

              if (shouldApplyRemoteItem(table, localItem, remoteData)) {
                const localThermalPrinting =
                  table === "workspaces"
                    ? (localItem as any)?.thermal_printing
                    : undefined;
                const workspaceOverrides =
                  table === "workspaces" &&
                  typeof localThermalPrinting === "boolean"
                    ? { thermal_printing: localThermalPrinting }
                    : {};

                await dbTable.put({
                  ...remoteData,
                  ...workspaceOverrides,
                  syncStatus: "synced",
                  lastSyncedAt: new Date().toISOString(),
                });
                if (
                  table === "inventory" &&
                  typeof (remoteData as any).productId === "string"
                ) {
                  affectedInventoryProducts.add((remoteData as any).productId);
                }
                totalPulled++;
              }

              if (
                (rowIndex + 1) % PULL_WRITE_BATCH_SIZE === 0 ||
                rowIndex + 1 === data.length
              ) {
                onProgress?.(
                  index,
                  SYNC_PULL_TABLES.length,
                  { table, completed: rowIndex + 1, total: data.length },
                );
              }
            }
          }

          if (table === "inventory" && affectedInventoryProducts.size > 0) {
            const { evaluateReorderTransferRulesForProduct } =
              await import("@/local-db/reorderTransferRules");
            await Promise.all(
              Array.from(affectedInventoryProducts).map((productId) =>
                syncProductStockSnapshot(
                  productId,
                  new Date().toISOString(),
                  "remote",
                ).then(() =>
                  evaluateReorderTransferRulesForProduct(workspaceId, productId),
                ),
              ),
            );
          }

          if (table === "products" || table === "product_barcodes") {
            await syncProductBarcodeCachesForWorkspace(workspaceId);
          }
        }

      } catch (err: any) {
        const message = err?.message || String(err) || "Unknown error";
        errors.push(`${table}: ${message}`);
        console.error(
          `[Sync] pullChanges: Critical error fetching ${table}:`,
          message,
        );
      }

      onProgress?.(index + 1, SYNC_PULL_TABLES.length);
    }
  }

  console.log(
    `[Sync] pullChanges COMPLETE: Total items pulled: ${totalPulled}`,
  );
  return { pulled: totalPulled, errors };
}

// Full sync - Process queue then pull
export async function fullSync(
  userId: string,
  workspaceId: string,
  lastSyncTime: string | null,
): Promise<SyncResult> {
  if (isLocalWorkspaceMode(workspaceId)) {
    return {
      success: true,
      pushed: 0,
      pulled: 0,
      errors: [],
    };
  }

  console.log(
    `[Sync] fullSync START for User ${userId}, Workspace ${workspaceId}`,
  );

  startSyncProgress();

  try {
    // 1. Process Offline Mutations
    const { success, failed, errors: pushErrors } = await processMutationQueue(
      userId,
      (completed, total) => updateSyncProgress("pushing", completed, total),
    );

    // 2. Pull Changes (Force pull to ensure consistency)
    updateSyncProgress("pulling", 0, SYNC_PULL_TABLES.length);
    const { pulled, errors: pullErrors } = await pullChanges(
      workspaceId,
      lastSyncTime,
      (completed, total, detail) => updateSyncProgress("pulling", completed, total, detail),
    );
    const errors = [...pushErrors, ...pullErrors];
    if (pullErrors.length === 0) {
      recordWorkspaceDataFetch(workspaceId, "supabase");
    }

    return {
      success: failed === 0 && pullErrors.length === 0,
      pushed: success,
      pulled,
      errors,
    };
  } finally {
    finishSyncProgress();
  }
}
