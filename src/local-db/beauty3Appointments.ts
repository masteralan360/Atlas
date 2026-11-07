import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { useQuery } from '@tanstack/react-query'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { addToOfflineMutations } from '@/local-db/offlineMutations'
import { queryKeys } from '@/query/queryKeys'
import {
  cancelWorkspaceDataHydration,
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress,
} from '@/workspace/workspaceDataFreshness'
import { isOnline } from '@/lib/network'
import {
  BEAUTY3_OTHER_PROCEDURE_TYPE,
  BEAUTY3_PROCEDURE_PRESET_CATEGORY,
  isBeauty3BuiltInProcedureType,
  isReservedBeauty3ProcedureName,
} from './beauty3Procedures'
import { db } from './database'
import type {
  BaseEntity,
  Beauty3Appointment,
  Beauty3Client,
  Beauty3MaritalStatus,
  Beauty3ProcedurePlace,
  CurrencyCode,
  PaymentTransaction,
} from './models'

export const BEAUTY3_APPOINTMENTS_TABLE = 'beauty3_appointments'
export const BEAUTY3_CLIENTS_TABLE = 'beauty3_clients'
export const BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE = 'beauty3_appointment_profit' as const

function normalizeRemoteBeauty3ProfitPayment(
  raw: Record<string, unknown>,
  fetchedAt: string,
): PaymentTransaction {
  const row = toCamelCase(raw)
  const amount = Number(row.amount)
  const currency = String(row.currency ?? '').toLowerCase()
  const direction = row.direction

  if (
    typeof row.id !== 'string'
    || typeof row.workspaceId !== 'string'
    || row.sourceModule !== 'clinical_appointments'
    || row.sourceType !== BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE
    || typeof row.sourceRecordId !== 'string'
    || (direction !== 'incoming' && direction !== 'outgoing')
    || !Number.isFinite(amount)
    || !['usd', 'eur', 'iqd', 'try'].includes(currency)
    || typeof row.paymentMethod !== 'string'
    || typeof row.paidAt !== 'string'
  ) {
    throw new Error('Invalid Beauty 3 profit payment response')
  }

  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : fetchedAt
  return {
    ...row,
    id: row.id,
    workspaceId: row.workspaceId,
    sourceModule: 'clinical_appointments',
    sourceType: BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
    sourceRecordId: row.sourceRecordId,
    sourceSubrecordId: typeof row.sourceSubrecordId === 'string' ? row.sourceSubrecordId : null,
    direction,
    amount,
    currency: currency as CurrencyCode,
    paymentMethod: row.paymentMethod as PaymentTransaction['paymentMethod'],
    paidAt: row.paidAt,
    counterpartyName: typeof row.counterpartyName === 'string' ? row.counterpartyName : null,
    referenceLabel: typeof row.referenceLabel === 'string' ? row.referenceLabel : null,
    note: typeof row.note === 'string' ? row.note : null,
    createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
    accountId: typeof row.accountId === 'string' ? row.accountId : null,
    accountNameSnapshot: typeof row.accountNameSnapshot === 'string' ? row.accountNameSnapshot : null,
    reversalOfTransactionId: typeof row.reversalOfTransactionId === 'string' ? row.reversalOfTransactionId : null,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : null,
    createdAt,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    version: Number.isInteger(Number(row.version)) ? Number(row.version) : 1,
    isDeleted: row.isDeleted === true,
    syncStatus: 'synced',
    lastSyncedAt: fetchedAt,
  } as PaymentTransaction
}

let profitPaymentHydrationSequence = 0

