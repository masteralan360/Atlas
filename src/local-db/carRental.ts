import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toSnakeCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import { toLiveCollection } from "./liveCollection";
import { canAccessBusinessPartnerInLocalCache } from "./businessPartnerPrivacy";
import { addToOfflineMutations, fetchTableFromSupabase } from "./hooks";
import { appendPaymentTransaction } from "./payments";
import type {
  CurrencyCode,
  PaymentTransaction,
  RentalContract,
  RentalContractStatus,
  RentalPaymentKind,
  RentalRequest,
  RentalRequestStatus,
  RentalVehicle,
  RentalVehicleStatus,
  WorkspacePaymentMethod,
} from "./models";

const VEHICLES_TABLE = "rental_vehicles";
const REQUESTS_TABLE = "rental_requests";
const CONTRACTS_TABLE = "rental_contracts";

export const RENTAL_VEHICLE_YEAR_MIN = 1900;
export const RENTAL_VEHICLE_YEAR_MAX = 2200;
export const INVALID_RENTAL_VEHICLE_YEAR_ERROR = "invalid_rental_vehicle_year";

type RentalTableName =
  | typeof VEHICLES_TABLE
  | typeof REQUESTS_TABLE
  | typeof CONTRACTS_TABLE;
type RentalEntity = RentalVehicle | RentalRequest | RentalContract;

export interface SaveRentalVehicleInput {
  plateNumber: string;
  make?: string | null;
  model: string;
  year?: number | null;
  color?: string | null;
  vin?: string | null;
  category?: string | null;
  dailyRate: number;
  currency: CurrencyCode;
  currentOdometer?: number | null;
  currentFuelLevel?: string | null;
  status: RentalVehicleStatus;
  notes?: string | null;
}

export interface CreateRentalRequestInput {
  customerName: string;
  customerPhone: string;
  businessPartnerId?: string | null;
  preferredVehicleId?: string | null;
  requestedStartAt: string;
  requestedEndAt: string;
  notes?: string | null;
  createdBy?: string | null;
}

export interface CreateRentalContractInput {
  requestId?: string | null;
  vehicleId: string;
  customerName: string;
  customerPhone: string;
  businessPartnerId?: string | null;
  driverLicenseNo?: string | null;
  plannedPickupAt: string;
  plannedReturnAt: string;
  dailyRate: number;
  rentalDays: number;
  discountAmount?: number;
  depositAmount?: number;
  currency: CurrencyCode;
  notes?: string | null;
  createdBy?: string | null;
}

export interface ReturnRentalContractInput {
  actualReturnAt?: string;
  returnOdometer?: number | null;
  returnFuelLevel?: string | null;
  returnCondition?: string | null;
  returnAdjustmentAmount?: number;
}

export interface RecordRentalContractPaymentInput {
  contractId: string;
  kind: RentalPaymentKind;
  amount: number;
  paymentMethod: WorkspacePaymentMethod;
  paidAt?: string;
  note?: string | null;
  accountId?: string | null;
  accountNameSnapshot?: string | null;
  createdBy?: string | null;
}

export interface RentalContractPaymentSummary {
  rentalPaid: number;
  rentalBalance: number;
  depositReceived: number;
  depositRefunded: number;
  depositHeld: number;
}

export interface RentalSaleProjectionOptions {
  serviceName: string;
  serviceCategory: string;
}

function shouldUseCloudRentalData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId);
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
  return shouldUseCloudRentalData(workspaceId)
    ? { syncStatus: "pending" as const, lastSyncedAt: null }
    : { syncStatus: "synced" as const, lastSyncedAt: timestamp };
}

function normalizeText(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function positiveAmount(value: number, label: string, allowZero = true) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return amount;
}

export function normalizeRentalVehicleYear(value?: number | null) {
  if (value === undefined || value === null) return null;

  const year = Number(value);
  if (
    !Number.isInteger(year)
    || year < RENTAL_VEHICLE_YEAR_MIN
    || year > RENTAL_VEHICLE_YEAR_MAX
  ) {
    throw new Error(INVALID_RENTAL_VEHICLE_YEAR_ERROR);
  }

  return year;
}

