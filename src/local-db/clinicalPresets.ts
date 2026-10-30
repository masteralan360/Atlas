import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './database'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { generateId, toSnakeCase } from '@/lib/utils'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isOnline } from '@/lib/network'
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { fetchTableFromSupabase } from './hooks'
import { addToOfflineMutations } from './offlineMutations'
import type { ClinicalPreset, BaseEntity, ClinicalRegistryType, UserSelectableClinicalRegistryType } from './models'
import {
  CLINICAL_REGISTRY_PRESET_CATEGORY,
  DEFAULT_CLINICAL_REGISTRY_TYPE,
  getClinicalRegistryPresetId,
  normalizeClinicalRegistryType,
} from './clinicalRegistryPreset'
import { BEAUTY3_PROCEDURE_PRESET_CATEGORY } from './beauty3Procedures'

const PRESETS_TABLE = 'clinical_presets'
const BEAUTY3_APPOINTMENTS_TABLE = 'beauty3_appointments'
const BEAUTY3_PROCEDURE_IN_USE_MARKER = 'beauty3_procedure_in_use'

export class Beauty3ProcedureInUseError extends Error {
  constructor() {
    super('The procedure is assigned to active appointments')
    this.name = 'Beauty3ProcedureInUseError'
  }
}

export class Beauty3ProcedureUsageCheckError extends Error {
  constructor() {
    super('The procedure usage could not be checked')
    this.name = 'Beauty3ProcedureUsageCheckError'
  }
}

function isBeauty3ProcedureInUseRemoteError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.includes(BEAUTY3_PROCEDURE_IN_USE_MARKER),
  )
}