async function fetchRemoteBeauty3AppointmentProfitTransactions(
  workspaceId: string,
  appointmentIds: readonly string[],
  signal: AbortSignal,
) {
  const uniqueIds = [...new Set(appointmentIds.filter(Boolean))]
  if (uniqueIds.length === 0) return [] as PaymentTransaction[]

  const operationId = 'beauty3-profit-payments-' + String(++profitPaymentHydrationSequence)
  const freshnessTableName = 'beauty3_appointment_profit_payments'
  startWorkspaceDataHydration(workspaceId, 'supabase', freshnessTableName, operationId)

  try {
    const result = await runSupabaseAction('beauty3Appointments.profitPayments', () => (
      (getSupabaseClientForTable('payment_transactions') as any)
        .from('payment_transactions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('source_module', 'clinical_appointments')
        .eq('source_type', BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE)
        .in('source_record_id', uniqueIds)
        .abortSignal(signal)
    ))
    if (result.error) throw result.error
    signal.throwIfAborted()

    const fetchedAt = new Date().toISOString()
    const items: PaymentTransaction[] = (result.data ?? []).map((row: Record<string, unknown>) => (
      normalizeRemoteBeauty3ProfitPayment(row, fetchedAt)
    ))
    signal.throwIfAborted()
    const cachedRows = await db.payment_transactions.bulkGet(items.map((item) => item.id))
    const rowsToCache = items.filter((item, index) => {
      const current = cachedRows[index]
      if (!current) return true
      if (current.syncStatus !== 'synced' || current.version > item.version) return false
      return current.updatedAt <= item.updatedAt
    })
    if (rowsToCache.length > 0) await db.payment_transactions.bulkPut(rowsToCache)

    updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', freshnessTableName, items.length, operationId)
    completeWorkspaceDataHydration(workspaceId, 'supabase', freshnessTableName, fetchedAt, operationId)
    recordWorkspaceDataFetch(workspaceId, 'supabase', fetchedAt, freshnessTableName)
    const keys: [string, typeof BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE, string][] = uniqueIds.map((id) => [
      workspaceId,
      BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
      id,
    ])
    return db.payment_transactions
      .where('[workspaceId+sourceType+sourceRecordId]')
      .anyOf(keys)
      .toArray()
  } catch (error) {
    if (signal.aborted) {
      cancelWorkspaceDataHydration(workspaceId, 'supabase', freshnessTableName, operationId)
    } else {
      failWorkspaceDataHydration(workspaceId, 'supabase', freshnessTableName, new Date().toISOString(), operationId)
    }
    throw error
  }
}

export function useBeauty3AppointmentProfitTransactions(
  workspaceId: string | undefined,
  appointmentIds: readonly string[],
  viewerUserId?: string | null,
) {
  const idsKey = JSON.stringify([...new Set(appointmentIds.filter(Boolean))])
  const uniqueIds = JSON.parse(idsKey) as string[]
  const online = useNetworkStatus()
  const localSource = workspaceId ? isLocalSource(workspaceId) : false
  const remoteQuery = useQuery({
    queryKey: queryKeys.beauty3Appointments.profitPayments(
      workspaceId ?? 'unscoped',
      uniqueIds,
      localSource ? 'local' : 'remote',
      { userId: viewerUserId },
    ),
    queryFn: ({ signal }) => fetchRemoteBeauty3AppointmentProfitTransactions(workspaceId!, uniqueIds, signal),
    enabled: Boolean(workspaceId && uniqueIds.length > 0 && online && !localSource),
  })

  const cachedTransactions = useLiveQuery(async () => {
    if (!workspaceId) return [] as PaymentTransaction[]
    if (uniqueIds.length === 0) return [] as PaymentTransaction[]

    const keys: [string, typeof BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE, string][] = uniqueIds.map((id) => [
      workspaceId,
      BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
      id,
    ])

    return db.payment_transactions
      .where('[workspaceId+sourceType+sourceRecordId]')
      .anyOf(keys)
      .toArray()
  }, [workspaceId, idsKey])

  const useLocalFallback = localSource || !online || remoteQuery.isError
  const transactions = useLocalFallback ? cachedTransactions ?? [] : remoteQuery.data ?? []
  return {
    transactions,
    isLoading: !useLocalFallback && remoteQuery.isFetching,
    error: remoteQuery.isError ? remoteQuery.error : null,
    isAvailable: localSource || (online && !remoteQuery.isError),
  }
}

export async function getBeauty3AppointmentProfitTransactions(
  workspaceId: string,
  appointmentId: string,
) {
  return db.payment_transactions
    .where('[workspaceId+sourceType+sourceRecordId]')
    .equals([workspaceId, BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE, appointmentId])
    .toArray()
}

export interface Beauty3AppointmentPageQuery {
  workspaceId: string
  page: number
  pageSize: number
  search: string
  dateFrom?: string
  dateTo?: string
  sourceMode: 'remote' | 'local'
  sort: 'procedureDate:desc,id:desc'
}

export interface Beauty3AppointmentPage {
  items: Beauty3Appointment[]
  totalCount: number
}

export type Beauty3ClientDraft = Pick<
  Beauty3Client,
  'name' | 'age' | 'maritalStatus' | 'address' | 'phoneNumber'
>

export interface Beauty3ClientSearchQuery {
  workspaceId: string
  search: string
  sourceMode: 'local' | 'remote'
}

export type Beauty3AppointmentDraft = Omit<
  Beauty3Appointment,
  keyof BaseEntity | 'createdBy'
>

export function getBeauty3AppointmentProcedureTypes(
  appointment: Pick<Beauty3Appointment, 'procedureType' | 'procedureTypes'>,
): string[] {
  const procedureTypes = Array.isArray(appointment.procedureTypes)
    ? appointment.procedureTypes.filter((value) => (
      typeof value === 'string' && value.trim().length > 0
    ))
    : []
  if (procedureTypes.length > 0) return procedureTypes
  return appointment.procedureType ? [appointment.procedureType] : []
}

const EMPTY_PAGE: Beauty3AppointmentPage = { items: [], totalCount: 0 }

function isLocalSource(workspaceId: string) {
  return isLocalWorkspaceMode(workspaceId) || isDemoWorkspaceMode(workspaceId)
}

function normalizeRemoteAppointment(raw: Record<string, unknown>): Beauty3Appointment {
  const row = toCamelCase(raw)
  const currency = String(row.currency ?? '').toLowerCase()
  const maritalStatus = row.maritalStatus
  const procedurePlace = row.procedurePlace
  const age = Number(row.age)
  const appointmentTotal = Number(row.appointmentTotal)
  const totalProfit = Number(row.totalProfit)

  if (
    typeof row.id !== 'string'
    || typeof row.workspaceId !== 'string'
    || typeof row.name !== 'string'
    || !Number.isInteger(age)
    || !['single', 'married'].includes(String(maritalStatus))
    || typeof row.address !== 'string'
    || typeof row.phoneNumber !== 'string'
    || !['sulaymaniyah', 'erbil'].includes(String(procedurePlace))
    || typeof row.procedureDate !== 'string'
    || !Number.isFinite(appointmentTotal)
    || !Number.isFinite(totalProfit)
    || !['usd', 'eur', 'iqd', 'try'].includes(currency)
  ) {
    throw new Error('Invalid Beauty 3 appointment response')
  }

  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString()
  const procedureType = typeof row.procedureType === 'string' && row.procedureType.trim()
    ? row.procedureType
    : null
  const remoteProcedureTypes = Array.isArray(row.procedureTypes)
    ? row.procedureTypes.filter((value): value is string => (
      typeof value === 'string' && value.trim().length > 0
    ))
    : []
  const procedureTypes = remoteProcedureTypes.length > 0
    ? remoteProcedureTypes
    : procedureType
      ? [procedureType]
      : []

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    clientId: typeof row.clientId === 'string' ? row.clientId : null,
    name: row.name,
    age,
    maritalStatus: maritalStatus as Beauty3MaritalStatus,
    address: row.address,
    phoneNumber: row.phoneNumber,
    procedureTypes,
    procedureType: procedureType ?? procedureTypes[0] ?? null,
    procedureTypeOther: typeof row.procedureTypeOther === 'string' && row.procedureTypeOther.trim()
      ? row.procedureTypeOther
      : null,
    procedurePlace: procedurePlace as Beauty3ProcedurePlace,
    procedureDate: row.procedureDate,
    appointmentTotal,
    totalProfit,
    currency: currency as CurrencyCode,
    createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : updatedAt,
    updatedAt,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : 1,
    isDeleted: row.isDeleted === true,
    syncStatus: 'synced',
    lastSyncedAt: updatedAt,
  }
}