export function isRentalVehicleYearConstraintError(error?: string) {
  return Boolean(error?.includes("rental_vehicles_year_check"));
}

function normalizeDateTime(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is required`);
  }
  return date.toISOString();
}

function isReservationStatus(status: RentalContractStatus) {
  return status === "reserved" || status === "active" || status === "returned" || status === "closed";
}

function tableFor(tableName: RentalTableName) {
  switch (tableName) {
    case VEHICLES_TABLE:
      return db.rental_vehicles;
    case REQUESTS_TABLE:
      return db.rental_requests;
    case CONTRACTS_TABLE:
      return db.rental_contracts;
  }
}

function sanitizePayload(entity: RentalEntity) {
  const payload = toSnakeCase(entity as unknown as Record<string, unknown>);
  delete payload.sync_status;
  delete payload.last_synced_at;
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

async function queueUpsert(tableName: RentalTableName, entity: RentalEntity) {
  await addToOfflineMutations(
    tableName,
    entity.id,
    entity.version > 1 ? "update" : "create",
    entity as unknown as Record<string, unknown>,
    entity.workspaceId,
  );
}

async function syncUpsert(tableName: RentalTableName, entity: RentalEntity) {
  if (!shouldUseCloudRentalData(entity.workspaceId)) return;

  if (!isOnline(entity.workspaceId)) {
    await queueUpsert(tableName, entity);
    return;
  }

  try {
    const client = getSupabaseClientForTable(tableName);
    const { error } = (await runSupabaseAction(`${tableName}.sync`, () =>
      client.from(tableName).upsert(sanitizePayload(entity)),
    )) as { error?: unknown };
    if (error) throw error;

    await tableFor(tableName).update(entity.id, {
      syncStatus: "synced",
      lastSyncedAt: new Date().toISOString(),
    } as never);
  } catch (error) {
    console.error(`[CarRental] Failed to sync ${tableName}:`, error);
    await queueUpsert(tableName, entity);
  }
}

async function hydrateRentalTable(tableName: RentalTableName, workspaceId: string) {
  if (!shouldUseCloudRentalData(workspaceId)) return;
  await fetchTableFromSupabase(tableName, tableFor(tableName), workspaceId);
}

async function nextNumber(workspaceId: string, prefix: string, tableName: typeof REQUESTS_TABLE | typeof CONTRACTS_TABLE) {
  const rows = tableName === REQUESTS_TABLE
    ? await db.rental_requests.where("workspaceId").equals(workspaceId).toArray()
    : await db.rental_contracts.where("workspaceId").equals(workspaceId).toArray();
  const year = new Date().getFullYear();
  const count = rows.filter((row) => !row.isDeleted && row.createdAt.startsWith(`${year}-`)).length + 1;
  return `${prefix}-${year}-${String(count).padStart(5, "0")}`;
}

function hasPeriodOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
) {
  return new Date(leftStart).getTime() < new Date(rightEnd).getTime()
    && new Date(leftEnd).getTime() > new Date(rightStart).getTime();
}

export async function assertRentalVehicleAvailable(
  workspaceId: string,
  vehicleId: string,
  plannedPickupAt: string,
  plannedReturnAt: string,
  exceptContractId?: string,
) {
  const vehicle = await db.rental_vehicles.get(vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.workspaceId !== workspaceId) {
    throw new Error("Rental vehicle not found");
  }
  if (vehicle.status !== "available") {
    throw new Error("This vehicle is unavailable");
  }

  const contracts = await db.rental_contracts
    .where("vehicleId")
    .equals(vehicleId)
    .toArray();
  const conflicts = contracts.some((contract) =>
    !contract.isDeleted
    && contract.id !== exceptContractId
    && isReservationStatus(contract.status)
    && hasPeriodOverlap(
      plannedPickupAt,
      plannedReturnAt,
      contract.plannedPickupAt,
      contract.plannedReturnAt,
    ),
  );
  if (conflicts) {
    throw new Error("This vehicle already has a reservation during the selected period");
  }
  return vehicle;
}

export function useRentalVehicles(workspaceId?: string) {
  const online = useNetworkStatus();
  const vehicles = useLiveQuery(
    () => workspaceId
      ? db.rental_vehicles
        .where("workspaceId")
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray()
      : [],
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId || !online) return;
    void hydrateRentalTable(VEHICLES_TABLE, workspaceId).catch((error) => {
      console.error("[CarRental] Failed to hydrate vehicles:", error);
    });
  }, [online, workspaceId]);

  return useMemo(
    () => toLiveCollection(
      [...(vehicles ?? [])].sort((left, right) => left.plateNumber.localeCompare(right.plateNumber)),
      Boolean(workspaceId) && vehicles === undefined,
    ),
    [vehicles, workspaceId],
  );
}

export function useRentalRequests(workspaceId?: string) {
  const online = useNetworkStatus();
  const requests = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const rows = await db.rental_requests
        .where("workspaceId")
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray();
      const visibility = await Promise.all(rows.map((request) =>
        canAccessBusinessPartnerInLocalCache(workspaceId, request.businessPartnerId, "customer")
      ));
      return rows.filter((_, index) => visibility[index]);
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId || !online) return;
    void hydrateRentalTable(REQUESTS_TABLE, workspaceId).catch((error) => {
      console.error("[CarRental] Failed to hydrate requests:", error);
    });
  }, [online, workspaceId]);

  return [...(requests ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function useRentalContracts(workspaceId?: string) {
  const online = useNetworkStatus();
  const contracts = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const rows = await db.rental_contracts
        .where("workspaceId")
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray();
      const visibility = await Promise.all(rows.map(async (contract) => {
        if (!await canAccessBusinessPartnerInLocalCache(workspaceId, contract.businessPartnerId, "customer")) {
          return false;
        }
        if (!contract.requestId) return true;
        const request = await db.rental_requests.get(contract.requestId);
        return !request || await canAccessBusinessPartnerInLocalCache(
          workspaceId,
          request.businessPartnerId,
          "customer"
        );
      }));
      return rows.filter((_, index) => visibility[index]);
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId || !online) return;
    void Promise.all([
      hydrateRentalTable(VEHICLES_TABLE, workspaceId),
      hydrateRentalTable(REQUESTS_TABLE, workspaceId),
      hydrateRentalTable(CONTRACTS_TABLE, workspaceId),
    ]).catch((error) => {
      console.error("[CarRental] Failed to hydrate contracts:", error);
    });
  }, [online, workspaceId]);

  return [...(contracts ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createRentalVehicle(workspaceId: string, input: SaveRentalVehicleInput) {
  const plateNumber = input.plateNumber.trim().toUpperCase();
  const model = input.model.trim();
  const dailyRate = positiveAmount(input.dailyRate, "Daily rate", false);
  const year = normalizeRentalVehicleYear(input.year);
  if (!plateNumber || !model) {
    throw new Error("Plate number and model are required");
  }

  const duplicate = await db.rental_vehicles
    .where("workspaceId")
    .equals(workspaceId)
    .and((row) => !row.isDeleted && row.plateNumber.toUpperCase() === plateNumber)
    .first();
  if (duplicate) throw new Error("A rental vehicle with this plate number already exists");

  const now = new Date().toISOString();
  const vehicle: RentalVehicle = {
    id: generateId(), workspaceId, plateNumber, model, dailyRate, currency: input.currency,
    make: normalizeText(input.make), year,
    color: normalizeText(input.color), vin: normalizeText(input.vin), category: normalizeText(input.category),
    currentOdometer: input.currentOdometer === undefined || input.currentOdometer === null ? null : positiveAmount(input.currentOdometer, "Odometer"),
    currentFuelLevel: normalizeText(input.currentFuelLevel), status: input.status, notes: normalizeText(input.notes),
    createdAt: now, updatedAt: now, version: 1, isDeleted: false, ...getSyncMetadata(workspaceId, now),
  };
  await db.rental_vehicles.put(vehicle);
  await syncUpsert(VEHICLES_TABLE, vehicle);
  return vehicle;
}

export async function updateRentalVehicle(vehicleId: string, input: SaveRentalVehicleInput) {
  const existing = await db.rental_vehicles.get(vehicleId);
  if (!existing || existing.isDeleted) throw new Error("Rental vehicle not found");
  const plateNumber = input.plateNumber.trim().toUpperCase();
  const year = normalizeRentalVehicleYear(input.year);
  if (!plateNumber || !input.model.trim()) throw new Error("Plate number and model are required");
  const duplicate = await db.rental_vehicles
    .where("workspaceId")
    .equals(existing.workspaceId)
    .and((row) => !row.isDeleted && row.id !== vehicleId && row.plateNumber.toUpperCase() === plateNumber)
    .first();
  if (duplicate) throw new Error("A rental vehicle with this plate number already exists");

  const now = new Date().toISOString();
  const vehicle: RentalVehicle = {
    ...existing, plateNumber, model: input.model.trim(), dailyRate: positiveAmount(input.dailyRate, "Daily rate", false),
    currency: input.currency, make: normalizeText(input.make), year,
    color: normalizeText(input.color), vin: normalizeText(input.vin), category: normalizeText(input.category),
    currentOdometer: input.currentOdometer === undefined || input.currentOdometer === null ? null : positiveAmount(input.currentOdometer, "Odometer"),
    currentFuelLevel: normalizeText(input.currentFuelLevel), status: input.status, notes: normalizeText(input.notes),
    updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now),
  };
  await db.rental_vehicles.put(vehicle);
  await syncUpsert(VEHICLES_TABLE, vehicle);
  return vehicle;
}

/**
 * Corrects the local record and the exact queued mutation Supabase rejected.
 * This preserves every other queued change and makes the repaired mutation
 * eligible for one deliberate retry.
 */
export async function repairQueuedRentalVehicleYear(
  workspaceId: string,
  vehicleId: string,
  mutationId: string,
  year?: number | null,
) {
  const correctedYear = normalizeRentalVehicleYear(year);

  return db.transaction("rw", db.rental_vehicles, db.offline_mutations, async () => {
    const [existing, mutation] = await Promise.all([
      db.rental_vehicles.get(vehicleId),
      db.offline_mutations.get(mutationId),
    ]);

    if (!existing || existing.isDeleted || existing.workspaceId !== workspaceId) {
      throw new Error("Rental vehicle not found");
    }
    if (
      !mutation
      || mutation.workspaceId !== workspaceId
      || mutation.entityType !== VEHICLES_TABLE
      || mutation.entityId !== vehicleId
      || mutation.status !== "failed"
      || !isRentalVehicleYearConstraintError(mutation.error)
    ) {
      throw new Error("Rental vehicle sync issue was not found");
    }

    const now = new Date().toISOString();
    const vehicle: RentalVehicle = {
      ...existing,
      year: correctedYear,
      updatedAt: now,
      version: existing.version + 1,
      ...getSyncMetadata(workspaceId, now),
    };

    await db.rental_vehicles.put(vehicle);
    await db.offline_mutations.update(mutation.id, {
      payload: { ...mutation.payload, ...(vehicle as unknown as Record<string, unknown>) },
      createdAt: now,
      status: "pending",
      error: undefined,
    });

    return vehicle;
  });
}

export async function createRentalRequest(workspaceId: string, input: CreateRentalRequestInput) {
  const customerName = input.customerName.trim();
  const customerPhone = input.customerPhone.trim();
  const requestedStartAt = normalizeDateTime(input.requestedStartAt, "Pickup date");
  const requestedEndAt = normalizeDateTime(input.requestedEndAt, "Return date");
  if (!customerName || !customerPhone) throw new Error("Customer name and phone are required");
  if (new Date(requestedEndAt) <= new Date(requestedStartAt)) throw new Error("Return date must be after pickup date");

  const now = new Date().toISOString();
  const request: RentalRequest = {
    id: generateId(), workspaceId, requestNo: await nextNumber(workspaceId, "RR", REQUESTS_TABLE),
    customerName, customerPhone, businessPartnerId: input.businessPartnerId || null,
    preferredVehicleId: input.preferredVehicleId || null, requestedStartAt, requestedEndAt,
    status: "new", notes: normalizeText(input.notes), convertedContractId: null, createdBy: input.createdBy || null,
    createdAt: now, updatedAt: now, version: 1, isDeleted: false, ...getSyncMetadata(workspaceId, now),
  };
  await db.rental_requests.put(request);
  await syncUpsert(REQUESTS_TABLE, request);
  return request;
}

export async function updateRentalRequestStatus(requestId: string, status: RentalRequestStatus) {
  const existing = await db.rental_requests.get(requestId);
  if (!existing || existing.isDeleted) throw new Error("Rental request not found");
  if (existing.status === "converted" && status !== "converted") throw new Error("Converted requests cannot be reopened");
  const now = new Date().toISOString();
  const request: RentalRequest = { ...existing, status, updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now) };
  await db.rental_requests.put(request);
  await syncUpsert(REQUESTS_TABLE, request);
  return request;
}

export async function createRentalContract(workspaceId: string, input: CreateRentalContractInput) {
  const customerName = input.customerName.trim();
  const customerPhone = input.customerPhone.trim();
  const plannedPickupAt = normalizeDateTime(input.plannedPickupAt, "Pickup date");
  const plannedReturnAt = normalizeDateTime(input.plannedReturnAt, "Return date");
  const rentalDays = Math.max(1, Math.trunc(Number(input.rentalDays || 0)));
  const dailyRate = positiveAmount(input.dailyRate, "Daily rate", false);
  const discountAmount = positiveAmount(input.discountAmount || 0, "Discount");
  const depositAmount = positiveAmount(input.depositAmount || 0, "Deposit");
  const gross = dailyRate * rentalDays;
  if (!input.vehicleId) throw new Error("Select a rental vehicle");
  if (!customerName || !customerPhone) throw new Error("Customer name and phone are required");
  if (new Date(plannedReturnAt) <= new Date(plannedPickupAt)) throw new Error("Return date must be after pickup date");
  if (discountAmount > gross) throw new Error("Discount cannot exceed the rental amount");

  const now = new Date().toISOString();
  const contract: RentalContract = {
    id: generateId(), workspaceId, contractNo: await nextNumber(workspaceId, "RC", CONTRACTS_TABLE),
    requestId: input.requestId || null, vehicleId: input.vehicleId, customerName, customerPhone,
    businessPartnerId: input.businessPartnerId || null, driverLicenseNo: normalizeText(input.driverLicenseNo),
    plannedPickupAt, plannedReturnAt, actualPickupAt: null, actualReturnAt: null, dailyRate, rentalDays,
    discountAmount, rentalAmount: gross - discountAmount, returnAdjustmentAmount: 0, finalAmount: gross - discountAmount,
    depositAmount, currency: input.currency, status: "draft", handoverOdometer: null, handoverFuelLevel: null,
    handoverCondition: null, returnOdometer: null, returnFuelLevel: null, returnCondition: null,
    notes: normalizeText(input.notes), createdBy: input.createdBy || null,
    createdAt: now, updatedAt: now, version: 1, isDeleted: false, ...getSyncMetadata(workspaceId, now),
  };
  await db.rental_contracts.put(contract);
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export async function reserveRentalContract(contractId: string) {
  const existing = await db.rental_contracts.get(contractId);
  if (!existing || existing.isDeleted) throw new Error("Rental contract not found");
  if (existing.status !== "draft") throw new Error("Only draft contracts can be reserved");
  await assertRentalVehicleAvailable(existing.workspaceId, existing.vehicleId, existing.plannedPickupAt, existing.plannedReturnAt, existing.id);
  const now = new Date().toISOString();
  const contract: RentalContract = { ...existing, status: "reserved", updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now) };
  await db.rental_contracts.put(contract);
  if (contract.requestId) {
    const request = await db.rental_requests.get(contract.requestId);
    if (request && !request.isDeleted) {
      const updatedRequest: RentalRequest = { ...request, status: "converted", convertedContractId: contract.id, updatedAt: now, version: request.version + 1, ...getSyncMetadata(request.workspaceId, now) };
      await db.rental_requests.put(updatedRequest);
      await syncUpsert(REQUESTS_TABLE, updatedRequest);
    }
  }
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export async function activateRentalContract(contractId: string, input: Pick<RentalContract, "handoverOdometer" | "handoverFuelLevel" | "handoverCondition">) {
  const existing = await db.rental_contracts.get(contractId);
  if (!existing || existing.isDeleted) throw new Error("Rental contract not found");
  if (existing.status !== "reserved") throw new Error("Only reserved contracts can be handed over");
  const now = new Date().toISOString();
  const contract: RentalContract = {
    ...existing, status: "active", actualPickupAt: now, handoverOdometer: input.handoverOdometer ?? null,
    handoverFuelLevel: normalizeText(input.handoverFuelLevel), handoverCondition: normalizeText(input.handoverCondition),
    updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now),
  };
  await db.rental_contracts.put(contract);
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export async function returnRentalContract(contractId: string, input: ReturnRentalContractInput) {
  const existing = await db.rental_contracts.get(contractId);
  if (!existing || existing.isDeleted) throw new Error("Rental contract not found");
  if (existing.status !== "active") throw new Error("Only active contracts can be returned");
  const adjustment = positiveAmount(input.returnAdjustmentAmount || 0, "Return adjustment");
  const now = new Date().toISOString();
  const actualReturnAt = input.actualReturnAt ? normalizeDateTime(input.actualReturnAt, "Return date") : now;
  const contract: RentalContract = {
    ...existing, status: "returned", actualReturnAt, returnOdometer: input.returnOdometer ?? null,
    returnFuelLevel: normalizeText(input.returnFuelLevel), returnCondition: normalizeText(input.returnCondition),
    returnAdjustmentAmount: adjustment, finalAmount: existing.rentalAmount + adjustment,
    updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now),
  };
  await db.rental_contracts.put(contract);
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export async function closeRentalContract(contractId: string) {
  const existing = await db.rental_contracts.get(contractId);
  if (!existing || existing.isDeleted) throw new Error("Rental contract not found");
  if (existing.status !== "returned") throw new Error("Return the vehicle before closing the contract");
  const payments = await db.payment_transactions.where("workspaceId").equals(existing.workspaceId).toArray();
  const summary = getRentalContractPaymentSummary(existing, payments);
  if (summary.rentalBalance > 0.000001) throw new Error("Record the remaining rental payment before closing the contract");
  const now = new Date().toISOString();
  const contract: RentalContract = { ...existing, status: "closed", updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now) };
  await db.rental_contracts.put(contract);
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export async function cancelRentalContract(contractId: string) {
  const existing = await db.rental_contracts.get(contractId);
  if (!existing || existing.isDeleted) throw new Error("Rental contract not found");
  if (existing.status !== "draft" && existing.status !== "reserved") throw new Error("Only draft or reserved contracts can be cancelled");
  const now = new Date().toISOString();
  const contract: RentalContract = { ...existing, status: "cancelled", updatedAt: now, version: existing.version + 1, ...getSyncMetadata(existing.workspaceId, now) };
  await db.rental_contracts.put(contract);
  await syncUpsert(CONTRACTS_TABLE, contract);
  return contract;
}

export function getRentalContractPaymentSummary(contract: RentalContract, paymentTransactions: PaymentTransaction[]): RentalContractPaymentSummary {
  const reversedIds = new Set(paymentTransactions.filter((row) => !!row.reversalOfTransactionId).map((row) => row.reversalOfTransactionId as string));
  const active = paymentTransactions.filter((row) => !row.isDeleted && !row.reversalOfTransactionId && !reversedIds.has(row.id) && row.sourceRecordId === contract.id);
  const totalFor = (sourceType: "rental_payment" | "rental_deposit" | "rental_deposit_refund") => active
    .filter((row) => row.sourceType === sourceType)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const rentalPaid = totalFor("rental_payment");
  const depositReceived = totalFor("rental_deposit");
  const depositRefunded = totalFor("rental_deposit_refund");
  return {
    rentalPaid,
    rentalBalance: Math.max(contract.finalAmount - rentalPaid, 0),
    depositReceived,
    depositRefunded,
    depositHeld: Math.max(depositReceived - depositRefunded, 0),
  };
}

export async function recordRentalContractPayment(workspaceId: string, input: RecordRentalContractPaymentInput) {
  const contract = await db.rental_contracts.get(input.contractId);
  if (!contract || contract.isDeleted || contract.workspaceId !== workspaceId) throw new Error("Rental contract not found");
  const amount = positiveAmount(input.amount, "Payment amount", false);
  if (input.paymentMethod === "credit" || input.paymentMethod === "loan" || input.paymentMethod === "loan_adjustment" || input.paymentMethod === "unknown") {
    throw new Error("Select a valid payment method");
  }
  const payments = await db.payment_transactions.where("workspaceId").equals(workspaceId).toArray();
  const summary = getRentalContractPaymentSummary(contract, payments);
  if (input.kind === "rental" && amount > summary.rentalBalance + 0.000001) throw new Error("Payment amount cannot exceed the rental balance");
  if (input.kind === "deposit" && amount > contract.depositAmount - summary.depositReceived + 0.000001) throw new Error("Payment amount cannot exceed the security deposit");
  if (input.kind === "deposit_refund" && amount > summary.depositHeld + 0.000001) throw new Error("Refund cannot exceed the held deposit");
  const sourceType = input.kind === "rental" ? "rental_payment" : input.kind === "deposit" ? "rental_deposit" : "rental_deposit_refund";
  return appendPaymentTransaction(workspaceId, {
    sourceModule: "car_rental", sourceType, sourceRecordId: contract.id, sourceSubrecordId: generateId(),
    direction: input.kind === "deposit_refund" ? "outgoing" : "incoming", amount, currency: contract.currency,
    paymentMethod: input.paymentMethod, paidAt: input.paidAt || new Date().toISOString(), counterpartyName: contract.customerName,
    referenceLabel: contract.contractNo, note: normalizeText(input.note), createdBy: input.createdBy || null,
    accountId: input.accountId ?? null, accountNameSnapshot: input.accountNameSnapshot ?? null,
    metadata: {
      rentalContractId: contract.id,
      rentalContractNo: contract.contractNo,
      rentalPaymentKind: input.kind,
      businessPartnerId: contract.businessPartnerId || null,
    },
  });
}

export function toUISaleFromRentalContract(contract: RentalContract, vehicle: RentalVehicle | undefined, options: RentalSaleProjectionOptions): any {
  const amount = Number(contract.finalAmount || 0);
  const vehicleLabel = vehicle ? `${vehicle.make || ""} ${vehicle.model} · ${vehicle.plateNumber}`.trim() : contract.contractNo;
  return {
    id: contract.id, workspace_id: contract.workspaceId, cashier_id: contract.createdBy || "", total_amount: amount,
    settlement_currency: contract.currency, created_at: contract.actualPickupAt || contract.plannedPickupAt,
    updated_at: contract.updatedAt, origin: "car_rental", payment_method: null, cashier_name: options.serviceName,
    items: [{ id: `rental:${contract.id}`, sale_id: contract.id, product_id: "car_rental_service", product_name: vehicleLabel,
      product_sku: "CAR-RENTAL", product_category: options.serviceCategory, quantity: 1, unit_price: amount, total_price: amount,
      cost_price: 0, converted_cost_price: 0, original_currency: contract.currency, original_unit_price: amount,
      converted_unit_price: amount, settlement_currency: contract.currency, returned_quantity: 0, is_returned: false,
      product: { name: vehicleLabel, sku: "CAR-RENTAL", category: options.serviceCategory, can_be_returned: false } }],
    is_returned: false, has_partial_return: false, sequenceId: contract.contractNo, notes: contract.notes || null,
    partyName: contract.customerName, business_partner_id: contract.businessPartnerId || null, _isCarRental: true,
    _rentalContractId: contract.id, _rentalContractNo: contract.contractNo,
  };
}