async function ensureBeauty3ProcedureUnused(preset: ClinicalPreset, workspaceId: string) {
  let localAppointments: number
  try {
    const matchingAppointments = db.beauty3_appointments
      .where('[workspaceId+procedureType]')
      .equals([workspaceId, preset.name])
    localAppointments = await matchingAppointments
      .filter((appointment) => !appointment.isDeleted && (
        !shouldUseCloudBusinessData(workspaceId) || appointment.syncStatus !== 'synced'
      ))
      .count()
  } catch {
    throw new Beauty3ProcedureUsageCheckError()
  }

  if (localAppointments > 0) throw new Beauty3ProcedureInUseError()
  if (!shouldUseCloudBusinessData(workspaceId)) return
  if (!isOnline()) throw new Beauty3ProcedureUsageCheckError()

  try {
    const { count, error } = await runSupabaseAction('beauty3Appointments.checkProcedureUsage', () => (
      (getSupabaseClientForTable(BEAUTY3_APPOINTMENTS_TABLE) as any)
        .from(BEAUTY3_APPOINTMENTS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('procedure_type', preset.name)
        .eq('is_deleted', false)
    ))
    if (error) throw error
    if (Number(count ?? 0) > 0) throw new Beauty3ProcedureInUseError()
  } catch (error) {
    if (error instanceof Beauty3ProcedureInUseError) throw error
    throw new Beauty3ProcedureUsageCheckError()
  }
}

type ClinicalPresetsSyncEntity = Record<string, unknown> & {
  id: string
  workspaceId: string
  version: number
  updatedAt: string
}

const tableByName = {
  [PRESETS_TABLE]: db.clinical_presets,
} as const

function shouldUseCloudBusinessData(workspaceId?: string | null) {
  return !!workspaceId
    && !isLocalWorkspaceMode(workspaceId)
    && !isDemoWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
  if (!shouldUseCloudBusinessData(workspaceId)) {
    return { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
  }
  return { syncStatus: 'pending' as const, lastSyncedAt: null }
}

function prepareEntityForSync<T extends ClinicalPreset>(entity: T, workspaceId: string, timestamp: string): T {
  const syncMeta = getSyncMetadata(workspaceId, timestamp)
  return { ...entity, ...syncMeta }
}

async function upsertClinicalPresetEntity<T extends ClinicalPreset>(entity: T, workspaceId: string, timestamp: string) {
  const prepared = prepareEntityForSync(entity, workspaceId, timestamp)
  const dexieTable = tableByName[PRESETS_TABLE]
  await dexieTable.put(prepared as any)
  await queueClinicalPresetsUpsert(prepared as unknown as ClinicalPresetsSyncEntity, workspaceId)
}

function sanitizeForSupabase<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const exclude = new Set(['syncStatus', 'lastSyncedAt'])
  const result: Record<string, unknown> = {}
  for (const key in obj) {
    if (obj[key] === undefined || exclude.has(key)) continue
    result[key] = obj[key]
  }
  return result
}

async function queueClinicalPresetsUpsert(entity: ClinicalPresetsSyncEntity, workspaceId: string) {
  const dexieTable = tableByName[PRESETS_TABLE]
  if (shouldUseCloudBusinessData(workspaceId) && isOnline()) {
    const supabaseClient = getSupabaseClientForTable(PRESETS_TABLE)
    const { error } = await runSupabaseAction(`clinical.upsert.${PRESETS_TABLE}`, () =>
      supabaseClient
        .from(PRESETS_TABLE)
        .upsert(toSnakeCase(sanitizeForSupabase(entity)), { onConflict: 'id' })
        .select()
        .single()
    )
    if (error) {
      await addToOfflineMutations(PRESETS_TABLE, entity.id, 'update', entity as any, workspaceId)
    } else {
      const current = await dexieTable.get(entity.id)
      if (current?.version === entity.version && current.updatedAt === entity.updatedAt) {
        await dexieTable.update(entity.id, {
          syncStatus: 'synced',
          lastSyncedAt: new Date().toISOString(),
        } as any)
      }
    }
  } else if (shouldUseCloudBusinessData(workspaceId)) {
    await addToOfflineMutations(PRESETS_TABLE, entity.id, 'update', entity as any, workspaceId)
  }
}

async function softDeleteClinicalPresetEntity(id: string, workspaceId: string) {
  const timestamp = new Date().toISOString()
  const dexieTable = tableByName[PRESETS_TABLE]
  const existing = await dexieTable.get(id)
  if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) return

  if (existing.category === BEAUTY3_PROCEDURE_PRESET_CATEGORY) {
    await ensureBeauty3ProcedureUnused(existing as ClinicalPreset, workspaceId)

    if (shouldUseCloudBusinessData(workspaceId)) {
      const supabaseClient = getSupabaseClientForTable(PRESETS_TABLE)
      const { error } = await runSupabaseAction(`clinical.softDelete.${PRESETS_TABLE}`, () =>
        supabaseClient
          .from(PRESETS_TABLE)
          .update({ is_deleted: true, updated_at: timestamp })
          .eq('id', id)
      )
      if (error) {
        if (isBeauty3ProcedureInUseRemoteError(error)) {
          throw new Beauty3ProcedureInUseError()
        }
        throw new Beauty3ProcedureUsageCheckError()
      }
    }

    await dexieTable.update(id, {
      isDeleted: true,
      updatedAt: timestamp,
      ...getSyncMetadata(workspaceId, timestamp),
    } as any)
    return
  }

  const syncMeta = getSyncMetadata(workspaceId, timestamp)
  await dexieTable.update(id, {
    isDeleted: true,
    updatedAt: timestamp,
    ...syncMeta,
  })

  if (shouldUseCloudBusinessData(workspaceId) && isOnline()) {
    const supabaseClient = getSupabaseClientForTable(PRESETS_TABLE)
    const { error } = await runSupabaseAction(`clinical.softDelete.${PRESETS_TABLE}`, () =>
      supabaseClient
        .from(PRESETS_TABLE)
        .update({ is_deleted: true, updated_at: timestamp })
        .eq('id', id)
    )
    if (error) {
      await addToOfflineMutations(PRESETS_TABLE, id, 'delete', { id, workspaceId } as any, workspaceId)
    } else {
      const current = await dexieTable.get(id)
      if (current?.updatedAt === timestamp) {
        await dexieTable.update(id, {
          syncStatus: 'synced',
          lastSyncedAt: new Date().toISOString(),
        } as any)
      }
    }
  } else if (shouldUseCloudBusinessData(workspaceId)) {
    await addToOfflineMutations(PRESETS_TABLE, id, 'delete', { id, workspaceId } as any, workspaceId)
  }
}

export function syncClinicalPreset(data: ClinicalPresetsSyncEntity, _workspaceId: string) {
  const timestamp = new Date().toISOString()
  const dexieTable = tableByName[PRESETS_TABLE]
  return dexieTable.put({ ...data, syncStatus: 'synced', lastSyncedAt: timestamp } as any)
}

export function syncClinicalPresetSoftDelete(id: string) {
  const timestamp = new Date().toISOString()
  const dexieTable = tableByName[PRESETS_TABLE]
  return dexieTable.update(id, { isDeleted: true, updatedAt: timestamp, syncStatus: 'synced' })
}

export function markClinicalPresetsSynced(ids: string[], timestamp: string) {
  const dexieTable = tableByName[PRESETS_TABLE]
  return Promise.all(ids.map((id) => dexieTable.update(id, { syncStatus: 'synced', lastSyncedAt: timestamp })))
}