function normalizeRemoteClient(raw: Record<string, unknown>): Beauty3Client {
  const row = toCamelCase(raw)
  const age = Number(row.age)
  const maritalStatus = row.maritalStatus
  if (
    typeof row.id !== 'string'
    || typeof row.workspaceId !== 'string'
    || typeof row.name !== 'string'
    || !Number.isInteger(age)
    || !['single', 'married'].includes(String(maritalStatus))
    || typeof row.address !== 'string'
    || typeof row.phoneNumber !== 'string'
  ) {
    throw new Error('Invalid Beauty 3 client response')
  }
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString()
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    age,
    maritalStatus: maritalStatus as Beauty3MaritalStatus,
    address: row.address,
    phoneNumber: row.phoneNumber,
    createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : updatedAt,
    updatedAt,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : 1,
    isDeleted: row.isDeleted === true,
    syncStatus: 'synced',
    lastSyncedAt: updatedAt,
  }
}

async function cacheRemoteBeauty3ClientsByIds(
  workspaceId: string,
  clientIds: readonly string[],
  signal: AbortSignal,
) {
  const uniqueIds = [...new Set(clientIds.filter(Boolean))]
  if (uniqueIds.length === 0) return
  const operationId = 'beauty3-clients-page-' + String(++hydrationSequence)
  startWorkspaceDataHydration(workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, operationId)
  try {
    const result = await runSupabaseAction('beauty3Clients.pageRelated', () => (
      (getSupabaseClientForTable(BEAUTY3_CLIENTS_TABLE) as any)
        .from(BEAUTY3_CLIENTS_TABLE)
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_deleted', false)
        .in('id', uniqueIds)
        .abortSignal(signal)
    ))
    if (result.error) throw result.error
    signal.throwIfAborted()
    const fetchedAt = new Date().toISOString()
    const clients: Beauty3Client[] = (result.data ?? []).map((row: Record<string, unknown>) => normalizeRemoteClient(row))
    const cachedRows = await db.beauty3_clients.bulkGet(clients.map((item) => item.id))
    const rowsToCache = clients.filter((item, index) => {
      const current = cachedRows[index]
      if (!current) return true
      if (current.syncStatus !== 'synced' || current.version > item.version) return false
      return current.updatedAt <= item.updatedAt
    })
    if (rowsToCache.length > 0) await db.beauty3_clients.bulkPut(rowsToCache)
    updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, clients.length, operationId)
    completeWorkspaceDataHydration(workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, fetchedAt, operationId)
    recordWorkspaceDataFetch(workspaceId, 'supabase', fetchedAt, BEAUTY3_CLIENTS_TABLE)
  } catch (error) {
    if (signal.aborted) cancelWorkspaceDataHydration(workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, operationId)
    else failWorkspaceDataHydration(workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, new Date().toISOString(), operationId)
    throw error
  }
}

