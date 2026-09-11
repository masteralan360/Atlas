import { useEffect } from "react";
import type { Table } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";

import { supabase } from "@/auth/supabase";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { getOrderLineInventoryQuantity, getOrderLinePaidQuantity } from "@/lib/orderLineItems";
import { isOnline } from "@/lib/network";
import { normalizeOrderAdjustments } from "@/lib/orderAdjustments";
import { getAppliedCurrencyConversion } from "@/lib/orderCurrency";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toSnakeCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";
import { readWorkspaceCache } from "@/workspace/workspaceCache";

import { db } from "./database";
import { fetchTableFromSupabase } from "./hooks";
import type {
  AgentCommissionEntry,
  AgentCommissionMembership,
  AgentCommissionPlan,
  CommissionCalculation,
  CommissionCalculationBasis,
  CommissionPlanLevel,
  CommissionPlanType,
  CurrencyCode,
  ExchangeRateSnapshot,
  ManualSalesAgentCommissionType,
  SalesOrder,
  SalesOrderAgentAssignment,
  SalesOrderAgentAssignmentSource,
  WorkspacePaymentMethod,
} from "./models";
import {
  activeProductCommissionRule,
  appendAgentProductCommissionEntry,
} from "./productCommissions";
import { addToOfflineMutations } from "./offlineMutations";

const PLAN_TABLE = "agent_commission_plans";
const MEMBERSHIP_TABLE = "agent_commission_memberships";
const ASSIGNMENT_TABLE = "sales_order_agent_assignments";
const ENTRY_TABLE = "agent_commission_entries";
const RECONCILIATION_ENTITY = "sales_agent_commission_reconciliation";
export const ORDER_CREATOR_PRODUCT_ASSIGNMENT_SOURCE = "order_creator_product" as const;

// Sales-account beneficiaries are derived from an order and can be requested
// by its save lifecycle, form assignment lifecycle, and agent-details
// backfill at nearly the same time. Serialize each order's derived work so
// two callers cannot both conclude that the beneficiary is missing.
const salesOrderAssignmentLocks = new Map<string, Promise<void>>();

async function withSalesOrderAssignmentLock<T>(
  workspaceId: string,
  orderId: string,
  operation: () => Promise<T>,
) {
  const key = `${workspaceId}:${orderId}`;
  const previous = salesOrderAssignmentLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => completed);
  salesOrderAssignmentLocks.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (salesOrderAssignmentLocks.get(key) === queued) {
      salesOrderAssignmentLocks.delete(key);
    }
  }
}

function hasCachedAgentSalesAccountsFeature(workspaceId: string) {
  return Boolean(readWorkspaceCache<{
    agent_sales_accounts?: boolean;
  }>(workspaceId)?.features.agent_sales_accounts);
}

type CommissionTableName =
  | typeof PLAN_TABLE
  | typeof MEMBERSHIP_TABLE
  | typeof ASSIGNMENT_TABLE
  | typeof ENTRY_TABLE;
type CommissionEntity =
  | AgentCommissionPlan
  | AgentCommissionMembership
  | SalesOrderAgentAssignment
  | AgentCommissionEntry;

export interface CreateAgentCommissionPlanInput {
  name: string;
  level: CommissionPlanLevel;
  ratePercent: number;
  commissionType?: CommissionPlanType;
  fixedAmount?: number | null;
  fixedCurrency?: CurrencyCode | null;
  tierName?: string | null;
  calculationBasis?: CommissionCalculationBasis;
  includeTax?: boolean;
  includeDeliveryCharge?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  isActive?: boolean;
  notes?: string | null;
  createdBy?: string | null;
}

export interface UpdateAgentCommissionPlanInput {
  name?: string;
  level?: CommissionPlanLevel;
  ratePercent?: number;
  commissionType?: CommissionPlanType;
  fixedAmount?: number | null;
  fixedCurrency?: CurrencyCode | null;
  tierName?: string | null;
  calculationBasis?: CommissionCalculationBasis;
  includeTax?: boolean;
  includeDeliveryCharge?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  isActive?: boolean;
  notes?: string | null;
  /** Actor hint for local mode. Cloud audit fields are stamped from auth.uid(). */
  createdBy?: string | null;
}

export interface DeleteAgentCommissionPlanInput {
  /** Actor hint for local mode. Cloud audit fields are stamped from auth.uid(). */
  deletedBy?: string | null;
  effectiveAt?: string;
}

export interface SetAgentCommissionMembershipInput {
  agentId: string;
  planId: string | null;
  effectiveAt?: string;
  assignedBy?: string | null;
  notes?: string | null;
}

export interface AssignSalesOrderAgentInput {
  orderId: string;
  agentId: string | null;
  assignmentSource?: SalesOrderAgentAssignmentSource;
  assignedAt?: string;
  assignedBy?: string | null;
  reason?: string | null;
  customerCitySnapshot?: string | null;
  deliveryChargeAmount?: number;
  internalDeliveryCostAmount?: number;
  manualCommission?: ManualSalesAgentCommissionInput | null;
}

export interface ReplaceSalesOrderAgentAssignmentsInput {
  orderId: string;
  assignments: Array<Omit<AssignSalesOrderAgentInput, "orderId" | "agentId" | "assignedBy"> & {
    agentId: string;
  }>;
  assignedBy?: string | null;
  reason?: string | null;
}

export interface ManualSalesAgentCommissionInput {
  /**
   * An order-specific commission fallback or an override of an agent's
   * effective plan terms. It never changes the workspace commission plan.
   */
  type: ManualSalesAgentCommissionType;
  /** Fixed amount or percentage, depending on `type`. */
  amount: number;
  /** The entered fixed-amount currency. Percentage always uses order currency. */
  currency: CurrencyCode;
  /** The exact order-rate snapshot used to lock a fixed-amount conversion. */
  exchangeRates?: ExchangeRateSnapshot[] | null;
}

export interface RecordCommissionApprovalInput {
  entryId: string;
  approvedBy?: string | null;
  occurredAt?: string;
  notes?: string | null;
}

export interface RecordCommissionAdjustmentInput {
  agentId: string;
  amount: number;
  currency: CurrencyCode;
  orderId?: string | null;
  relatedEntryId?: string | null;
  occurredAt?: string;
  notes: string;
  createdBy?: string | null;
}

function shouldUseCloudData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId);
}

function normalizeText(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeTimestamp(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error("Enter a valid date and time");
  }
  return date.toISOString();
}

function normalizePlanUpdateTimestamp(
  value: string | null | undefined,
  existing: string | null,
) {
  if (value === undefined) return existing;
  if (value === null || value === "") return null;
  // The settings form uses date-only controls. Preserve the original precise
  // revision boundary when the displayed calendar day was not changed.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && existing?.slice(0, 10) === value) {
    return existing;
  }
  return normalizeTimestamp(value);
}

function isCurrentPlanRevision(plan: AgentCommissionPlan) {
  return !plan.isDeleted && (plan.isActive || !plan.effectiveTo);
}