function useGenericClinicalPresetsTableFetch(workspaceId: string | undefined) {
  const isOnlineVal = useNetworkStatus()
  useEffect(() => {
    if (
      !workspaceId
      || !isOnlineVal
      || isLocalWorkspaceMode(workspaceId)
      || isDemoWorkspaceMode(workspaceId)
    ) return
    const dexieTable = tableByName[PRESETS_TABLE]
    fetchTableFromSupabase(PRESETS_TABLE, dexieTable as any, workspaceId)
  }, [workspaceId, isOnlineVal])
}

export function useClinicalPresets(workspaceId: string | undefined) {
  useGenericClinicalPresetsTableFetch(workspaceId)
  return useLiveQuery(async () => {
    if (!workspaceId) return []
    return db.clinical_presets
      .where('workspaceId').equals(workspaceId)
      .filter((p) => (
        !p.isDeleted
        && p.category !== CLINICAL_REGISTRY_PRESET_CATEGORY
        && p.category !== 'beauty3_procedure'
      ))
      .sortBy('sortOrder')
  }, [workspaceId])
}

export function useClinicalRegistryType(workspaceId: string | undefined): ClinicalRegistryType {
  useGenericClinicalPresetsTableFetch(workspaceId)
  const registryType = useLiveQuery(async () => {
    if (!workspaceId) return DEFAULT_CLINICAL_REGISTRY_TYPE

    const preset = await db.clinical_presets
      .where('[workspaceId+category]')
      .equals([workspaceId, CLINICAL_REGISTRY_PRESET_CATEGORY])
      .filter((item) => !item.isDeleted && item.isActive)
      .first()

    return normalizeClinicalRegistryType(preset?.name)
  }, [workspaceId])

  return registryType ?? DEFAULT_CLINICAL_REGISTRY_TYPE
}

export function useClinicalPreset(id: string | undefined) {
  return useLiveQuery(async () => {
    if (!id) return null
    return db.clinical_presets.get(id)
  }, [id])
}

export function useClinicalPresetsByCategory(workspaceId: string | undefined, category: string | undefined) {
  useGenericClinicalPresetsTableFetch(workspaceId)
  return useLiveQuery(async () => {
    if (!workspaceId || !category) return []
    return db.clinical_presets
      .where('workspaceId').equals(workspaceId)
      .filter((p) => !p.isDeleted && p.category === category)
      .sortBy('sortOrder')
  }, [workspaceId, category])
}

export async function createClinicalPreset(
  preset: Omit<ClinicalPreset, keyof BaseEntity | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>,
  workspaceId: string,
) {
  const timestamp = new Date().toISOString()
  const entity: ClinicalPreset = {
    ...preset,
    id: generateId(),
    workspaceId,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    isDeleted: false,
    syncStatus: 'pending',
    lastSyncedAt: null,
  }
  await upsertClinicalPresetEntity(entity, workspaceId, timestamp)
  return entity
}

export async function setClinicalRegistryType(
  workspaceId: string,
  registryType: UserSelectableClinicalRegistryType,
  createdBy?: string | null,
) {
  const timestamp = new Date().toISOString()
  const existing = await db.clinical_presets
    .where('[workspaceId+category]')
    .equals([workspaceId, CLINICAL_REGISTRY_PRESET_CATEGORY])
    .filter((item) => !item.isDeleted)
    .first()

  const entity: ClinicalPreset = {
    id: existing?.id ?? getClinicalRegistryPresetId(workspaceId),
    workspaceId,
    category: CLINICAL_REGISTRY_PRESET_CATEGORY,
    name: registryType,
    consultationFee: 0,
    sortOrder: 0,
    isActive: true,
    createdBy: existing?.createdBy ?? createdBy ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    syncStatus: 'pending',
    lastSyncedAt: existing?.lastSyncedAt ?? null,
  }

  await upsertClinicalPresetEntity(entity, workspaceId, timestamp)
  return entity
}

export async function updateClinicalPreset(id: string, updates: Partial<ClinicalPreset>, workspaceId: string) {
  const timestamp = new Date().toISOString()
  const existing = await db.clinical_presets.get(id)
  if (!existing) return null
  const updated: ClinicalPreset = {
    ...existing,
    ...updates,
    id,
    workspaceId,
    updatedAt: timestamp,
    version: existing.version + 1,
    syncStatus: 'pending',
  }
  await upsertClinicalPresetEntity(updated, workspaceId, timestamp)
  return updated
}

export async function deleteClinicalPreset(id: string, workspaceId: string) {
  await softDeleteClinicalPresetEntity(id, workspaceId)
}