function matchesClientSearch(client: Beauty3Client, search: string) {
  const normalized = search.trim().toLocaleLowerCase()
  return !normalized || client.name.toLocaleLowerCase().includes(normalized)
    || client.phoneNumber.toLocaleLowerCase().includes(normalized)
}

async function fetchLocalBeauty3Clients(query: Beauty3ClientSearchQuery) {
  if (!query.workspaceId) return [] as Beauty3Client[]
  return db.beauty3_clients
    .where('[workspaceId+updatedAt]')
    .between([query.workspaceId, Dexie.minKey], [query.workspaceId, Dexie.maxKey], true, true)
    .reverse()
    .filter((client) => !client.isDeleted && matchesClientSearch(client, query.search))
    .limit(25)
    .toArray()
}

async function fetchRemoteBeauty3Clients(query: Beauty3ClientSearchQuery, signal: AbortSignal) {
  const operationId = 'beauty3-clients-' + String(++hydrationSequence)
  startWorkspaceDataHydration(query.workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, operationId)
  try {
    const client = getSupabaseClientForTable(BEAUTY3_CLIENTS_TABLE) as any
    const baseRequest = () => client
      .from(BEAUTY3_CLIENTS_TABLE)
      .select('*')
      .eq('workspace_id', query.workspaceId)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })

    let remoteRows: Record<string, unknown>[]
    const search = query.search.trim().replace(/[%_\\]/g, '')
    if (search) {
      const [nameResult, phoneResult] = await Promise.all([
        runSupabaseAction('beauty3Clients.searchByName', () => (
          baseRequest().ilike('name', '%' + search + '%').limit(25).abortSignal(signal)
        )),
        runSupabaseAction('beauty3Clients.searchByPhone', () => (
          baseRequest().ilike('phone_number', '%' + search + '%').limit(25).abortSignal(signal)
        )),
      ])
      if (nameResult.error) throw nameResult.error
      if (phoneResult.error) throw phoneResult.error
      remoteRows = [...(nameResult.data ?? []), ...(phoneResult.data ?? [])]
    } else {
      const result = await runSupabaseAction('beauty3Clients.listRecent', () => (
        baseRequest().limit(25).abortSignal(signal)
      ))
      if (result.error) throw result.error
      remoteRows = result.data ?? []
    }
    signal.throwIfAborted()
    const byId = new Map<string, Beauty3Client>()
    for (const row of remoteRows) {
      const normalized = normalizeRemoteClient(row)
      byId.set(normalized.id, normalized)
    }
    const items = [...byId.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, 25)
    const cachedRows = await db.beauty3_clients.bulkGet(items.map((item) => item.id))
    const rowsToCache = items.filter((item, index) => {
      const current = cachedRows[index]
      if (!current) return true
      if (current.syncStatus !== 'synced' || current.version > item.version) return false
      return current.updatedAt <= item.updatedAt
    })
    if (rowsToCache.length > 0) await db.beauty3_clients.bulkPut(rowsToCache)
    const fetchedAt = new Date().toISOString()
    updateWorkspaceDataHydrationProgress(query.workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, items.length, operationId)
    completeWorkspaceDataHydration(query.workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, fetchedAt, operationId)
    recordWorkspaceDataFetch(query.workspaceId, 'supabase', fetchedAt, BEAUTY3_CLIENTS_TABLE)
    return items
  } catch (error) {
    if (signal.aborted) cancelWorkspaceDataHydration(query.workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, operationId)
    else failWorkspaceDataHydration(query.workspaceId, 'supabase', BEAUTY3_CLIENTS_TABLE, new Date().toISOString(), operationId)
    throw error
  }
}