function roundCommissionAmount(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function assertMoney(value: number, label: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label} must be zero or greater`);
  }
  return roundCommissionAmount(amount);
}

function assertRate(value: number) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error("Commission rate must be between 0 and 100 percent");
  }
  return roundCommissionAmount(rate);
}

function resolveCommissionPlanType(value?: CommissionPlanType | null): CommissionPlanType {
  return value === "fixed_amount" ? "fixed_amount" : "percentage";
}

function assertCommissionCurrency(value?: CurrencyCode | null): CurrencyCode {
  if (value === "usd" || value === "eur" || value === "iqd" || value === "try") {
    return value;
  }
  throw new Error("Select a valid commission currency");
}

function resolveCommissionPlanTerms(input: {
  commissionType?: CommissionPlanType | null;
  ratePercent?: number | null;
  fixedAmount?: number | null;
  fixedCurrency?: CurrencyCode | null;
}, fallback?: Pick<AgentCommissionPlan, "commissionType" | "ratePercent" | "fixedAmount" | "fixedCurrency">) {
  const commissionType = resolveCommissionPlanType(input.commissionType ?? fallback?.commissionType);
  if (commissionType === "percentage") {
    return {
      commissionType,
      ratePercent: assertRate(input.ratePercent ?? fallback?.ratePercent ?? 0),
      fixedAmount: null,
      fixedCurrency: null,
    };
  }

  const fixedAmount = assertMoney(input.fixedAmount ?? fallback?.fixedAmount ?? 0, "Fixed commission");
  return {
    commissionType,
    ratePercent: 0,
    fixedAmount,
    fixedCurrency: assertCommissionCurrency(input.fixedCurrency ?? fallback?.fixedCurrency),
  };
}

type ResolvedManualSalesAgentCommission = {
  type: ManualSalesAgentCommissionType;
  sourceAmount: number;
  sourceCurrency: CurrencyCode;
  convertedAmount: number;
  exchangeRate: number;
  exchangeRateSource: string;
  exchangeRateTimestamp: string;
  exchangeRates: ExchangeRateSnapshot[];
};

function resolveManualSalesAgentCommission(
  order: Pick<SalesOrder, "currency" | "total" | "exchangeRates">,
  input: ManualSalesAgentCommissionInput,
): ResolvedManualSalesAgentCommission {
  const sourceAmount = assertMoney(input.amount, "Manual commission");
  if (sourceAmount < 0) {
    throw new Error("Manual commission must be zero or greater");
  }

  if (input.type === "percentage") {
    const ratePercent = assertRate(sourceAmount);
    const now = new Date().toISOString();
    return {
      type: "percentage",
      sourceAmount: ratePercent,
      sourceCurrency: order.currency,
      convertedAmount: roundCommissionAmount(Math.max(0, Number(order.total || 0)) * ratePercent / 100),
      exchangeRate: 1,
      exchangeRateSource: "native",
      exchangeRateTimestamp: now,
      exchangeRates: [],
    };
  }

  const conversion = getAppliedCurrencyConversion(
    sourceAmount,
    input.currency,
    order.currency,
    order.exchangeRates ?? input.exchangeRates,
  );
  if (!conversion) {
    throw new Error("Exchange rate unavailable for the selected commission currency");
  }
  return {
    type: "fixed_amount",
    sourceAmount,
    sourceCurrency: input.currency,
    convertedAmount: roundCommissionAmount(conversion.convertedAmount),
    exchangeRate: conversion.exchangeRate,
    exchangeRateSource: conversion.exchangeRateSource,
    exchangeRateTimestamp: conversion.exchangeRateTimestamp,
    exchangeRates: conversion.exchangeRates,
  };
}

function getAssignmentManualSalesAgentCommission(
  assignment: Pick<
    SalesOrderAgentAssignment,
    | "manualCommissionType"
    | "manualCommissionSourceAmount"
    | "manualCommissionSourceCurrency"
    | "manualCommissionConvertedAmount"
    | "manualCommissionExchangeRate"
    | "manualCommissionExchangeRateSource"
    | "manualCommissionExchangeRateTimestamp"
    | "manualCommissionExchangeRates"
  >,
): ResolvedManualSalesAgentCommission | null {
  const type = assignment.manualCommissionType;
  const sourceAmount = Number(assignment.manualCommissionSourceAmount);
  const convertedAmount = Number(assignment.manualCommissionConvertedAmount);
  const exchangeRate = Number(assignment.manualCommissionExchangeRate);
  const sourceCurrency = assignment.manualCommissionSourceCurrency;
  if (
    (type !== "fixed_amount" && type !== "percentage")
    || !sourceCurrency
    || !Number.isFinite(sourceAmount)
    || sourceAmount < 0
    || !Number.isFinite(convertedAmount)
    || convertedAmount < 0
    || !Number.isFinite(exchangeRate)
    || exchangeRate <= 0
    || !assignment.manualCommissionExchangeRateSource
    || !assignment.manualCommissionExchangeRateTimestamp
  ) return null;

  return {
    type,
    sourceAmount: roundCommissionAmount(sourceAmount),
    sourceCurrency,
    convertedAmount: roundCommissionAmount(convertedAmount),
    exchangeRate,
    exchangeRateSource: assignment.manualCommissionExchangeRateSource,
    exchangeRateTimestamp: assignment.manualCommissionExchangeRateTimestamp,
    exchangeRates: assignment.manualCommissionExchangeRates ?? [],
  };
}

function hasSameManualSalesAgentCommission(
  assignment: SalesOrderAgentAssignment | null | undefined,
  manual: ResolvedManualSalesAgentCommission | null,
) {
  const existing = assignment ? getAssignmentManualSalesAgentCommission(assignment) : null;
  if (!existing || !manual) return existing === manual;
  return existing.type === manual.type
    && existing.sourceAmount === manual.sourceAmount
    && existing.sourceCurrency === manual.sourceCurrency
    && existing.convertedAmount === manual.convertedAmount
    && existing.exchangeRate === manual.exchangeRate
    && existing.exchangeRateSource === manual.exchangeRateSource
    && existing.exchangeRateTimestamp === manual.exchangeRateTimestamp
    && JSON.stringify(existing.exchangeRates) === JSON.stringify(manual.exchangeRates);
}

export function calculateManualSalesOrderCommission(
  order: SalesOrder,
  assignment: Pick<
    SalesOrderAgentAssignment,
    | "manualCommissionType"
    | "manualCommissionSourceAmount"
    | "manualCommissionSourceCurrency"
    | "manualCommissionConvertedAmount"
    | "manualCommissionExchangeRate"
    | "manualCommissionExchangeRateSource"
    | "manualCommissionExchangeRateTimestamp"
    | "manualCommissionExchangeRates"
  >,
  excludedProductBasis = 0,
): CommissionCalculation | null {
  const manual = getAssignmentManualSalesAgentCommission(assignment);
  if (!manual) return null;
  const orderTotal = Math.max(0, Number(order.total || 0));
  // A product rule replaces normal commission for that line. Manual order
  // commission follows the same rule: it is only calculated over the part of
  // the order not covered by immutable product-line commission snapshots.
  const eligibleTotal = Math.max(0, orderTotal - Math.max(0, excludedProductBasis));
  const remainingRatio = orderTotal > 0 ? eligibleTotal / orderTotal : 0;
  const isEligibleOrder = order.status !== "cancelled"
    && order.returnStatus !== "full"
    && !order.isDeleted;
  const commissionAmount = !isEligibleOrder
    ? 0
    : manual.type === "percentage"
      ? roundCommissionAmount(eligibleTotal * manual.sourceAmount / 100)
      : roundCommissionAmount(manual.convertedAmount * remainingRatio);

  return {
    currency: order.currency,
    revenueAmount: isEligibleOrder ? roundCommissionAmount(eligibleTotal) : 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    basisAmount: isEligibleOrder ? roundCommissionAmount(eligibleTotal) : 0,
    ratePercent: manual.type === "percentage" ? manual.sourceAmount : 0,
    commissionAmount,
  };
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
  return shouldUseCloudData(workspaceId)
    ? { syncStatus: "pending" as const, lastSyncedAt: null }
    : { syncStatus: "synced" as const, lastSyncedAt: timestamp };
}

function getTable(tableName: CommissionTableName) {
  switch (tableName) {
    case PLAN_TABLE: return db.agent_commission_plans;
    case MEMBERSHIP_TABLE: return db.agent_commission_memberships;
    case ASSIGNMENT_TABLE: return db.sales_order_agent_assignments;
    case ENTRY_TABLE: return db.agent_commission_entries;
  }
}

function sanitizePayload(entity: CommissionEntity) {
  const payload = toSnakeCase(entity as unknown as Record<string, unknown>);
  delete payload.sync_status;
  delete payload.last_synced_at;
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

async function markSynced(tableName: CommissionTableName, id: string) {
  await getTable(tableName).update(id, {
    syncStatus: "synced",
    lastSyncedAt: new Date().toISOString(),
  } as never);
}

async function syncUpsert(tableName: CommissionTableName, entity: CommissionEntity) {
  if (!shouldUseCloudData(entity.workspaceId)) return;

  if (!isOnline(entity.workspaceId)) {
    await addToOfflineMutations(
      tableName,
      entity.id,
      entity.version > 1 ? "update" : "create",
      entity as unknown as Record<string, unknown>,
      entity.workspaceId,
    );
    return;
  }

  try {
    const client = getSupabaseClientForTable(tableName);
    const payload = sanitizePayload(entity);
    const { error } = (await runSupabaseAction(`${tableName}.sync`, () =>
      tableName === ENTRY_TABLE
        ? client.from(tableName).insert(payload)
        : client.from(tableName).upsert(payload),
    )) as { error?: { code?: unknown } | null };
    if (error) {
      if (tableName !== ENTRY_TABLE || error.code !== "23505") throw error;
      const { data: existingEntry, error: lookupError } = (await runSupabaseAction(
        `${tableName}.confirmRetry`,
        () => client.from(tableName).select("id").eq("id", entity.id).maybeSingle(),
      )) as { data?: { id?: unknown } | null; error?: unknown };
      if (lookupError || existingEntry?.id !== entity.id) throw error;
    }
    await markSynced(tableName, entity.id);
  } catch (error) {
    if (
      tableName === ENTRY_TABLE
      && (entity as AgentCommissionEntry).kind === "payout"
      && (error as { code?: unknown } | null)?.code === "23505"
    ) {
      await db.agent_commission_entries.delete(entity.id);
      throw new Error("That payout reference has already been recorded for this agent and currency");
    }
    console.error(`[Sales Agent Commissions] Failed to sync ${tableName}:`, error);
    await addToOfflineMutations(
      tableName,
      entity.id,
      entity.version > 1 ? "update" : "create",
      entity as unknown as Record<string, unknown>,
      entity.workspaceId,
    );
  }
}

type CommissionReconciliationRequestOptions = {
  orderReturnId?: string | null;
  assignmentId?: string | null;
  membershipId?: string | null;
  planId?: string | null;
};

async function requestServerCommissionReconciliation(
  workspaceId: string,
  orderId: string,
  options: CommissionReconciliationRequestOptions = {},
) {
  if (!shouldUseCloudData(workspaceId)) return false;

  const payload = {
    orderId,
    ...(options.orderReturnId ? { orderReturnId: options.orderReturnId } : {}),
    ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
    ...(options.membershipId ? { membershipId: options.membershipId } : {}),
    ...(options.planId ? { planId: options.planId } : {}),
  };
  await addToOfflineMutations(
    RECONCILIATION_ENTITY,
    orderId,
    "update",
    payload,
    workspaceId,
  );
  if (!isOnline(workspaceId)) return false;

  const order = await db.sales_orders.get(orderId);
  if (!order || order.syncStatus !== "synced") return false;
  const [assignments, postedReturns] = await Promise.all([
    db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, orderId])
      .and((row) => !row.isDeleted)
      .toArray(),
    db.order_returns
      .where("[workspaceId+orderId]")
      .equals([workspaceId, orderId])
      .and((row) => !row.isDeleted && row.status === "posted")
      .toArray(),
  ]);
  if (assignments.some((row) => row.syncStatus !== "synced")
    || postedReturns.some((row) => row.syncStatus !== "synced")) return false;

  const agentIds = new Set(assignments.map((assignment) => assignment.agentId));
  const memberships = (await db.agent_commission_memberships
    .where("workspaceId")
    .equals(workspaceId)
    .and((membership) => !membership.isDeleted && agentIds.has(membership.agentId))
    .toArray());
  if (memberships.some((membership) => membership.syncStatus !== "synced")) return false;
  const planIds = new Set(memberships.map((membership) => membership.planId));
  const plans = await db.agent_commission_plans
    .where("workspaceId")
    .equals(workspaceId)
    .and((plan) => !plan.isDeleted && planIds.has(plan.id))
    .toArray();
  if (plans.some((plan) => plan.syncStatus !== "synced")) return false;

  try {
    const { error } = (await runSupabaseAction(
      "salesAgentCommissions.reconcile",
      () => supabase.rpc("reconcile_sales_agent_commission", {
        p_order_id: orderId,
        p_order_return_id: options.orderReturnId ?? null,
      }),
    )) as { error?: unknown };
    if (error) throw error;
    const pendingIds = await db.offline_mutations
      .where("[entityType+entityId+status]")
      .equals([RECONCILIATION_ENTITY, orderId, "pending"])
      .primaryKeys();
    if (pendingIds.length > 0) {
      await db.offline_mutations.bulkUpdate(pendingIds.map((id) => ({
        key: id,
        changes: { status: "synced" as const, error: undefined },
      })));
    }
    return true;
  } catch (error) {
    console.error("[Sales Agent Commissions] Server reconciliation was queued:", error);
    return false;
  }
}

async function hydrateTable(tableName: CommissionTableName, workspaceId: string) {
  if (!shouldUseCloudData(workspaceId)) return;
  await fetchTableFromSupabase(tableName, getTable(tableName), workspaceId);
}

function useCommissionRows<T extends CommissionEntity>(
  tableName: CommissionTableName,
  workspaceId?: string,
) {
  const online = useNetworkStatus();
  const featureEnabled = Boolean(workspaceId && readWorkspaceCache<{
    sales_agent_commissions?: boolean;
  }>(workspaceId)?.features.sales_agent_commissions);
  const rows = useLiveQuery<T[]>(
    async () => {
      if (!workspaceId || !featureEnabled) return [];
      const table = getTable(tableName) as unknown as Table<T, string>;
      return table
        .where("workspaceId")
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray();
    },
    [featureEnabled, tableName, workspaceId],
  );

  useEffect(() => {
    if (!workspaceId || !online || !featureEnabled) return;
    void hydrateTable(tableName, workspaceId).catch((error) => {
      console.error(`[Sales Agent Commissions] Failed to hydrate ${tableName}:`, error);
    });
  }, [featureEnabled, online, tableName, workspaceId]);

  return rows ?? [];
}

export function useAgentCommissionPlans(workspaceId?: string) {
  return useCommissionRows<AgentCommissionPlan>(PLAN_TABLE, workspaceId)
    .sort((left, right) => left.level.localeCompare(right.level)
      || right.effectiveFrom.localeCompare(left.effectiveFrom));
}

export function useAgentCommissionMemberships(workspaceId?: string) {
  return useCommissionRows<AgentCommissionMembership>(MEMBERSHIP_TABLE, workspaceId)
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
}

export function useSalesOrderAgentAssignments(workspaceId?: string) {
  return useCommissionRows<SalesOrderAgentAssignment>(ASSIGNMENT_TABLE, workspaceId)
    .sort((left, right) => right.assignedAt.localeCompare(left.assignedAt));
}

export function useAgentCommissionEntries(workspaceId?: string) {
  return useCommissionRows<AgentCommissionEntry>(ENTRY_TABLE, workspaceId)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

export function getActiveSalesOrderAgentAssignment(
  assignments: readonly SalesOrderAgentAssignment[],
  orderId: string,
) {
  return getActiveSalesOrderAgentAssignments(assignments, orderId)[0] ?? null;
}

export function getActiveSalesOrderAgentAssignments(
  assignments: readonly SalesOrderAgentAssignment[],
  orderId: string,
) {
  return assignments
    .filter((row) => !row.isDeleted && row.orderId === orderId && !row.unassignedAt)
    .sort((left, right) => right.assignedAt.localeCompare(left.assignedAt) || left.agentId.localeCompare(right.agentId));
}

export function getEffectiveAgentCommissionMembership(
  memberships: readonly AgentCommissionMembership[],
  agentId: string,
  at = new Date().toISOString(),
) {
  const timestamp = new Date(at).getTime();
  return memberships
    .filter((row) => {
      if (row.isDeleted || row.agentId !== agentId) return false;
      const starts = new Date(row.effectiveFrom).getTime();
      const ends = row.effectiveTo ? new Date(row.effectiveTo).getTime() : Number.POSITIVE_INFINITY;
      return starts <= timestamp && timestamp < ends;
    })
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null;
}

export async function createAgentCommissionPlan(
  workspaceId: string,
  input: CreateAgentCommissionPlanInput,
) {
  const name = normalizeText(input.name);
  if (!name) throw new Error("Commission plan name is required");
  const level = normalizeText(input.level);
  if (!level) throw new Error("Commission level is required");
  const effectiveFrom = normalizeTimestamp(input.effectiveFrom);
  const effectiveTo = input.effectiveTo ? normalizeTimestamp(input.effectiveTo) : null;
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw new Error("Commission plan end date must be after its start date");
  }
  const existingLevel = await db.agent_commission_plans
    .where("[workspaceId+level]")
    .equals([workspaceId, level])
    .and(isCurrentPlanRevision)
    .first();
  if (existingLevel) {
    throw new Error("This workspace already has a commission plan for that level");
  }
  const terms = resolveCommissionPlanTerms(input);
  const now = new Date().toISOString();
  const plan: AgentCommissionPlan = {
    id: generateId(),
    workspaceId,
    name,
    level,
    commissionType: terms.commissionType,
    ratePercent: terms.ratePercent,
    fixedAmount: terms.fixedAmount,
    fixedCurrency: terms.fixedCurrency,
    tierName: normalizeText(input.tierName),
    calculationBasis: input.calculationBasis ?? "net_profit",
    includeTax: input.includeTax ?? false,
    includeDeliveryCharge: input.includeDeliveryCharge ?? false,
    effectiveFrom,
    effectiveTo,
    isActive: input.isActive ?? true,
    notes: normalizeText(input.notes),
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now),
  };
  await db.agent_commission_plans.put(plan);
  await syncUpsert(PLAN_TABLE, plan);
  return plan;
}

export async function updateAgentCommissionPlan(
  planId: string,
  input: UpdateAgentCommissionPlanInput,
) {
  const existing = await db.agent_commission_plans.get(planId);
  if (!existing || existing.isDeleted) throw new Error("Commission plan not found");
  const name = input.name === undefined ? existing.name : normalizeText(input.name);
  if (!name) throw new Error("Commission plan name is required");
  const effectiveFrom = normalizePlanUpdateTimestamp(
    input.effectiveFrom,
    existing.effectiveFrom,
  )!;
  const effectiveTo = normalizePlanUpdateTimestamp(
    input.effectiveTo,
    existing.effectiveTo ?? null,
  );
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw new Error("Commission plan end date must be after its start date");
  }
  const nextLevel = input.level === undefined ? existing.level : normalizeText(input.level);
  if (!nextLevel) throw new Error("Commission level is required");
  const terms = resolveCommissionPlanTerms({
    commissionType: input.commissionType,
    ratePercent: input.ratePercent,
    fixedAmount: input.fixedAmount,
    fixedCurrency: input.fixedCurrency,
  }, existing);
  const { commissionType, ratePercent, fixedAmount, fixedCurrency } = terms;
  const tierName = input.tierName === undefined ? existing.tierName ?? null : normalizeText(input.tierName);
  const calculationBasis = input.calculationBasis ?? existing.calculationBasis;
  const includeTax = input.includeTax ?? existing.includeTax;
  const includeDeliveryCharge = input.includeDeliveryCharge ?? existing.includeDeliveryCharge;
  const isActive = input.isActive ?? existing.isActive;
  const notes = input.notes === undefined ? existing.notes ?? null : normalizeText(input.notes);
  if (nextLevel !== existing.level) {
    const existingLevel = await db.agent_commission_plans
      .where("[workspaceId+level]")
      .equals([existing.workspaceId, nextLevel])
      .and((plan) => plan.id !== existing.id && isCurrentPlanRevision(plan))
      .first();
    if (existingLevel) {
      throw new Error("This workspace already has a commission plan for that level");
    }
  }
  const now = new Date().toISOString();
  const memberships = await db.agent_commission_memberships
    .where("[workspaceId+planId]")
    .equals([existing.workspaceId, existing.id])
    .and((membership) => !membership.isDeleted)
    .toArray();
  const changesTerms = nextLevel !== existing.level
    || commissionType !== resolveCommissionPlanType(existing.commissionType)
    || ratePercent !== existing.ratePercent
    || fixedAmount !== (existing.fixedAmount ?? null)
    || fixedCurrency !== (existing.fixedCurrency ?? null)
    || calculationBasis !== existing.calculationBasis
    || includeTax !== existing.includeTax
    || includeDeliveryCharge !== existing.includeDeliveryCharge
    || effectiveFrom !== existing.effectiveFrom
    || effectiveTo !== (existing.effectiveTo ?? null)
    || isActive !== existing.isActive;

  if (memberships.length > 0 && changesTerms) {
    if (nextLevel !== existing.level) {
      throw new Error("A used commission plan keeps its level; create or edit that level's current revision instead");
    }
    if (existing.effectiveTo && existing.effectiveTo <= now && !existing.isActive) {
      throw new Error("Historical commission plan revisions cannot be changed");
    }

    const openMemberships = memberships.filter((membership) => !membership.effectiveTo);
    const revisionAtMs = Math.max(
      new Date(now).getTime(),
      new Date(existing.effectiveFrom).getTime() + 1,
      ...openMemberships.map((membership) => new Date(membership.effectiveFrom).getTime() + 1),
    );
    const revisionAt = new Date(revisionAtMs).toISOString();
    if (effectiveTo && effectiveTo <= revisionAt) {
      throw new Error("The revised plan end date must be after the new revision starts");
    }

    const actorId = input.createdBy ?? null;
    const closedPlan: AgentCommissionPlan = {
      ...existing,
      effectiveTo: revisionAt,
      isActive: false,
      updatedAt: now,
      version: existing.version + 1,
      ...getSyncMetadata(existing.workspaceId, now),
    };
    const revision: AgentCommissionPlan = {
      ...existing,
      id: generateId(),
      name,
      level: existing.level,
      commissionType,
      ratePercent,
      fixedAmount,
      fixedCurrency,
      tierName,
      calculationBasis,
      includeTax,
      includeDeliveryCharge,
      effectiveFrom: revisionAt,
      effectiveTo,
      isActive,
      notes,
      createdBy: actorId ?? existing.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      isDeleted: false,
      ...getSyncMetadata(existing.workspaceId, now),
    };
    const closedMemberships = openMemberships.map((membership) => ({
      ...membership,
      effectiveTo: revisionAt,
      endedBy: actorId,
      updatedAt: now,
      version: membership.version + 1,
      ...getSyncMetadata(existing.workspaceId, now),
    } satisfies AgentCommissionMembership));
    const replacementMemberships = isActive
      ? openMemberships.map((membership) => ({
          ...membership,
          id: generateId(),
          planId: revision.id,
          effectiveFrom: revisionAt,
          effectiveTo: null,
          assignedBy: actorId,
          endedBy: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          isDeleted: false,
          ...getSyncMetadata(existing.workspaceId, now),
        } satisfies AgentCommissionMembership))
      : [];

    await db.transaction(
      "rw",
      db.agent_commission_plans,
      db.agent_commission_memberships,
      async () => {
        await db.agent_commission_plans.put(closedPlan);
        if (closedMemberships.length > 0) {
          await db.agent_commission_memberships.bulkPut(closedMemberships);
        }
        await db.agent_commission_plans.put(revision);
        if (replacementMemberships.length > 0) {
          await db.agent_commission_memberships.bulkPut(replacementMemberships);
        }
      },
    );

    await syncUpsert(PLAN_TABLE, closedPlan);
    for (const membership of closedMemberships) {
      await syncUpsert(MEMBERSHIP_TABLE, membership);
    }
    await syncUpsert(PLAN_TABLE, revision);
    for (const membership of replacementMemberships) {
      await syncUpsert(MEMBERSHIP_TABLE, membership);
    }

    if (shouldUseCloudData(existing.workspaceId)) {
      for (const membership of openMemberships) {
        const assignments = await db.sales_order_agent_assignments
          .where("[workspaceId+agentId]")
          .equals([existing.workspaceId, membership.agentId])
          .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
          .toArray();
        const replacement = replacementMemberships.find((row) => row.agentId === membership.agentId);
        await Promise.all(assignments.map((assignment) => requestServerCommissionReconciliation(
          existing.workspaceId,
          assignment.orderId,
          {
            assignmentId: assignment.id,
            membershipId: replacement?.id ?? membership.id,
            planId: revision.id,
          },
        )));
      }
    }
    return revision;
  }

  const updated: AgentCommissionPlan = {
    ...existing,
    name,
    level: nextLevel,
    commissionType,
    ratePercent,
    fixedAmount,
    fixedCurrency,
    tierName,
    calculationBasis,
    includeTax,
    includeDeliveryCharge,
    effectiveFrom,
    effectiveTo,
    isActive,
    notes,
    updatedAt: now,
    version: existing.version + 1,
    ...getSyncMetadata(existing.workspaceId, now),
  };
  await db.agent_commission_plans.put(updated);
  await syncUpsert(PLAN_TABLE, updated);
  if (shouldUseCloudData(existing.workspaceId)) {
    for (const membership of memberships) {
      const assignments = await db.sales_order_agent_assignments
        .where("[workspaceId+agentId]")
        .equals([existing.workspaceId, membership.agentId])
        .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
        .toArray();
      await Promise.all(assignments.map((assignment) => requestServerCommissionReconciliation(
        existing.workspaceId,
        assignment.orderId,
        { assignmentId: assignment.id, membershipId: membership.id, planId: existing.id },
      )));
    }
  }
  return updated;
}

/**
 * Retires a saved commission level without deleting any historical plan,
 * membership, order, or ledger records. Retired levels are excluded from
 * settings and can no longer be assigned to a field agent.
 */
export async function deleteAgentCommissionPlan(
  planId: string,
  input: DeleteAgentCommissionPlanInput = {},
) {
  const existing = await db.agent_commission_plans.get(planId);
  if (!existing || existing.isDeleted) throw new Error("Commission plan not found");
  if (!existing.isActive && existing.effectiveTo) {
    throw new Error("Commission plan has already been deleted");
  }

  const memberships = await db.agent_commission_memberships
    .where("[workspaceId+planId]")
    .equals([existing.workspaceId, existing.id])
    .and((membership) => !membership.isDeleted && !membership.effectiveTo)
    .toArray();
  const requestedAt = normalizeTimestamp(input.effectiveAt);
  const retiredAt = new Date(Math.max(
    new Date(requestedAt).getTime(),
    new Date(existing.effectiveFrom).getTime() + 1,
    ...memberships.map((membership) => new Date(membership.effectiveFrom).getTime() + 1),
  )).toISOString();
  const now = new Date().toISOString();
  const retiredPlan: AgentCommissionPlan = {
    ...existing,
    effectiveTo: retiredAt,
    isActive: false,
    updatedAt: now,
    version: existing.version + 1,
    ...getSyncMetadata(existing.workspaceId, now),
  };
  const endedMemberships = memberships.map((membership) => ({
    ...membership,
    effectiveTo: retiredAt,
    endedBy: input.deletedBy ?? null,
    updatedAt: now,
    version: membership.version + 1,
    ...getSyncMetadata(existing.workspaceId, now),
  } satisfies AgentCommissionMembership));

  await db.transaction(
    "rw",
    db.agent_commission_plans,
    db.agent_commission_memberships,
    async () => {
      if (endedMemberships.length > 0) {
        await db.agent_commission_memberships.bulkPut(endedMemberships);
      }
      await db.agent_commission_plans.put(retiredPlan);
    },
  );

  for (const membership of endedMemberships) {
    await syncUpsert(MEMBERSHIP_TABLE, membership);
  }
  await syncUpsert(PLAN_TABLE, retiredPlan);

  if (shouldUseCloudData(existing.workspaceId)) {
    for (const membership of endedMemberships) {
      const assignments = await db.sales_order_agent_assignments
        .where("[workspaceId+agentId]")
        .equals([existing.workspaceId, membership.agentId])
        .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
        .toArray();
      await Promise.all(assignments.map((assignment) => requestServerCommissionReconciliation(
        existing.workspaceId,
        assignment.orderId,
        { membershipId: membership.id, planId: existing.id },
      )));
    }
  }

  return retiredPlan;
}

function closeTimestampAfter(start: string, requested: string) {
  const startMs = new Date(start).getTime();
  const requestedMs = new Date(requested).getTime();
  return new Date(Math.max(requestedMs, startMs + 1)).toISOString();
}

export async function setAgentCommissionMembership(
  workspaceId: string,
  input: SetAgentCommissionMembershipInput,
) {
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.agentType !== "field_agent") {
    throw new Error("Select an active field agent from this workspace");
  }
  const requestedEffectiveAt = normalizeTimestamp(input.effectiveAt);
  const current = await db.agent_commission_memberships
    .where("[workspaceId+agentId]")
    .equals([workspaceId, input.agentId])
    .and((row) => !row.isDeleted && !row.effectiveTo)
    .first();
  if (current?.planId === input.planId) return current;

  const now = new Date().toISOString();
  const ended = current ? {
    ...current,
    effectiveTo: closeTimestampAfter(current.effectiveFrom, requestedEffectiveAt),
    endedBy: input.assignedBy ?? null,
    updatedAt: now,
    version: current.version + 1,
    ...getSyncMetadata(workspaceId, now),
  } satisfies AgentCommissionMembership : null;
  const effectiveAt = ended?.effectiveTo ?? requestedEffectiveAt;

  let membership: AgentCommissionMembership | null = null;
  if (input.planId) {
    const plan = await db.agent_commission_plans.get(input.planId);
    if (!plan || plan.isDeleted || !plan.isActive || plan.workspaceId !== workspaceId) {
      throw new Error("Select an active commission plan from this workspace");
    }
    membership = {
      id: generateId(),
      workspaceId,
      agentId: input.agentId,
      planId: input.planId,
      effectiveFrom: effectiveAt,
      effectiveTo: null,
      assignedBy: input.assignedBy ?? null,
      endedBy: null,
      notes: normalizeText(input.notes),
      createdAt: now,
      updatedAt: now,
      version: 1,
      isDeleted: false,
      ...getSyncMetadata(workspaceId, now),
    };
  }

  await db.transaction("rw", db.agent_commission_memberships, async () => {
    if (ended) await db.agent_commission_memberships.put(ended);
    if (membership) await db.agent_commission_memberships.put(membership);
  });
  if (ended) await syncUpsert(MEMBERSHIP_TABLE, ended);
  if (membership) await syncUpsert(MEMBERSHIP_TABLE, membership);
  if (shouldUseCloudData(workspaceId)) {
    const assignments = await db.sales_order_agent_assignments
      .where("[workspaceId+agentId]")
      .equals([workspaceId, input.agentId])
      .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
      .toArray();
    await Promise.all(assignments.map((assignment) => requestServerCommissionReconciliation(
      workspaceId,
      assignment.orderId,
      { membershipId: membership?.id ?? ended?.id ?? null, planId: input.planId },
    )));
  }
  return membership;
}

export function calculateSalesOrderCommission(
  order: SalesOrder,
  plan: Pick<
    AgentCommissionPlan,
    | "commissionType"
    | "ratePercent"
    | "fixedAmount"
    | "fixedCurrency"
    | "calculationBasis"
    | "includeTax"
    | "includeDeliveryCharge"
  >,
  assignment?: Pick<
    SalesOrderAgentAssignment,
    "deliveryChargeAmount" | "internalDeliveryCostAmount"
  > | null,
  excludedProductIds: ReadonlySet<string> = new Set(),
): CommissionCalculation {
  const commissionType = resolveCommissionPlanType(plan.commissionType);
  const ratePercent = commissionType === "percentage" ? assertRate(plan.ratePercent) : 0;
  const zero: CommissionCalculation = {
    currency: order.currency,
    revenueAmount: 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    basisAmount: 0,
    ratePercent,
    commissionAmount: 0,
  };
  if (order.status === "cancelled" || order.returnStatus === "full" || order.isDeleted) return zero;

  let itemRevenue = 0;
  let itemCost = 0;
  let fullItemRevenue = 0;
  for (const item of order.items ?? []) {
    const returnedQuantity = Math.min(
      getOrderLineInventoryQuantity(item),
      Math.max(0, Number(item.returnedQuantity ?? 0)),
    );
    const netPaidQuantity = Math.max(0, getOrderLinePaidQuantity(item) - returnedQuantity);
    const netCostQuantity = Math.max(0, getOrderLineInventoryQuantity(item) - returnedQuantity);
    const itemRevenueAmount = netPaidQuantity * Math.max(0, Number(item.convertedUnitPrice || 0));
    const itemCostAmount = netCostQuantity * Math.max(0, Number(item.convertedCostPrice ?? item.costPrice ?? 0));
    fullItemRevenue += itemRevenueAmount;
    if (!excludedProductIds.has(item.productId)) {
      itemRevenue += itemRevenueAmount;
      itemCost += itemCostAmount;
    }
  }

  // Every normalized persisted adjustment changes the order's commercial
  // balance, including immutable post-return corrections.
  const orderAdjustmentNet = normalizeOrderAdjustments(
    order.orderAdjustments,
    order.currency,
  ).reduce((total, adjustment) => {
    const amount = Math.max(0, Number(adjustment.convertedAmount || 0));
    return total + (adjustment.type === "addition" ? amount : -amount);
  }, 0);
  const remainingRatio = fullItemRevenue > 0 ? itemRevenue / fullItemRevenue : 0;
  const merchandiseRevenue = Math.max(0, itemRevenue
    - Math.max(0, Number(order.discount || 0)) * remainingRatio
    + orderAdjustmentNet * remainingRatio);
  const taxAmount = plan.includeTax ? Math.max(0, Number(order.tax || 0)) * remainingRatio : 0;
  const deliveryChargeAmount = plan.includeDeliveryCharge
    ? Math.max(0, Number(assignment?.deliveryChargeAmount || 0)) * remainingRatio
    : 0;
  const internalDeliveryCost = plan.includeDeliveryCharge
    ? Math.max(0, Number(assignment?.internalDeliveryCostAmount || 0)) * remainingRatio
    : 0;
  const revenueAmount = merchandiseRevenue + taxAmount + deliveryChargeAmount;
  const costAmount = itemCost + internalDeliveryCost;
  const basisAmount = Math.max(
    0,
    plan.calculationBasis === "net_revenue" ? revenueAmount : revenueAmount - costAmount,
  );
  const fixedCommission = commissionType === "fixed_amount"
    ? getAppliedCurrencyConversion(
      assertMoney(plan.fixedAmount ?? 0, "Fixed commission"),
      assertCommissionCurrency(plan.fixedCurrency),
      order.currency,
      order.exchangeRates,
    )
    : null;
  if (commissionType === "fixed_amount" && !fixedCommission) {
    throw new Error("Exchange rate unavailable for the commission plan currency");
  }

  return {
    currency: order.currency,
    revenueAmount: roundCommissionAmount(revenueAmount),
    costAmount: roundCommissionAmount(costAmount),
    taxAmount: roundCommissionAmount(taxAmount),
    deliveryChargeAmount: roundCommissionAmount(deliveryChargeAmount),
    basisAmount: roundCommissionAmount(basisAmount),
    ratePercent,
    commissionAmount: commissionType === "fixed_amount"
      ? roundCommissionAmount(fixedCommission!.convertedAmount * remainingRatio)
      : roundCommissionAmount(basisAmount * ratePercent / 100),
  };
}

async function appendEntry(
  workspaceId: string,
  input: Omit<AgentCommissionEntry, keyof ReturnType<typeof getSyncMetadata>
    | "id" | "workspaceId" | "createdAt" | "updatedAt" | "version" | "isDeleted">,
  id = generateId(),
) {
  const now = new Date().toISOString();
  const entry: AgentCommissionEntry = {
    ...input,
    id,
    workspaceId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now),
  };
  await db.agent_commission_entries.put(entry);
  await syncUpsert(ENTRY_TABLE, entry);
  return entry;
}

async function findMembershipAndPlan(agentId: string, at: string) {
  const memberships = await db.agent_commission_memberships
    .where("agentId")
    .equals(agentId)
    .and((row) => !row.isDeleted)
    .toArray();
  const membership = getEffectiveAgentCommissionMembership(memberships, agentId, at);
  if (!membership) return null;
  const plan = await db.agent_commission_plans.get(membership.planId);
  // `isActive` controls new configuration choices. Effective dates determine
  // historical eligibility so a late/offline accrual is not erased when an
  // administrator later deactivates the plan.
  if (!plan || plan.isDeleted) return null;
  if (plan.effectiveFrom > at || (plan.effectiveTo && at >= plan.effectiveTo)) return null;
  return { membership, plan };
}

type ProductCommissionTarget = {
  orderItemId: string;
  productId: string;
  productNameSnapshot: string;
  productSkuSnapshot: string | null;
  unitSnapshot: string | null;
  ruleId: string;
  commissionType: CommissionPlanType;
  ratePercent: number;
  fixedSourceAmount: number | null;
  fixedSourceCurrency: CurrencyCode | null;
  fixedConversionRate: number | null;
  fixedExchangeRateSource: string | null;
  fixedExchangeRateTimestamp: string | null;
  fixedExchangeRates: ExchangeRateSnapshot[] | null;
  quantity: number;
  basisAmountPerUnit: number;
  commissionPerUnit: number;
};

function orderCommissionEventAt(order: SalesOrder, assignedAt: string) {
  const orderEventAt = [order.actualDeliveryDate, order.paidAt]
    .filter((value): value is string => !!value)
    .sort((left, right) => right.localeCompare(left))[0];
  return [assignedAt, orderEventAt ?? order.updatedAt]
    .sort((left, right) => right.localeCompare(left))[0];
}

function productCommissionEventAt(order: SalesOrder, assignment: SalesOrderAgentAssignment) {
  return orderCommissionEventAt(order, assignment.assignedAt);
}

function emptyCommissionCalculation(currency: CurrencyCode): CommissionCalculation {
  return {
    currency,
    revenueAmount: 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    basisAmount: 0,
    ratePercent: 0,
    commissionAmount: 0,
  };
}

/**
 * Local Mode counterpart of the server-side creator attribution helper.
 * Creator-derived assignments intentionally carry product commission only;
 * a normal manual or sales-account assignment for the same agent takes
 * precedence and keeps its ordinary plan behavior.
 */
async function ensureLocalOrderCreatorProductCommissionAssignmentInternal(order: SalesOrder) {
  if (
    !order.createdBy
    || order.status !== "completed"
    || (!order.isPaid && order.paymentStatus !== "paid")
    || order.returnStatus === "full"
    || order.isDeleted
  ) {
    return null;
  }

  const creatorAgent = await db.agents
    .where("workspaceId")
    .equals(order.workspaceId)
    .and((agent) => (
      !agent.isDeleted
      && agent.status === "active"
      && agent.agentType === "field_agent"
      && agent.linkedUserId === order.createdBy
    ))
    .first();
  if (!creatorAgent) return null;

  const history = await db.sales_order_agent_assignments
    .where("[workspaceId+orderId]")
    .equals([order.workspaceId, order.id])
    .and((assignment) => !assignment.isDeleted)
    .toArray();
  const active = getActiveSalesOrderAgentAssignments(history, order.id)
    .find((assignment) => assignment.agentId === creatorAgent.id);
  if (active) return active;

  const occurredAt = orderCommissionEventAt(order, order.updatedAt);
  const productIds = [...new Set((order.items || [])
    .filter((item) => (
      getOrderLinePaidQuantity(item)
      - Math.min(getOrderLineInventoryQuantity(item), Math.max(0, Number(item.returnedQuantity ?? 0)))
    ) > 0)
    .map((item) => item.productId)
    .filter(Boolean))];
  if (productIds.length === 0) return null;

  const [rules, recipients] = await Promise.all([
    db.product_commission_rules
      .where("workspaceId")
      .equals(order.workspaceId)
      .and((rule) => !rule.isDeleted && rule.isActive && productIds.includes(rule.productId))
      .toArray(),
    db.product_commission_rule_agents
      .where("workspaceId")
      .equals(order.workspaceId)
      .and((recipient) => !recipient.isDeleted && recipient.agentId === creatorAgent.id)
      .toArray(),
  ]);
  const recipientRuleIds = new Set(recipients.map((recipient) => recipient.ruleId));
  const eligible = productIds.some((productId) => {
    const rule = activeProductCommissionRule(rules, productId, occurredAt);
    return Boolean(rule && (
      rule.recipientScope === "all_assigned" || recipientRuleIds.has(rule.id)
    ));
  });
  if (!eligible) return null;

  const previous = history
    .filter((assignment) => assignment.agentId === creatorAgent.id)
    .sort((left, right) => right.assignedAt.localeCompare(left.assignedAt))[0] ?? null;
  const assignedAt = previous?.unassignedAt && previous.unassignedAt > occurredAt
    ? previous.unassignedAt
    : occurredAt;
  const now = new Date().toISOString();
  const assignment: SalesOrderAgentAssignment = {
    id: generateId(),
    workspaceId: order.workspaceId,
    orderId: order.id,
    agentId: creatorAgent.id,
    assignmentSource: ORDER_CREATOR_PRODUCT_ASSIGNMENT_SOURCE,
    assignedAt,
    unassignedAt: null,
    assignedBy: order.createdBy,
    unassignedBy: null,
    reassignmentReason: "Automatically attributed from the staff user who created the sale",
    previousAssignmentId: previous?.id ?? null,
    customerCitySnapshot: null,
    deliveryChargeAmount: 0,
    internalDeliveryCostAmount: 0,
    manualCommissionType: null,
    manualCommissionSourceAmount: null,
    manualCommissionSourceCurrency: null,
    manualCommissionConvertedAmount: null,
    manualCommissionExchangeRate: null,
    manualCommissionExchangeRateSource: null,
    manualCommissionExchangeRateTimestamp: null,
    manualCommissionExchangeRates: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(order.workspaceId, now),
  };
  await db.sales_order_agent_assignments.put(assignment);
  return assignment;
}

async function ensureLocalOrderCreatorProductCommissionAssignment(order: SalesOrder) {
  return db.transaction(
    "rw",
    [
      db.agents,
      db.sales_order_agent_assignments,
      db.product_commission_rules,
      db.product_commission_rule_agents,
    ],
    () => ensureLocalOrderCreatorProductCommissionAssignmentInternal(order),
  );
}

async function getProductCommissionTargets(
  order: SalesOrder,
  assignment: SalesOrderAgentAssignment,
  occurredAt: string,
) {
  if (order.status === 'cancelled' || order.returnStatus === 'full' || order.isDeleted || assignment.unassignedAt) {
    return [] as ProductCommissionTarget[];
  }
  const productIds = [...new Set((order.items || []).map((item) => item.productId).filter(Boolean))];
  if (productIds.length === 0) return [] as ProductCommissionTarget[];
  const [rules, recipients] = await Promise.all([
    db.product_commission_rules.where('workspaceId').equals(order.workspaceId)
      .and((rule) => !rule.isDeleted && rule.isActive && productIds.includes(rule.productId))
      .toArray(),
    db.product_commission_rule_agents.where('workspaceId').equals(order.workspaceId)
      .and((row) => !row.isDeleted)
      .toArray(),
  ]);
  const recipientIdsByRule = new Map<string, Set<string>>();
  for (const recipient of recipients) {
    const values = recipientIdsByRule.get(recipient.ruleId) ?? new Set<string>();
    values.add(recipient.agentId);
    recipientIdsByRule.set(recipient.ruleId, values);
  }

  const orderedItems = (order.items || []).map((item) => {
    const returnedQuantity = Math.min(getOrderLineInventoryQuantity(item), Math.max(0, Number(item.returnedQuantity ?? 0)));
    const quantity = Math.max(0, getOrderLinePaidQuantity(item) - returnedQuantity);
    const grossAmount = quantity * Math.max(0, Number(item.convertedUnitPrice || 0));
    return { item, quantity, grossAmount };
  });
  const grossTotal = orderedItems.reduce((sum, item) => sum + item.grossAmount, 0);
  const adjustmentNet = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
    .reduce((sum, adjustment) => sum + (adjustment.type === 'addition' ? 1 : -1) * Math.max(0, Number(adjustment.convertedAmount || 0)), 0);

  const targets: ProductCommissionTarget[] = [];
  for (const line of orderedItems) {
    if (line.quantity <= 0) continue;
    const rule = activeProductCommissionRule(rules, line.item.productId, occurredAt);
    if (!rule) continue;
    if (rule.recipientScope === 'selected_assigned' && !recipientIdsByRule.get(rule.id)?.has(assignment.agentId)) continue;
    const allocation = grossTotal > 0 ? line.grossAmount / grossTotal : 0;
    const basisAmountPerUnit = roundCommissionAmount(Math.max(0,
      (line.grossAmount - Math.max(0, Number(order.discount || 0)) * allocation + adjustmentNet * allocation) / line.quantity,
    ));
    const commissionType = resolveCommissionPlanType(rule.commissionType);
    let commissionPerUnit: number;
    let fixedConversionRate: number | null = null;
    let fixedExchangeRateSource: string | null = null;
    let fixedExchangeRateTimestamp: string | null = null;
    let fixedExchangeRates: ExchangeRateSnapshot[] | null = null;
    if (commissionType === 'percentage') {
      commissionPerUnit = roundCommissionAmount(basisAmountPerUnit * assertRate(rule.ratePercent) / 100);
    } else {
      const conversion = getAppliedCurrencyConversion(
        assertMoney(rule.fixedAmount ?? 0, 'Product fixed commission'),
        assertCommissionCurrency(rule.fixedCurrency),
        order.currency,
        order.exchangeRates,
      );
      if (!conversion) throw new Error('Exchange rate unavailable for the product commission currency');
      commissionPerUnit = roundCommissionAmount(conversion.convertedAmount);
      fixedConversionRate = conversion.exchangeRate;
      fixedExchangeRateSource = conversion.exchangeRateSource;
      fixedExchangeRateTimestamp = conversion.exchangeRateTimestamp;
      fixedExchangeRates = conversion.exchangeRates;
    }
    targets.push({
      orderItemId: line.item.id,
      productId: line.item.productId,
      productNameSnapshot: line.item.productName,
      productSkuSnapshot: line.item.productSku || null,
      unitSnapshot: line.item.unit || null,
      ruleId: rule.id,
      commissionType,
      ratePercent: commissionType === 'percentage' ? assertRate(rule.ratePercent) : 0,
      fixedSourceAmount: commissionType === 'fixed_amount' ? Number(rule.fixedAmount || 0) : null,
      fixedSourceCurrency: commissionType === 'fixed_amount' ? rule.fixedCurrency || null : null,
      fixedConversionRate,
      fixedExchangeRateSource,
      fixedExchangeRateTimestamp,
      fixedExchangeRates,
      quantity: line.quantity,
      basisAmountPerUnit,
      commissionPerUnit,
    });
  }
  return targets;
}

async function reconcileProductCommissionLines(
  order: SalesOrder,
  assignment: SalesOrderAgentAssignment,
  occurredAt: string,
  createdBy?: string | null,
  orderReturnId?: string | null,
  eligible = true,
) {
  const [targets, existing] = await Promise.all([
    eligible ? getProductCommissionTargets(order, assignment, occurredAt) : Promise.resolve([] as ProductCommissionTarget[]),
    db.agent_product_commission_entries.where('assignmentId').equals(assignment.id)
      .and((entry) => !entry.isDeleted && entry.orderId === order.id)
      .toArray(),
  ]);
  const targetsByItemId = new Map(targets.map((target) => [target.orderItemId, target]));
  const sourceEntries = existing.filter((entry) => entry.kind === 'accrual');
  const sourceByItemId = new Map(sourceEntries.map((entry) => [entry.orderItemId, entry]));

  for (const target of targets) {
    const source = sourceByItemId.get(target.orderItemId);
    if (!source) {
      await appendAgentProductCommissionEntry(order.workspaceId, {
        orderId: order.id, assignmentId: assignment.id, agentId: assignment.agentId,
        orderItemId: target.orderItemId, productId: target.productId,
        productNameSnapshot: target.productNameSnapshot, productSkuSnapshot: target.productSkuSnapshot,
        unitSnapshot: target.unitSnapshot, ruleId: target.ruleId, orderReturnId: null, relatedEntryId: null,
        kind: 'accrual', status: 'earned', currency: order.currency,
        commissionType: target.commissionType, ratePercent: target.ratePercent,
        fixedSourceAmount: target.fixedSourceAmount, fixedSourceCurrency: target.fixedSourceCurrency,
        fixedConversionRate: target.fixedConversionRate, fixedExchangeRateSource: target.fixedExchangeRateSource,
        fixedExchangeRateTimestamp: target.fixedExchangeRateTimestamp, fixedExchangeRates: target.fixedExchangeRates,
        quantity: target.quantity, basisAmountPerUnit: target.basisAmountPerUnit,
        commissionPerUnit: target.commissionPerUnit,
        amount: roundCommissionAmount(target.quantity * target.commissionPerUnit),
        occurredAt, notes: `Product commission accrued for ${order.orderNumber}`, createdBy: createdBy ?? null,
      });
      continue;
    }
    const recognizedQuantity = existing.filter((entry) => entry.orderItemId === target.orderItemId)
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const quantityDelta = roundCommissionAmount(target.quantity - recognizedQuantity);
    if (Math.abs(quantityDelta) <= 0.000001) continue;
    await appendAgentProductCommissionEntry(order.workspaceId, {
      orderId: order.id, assignmentId: assignment.id, agentId: assignment.agentId,
      orderItemId: source.orderItemId, productId: source.productId,
      productNameSnapshot: source.productNameSnapshot, productSkuSnapshot: source.productSkuSnapshot || null,
      unitSnapshot: source.unitSnapshot || null, ruleId: source.ruleId || null,
      orderReturnId: quantityDelta < 0 ? orderReturnId ?? null : null, relatedEntryId: source.id,
      kind: quantityDelta < 0 ? 'reversal' : 'adjustment', status: quantityDelta < 0 ? 'reversed' : 'earned',
      currency: source.currency, commissionType: source.commissionType, ratePercent: source.ratePercent,
      fixedSourceAmount: source.fixedSourceAmount ?? null, fixedSourceCurrency: source.fixedSourceCurrency ?? null,
      fixedConversionRate: source.fixedConversionRate ?? null, fixedExchangeRateSource: source.fixedExchangeRateSource ?? null,
      fixedExchangeRateTimestamp: source.fixedExchangeRateTimestamp ?? null, fixedExchangeRates: source.fixedExchangeRates ?? null,
      quantity: quantityDelta, basisAmountPerUnit: source.basisAmountPerUnit,
      commissionPerUnit: source.commissionPerUnit,
      amount: roundCommissionAmount(quantityDelta * source.commissionPerUnit), occurredAt: order.updatedAt,
      notes: quantityDelta < 0 ? `Product commission reversed for ${order.orderNumber}` : `Product commission adjusted for ${order.orderNumber}`,
      createdBy: createdBy ?? null,
    });
  }

  for (const source of sourceEntries) {
    if (targetsByItemId.has(source.orderItemId)) continue;
    const recognizedQuantity = existing.filter((entry) => entry.orderItemId === source.orderItemId)
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    if (recognizedQuantity <= 0.000001) continue;
    await appendAgentProductCommissionEntry(order.workspaceId, {
      orderId: order.id, assignmentId: assignment.id, agentId: assignment.agentId,
      orderItemId: source.orderItemId, productId: source.productId,
      productNameSnapshot: source.productNameSnapshot, productSkuSnapshot: source.productSkuSnapshot || null,
      unitSnapshot: source.unitSnapshot || null, ruleId: source.ruleId || null,
      orderReturnId: orderReturnId ?? null, relatedEntryId: source.id,
      kind: 'reversal', status: 'reversed', currency: source.currency,
      commissionType: source.commissionType, ratePercent: source.ratePercent,
      fixedSourceAmount: source.fixedSourceAmount ?? null, fixedSourceCurrency: source.fixedSourceCurrency ?? null,
      fixedConversionRate: source.fixedConversionRate ?? null, fixedExchangeRateSource: source.fixedExchangeRateSource ?? null,
      fixedExchangeRateTimestamp: source.fixedExchangeRateTimestamp ?? null, fixedExchangeRates: source.fixedExchangeRates ?? null,
      quantity: -recognizedQuantity, basisAmountPerUnit: source.basisAmountPerUnit,
      commissionPerUnit: source.commissionPerUnit,
      amount: roundCommissionAmount(-recognizedQuantity * source.commissionPerUnit), occurredAt: order.updatedAt,
      notes: `Product commission reversed for ${order.orderNumber}`, createdBy: createdBy ?? null,
    });
  }

  const updated = await db.agent_product_commission_entries.where('assignmentId').equals(assignment.id)
    .and((entry) => !entry.isDeleted && entry.orderId === order.id)
    .toArray();
  return {
    productIds: new Set(targets.map((target) => target.productId)),
    basisAmount: roundCommissionAmount(updated.reduce((sum, entry) => (
      sum + Number(entry.quantity || 0) * Number(entry.basisAmountPerUnit || 0)
    ), 0)),
    amount: roundCommissionAmount(updated.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)),
  };
}

export async function accrueSalesOrderCommission(
  workspaceId: string,
  orderId: string,
  createdBy?: string | null,
) {
  const order = await db.sales_orders.get(orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
    throw new Error("Sales order not found");
  }
  if (shouldUseCloudData(workspaceId)) {
    const reconciled = await requestServerCommissionReconciliation(workspaceId, orderId);
    if (reconciled) {
      await Promise.all([
        hydrateTable(ASSIGNMENT_TABLE, workspaceId),
        hydrateTable(ENTRY_TABLE, workspaceId),
        fetchTableFromSupabase(
          "agent_product_commission_entries",
          db.agent_product_commission_entries,
          workspaceId,
        ),
        fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
      ]);
    }
    return null;
  }
  if (!isCommissionEligibleOrder(order)) return null;

  await ensureLocalOrderCreatorProductCommissionAssignment(order);

  const assignments = await db.sales_order_agent_assignments
    .where("[workspaceId+orderId]")
    .equals([workspaceId, orderId])
    .and((row) => !row.isDeleted)
    .toArray();
  const activeAssignments = getActiveSalesOrderAgentAssignments(assignments, orderId);
  const entries: AgentCommissionEntry[] = [];
  for (const assignment of activeAssignments) {
    const entry = await accrueSalesOrderAssignmentCommission(order, assignment, createdBy);
    if (entry) entries.push(entry);
  }
  return entries[0] ?? null;
}

/**
 * Commission is earned when the sale is saved and remains an open payable until
 * somebody records a commission payment.  Customer collection is deliberately
 * not part of this eligibility rule.
 */
function isCommissionEligibleOrder(order: SalesOrder) {
  return !order.isDeleted && order.status !== 'cancelled' && order.returnStatus !== 'full';
}

async function accrueSalesOrderAssignmentCommission(
  order: SalesOrder,
  assignment: SalesOrderAgentAssignment,
  createdBy?: string | null,
) {
  const existing = await db.agent_commission_entries
    .where("assignmentId")
    .equals(assignment.id)
    .and((row) => !row.isDeleted && row.kind === "accrual")
    .first();
  if (existing) return existing;

  // A completed order may be attributed after delivery. In that case the
  // assignment time, not the earlier delivery time, selects its snapshot.
  const occurredAt = productCommissionEventAt(order, assignment);
  const productCommission = await reconcileProductCommissionLines(order, assignment, occurredAt, createdBy);
  const manualCommission = getAssignmentManualSalesAgentCommission(assignment);
  const isCreatorProductOnly = assignment.assignmentSource === ORDER_CREATOR_PRODUCT_ASSIGNMENT_SOURCE;
  const terms = manualCommission || isCreatorProductOnly
    ? null
    : await findMembershipAndPlan(assignment.agentId, occurredAt);
  if (!terms && !manualCommission && productCommission.amount <= 0) return null;
  const calculation = isCreatorProductOnly
    ? emptyCommissionCalculation(order.currency)
    : manualCommission
    ? calculateManualSalesOrderCommission(order, assignment, productCommission.basisAmount)
    : terms
      ? calculateSalesOrderCommission(order, terms.plan, assignment, productCommission.productIds)
      : {
        currency: order.currency, revenueAmount: 0, costAmount: 0, taxAmount: 0,
        deliveryChargeAmount: 0, basisAmount: 0, ratePercent: 0, commissionAmount: 0,
      };
  if (!calculation) return null;

  return appendEntry(order.workspaceId, {
    orderId: order.id,
    assignmentId: assignment.id,
    agentId: assignment.agentId,
    membershipId: terms?.membership.id ?? null,
    planId: terms?.plan.id ?? null,
    orderReturnId: null,
    relatedEntryId: null,
    kind: "accrual",
    status: "earned",
    currency: calculation.currency,
    calculationBasis: manualCommission ? "net_revenue" : terms?.plan.calculationBasis ?? "net_revenue",
    includeTax: manualCommission ? false : terms?.plan.includeTax ?? false,
    includeDeliveryCharge: manualCommission ? false : terms?.plan.includeDeliveryCharge ?? false,
    basisAmount: calculation.basisAmount,
    revenueAmount: calculation.revenueAmount,
    costAmount: calculation.costAmount,
    taxAmount: calculation.taxAmount,
    deliveryChargeAmount: calculation.deliveryChargeAmount,
    ratePercent: calculation.ratePercent,
    planCommissionAmount: calculation.commissionAmount,
    productCommissionAmount: productCommission.amount,
    amount: roundCommissionAmount(calculation.commissionAmount + productCommission.amount),
    occurredAt,
    payoutReference: null,
    notes: manualCommission
      ? `Manual ${manualCommission.type === "percentage" ? "percentage" : "fixed"} commission accrued for sales order ${order.orderNumber}`
      : productCommission.amount > 0 && !terms
        ? `Product commission accrued for sales order ${order.orderNumber}`
        : `Commission accrued for sales order ${order.orderNumber}`,
    createdBy: createdBy ?? null,
  });
}

function isOrderTargetCommissionEntry(entry: AgentCommissionEntry) {
  return entry.kind === "accrual"
    || entry.kind === "reversal"
    || (entry.kind === "adjustment" && Boolean(entry.relatedEntryId));
}

async function reverseRecognizedAssignmentCommission(
  assignment: SalesOrderAgentAssignment,
  order: SalesOrder,
  relatedEntry: AgentCommissionEntry,
  amount: number,
  options: { orderReturnId?: string | null; occurredAt: string; reason: string; createdBy?: string | null },
) {
  if (amount >= 0) return null;
  return appendEntry(order.workspaceId, {
    orderId: order.id,
    assignmentId: assignment.id,
    agentId: assignment.agentId,
    membershipId: relatedEntry.membershipId ?? null,
    planId: relatedEntry.planId ?? null,
    orderReturnId: options.orderReturnId ?? null,
    relatedEntryId: relatedEntry.id,
    kind: "reversal",
    status: "reversed",
    currency: relatedEntry.currency,
    calculationBasis: relatedEntry.calculationBasis,
    includeTax: relatedEntry.includeTax,
    includeDeliveryCharge: relatedEntry.includeDeliveryCharge,
    basisAmount: relatedEntry.basisAmount,
    revenueAmount: relatedEntry.revenueAmount,
    costAmount: relatedEntry.costAmount,
    taxAmount: relatedEntry.taxAmount,
    deliveryChargeAmount: relatedEntry.deliveryChargeAmount,
    ratePercent: relatedEntry.ratePercent,
    amount: roundCommissionAmount(amount),
    occurredAt: options.occurredAt,
    payoutReference: null,
    notes: options.reason,
    createdBy: options.createdBy ?? null,
  });
}

/**
 * Keeps the append-only ledger aligned with the current order and return
 * state. Customer-payment state never settles or suspends agent commission.
 */
export async function reconcileSalesOrderCommission(
  workspaceId: string,
  orderId: string,
  createdBy?: string | null,
) {
  const order = await db.sales_orders.get(orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
    throw new Error("Sales order not found");
  }
  if (shouldUseCloudData(workspaceId)) {
    const reconciled = await requestServerCommissionReconciliation(workspaceId, orderId);
    if (reconciled) {
      await Promise.all([
        hydrateTable(ASSIGNMENT_TABLE, workspaceId),
        hydrateTable(ENTRY_TABLE, workspaceId),
        fetchTableFromSupabase(
          "agent_product_commission_entries",
          db.agent_product_commission_entries,
          workspaceId,
        ),
        fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
      ]);
    }
    return null;
  }
  await ensureLocalOrderCreatorProductCommissionAssignment(order);
  const assignments = await db.sales_order_agent_assignments
    .where("[workspaceId+orderId]")
    .equals([workspaceId, orderId])
    .and((assignment) => !assignment.isDeleted)
    .toArray();
  const entries: AgentCommissionEntry[] = [];
  for (const assignment of assignments) {
    const entry = await reconcileSalesOrderAssignmentCommission(order, assignment, createdBy);
    if (entry) entries.push(entry);
  }
  return entries[0] ?? null;
}

async function reconcileSalesOrderAssignmentCommission(
  order: SalesOrder,
  assignment: SalesOrderAgentAssignment,
  createdBy?: string | null,
) {

  const entries = await db.agent_commission_entries
    .where("assignmentId")
    .equals(assignment.id)
    .and((entry) => !entry.isDeleted)
    .toArray();
  const accrual = entries.find((entry) => entry.kind === "accrual");
  const isEligible = isCommissionEligibleOrder(order);
  if (!accrual) {
    return isEligible && !assignment.unassignedAt
      ? accrueSalesOrderAssignmentCommission(order, assignment, createdBy)
      : null;
  }

  const accrualPlan = accrual.planId
    ? await db.agent_commission_plans.get(accrual.planId)
    : null;
  const productCommission = await reconcileProductCommissionLines(
    order,
    assignment,
    productCommissionEventAt(order, assignment),
    createdBy,
    null,
    isEligible && !assignment.unassignedAt,
  );
  const calculation = isEligible && !assignment.unassignedAt
    ? assignment.assignmentSource === ORDER_CREATOR_PRODUCT_ASSIGNMENT_SOURCE
      ? emptyCommissionCalculation(order.currency)
      : accrual.membershipId == null && accrual.planId == null
      ? calculateManualSalesOrderCommission(order, assignment, productCommission.basisAmount)
      : calculateSalesOrderCommission(order, accrualPlan ?? {
        ratePercent: accrual.ratePercent,
        calculationBasis: accrual.calculationBasis,
        includeTax: accrual.includeTax,
        includeDeliveryCharge: accrual.includeDeliveryCharge,
      }, assignment, productCommission.productIds)
    : { ...emptyCommissionCalculation(accrual.currency), ratePercent: accrual.ratePercent };
  if (!calculation) return null;
  const recognized = roundCommissionAmount(entries
    .filter(isOrderTargetCommissionEntry)
    .reduce((sum, entry) => sum + entry.amount, 0));
  const desiredAmount = roundCommissionAmount(calculation.commissionAmount + productCommission.amount);
  const delta = roundCommissionAmount(desiredAmount - recognized);
  if (Math.abs(delta) <= 0.000001) return null;

  return appendEntry(order.workspaceId, {
    orderId: order.id,
    assignmentId: assignment.id,
    agentId: assignment.agentId,
    membershipId: accrual.membershipId ?? null,
    planId: accrual.planId ?? null,
    orderReturnId: null,
    relatedEntryId: accrual.id,
    kind: "adjustment",
    status: delta < 0 ? "reversed" : "earned",
    currency: accrual.currency,
    calculationBasis: accrual.calculationBasis,
    includeTax: accrual.includeTax,
    includeDeliveryCharge: accrual.includeDeliveryCharge,
    basisAmount: calculation.basisAmount,
    revenueAmount: calculation.revenueAmount,
    costAmount: calculation.costAmount,
    taxAmount: calculation.taxAmount,
    deliveryChargeAmount: calculation.deliveryChargeAmount,
    ratePercent: accrual.ratePercent,
    planCommissionAmount: calculation.commissionAmount,
    productCommissionAmount: productCommission.amount,
    amount: delta,
    occurredAt: order.updatedAt,
    payoutReference: null,
    notes: delta > 0
      ? `Commission restored after sales order update ${order.orderNumber}`
      : isEligible
        ? `Commission reduced after sales order update ${order.orderNumber}`
        : `Commission reversed because sales order ${order.orderNumber} is no longer eligible`,
    createdBy: createdBy ?? null,
  });
}

/** Backfills/delta-reconciles every currently assigned completed order. */
export async function reconcileWorkspaceSalesOrderCommissions(
  workspaceId: string,
  createdBy?: string | null,
) {
  const postedReturns = await db.order_returns
    .where("workspaceId")
    .equals(workspaceId)
    .and((orderReturn) => !orderReturn.isDeleted && orderReturn.status === "posted")
    .toArray();
  for (const orderReturn of postedReturns) {
    await reverseCommissionForOrderReturn(workspaceId, orderReturn.id, createdBy);
  }
  const assignments = await db.sales_order_agent_assignments
    .where("workspaceId")
    .equals(workspaceId)
    .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
    .toArray();
  const entries: AgentCommissionEntry[] = [];
  for (const orderId of new Set(assignments.map((assignment) => assignment.orderId))) {
    const order = await db.sales_orders.get(orderId);
    if (!order || !isCommissionEligibleOrder(order)) continue;
    const entry = await reconcileSalesOrderCommission(workspaceId, orderId, createdBy);
    if (entry) entries.push(entry);
  }
  return entries;
}

export interface UnassignSalesOrderAgentInput {
  orderId: string;
  agentId: string;
  unassignedAt?: string;
  unassignedBy?: string | null;
  reason?: string | null;
}

async function reverseClosedSalesOrderAssignmentCommission(
  assignment: SalesOrderAgentAssignment,
  order: SalesOrder,
  occurredAt: string,
  reason: string | null,
  createdBy?: string | null,
) {
  if (order.status !== "completed") return;
  const entries = await db.agent_commission_entries
    .where("assignmentId")
    .equals(assignment.id)
    .and((entry) => !entry.isDeleted)
    .toArray();
  const recognized = roundCommissionAmount(entries.filter(isOrderTargetCommissionEntry)
    .reduce((sum, entry) => sum + entry.amount, 0));
  const accrual = entries.find((entry) => entry.kind === "accrual");
  if (recognized > 0 && accrual) {
    await reverseRecognizedAssignmentCommission(assignment, order, accrual, -recognized, {
      occurredAt,
      reason: reason || "Commission reversed after sales order assignment was removed",
      createdBy,
    });
  }
}

export async function unassignSalesOrderAgent(
  workspaceId: string,
  input: UnassignSalesOrderAgentInput,
) {
  const order = await db.sales_orders.get(input.orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
    throw new Error("Sales order not found");
  }
  const activeAssignments = getActiveSalesOrderAgentAssignments(
    await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, input.orderId])
      .and((row) => !row.isDeleted)
      .toArray(),
    input.orderId,
  );
  const current = activeAssignments.find((assignment) => assignment.agentId === input.agentId);
  if (!current) return null;

  const now = new Date().toISOString();
  const unassignedAt = closeTimestampAfter(current.assignedAt, normalizeTimestamp(input.unassignedAt));
  const closed: SalesOrderAgentAssignment = {
    ...current,
    unassignedAt,
    unassignedBy: input.unassignedBy ?? null,
    reassignmentReason: normalizeText(input.reason),
    updatedAt: now,
    version: current.version + 1,
    ...getSyncMetadata(workspaceId, now),
  };
  await db.sales_order_agent_assignments.put(closed);
  await syncUpsert(ASSIGNMENT_TABLE, closed);

  if (shouldUseCloudData(workspaceId)) {
    await requestServerCommissionReconciliation(workspaceId, order.id, { assignmentId: closed.id });
    return closed;
  }

  await reverseClosedSalesOrderAssignmentCommission(
    current,
    order,
    unassignedAt,
    normalizeText(input.reason),
    input.unassignedBy,
  );
  return closed;
}

export async function assignSalesOrderAgent(
  workspaceId: string,
  input: AssignSalesOrderAgentInput,
) {
  const order = await db.sales_orders.get(input.orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
    throw new Error("Sales order not found");
  }
  if (!input.agentId) {
    const activeAssignments = getActiveSalesOrderAgentAssignments(
      await db.sales_order_agent_assignments
        .where("[workspaceId+orderId]")
        .equals([workspaceId, input.orderId])
        .and((row) => !row.isDeleted)
        .toArray(),
      input.orderId,
    );
    for (const assignment of activeAssignments) {
      await unassignSalesOrderAgent(workspaceId, {
        orderId: input.orderId,
        agentId: assignment.agentId,
        unassignedAt: input.assignedAt,
        unassignedBy: input.assignedBy,
        reason: input.reason,
      });
    }
    return null;
  }
  if (order.status === "cancelled") {
    throw new Error("Cancelled sales orders cannot be assigned");
  }
  const agent = await db.agents.get(input.agentId);
  const assignmentSource = input.assignmentSource ?? "manual";
  if (
    !agent
    || agent.isDeleted
    || agent.workspaceId !== workspaceId
    || agent.agentType !== "field_agent"
  ) {
    throw new Error("Select a field agent from this workspace");
  }

  const history = await db.sales_order_agent_assignments
    .where("[workspaceId+orderId]")
    .equals([workspaceId, input.orderId])
    .and((row) => !row.isDeleted)
    .toArray();
  const current = getActiveSalesOrderAgentAssignments(history, input.orderId)
    .find((assignment) => assignment.agentId === input.agentId) ?? null;

  let citySnapshot = input.customerCitySnapshot === undefined
    ? current?.customerCitySnapshot ?? null
    : normalizeText(input.customerCitySnapshot);
  if (input.customerCitySnapshot === undefined && !current) {
    const [partner, customer] = await Promise.all([
      order.businessPartnerId ? db.business_partners.get(order.businessPartnerId) : null,
      order.customerId ? db.customers.get(order.customerId) : null,
    ]);
    citySnapshot = normalizeText(partner?.city || customer?.city || null);
  }
  const deliveryChargeAmount = input.deliveryChargeAmount === undefined
    ? current?.deliveryChargeAmount ?? 0
    : assertMoney(input.deliveryChargeAmount, "Delivery charge");
  const internalDeliveryCostAmount = input.internalDeliveryCostAmount === undefined
    ? current?.internalDeliveryCostAmount ?? 0
    : assertMoney(input.internalDeliveryCostAmount, "Internal delivery cost");
  const requestedAssignedAt = normalizeTimestamp(input.assignedAt);
  const manualCommission = input.manualCommission === undefined && current
    ? getAssignmentManualSalesAgentCommission(current)
    : input.manualCommission
      ? resolveManualSalesAgentCommission(order, input.manualCommission)
      : null;
  if (manualCommission) {
    const existingTerms = await findMembershipAndPlan(input.agentId, requestedAssignedAt);
    if (existingTerms) {
      const planType = resolveCommissionPlanType(existingTerms.plan.commissionType);
      if (planType !== "fixed_amount" || manualCommission.type !== "fixed_amount") {
        throw new Error("Order commission amount overrides are available only for fixed commission plans");
      }
      if (
        manualCommission.type === "fixed_amount"
        && manualCommission.sourceCurrency !== existingTerms.plan.fixedCurrency
      ) {
        throw new Error("Order commission overrides must use the commission plan currency");
      }
    }
  }
  const keepsCurrentSnapshots = current
    && (current.assignmentSource ?? "manual") === assignmentSource
    && current.customerCitySnapshot === citySnapshot
    && current.deliveryChargeAmount === deliveryChargeAmount
    && current.internalDeliveryCostAmount === internalDeliveryCostAmount
    && hasSameManualSalesAgentCommission(current, manualCommission);
  if (keepsCurrentSnapshots) return current;

  const now = new Date().toISOString();
  const closed = current ? {
    ...current,
    unassignedAt: closeTimestampAfter(current.assignedAt, requestedAssignedAt),
    unassignedBy: input.assignedBy ?? null,
    reassignmentReason: normalizeText(input.reason),
    updatedAt: now,
    version: current.version + 1,
    ...getSyncMetadata(workspaceId, now),
  } satisfies SalesOrderAgentAssignment : null;
  const assignedAt = closed?.unassignedAt ?? requestedAssignedAt;
  const assignment: SalesOrderAgentAssignment = {
    id: generateId(),
    workspaceId,
    orderId: input.orderId,
    agentId: input.agentId,
    assignmentSource,
    assignedAt,
    unassignedAt: null,
    assignedBy: input.assignedBy ?? null,
    unassignedBy: null,
    reassignmentReason: normalizeText(input.reason),
    previousAssignmentId: current?.id ?? null,
    customerCitySnapshot: citySnapshot,
    deliveryChargeAmount,
    internalDeliveryCostAmount,
    manualCommissionType: manualCommission?.type ?? null,
    manualCommissionSourceAmount: manualCommission?.sourceAmount ?? null,
    manualCommissionSourceCurrency: manualCommission?.sourceCurrency ?? null,
    manualCommissionConvertedAmount: manualCommission?.convertedAmount ?? null,
    manualCommissionExchangeRate: manualCommission?.exchangeRate ?? null,
    manualCommissionExchangeRateSource: manualCommission?.exchangeRateSource ?? null,
    manualCommissionExchangeRateTimestamp: manualCommission?.exchangeRateTimestamp ?? null,
    manualCommissionExchangeRates: manualCommission?.exchangeRates ?? null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now),
  };

  await db.transaction("rw", db.sales_order_agent_assignments, async () => {
    if (closed) await db.sales_order_agent_assignments.put(closed);
    await db.sales_order_agent_assignments.put(assignment);
  });
  if (closed) await syncUpsert(ASSIGNMENT_TABLE, closed);
  await syncUpsert(ASSIGNMENT_TABLE, assignment);

  if (shouldUseCloudData(workspaceId)) {
    await requestServerCommissionReconciliation(workspaceId, order.id, { assignmentId: assignment.id });
    return assignment;
  }

  if (current) {
    await reverseClosedSalesOrderAssignmentCommission(
      current,
      order,
      assignedAt,
      normalizeText(input.reason) || "Commission reversed after sales order assignment changed",
      input.assignedBy,
    );
  }
  if (isCommissionEligibleOrder(order)) {
    await accrueSalesOrderCommission(workspaceId, order.id, input.assignedBy);
  }
  return assignment;
}

export async function replaceSalesOrderAgentAssignments(
  workspaceId: string,
  input: ReplaceSalesOrderAgentAssignmentsInput,
) {
  return withSalesOrderAssignmentLock(
    workspaceId,
    input.orderId,
    () => replaceSalesOrderAgentAssignmentsInternal(workspaceId, input),
  );
}

async function replaceSalesOrderAgentAssignmentsInternal(
  workspaceId: string,
  input: ReplaceSalesOrderAgentAssignmentsInput,
) {
  const requestedAgentIds = new Set<string>();
  for (const assignment of input.assignments) {
    if (requestedAgentIds.has(assignment.agentId)) {
      throw new Error("A sales agent can only be added once to an order");
    }
    requestedAgentIds.add(assignment.agentId);
  }

  const manualAssignments = input.assignments
    .filter((assignment) => (assignment.assignmentSource ?? "manual") === "manual");
  const salesAccountAssignments = input.assignments
    .filter((assignment) => assignment.assignmentSource === "sales_account");
  const requestedManualAgentIds = new Set(manualAssignments.map((assignment) => assignment.agentId));

  const allActiveAssignments = getActiveSalesOrderAgentAssignments(
    await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, input.orderId])
      .and((row) => !row.isDeleted)
      .toArray(),
    input.orderId,
  );
  const activeManualAssignments = allActiveAssignments
    .filter((assignment) => (assignment.assignmentSource ?? "manual") === "manual");
  for (const assignment of activeManualAssignments) {
    if (requestedManualAgentIds.has(assignment.agentId)) continue;
    await unassignSalesOrderAgent(workspaceId, {
      orderId: input.orderId,
      agentId: assignment.agentId,
      unassignedBy: input.assignedBy,
      reason: input.reason,
    });
  }
  for (const assignment of manualAssignments) {
    await assignSalesOrderAgent(workspaceId, {
      ...assignment,
      orderId: input.orderId,
      assignedBy: input.assignedBy,
      reason: assignment.reason ?? input.reason,
    });
  }

  // The lifecycle owns the identity of a sales-account beneficiary. The form
  // may update its manual per-order commission, but a stale form submission
  // must never recreate a beneficiary for an account that was just changed.
  for (const assignment of salesAccountAssignments) {
    const currentAutomatic = allActiveAssignments.find((current) => (
      current.assignmentSource === "sales_account"
      && current.agentId === assignment.agentId
    ));
    if (!currentAutomatic) continue;
    await assignSalesOrderAgent(workspaceId, {
      ...assignment,
      orderId: input.orderId,
      assignedBy: input.assignedBy,
      reason: assignment.reason ?? input.reason,
    });
  }

  // Manual assignment edits can remove the only beneficiary for the selected
  // sales account. Recreate the automatic beneficiary only after those edits
  // have settled, keeping the two assignment sources independent.
  await synchronizeSalesAccountAgentCommissionAssignmentInternal(
    workspaceId,
    input.orderId,
    input.assignedBy,
  );

  return getActiveSalesOrderAgentAssignments(
    await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, input.orderId])
      .and((row) => !row.isDeleted)
      .toArray(),
    input.orderId,
  );
}

/**
 * Keeps the commission beneficiary derived from an order's selected sales
 * account in sync. It is intentionally distinct from manual beneficiaries so
 * removing a sales account never removes an agent the user assigned manually.
 */
export async function synchronizeSalesAccountAgentCommissionAssignment(
  workspaceId: string,
  orderId: string,
  createdBy?: string | null,
) {
  return withSalesOrderAssignmentLock(
    workspaceId,
    orderId,
    () => synchronizeSalesAccountAgentCommissionAssignmentInternal(workspaceId, orderId, createdBy),
  );
}

async function synchronizeSalesAccountAgentCommissionAssignmentInternal(
  workspaceId: string,
  orderId: string,
  createdBy?: string | null,
) {
  if (!hasCachedAgentSalesAccountsFeature(workspaceId)) return null;
  const order = await db.sales_orders.get(orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) return null;

  const activeAssignments = getActiveSalesOrderAgentAssignments(
    await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, orderId])
      .and((row) => !row.isDeleted)
      .toArray(),
    orderId,
  );
  const salesAccountAssignments = activeAssignments
    .filter((assignment) => assignment.assignmentSource === "sales_account");
  const salesAccountAgentId = order.salesAccountAgentId ?? null;

  for (const assignment of salesAccountAssignments) {
    if (order.commissionEnabled !== false && assignment.agentId === salesAccountAgentId) continue;
    await unassignSalesOrderAgent(workspaceId, {
      orderId,
      agentId: assignment.agentId,
      unassignedBy: createdBy ?? null,
      reason: order.commissionEnabled === false
        ? "Commission attribution was disabled for the order"
        : "Sales account changed on the order",
    });
  }

  if (!salesAccountAgentId || order.commissionEnabled === false) return null;
  const salesAccountAgent = await db.agents.get(salesAccountAgentId);
  if (
    !salesAccountAgent
    || salesAccountAgent.isDeleted
    || salesAccountAgent.workspaceId !== workspaceId
    || salesAccountAgent.agentType !== "field_agent"
    || !salesAccountAgent.salesAccountEnabled
  ) {
    return null;
  }
  if (activeAssignments.some((assignment) => assignment.agentId === salesAccountAgentId)) {
    return activeAssignments.find((assignment) => assignment.agentId === salesAccountAgentId) ?? null;
  }

  return assignSalesOrderAgent(workspaceId, {
    orderId,
    agentId: salesAccountAgentId,
    assignmentSource: "sales_account",
    assignedBy: createdBy ?? null,
    reason: "Automatically assigned from the order sales account",
  });
}

/** Backfills missing automatic beneficiaries for sales-account orders. */
export async function synchronizeWorkspaceSalesAccountCommissionAssignments(
  workspaceId: string,
  createdBy?: string | null,
) {
  const orders = await db.sales_orders
    .where("workspaceId")
    .equals(workspaceId)
    .and((order) => !order.isDeleted && Boolean(order.salesAccountAgentId))
    .toArray();
  const assignments: SalesOrderAgentAssignment[] = [];
  for (const order of orders) {
    const assignment = await synchronizeSalesAccountAgentCommissionAssignment(
      workspaceId,
      order.id,
      createdBy,
    );
    if (assignment?.assignmentSource === "sales_account") assignments.push(assignment);
  }
  return assignments;
}

export async function reverseCommissionForOrderReturn(
  workspaceId: string,
  orderReturnId: string,
  createdBy?: string | null,
) {
  const orderReturn = await db.order_returns.get(orderReturnId);
  if (!orderReturn || orderReturn.isDeleted || orderReturn.workspaceId !== workspaceId || orderReturn.status !== "posted") {
    return [];
  }
  const order = await db.sales_orders.get(orderReturn.orderId);
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) return [];
  if (shouldUseCloudData(workspaceId)) {
    await requestServerCommissionReconciliation(workspaceId, order.id, {
      orderReturnId,
    });
    return [];
  }

  const existingReturnReversals = await db.agent_commission_entries
    .where("orderReturnId")
    .equals(orderReturnId)
    .and((entry) => !entry.isDeleted && entry.kind === "reversal")
    .toArray();
  const reversedAssignmentIds = new Set(existingReturnReversals
    .map((entry) => entry.assignmentId)
    .filter((assignmentId): assignmentId is string => !!assignmentId));

  const orderEntries = await db.agent_commission_entries
    .where("[workspaceId+orderId]")
    .equals([workspaceId, order.id])
    .and((entry) => !entry.isDeleted)
    .toArray();
  const assignments = await db.sales_order_agent_assignments
    .where("[workspaceId+orderId]")
    .equals([workspaceId, order.id])
    .and((row) => !row.isDeleted)
    .toArray();
  const reversals: AgentCommissionEntry[] = [];

  for (const accrual of orderEntries.filter((entry) => entry.kind === "accrual")) {
    if (accrual.assignmentId && reversedAssignmentIds.has(accrual.assignmentId)) continue;
    const assignment = assignments.find((row) => row.id === accrual.assignmentId);
    if (!assignment) continue;
    const recognized = roundCommissionAmount(orderEntries
      .filter((entry) => entry.assignmentId === assignment.id && isOrderTargetCommissionEntry(entry))
      .reduce((sum, entry) => sum + entry.amount, 0));
    if (recognized <= 0) continue;

    const currentAssignment = !assignment.unassignedAt;
    const snapshotPlan = accrual.planId
      ? await db.agent_commission_plans.get(accrual.planId)
      : null;
    const fallbackPlan = {
      ratePercent: accrual.ratePercent,
      calculationBasis: accrual.calculationBasis,
      includeTax: accrual.includeTax,
      includeDeliveryCharge: accrual.includeDeliveryCharge,
    };
    const productCommission = await reconcileProductCommissionLines(
      order,
      assignment,
      productCommissionEventAt(order, assignment),
      createdBy ?? orderReturn.returnedBy ?? null,
      orderReturnId,
      currentAssignment && isCommissionEligibleOrder(order),
    );
    const targetCalculation = currentAssignment
      ? accrual.membershipId == null && accrual.planId == null
        ? calculateManualSalesOrderCommission(order, assignment, productCommission.basisAmount)
        : calculateSalesOrderCommission(order, snapshotPlan ?? fallbackPlan, assignment, productCommission.productIds)
      : null;
    const target = roundCommissionAmount((targetCalculation?.commissionAmount ?? 0) + productCommission.amount);
    const difference = roundCommissionAmount(target - recognized);
    if (difference >= 0) continue;
    const reversal = await reverseRecognizedAssignmentCommission(assignment, order, accrual, difference, {
      orderReturnId,
      occurredAt: orderReturn.returnedAt,
      reason: `Commission reversed for order return: ${orderReturn.reason}`,
      createdBy: createdBy ?? orderReturn.returnedBy ?? null,
    });
    if (reversal) reversals.push(reversal);
  }
  return [...existingReturnReversals, ...reversals];
}

export async function recordCommissionApproval(
  workspaceId: string,
  input: RecordCommissionApprovalInput,
) {
  const source = await db.agent_commission_entries.get(input.entryId);
  if (!source || source.isDeleted || source.workspaceId !== workspaceId
    || !["accrual", "adjustment"].includes(source.kind)) {
    throw new Error("Earned commission entry not found");
  }
  const existing = await db.agent_commission_entries
    .where("relatedEntryId")
    .equals(source.id)
    .and((entry) => !entry.isDeleted && entry.kind === "approval")
    .first();
  if (existing) return existing;

  return appendEntry(workspaceId, {
    orderId: source.orderId ?? null,
    assignmentId: source.assignmentId ?? null,
    agentId: source.agentId,
    membershipId: source.membershipId ?? null,
    planId: source.planId ?? null,
    orderReturnId: null,
    relatedEntryId: source.id,
    kind: "approval",
    status: "approved",
    currency: source.currency,
    calculationBasis: source.calculationBasis,
    includeTax: source.includeTax,
    includeDeliveryCharge: source.includeDeliveryCharge,
    basisAmount: source.basisAmount,
    revenueAmount: source.revenueAmount,
    costAmount: source.costAmount,
    taxAmount: source.taxAmount,
    deliveryChargeAmount: source.deliveryChargeAmount,
    ratePercent: source.ratePercent,
    amount: 0,
    occurredAt: normalizeTimestamp(input.occurredAt),
    payoutReference: null,
    notes: normalizeText(input.notes),
    createdBy: input.approvedBy ?? null,
  });
}

const COMMISSION_PAYOUT_SOURCE_TYPE = "agent_commission_payout";
const COMMISSION_RECOVERY_SOURCE_TYPE = "agent_commission_recovery";

async function resolveAgentCounterpartyName(agentId: string) {
  const agent = await db.agents.get(agentId);
  if (!agent) return null;
  const partner = await db.business_partners.get(agent.businessPartnerId);
  return partner && !partner.isDeleted ? partner.partnerName : null;
}

/**
 * Commission payouts are real cash movements: every payout entry is mirrored
 * by an outgoing `payment_transaction` so the ledger, payments page, and safe
 * reports stay consistent. Safe to call repeatedly — an existing transaction
 * linked to the payout entry is reused instead of duplicated.
 */
async function ensureCommissionPayoutTransaction(
  workspaceId: string,
  entry: Pick<AgentCommissionEntry, "id" | "orderId" | "agentId" | "amount" | "currency" | "occurredAt" | "payoutReference" | "settlementSource">,
  options: {
    counterpartyName: string | null;
    businessPartnerId?: string | null;
    paymentMethod: WorkspacePaymentMethod;
    notes: string | null;
    createdBy: string | null;
    accountId: string | null;
    accountNameSnapshot: string | null;
  },
) {
  const existing = await db.payment_transactions
    .where("[workspaceId+sourceType+sourceRecordId]")
    .equals([workspaceId, COMMISSION_PAYOUT_SOURCE_TYPE, entry.agentId])
    .and((transaction) => (
      !transaction.isDeleted
      && transaction.sourceSubrecordId === entry.id
    ))
    .first();
  if (existing) return existing;

  const { appendPaymentTransaction } = await import("./payments");
  return appendPaymentTransaction(workspaceId, {
    sourceModule: "orders",
    sourceType: COMMISSION_PAYOUT_SOURCE_TYPE,
    sourceRecordId: entry.agentId,
    sourceSubrecordId: entry.id,
    direction: "outgoing",
    amount: Math.abs(entry.amount),
    currency: entry.currency,
    paymentMethod: options.paymentMethod,
    paidAt: entry.occurredAt,
    counterpartyName: options.counterpartyName,
    // The order number is the payout reference. Prefixing it with a generated
    // label made Quick Order payments harder to correlate in the ledger.
    referenceLabel: entry.payoutReference?.trim() || null,
    note: options.notes,
    createdBy: options.createdBy,
    accountId: options.accountId,
    accountNameSnapshot: options.accountNameSnapshot,
    metadata: {
      agentCommissionEntryId: entry.id,
      agentId: entry.agentId,
      orderId: entry.orderId ?? null,
      payoutReference: entry.payoutReference ?? null,
      businessPartnerId: options.businessPartnerId ?? null,
      automaticSettlement: entry.settlementSource === 'automatic',
    },
  });
}

async function ensureCommissionRecoveryTransaction(
  workspaceId: string,
  entry: Pick<AgentCommissionEntry, "id" | "orderId" | "agentId" | "amount" | "currency" | "occurredAt" | "payoutReference">,
  options: {
    counterpartyName: string | null;
    businessPartnerId?: string | null;
    paymentMethod: WorkspacePaymentMethod;
    notes: string | null;
    createdBy: string | null;
    accountId: string | null;
    accountNameSnapshot: string | null;
  },
) {
  const existing = await db.payment_transactions
    .where("[workspaceId+sourceType+sourceRecordId]")
    .equals([workspaceId, COMMISSION_RECOVERY_SOURCE_TYPE, entry.agentId])
    .and((transaction) => !transaction.isDeleted && transaction.sourceSubrecordId === entry.id)
    .first();
  if (existing) return existing;

  const { appendPaymentTransaction } = await import("./payments");
  return appendPaymentTransaction(workspaceId, {
    sourceModule: "orders",
    sourceType: COMMISSION_RECOVERY_SOURCE_TYPE,
    sourceRecordId: entry.agentId,
    sourceSubrecordId: entry.id,
    direction: "incoming",
    amount: Math.abs(entry.amount),
    currency: entry.currency,
    paymentMethod: options.paymentMethod,
    paidAt: entry.occurredAt,
    counterpartyName: options.counterpartyName,
    referenceLabel: entry.payoutReference?.trim() || null,
    note: options.notes,
    createdBy: options.createdBy,
    accountId: options.accountId,
    accountNameSnapshot: options.accountNameSnapshot,
    metadata: {
      agentCommissionEntryId: entry.id,
      agentId: entry.agentId,
      orderId: entry.orderId ?? null,
      payoutReference: entry.payoutReference ?? null,
      businessPartnerId: options.businessPartnerId ?? null,
    },
  });
}

type RecordAgentCommissionSettlementInput = {
  agentId: string;
  assignmentId: string;
  orderId: string;
  amount: number;
  currency: CurrencyCode;
  paymentMethod: WorkspacePaymentMethod;
  paidAt?: string;
  note?: string | null;
  createdBy?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
};

async function recordServerCommissionSettlement(
  workspaceId: string,
  kind: 'payout' | 'recovery',
  input: RecordAgentCommissionSettlementInput,
) {
  const { data, error } = await runSupabaseAction(
    'salesAgentCommissions.pay',
    () => supabase.rpc(
      kind === 'payout'
        ? 'record_sales_agent_commission_payout'
        : 'record_sales_agent_commission_recovery',
      {
        p_order_id: input.orderId,
        p_assignment_id: input.assignmentId,
        p_amount: roundCommissionAmount(Number(input.amount)),
        p_payment_method: input.paymentMethod,
        p_paid_at: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        p_note: normalizeText(input.note),
        p_account_id: input.accountId ?? null,
        p_account_name_snapshot: input.accountNameSnapshot ?? null,
      },
    ),
  ) as { data?: { entry_id?: string }[] | null; error?: unknown };
  if (error) throw error;

  await Promise.all([
    hydrateTable(ENTRY_TABLE, workspaceId),
    fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
  ]);
  const entryId = data?.[0]?.entry_id;
  return entryId ? db.agent_commission_entries.get(entryId) : null;
}

export interface RecordAgentCommissionPayoutInput extends RecordAgentCommissionSettlementInput {}
export interface RecordAgentCommissionRecoveryInput extends RecordAgentCommissionSettlementInput {}

/**
 * Pays an outstanding commission for one sales-order assignment. The payment
 * transaction is written alongside the immutable commission-payout entry, so
 * the Payments module, ledger, and payment-account movement stay in sync.
 */
export async function recordAgentCommissionPayout(
  workspaceId: string,
  input: RecordAgentCommissionPayoutInput,
) {
  if (shouldUseCloudData(workspaceId)) {
    return recordServerCommissionSettlement(workspaceId, 'payout', input);
  }
  const { softDeletePaymentTransaction } = await import('./payments');
  if (
    input.paymentMethod === 'credit'
    || input.paymentMethod === 'unknown'
    || input.paymentMethod === 'loan_adjustment'
    || input.paymentMethod === 'loan'
  ) {
    throw new Error('Select a settlement payment method');
  }

  const amount = roundCommissionAmount(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0.000001) {
    throw new Error('Commission payout amount must be greater than zero');
  }

  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) {
    throw new Error('Enter a valid payout date');
  }
  const occurredAt = paidAt.toISOString();

  const [agent, assignment, order] = await Promise.all([
    db.agents.get(input.agentId),
    db.sales_order_agent_assignments.get(input.assignmentId),
    db.sales_orders.get(input.orderId),
  ]);
  if (
    !agent
    || agent.isDeleted
    || agent.workspaceId !== workspaceId
    || agent.agentType !== 'field_agent'
  ) {
    throw new Error('Field sales agent not found');
  }
  if (
    !assignment
    || assignment.isDeleted
    || assignment.workspaceId !== workspaceId
    || assignment.agentId !== agent.id
    || assignment.orderId !== input.orderId
  ) {
    throw new Error('Sales agent commission assignment not found');
  }
  if (
    !order
    || order.isDeleted
    || order.workspaceId !== workspaceId
    || !isCommissionEligibleOrder(order)
  ) {
    throw new Error('Eligible sales order not found');
  }
  if (order.currency !== input.currency) {
    throw new Error('Commission payout currency must match the sales order');
  }

  const commissionEntries = await db.agent_commission_entries
    .where('[workspaceId+agentId]')
    .equals([workspaceId, agent.id])
    .and((entry) => (
      !entry.isDeleted
      && entry.assignmentId === assignment.id
      && entry.orderId === order.id
      && entry.currency === input.currency
      && entry.kind !== 'estimate'
      && entry.kind !== 'approval'
    ))
    .toArray();
  const outstanding = roundCommissionAmount(commissionEntries.reduce((total, entry) => total + entry.amount, 0));
  if (amount - outstanding > 0.000001) {
    throw new Error('Commission payout cannot exceed the outstanding balance');
  }

  const partner = await db.business_partners.get(agent.businessPartnerId);
  if (!partner || partner.isDeleted || partner.workspaceId !== workspaceId) {
    throw new Error('Sales agent business partner not found');
  }

  const payoutId = generateId();
  const payoutReference = `${order.orderNumber} · SET-${payoutId.slice(0, 8).toUpperCase()}`;
  const note = normalizeText(input.note);
  const payoutInput = {
    orderId: order.id,
    assignmentId: assignment.id,
    agentId: agent.id,
    membershipId: null,
    planId: null,
    orderReturnId: null,
    relatedEntryId: null,
    kind: 'payout' as const,
    status: 'paid' as const,
    currency: input.currency,
    calculationBasis: 'net_profit' as const,
    includeTax: false,
    includeDeliveryCharge: false,
    basisAmount: 0,
    revenueAmount: 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    ratePercent: 0,
    amount: -amount,
    occurredAt,
    payoutReference,
    settlementSource: 'manual' as const,
    notes: note,
    createdBy: input.createdBy ?? null,
  } satisfies Omit<AgentCommissionEntry, keyof ReturnType<typeof getSyncMetadata>
    | 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'version' | 'isDeleted'>;

  const payment = await ensureCommissionPayoutTransaction(workspaceId, {
    id: payoutId,
    orderId: order.id,
    agentId: agent.id,
    amount: -amount,
    currency: input.currency,
    occurredAt,
    payoutReference,
    settlementSource: 'manual',
  }, {
    counterpartyName: partner.partnerName,
    businessPartnerId: partner.id,
    paymentMethod: input.paymentMethod,
    notes: note,
    createdBy: input.createdBy ?? null,
    accountId: input.accountId ?? null,
    accountNameSnapshot: input.accountNameSnapshot ?? null,
  });

  try {
    const entry = await appendEntry(workspaceId, payoutInput, payoutId);
    const { recalculateBusinessPartnerSummary } = await import('./businessPartners');
    await recalculateBusinessPartnerSummary(workspaceId, partner.id);
    return entry;
  } catch (error) {
    try {
      await softDeletePaymentTransaction(payment);
    } catch (cleanupError) {
      console.error('[Sales Agent Commissions] Failed to roll back commission payout payment:', cleanupError);
    }
    throw error;
  }
}

/**
 * A recovery is the counterpart of an overpaid commission. It records an
 * incoming payment and a positive immutable entry, bringing a negative
 * commission balance back toward zero without changing the order commission.
 */
export async function recordAgentCommissionRecovery(
  workspaceId: string,
  input: RecordAgentCommissionRecoveryInput,
) {
  if (shouldUseCloudData(workspaceId)) {
    return recordServerCommissionSettlement(workspaceId, 'recovery', input);
  }
  const { softDeletePaymentTransaction } = await import('./payments');
  if (
    input.paymentMethod === 'credit'
    || input.paymentMethod === 'unknown'
    || input.paymentMethod === 'loan_adjustment'
    || input.paymentMethod === 'loan'
  ) {
    throw new Error('Select a settlement payment method');
  }

  const amount = roundCommissionAmount(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0.000001) {
    throw new Error('Commission recovery amount must be greater than zero');
  }
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) {
    throw new Error('Enter a valid recovery date');
  }

  const [agent, assignment, order] = await Promise.all([
    db.agents.get(input.agentId),
    db.sales_order_agent_assignments.get(input.assignmentId),
    db.sales_orders.get(input.orderId),
  ]);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.agentType !== 'field_agent') {
    throw new Error('Field sales agent not found');
  }
  if (!assignment || assignment.isDeleted || assignment.workspaceId !== workspaceId || assignment.agentId !== agent.id || assignment.orderId !== input.orderId) {
    throw new Error('Sales agent commission assignment not found');
  }
  if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
    throw new Error('Sales order not found');
  }
  if (order.currency !== input.currency) {
    throw new Error('Commission recovery currency must match the sales order');
  }

  const entries = await db.agent_commission_entries
    .where('[workspaceId+agentId]')
    .equals([workspaceId, agent.id])
    .and((entry) => !entry.isDeleted
      && entry.assignmentId === assignment.id
      && entry.orderId === order.id
      && entry.currency === input.currency
      && entry.kind !== 'estimate'
      && entry.kind !== 'approval')
    .toArray();
  const outstanding = roundCommissionAmount(entries.reduce((total, entry) => total + entry.amount, 0));
  if (outstanding >= -0.000001 || amount + outstanding > 0.000001) {
    throw new Error('Commission recovery cannot exceed the recoverable balance');
  }

  const partner = await db.business_partners.get(agent.businessPartnerId);
  if (!partner || partner.isDeleted || partner.workspaceId !== workspaceId) {
    throw new Error('Sales agent business partner not found');
  }

  const recoveryId = generateId();
  const occurredAt = paidAt.toISOString();
  const payoutReference = `${order.orderNumber} · REC-${recoveryId.slice(0, 8).toUpperCase()}`;
  const note = normalizeText(input.note);
  const recoveryInput = {
    orderId: order.id,
    assignmentId: assignment.id,
    agentId: agent.id,
    membershipId: null,
    planId: null,
    orderReturnId: null,
    relatedEntryId: null,
    kind: 'recovery' as const,
    status: 'paid' as const,
    currency: input.currency,
    calculationBasis: 'net_profit' as const,
    includeTax: false,
    includeDeliveryCharge: false,
    basisAmount: 0,
    revenueAmount: 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    ratePercent: 0,
    amount,
    occurredAt,
    payoutReference,
    settlementSource: 'manual' as const,
    notes: note,
    createdBy: input.createdBy ?? null,
  } satisfies Omit<AgentCommissionEntry, keyof ReturnType<typeof getSyncMetadata>
    | 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'version' | 'isDeleted'>;

  const payment = await ensureCommissionRecoveryTransaction(workspaceId, {
    id: recoveryId,
    orderId: order.id,
    agentId: agent.id,
    amount,
    currency: input.currency,
    occurredAt,
    payoutReference,
  }, {
    counterpartyName: partner.partnerName,
    businessPartnerId: partner.id,
    paymentMethod: input.paymentMethod,
    notes: note,
    createdBy: input.createdBy ?? null,
    accountId: input.accountId ?? null,
    accountNameSnapshot: input.accountNameSnapshot ?? null,
  });
  try {
    const entry = await appendEntry(workspaceId, recoveryInput, recoveryId);
    const { recalculateBusinessPartnerSummary } = await import('./businessPartners');
    await recalculateBusinessPartnerSummary(workspaceId, partner.id);
    return entry;
  } catch (error) {
    try {
      await softDeletePaymentTransaction(payment);
    } catch (cleanupError) {
      console.error('[Sales Agent Commissions] Failed to roll back commission recovery payment:', cleanupError);
    }
    throw error;
  }
}

type CommissionPayoutFunding = {
  accountId: string | null;
  accountNameSnapshot: string | null;
  paymentMethod: WorkspacePaymentMethod;
  /** Amount still eligible to settle from this order's receipt/account. */
  availableAmount: number;
};

/**
 * Resolve every account that actually received money for this order. We never
 * guess from the order's initial-account snapshot: progressive and loan
 * payments may be collected later through different accounts. Each source is
 * capped by both the net order receipt and the account's current available
 * balance, so a commission cannot spend an already-used receipt.
 */
async function resolveSalesOrderCommissionPayoutFunding(
  order: SalesOrder,
): Promise<CommissionPayoutFunding[]> {
  const payments = await db.payment_transactions
    .where("[workspaceId+sourceType+sourceRecordId]")
    .equals([order.workspaceId, "sales_order", order.id])
    .toArray();

  const reversedAmounts = new Map<string, number>();
  for (const payment of payments) {
    if (payment.isDeleted || !payment.reversalOfTransactionId) continue;
    reversedAmounts.set(
      payment.reversalOfTransactionId,
      (reversedAmounts.get(payment.reversalOfTransactionId) ?? 0) + Math.abs(payment.amount),
    );
  }

  const fundingPayments = payments
    .filter((payment) => (
      !payment.isDeleted
      && payment.direction === "incoming"
      && !payment.reversalOfTransactionId
      && Boolean(payment.accountId)
      && payment.amount - (reversedAmounts.get(payment.id) ?? 0) > 0.000001
    ));

  // Preserve the established ledger-only behavior only when the order really
  // has no account-backed receipt. A selected but empty/spent account must not
  // silently turn into an unaccounted cash payout.
  if (!fundingPayments.length) {
    return [{
      accountId: null,
      accountNameSnapshot: null,
      paymentMethod: "unknown",
      availableAmount: Number.POSITIVE_INFINITY,
    }];
  }

  const allWorkspacePayments = await db.payment_transactions
    .where("workspaceId")
    .equals(order.workspaceId)
    .toArray();
  const payoutEntries = await db.agent_commission_entries
    .where("workspaceId")
    .equals(order.workspaceId)
    .and((entry) => !entry.isDeleted && entry.kind === "payout")
    .toArray();
  const payoutOrderIdByEntryId = new Map(payoutEntries.map((entry) => [entry.id, entry.orderId ?? null]));
  const fundingByAccountId = new Map<string, {
    amount: number;
    latest: typeof fundingPayments[number];
  }>();

  for (const payment of fundingPayments) {
    const netAmount = roundCommissionAmount(payment.amount - (reversedAmounts.get(payment.id) ?? 0));
    if (netAmount <= 0.000001 || !payment.accountId) continue;
    const current = fundingByAccountId.get(payment.accountId);
    if (!current) {
      fundingByAccountId.set(payment.accountId, { amount: netAmount, latest: payment });
      continue;
    }
    current.amount = roundCommissionAmount(current.amount + netAmount);
    if (
      payment.paidAt > current.latest.paidAt
      || (payment.paidAt === current.latest.paidAt && payment.createdAt > current.latest.createdAt)
    ) {
      current.latest = payment;
    }
  }

  const fundings: CommissionPayoutFunding[] = [];
  for (const [accountId, receipt] of fundingByAccountId) {
    const account = await db.payment_accounts.get(accountId);
    if (!account
      || account.workspaceId !== order.workspaceId
      || account.isDeleted
      || !account.isActive) {
      continue;
    }

    const accountBalance = allWorkspacePayments
      .filter((payment) => !payment.isDeleted && payment.accountId === accountId && payment.currency === order.currency)
      .reduce((total, payment) => total + (payment.direction === "incoming" ? payment.amount : -payment.amount), 0);
    const alreadyAllocated = allWorkspacePayments
      .filter((payment) => (
        !payment.isDeleted
        && payment.sourceType === COMMISSION_PAYOUT_SOURCE_TYPE
        && payment.accountId === accountId
        && payment.currency === order.currency
        && (
          payment.metadata?.orderId === order.id
          || payoutOrderIdByEntryId.get(payment.sourceSubrecordId ?? "") === order.id
        )
      ))
      .reduce((total, payment) => total + Math.abs(payment.amount), 0);
    const availableAmount = roundCommissionAmount(Math.max(
      0,
      Math.min(receipt.amount - alreadyAllocated, accountBalance),
    ));
    if (availableAmount <= 0.000001) continue;
    fundings.push({
      accountId,
      accountNameSnapshot: receipt.latest.accountNameSnapshot || account.name,
      paymentMethod: receipt.latest.paymentMethod,
      availableAmount,
    });
  }

  // A stable order prevents concurrent local settlement retries from choosing
  // account rows in a different sequence.
  return fundings.sort((left, right) => (left.accountId ?? "").localeCompare(right.accountId ?? ""));
}

/**
 * Local workspaces have no server trigger, so mirror the cloud settlement
 * behavior here. A commission is paid only once its order is fully paid. When
 * the order has an active account-backed payment, its payout uses that same
 * account; otherwise the legacy ledger-only behavior is retained.
 */
export async function settlePaidSalesOrderCommissionsLocally(
  order: SalesOrder,
  assignments: SalesOrderAgentAssignment[],
  createdBy?: string | null,
) {
  if (shouldUseCloudData(order.workspaceId)
    || order.status !== 'completed'
    || (!order.isPaid && order.paymentStatus !== 'paid')) {
    return [] as AgentCommissionEntry[];
  }

  const fundings = await resolveSalesOrderCommissionPayoutFunding(order);
  const payouts: AgentCommissionEntry[] = [];
  for (const assignment of assignments) {
    if (assignment.isDeleted || assignment.unassignedAt) continue;
    if (
      order.commissionEnabled === false
      && assignment.assignmentSource !== ORDER_CREATOR_PRODUCT_ASSIGNMENT_SOURCE
    ) {
      continue;
    }
    const entries = await db.agent_commission_entries
      .where('assignmentId')
      .equals(assignment.id)
      .and((entry) => !entry.isDeleted)
      .toArray();
    const source = entries.find((entry) => entry.kind === 'accrual');
    if (!source) continue;
    const assignmentDue = roundCommissionAmount(entries
      .filter((entry) => entry.currency === source.currency
        && entry.kind !== 'estimate'
        && entry.kind !== 'approval')
      .reduce((sum, entry) => sum + entry.amount, 0));
    const agentEntries = await db.agent_commission_entries
      .where('[workspaceId+agentId]')
      .equals([order.workspaceId, assignment.agentId])
      .and((entry) => !entry.isDeleted && entry.currency === source.currency)
      .toArray();
    const agentDue = roundCommissionAmount(agentEntries
      .filter((entry) => entry.kind !== 'estimate' && entry.kind !== 'approval')
      .reduce((sum, entry) => sum + entry.amount, 0));
    const due = Math.min(assignmentDue, agentDue);
    if (due <= 0.000001) continue;

    let remainingDue = due;
    for (const funding of fundings) {
      if (remainingDue <= 0.000001 || funding.availableAmount <= 0.000001) continue;
      const amount = roundCommissionAmount(Math.min(remainingDue, funding.availableAmount));
      const payoutId = generateId();
      const payoutInput = {
        orderId: order.id,
        assignmentId: assignment.id,
        agentId: assignment.agentId,
        membershipId: null,
        planId: null,
        orderReturnId: null,
        relatedEntryId: null,
        kind: 'payout',
        status: 'paid',
        currency: source.currency,
        calculationBasis: source.calculationBasis,
        includeTax: false,
        includeDeliveryCharge: false,
        basisAmount: 0,
        revenueAmount: 0,
        costAmount: 0,
        taxAmount: 0,
        deliveryChargeAmount: 0,
        ratePercent: 0,
        amount: -amount,
        occurredAt: order.paidAt ?? order.updatedAt,
        payoutReference: order.orderNumber,
        settlementSource: 'automatic' as const,
        notes: 'Automatically settled after the sales order was paid in full.',
        createdBy: createdBy ?? null,
      } satisfies Omit<AgentCommissionEntry, keyof ReturnType<typeof getSyncMetadata>
        | 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'version' | 'isDeleted'>;

      const payment = await ensureCommissionPayoutTransaction(order.workspaceId, {
        id: payoutId,
        orderId: order.id,
        agentId: assignment.agentId,
        amount: -amount,
        currency: source.currency,
        occurredAt: payoutInput.occurredAt,
        payoutReference: order.orderNumber,
        settlementSource: payoutInput.settlementSource,
      }, {
        counterpartyName: await resolveAgentCounterpartyName(assignment.agentId),
        paymentMethod: funding.paymentMethod,
        notes: payoutInput.notes,
        createdBy: createdBy ?? null,
        accountId: funding.accountId,
        accountNameSnapshot: funding.accountNameSnapshot,
      });

      try {
        payouts.push(await appendEntry(order.workspaceId, payoutInput, payoutId));
        remainingDue = roundCommissionAmount(remainingDue - amount);
        funding.availableAmount = roundCommissionAmount(funding.availableAmount - amount);
      } catch (error) {
        try {
          const { softDeletePaymentTransaction } = await import('./payments');
          await softDeletePaymentTransaction(payment);
        } catch (cleanupError) {
          console.error('[Sales Agent Commissions] Failed to roll back automatic settlement payment:', cleanupError);
        }
        throw error;
      }
    }
  }
  return payouts;
}

export async function recordCommissionAdjustment(
  workspaceId: string,
  input: RecordCommissionAdjustmentInput,
) {
  const amount = roundCommissionAmount(Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0) throw new Error("Adjustment amount cannot be zero");
  if (!normalizeText(input.notes)) throw new Error("Adjustment reason is required");
  const agent = await db.agents.get(input.agentId);
  if (!agent || agent.isDeleted || agent.workspaceId !== workspaceId || agent.agentType !== "field_agent") {
    throw new Error("Field agent not found");
  }
  if (input.relatedEntryId) {
    const related = await db.agent_commission_entries.get(input.relatedEntryId);
    if (!related || related.workspaceId !== workspaceId || related.agentId !== input.agentId) {
      throw new Error("Related commission entry does not belong to this agent");
    }
    throw new Error("Manual adjustments cannot impersonate an automatic order reconciliation event");
  }
  const resolvedOrderId = input.orderId ?? null;
  let assignment: SalesOrderAgentAssignment | null = null;
  if (resolvedOrderId) {
    const order = await db.sales_orders.get(resolvedOrderId);
    if (!order || order.isDeleted || order.workspaceId !== workspaceId) {
      throw new Error("Sales order not found");
    }
    if (order.currency.toLowerCase() !== input.currency.toLowerCase()) {
      throw new Error("An order-linked adjustment must use the sales order currency");
    }
    const matchingAssignments = await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([workspaceId, resolvedOrderId])
      .and((row) => !row.isDeleted && row.agentId === input.agentId)
      .toArray();
    // Sort active assignments first, then newest within each state.
    assignment = matchingAssignments.sort((left, right) => (
      Number(!!left.unassignedAt) - Number(!!right.unassignedAt)
      || right.assignedAt.localeCompare(left.assignedAt)
    ))[0] ?? null;
    if (!assignment) {
      throw new Error("The sales order is not assigned to this agent");
    }
  }

  return appendEntry(workspaceId, {
    orderId: resolvedOrderId,
    assignmentId: assignment?.id ?? null,
    agentId: input.agentId,
    membershipId: null,
    planId: null,
    orderReturnId: null,
    relatedEntryId: null,
    kind: "adjustment",
    status: amount < 0 ? "reversed" : "earned",
    currency: input.currency,
    calculationBasis: "net_profit",
    includeTax: false,
    includeDeliveryCharge: false,
    basisAmount: 0,
    revenueAmount: 0,
    costAmount: 0,
    taxAmount: 0,
    deliveryChargeAmount: 0,
    ratePercent: 0,
    amount,
    occurredAt: normalizeTimestamp(input.occurredAt),
    payoutReference: null,
    notes: normalizeText(input.notes),
    createdBy: input.createdBy ?? null,
  });
}