export function useBeauty3ClientSearch(
  query: Beauty3ClientSearchQuery,
  viewerUserId?: string | null,
) {
  const networkOnline = useNetworkStatus()
  const localSource = isLocalSource(query.workspaceId)
  const remoteQuery = useQuery({
    queryKey: queryKeys.beauty3Appointments.clients(query.workspaceId, query.search, localSource ? 'local' : 'remote', viewerUserId),
    queryFn: ({ signal }) => fetchRemoteBeauty3Clients(query, signal),
    enabled: Boolean(query.workspaceId) && networkOnline && !localSource,
  })
  const useLocalFallback = localSource || !networkOnline || remoteQuery.isError
  const localClients = useLiveQuery(
    () => useLocalFallback ? fetchLocalBeauty3Clients(query) : Promise.resolve([] as Beauty3Client[]),
    [query.workspaceId, query.search, useLocalFallback],
  )
  return {
    clients: useLocalFallback ? localClients ?? [] : remoteQuery.data ?? [],
    isLoading: localSource || !networkOnline ? localClients === undefined : remoteQuery.isFetching,
    error: remoteQuery.isError ? remoteQuery.error : null,
  }
}

function toRemoteClientPayload(client: Beauty3Client) {
  const { syncStatus: _syncStatus, lastSyncedAt: _lastSyncedAt, ...payload } = client
  return toSnakeCase(payload as unknown as Record<string, unknown>)
}

async function persistBeauty3ClientRemote(client: Beauty3Client, operation: 'create' | 'update') {
  if (isLocalSource(client.workspaceId)) return false
  if (isOnline()) {
    try {
      const response = await runSupabaseAction('beauty3Clients.save', () => (
        (getSupabaseClientForTable(BEAUTY3_CLIENTS_TABLE) as any)
          .from(BEAUTY3_CLIENTS_TABLE)
          .upsert(toRemoteClientPayload(client), { onConflict: 'id' })
          .select('id')
          .single()
      ))
      if (response.error) throw response.error
      const syncedAt = new Date().toISOString()
      await db.beauty3_clients.update(client.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
      return false
    } catch {
      // Preserve the local profile and queue it through the normal sync worker.
    }
  }
  await addToOfflineMutations(
    BEAUTY3_CLIENTS_TABLE,
    client.id,
    operation,
    client as unknown as Record<string, unknown>,
    client.workspaceId,
  )
  return true
}

export async function saveBeauty3Client(
  draft: Beauty3ClientDraft,
  workspaceId: string,
  createdBy?: string | null,
  clientId?: string | null,
) {
  if (!workspaceId || !draft.name.trim() || !Number.isInteger(draft.age) || draft.age < 0
    || !['single', 'married'].includes(draft.maritalStatus) || !draft.address.trim() || !draft.phoneNumber.trim()) {
    throw new Error('Invalid Beauty 3 client')
  }
  let existing = clientId ? await db.beauty3_clients.get(clientId) : undefined
  if (clientId && (!existing || existing.workspaceId !== workspaceId || existing.isDeleted)) {
    throw new Error('Beauty 3 client not found')
  }
  if (!existing) {
    const phoneMatches = await db.beauty3_clients
      .where('[workspaceId+phoneNumber]')
      .equals([workspaceId, draft.phoneNumber.trim()])
      .filter((candidate) => !candidate.isDeleted
        && candidate.name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase())
      .limit(5)
      .toArray()
    existing = phoneMatches[0]
  }
  const now = new Date().toISOString()
  const localSource = isLocalSource(workspaceId)
  const profile: Beauty3Client = {
    ...draft,
    name: draft.name.trim(),
    address: draft.address.trim(),
    phoneNumber: draft.phoneNumber.trim(),
    id: existing?.id ?? generateId(),
    workspaceId,
    createdBy: existing?.createdBy ?? createdBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    syncStatus: localSource ? 'synced' : 'pending',
    lastSyncedAt: localSource ? now : null,
  }
  await db.beauty3_clients.put(profile)
  try {
    const syncPending = await persistBeauty3ClientRemote(profile, existing ? 'update' : 'create')
    return { client: profile, syncPending }
  } catch (error) {
    if (existing) await db.beauty3_clients.put(existing)
    else await db.beauty3_clients.delete(profile.id)
    throw error
  }
}

function matchesSearch(appointment: Beauty3Appointment, search: string) {
  const normalized = search.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [
    appointment.name,
    appointment.address,
    appointment.phoneNumber,
    appointment.procedureType ?? '',
    (appointment.procedureTypes ?? []).join(' '),
    appointment.procedureTypeOther ?? '',
  ].some((value) => value.toLocaleLowerCase().includes(normalized))
}

async function fetchLocalBeauty3AppointmentPage(
  query: Beauty3AppointmentPageQuery,
): Promise<Beauty3AppointmentPage> {
  if (!query.workspaceId) return EMPTY_PAGE

  const from = query.dateFrom ?? Dexie.minKey
  const to = query.dateTo ?? Dexie.maxKey
  let collection = db.beauty3_appointments
    .where('[workspaceId+procedureDate]')
    .between([query.workspaceId, from], [query.workspaceId, to], true, true)
    .reverse()
    .filter((appointment) => (
      !appointment.isDeleted
      && (!query.dateFrom || appointment.procedureDate >= query.dateFrom)
      && (!query.dateTo || appointment.procedureDate < query.dateTo)
      && matchesSearch(appointment, query.search)
    ))

  const totalCount = await collection.count()
  const items = await collection
    .offset((query.page - 1) * query.pageSize)
    .limit(query.pageSize)
    .toArray()

  return { items, totalCount }
}

let hydrationSequence = 0

async function fetchRemoteBeauty3AppointmentPage(
  query: Beauty3AppointmentPageQuery,
  signal: AbortSignal,
): Promise<Beauty3AppointmentPage> {
  const operationId = 'beauty3-page-' + String(++hydrationSequence)
  startWorkspaceDataHydration(query.workspaceId, 'supabase', BEAUTY3_APPOINTMENTS_TABLE, operationId)

  try {
    let request: any = (getSupabaseClientForTable(BEAUTY3_APPOINTMENTS_TABLE) as any)
      .from(BEAUTY3_APPOINTMENTS_TABLE)
      .select('*', { count: 'exact' })
      .eq('workspace_id', query.workspaceId)
      .eq('is_deleted', false)

    if (query.dateFrom) request = request.gte('procedure_date', query.dateFrom)
    if (query.dateTo) request = request.lt('procedure_date', query.dateTo)

    const search = query.search.trim()
    if (search) {
      const quotedSearch = search.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const pattern = '"%' + quotedSearch + '%"'
      request = request.or(
        'name.ilike.' + pattern
        + ',address.ilike.' + pattern
        + ',phone_number.ilike.' + pattern
        + ',procedure_type.ilike.' + pattern
        + ',procedure_type_other.ilike.' + pattern,
      )
    }

    const offset = (query.page - 1) * query.pageSize
    const result = await runSupabaseAction('beauty3Appointments.list', () => (
      request
        .order('procedure_date', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + query.pageSize - 1)
        .abortSignal(signal)
    ))

    if (result.error) throw result.error
    const items: Beauty3Appointment[] = (result.data ?? []).map(
      (row: Record<string, unknown>) => normalizeRemoteAppointment(row),
    )
    const fetchedAt = new Date().toISOString()

    const cachedRows = await db.beauty3_appointments.bulkGet(items.map((item) => item.id))
    const rowsToCache = items.filter((item, index) => {
      const current = cachedRows[index]
      if (!current) return true
      if (current.syncStatus !== 'synced' || current.version > item.version) return false
      return current.updatedAt <= item.updatedAt
    })
    if (rowsToCache.length > 0) await db.beauty3_appointments.bulkPut(rowsToCache)

    try {
      await cacheRemoteBeauty3ClientsByIds(
        query.workspaceId,
        items.map((appointment) => appointment.clientId ?? ''),
        signal,
      )
    } catch (clientError) {
      if (signal.aborted) throw clientError
      console.warn('[Beauty3Appointments] Could not cache client profiles for this page:', clientError)
    }

    updateWorkspaceDataHydrationProgress(
      query.workspaceId,
      'supabase',
      BEAUTY3_APPOINTMENTS_TABLE,
      items.length,
      operationId,
    )
    completeWorkspaceDataHydration(
      query.workspaceId,
      'supabase',
      BEAUTY3_APPOINTMENTS_TABLE,
      fetchedAt,
      operationId,
    )
    recordWorkspaceDataFetch(
      query.workspaceId,
      'supabase',
      fetchedAt,
      BEAUTY3_APPOINTMENTS_TABLE,
    )

    return {
      items,
      totalCount: Number(result.count ?? 0),
    }
  } catch (error) {
    if (signal.aborted) {
      cancelWorkspaceDataHydration(
        query.workspaceId,
        'supabase',
        BEAUTY3_APPOINTMENTS_TABLE,
        operationId,
      )
    } else {
      failWorkspaceDataHydration(
        query.workspaceId,
        'supabase',
        BEAUTY3_APPOINTMENTS_TABLE,
        new Date().toISOString(),
        operationId,
      )
    }
    throw error
  }
}

export function useBeauty3AppointmentPage(
  query: Beauty3AppointmentPageQuery,
  viewerUserId?: string | null,
) {
  const networkOnline = useNetworkStatus()
  const localSource = isLocalSource(query.workspaceId)
  const remoteQuery = useQuery({
    queryKey: queryKeys.beauty3Appointments.page(query, { userId: viewerUserId }),
    queryFn: ({ signal }) => fetchRemoteBeauty3AppointmentPage(query, signal),
    enabled: Boolean(query.workspaceId) && !localSource && networkOnline,
  })

  const useLocalFallback = localSource || !networkOnline || remoteQuery.isError
  const localPage = useLiveQuery(
    () => useLocalFallback ? fetchLocalBeauty3AppointmentPage(query) : Promise.resolve(EMPTY_PAGE),
    [
      query.workspaceId,
      query.page,
      query.pageSize,
      query.search,
      query.dateFrom,
      query.dateTo,
      useLocalFallback,
    ],
  )

  const page = localSource || !networkOnline
    ? localPage ?? EMPTY_PAGE
    : remoteQuery.data ?? (remoteQuery.isError ? localPage ?? EMPTY_PAGE : EMPTY_PAGE)

  return {
    ...page,
    isLoading: localSource || !networkOnline
      ? localPage === undefined
      : remoteQuery.isFetching,
    error: remoteQuery.isError ? remoteQuery.error : null,
    isError: remoteQuery.isError,
  }
}

function toRemotePayload(appointment: Beauty3Appointment) {
  const {
    syncStatus: _syncStatus,
    lastSyncedAt: _lastSyncedAt,
    ...payload
  } = appointment
  return toSnakeCase(payload as unknown as Record<string, unknown>)
}

async function persistBeauty3AppointmentRemote(
  appointment: Beauty3Appointment,
  operation: 'create' | 'update',
) {
  if (isLocalSource(appointment.workspaceId)) return false

  if (isOnline()) {
    try {
      const response = await runSupabaseAction('beauty3Appointments.save', () => (
        (getSupabaseClientForTable(BEAUTY3_APPOINTMENTS_TABLE) as any)
          .from(BEAUTY3_APPOINTMENTS_TABLE)
          .upsert(toRemotePayload(appointment), { onConflict: 'id' })
          .select('id')
          .single()
      ))
      if (response.error) throw response.error
      const syncedAt = new Date().toISOString()
      await db.beauty3_appointments.update(appointment.id, {
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
      })
      return false
    } catch {
      // Queue the locally committed row for the standard workspace sync worker.
    }
  }

  await addToOfflineMutations(
    BEAUTY3_APPOINTMENTS_TABLE,
    appointment.id,
    operation,
    appointment as unknown as Record<string, unknown>,
    appointment.workspaceId,
  )
  return true
}

function validateDraft(draft: Beauty3AppointmentDraft) {
  const procedureTypes = getBeauty3AppointmentProcedureTypes(draft)
  return Boolean(
    draft.name.trim()
    && Number.isInteger(draft.age)
    && draft.age >= 0
    && (draft.maritalStatus === 'single' || draft.maritalStatus === 'married')
    && draft.address.trim()
    && draft.phoneNumber.trim()
    && typeof draft.procedureType === 'string'
    && draft.procedureType.trim().length > 0
    && procedureTypes.length > 0
    && new Set(procedureTypes).size === procedureTypes.length
    && procedureTypes.every((procedureType) => procedureType.trim().length > 0)
    && draft.procedureType === procedureTypes[0]
    && (
      procedureTypes.includes(BEAUTY3_OTHER_PROCEDURE_TYPE)
        ? Boolean(draft.procedureTypeOther?.trim())
        : !draft.procedureTypeOther?.trim()
    )
    && (draft.procedurePlace === 'sulaymaniyah' || draft.procedurePlace === 'erbil')
    && /^\d{4}-\d{2}-\d{2}$/.test(draft.procedureDate)
    && Number.isFinite(draft.appointmentTotal)
    && draft.appointmentTotal >= 0
    && Number.isFinite(draft.totalProfit)
    && draft.totalProfit >= 0
    && ['usd', 'eur', 'iqd', 'try'].includes(draft.currency)
  )
}

export class InvalidBeauty3ProcedureTypeError extends Error {
  constructor() {
    super('The selected procedure is no longer available')
    this.name = 'InvalidBeauty3ProcedureTypeError'
  }
}

export class InvalidBeauty3ClientError extends Error {
  constructor() {
    super('The selected client is no longer available')
    this.name = 'InvalidBeauty3ClientError'
  }
}

async function getBeauty3ClientForAppointment(clientId: string, workspaceId: string) {
  const cached = await db.beauty3_clients.get(clientId)
  if (!cached || cached.workspaceId !== workspaceId || cached.isDeleted) {
    throw new InvalidBeauty3ClientError()
  }
  if (isLocalSource(workspaceId) || !isOnline() || cached.syncStatus !== 'synced') return cached

  const result = await runSupabaseAction('beauty3Clients.validateSelection', () => (
    (getSupabaseClientForTable(BEAUTY3_CLIENTS_TABLE) as any)
      .from(BEAUTY3_CLIENTS_TABLE)
      .select('*')
      .eq('id', clientId)
      .eq('workspace_id', workspaceId)
      .eq('is_deleted', false)
      .maybeSingle()
  ))
  if (result.error) throw result.error
  if (!result.data) throw new InvalidBeauty3ClientError()

  const remote = normalizeRemoteClient(result.data as Record<string, unknown>)
  const current = await db.beauty3_clients.get(clientId)
  if (!current || (current.syncStatus === 'synced' && current.updatedAt <= remote.updatedAt)) {
    await db.beauty3_clients.put(remote)
  }
  return current && current.syncStatus !== 'synced' ? current : remote
}

async function validateProcedureType(draft: Beauty3AppointmentDraft, workspaceId: string) {
  const procedureTypes = getBeauty3AppointmentProcedureTypes(draft)
  if (procedureTypes.length === 0) return false

  for (const procedureType of procedureTypes) {
    if (procedureType === BEAUTY3_OTHER_PROCEDURE_TYPE) {
      if (!draft.procedureTypeOther?.trim()) return false
      continue
    }
    if (isBeauty3BuiltInProcedureType(procedureType)) continue
    if (isReservedBeauty3ProcedureName(procedureType)) return false

    const preset = await db.clinical_presets
      .where('[workspaceId+category]')
      .equals([workspaceId, BEAUTY3_PROCEDURE_PRESET_CATEGORY])
      .filter((item) => (
        !item.isDeleted
        && item.isActive
        && item.name === procedureType
      ))
      .first()

    if (!preset) return false
  }

  return true
}

export async function saveBeauty3Appointment(
  draft: Beauty3AppointmentDraft,
  workspaceId: string,
  createdBy?: string | null,
  appointmentId?: string,
) {
  if (!workspaceId || !validateDraft(draft)) {
    throw new Error('Invalid Beauty 3 appointment')
  }
  if (!await validateProcedureType(draft, workspaceId)) {
    throw new InvalidBeauty3ProcedureTypeError()
  }

  const existing = appointmentId
    ? await db.beauty3_appointments.get(appointmentId)
    : undefined
  if (appointmentId && (!existing || existing.workspaceId !== workspaceId)) {
    throw new Error('Beauty 3 appointment not found')
  }

  const now = new Date().toISOString()
  const localSource = isLocalSource(workspaceId)
  const procedureTypes = getBeauty3AppointmentProcedureTypes(draft)
  const requestedClientId = draft.clientId ?? existing?.clientId ?? null
  let client: Beauty3Client | undefined
  let clientSyncPending = false
  if (requestedClientId) {
    client = await getBeauty3ClientForAppointment(requestedClientId, workspaceId)
    if (existing) {
      const savedClient = await saveBeauty3Client({
        name: draft.name,
        age: draft.age,
        maritalStatus: draft.maritalStatus,
        address: draft.address,
        phoneNumber: draft.phoneNumber,
      }, workspaceId, createdBy, client.id)
      client = savedClient.client
      clientSyncPending = savedClient.syncPending
    }
  } else {
    const savedClient = await saveBeauty3Client({
      name: draft.name,
      age: draft.age,
      maritalStatus: draft.maritalStatus,
      address: draft.address,
      phoneNumber: draft.phoneNumber,
    }, workspaceId, createdBy)
    client = savedClient.client
    clientSyncPending = savedClient.syncPending
  }
  if (!client) throw new InvalidBeauty3ClientError()
  const appointment: Beauty3Appointment = {
    ...draft,
    clientId: client.id,
    name: client.name,
    age: client.age,
    maritalStatus: client.maritalStatus,
    address: client.address,
    phoneNumber: client.phoneNumber,
    procedureTypes,
    procedureType: procedureTypes[0] ?? draft.procedureType,
    id: existing?.id ?? generateId(),
    workspaceId,
    createdBy: existing?.createdBy ?? createdBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    syncStatus: localSource ? 'synced' : 'pending',
    lastSyncedAt: localSource ? now : null,
  }

  await db.beauty3_appointments.put(appointment)
  try {
    const syncPending = await persistBeauty3AppointmentRemote(
      appointment,
      existing ? 'update' : 'create',
    )
    return { appointment, syncPending: syncPending || clientSyncPending }
  } catch (error) {
    if (existing) await db.beauty3_appointments.put(existing)
    else await db.beauty3_appointments.delete(appointment.id)
    throw error
  }
}

export async function deleteBeauty3Appointment(id: string, workspaceId: string) {
  const existing = await db.beauty3_appointments.get(id)
  if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) return false

  const now = new Date().toISOString()
  const appointment: Beauty3Appointment = {
    ...existing,
    isDeleted: true,
    updatedAt: now,
    version: existing.version + 1,
    syncStatus: isLocalSource(workspaceId) ? 'synced' : 'pending',
    lastSyncedAt: isLocalSource(workspaceId) ? now : null,
  }
  await db.beauty3_appointments.put(appointment)
  try {
    const syncPending = await persistBeauty3AppointmentRemote(appointment, 'update')
    return { deleted: true, syncPending }
  } catch (error) {
    await db.beauty3_appointments.put(existing)
    throw error
  }
}
