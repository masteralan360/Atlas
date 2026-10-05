import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { generateId, toSnakeCase } from '@/lib/utils'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isOnline } from '@/lib/network'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import type {
  GardenConstructionProject,
  GardenJob,
  GardenJobActivity,
  GardenJobAssignment,
  GardenMaintenanceContract,
  GardenSite,
  CurrencyCode,
} from './models'
import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'

const GARDEN_TABLES = [
  'garden_sites',
  'garden_construction_projects',
  'garden_maintenance_contracts',
  'garden_jobs',
  'garden_job_assignments',
  'garden_job_activity',
] as const

type GardenTableName = typeof GARDEN_TABLES[number]

function makeMetadata(workspaceId: string, now: string, version = 1) {
  const localOnly = isLocalWorkspaceMode(workspaceId)
  return {
    workspaceId,
    createdAt: now,
    updatedAt: now,
    version,
    isDeleted: false,
    syncStatus: localOnly ? 'synced' as const : 'pending' as const,
    lastSyncedAt: localOnly ? now : null,
  }
}

async function persistGardenRow<T extends { id: string; workspaceId: string; version: number }>(
  tableName: GardenTableName,
  table: { put: (row: T) => Promise<unknown>; update: (id: string, changes: Partial<T>) => Promise<unknown> },
  row: T,
  operation: 'create' | 'update' = 'create',
) {
  await table.put(row)
  if (isLocalWorkspaceMode(row.workspaceId)) return row

  const remotePayload = toSnakeCase({ ...row, syncStatus: undefined, lastSyncedAt: undefined })
  if (isOnline(row.workspaceId)) {
    try {
      const client = getSupabaseClientForTable(tableName)
      const response = await runSupabaseAction(tableName + '.' + operation, () =>
        tableName === 'garden_jobs' && operation === 'update'
          ? client.from(tableName).update(remotePayload).eq('id', row.id).eq('workspace_id', row.workspaceId).select('id').maybeSingle()
          : client.from(tableName).upsert(remotePayload),
      )
      if (response.error) throw response.error
      if (tableName === 'garden_jobs' && operation === 'update' && !response.data) {
        throw new Error('Garden job update was not applied.')
      }
      await table.update(row.id, { syncStatus: 'synced', lastSyncedAt: new Date().toISOString() } as Partial<T>)
      return { ...row, syncStatus: 'synced' as const }
    } catch (error) {
      console.warn(`[Garden] ${tableName} will sync when connected:`, error)
    }
  }

  await addToOfflineMutations(tableName, row.id, operation, row as unknown as Record<string, unknown>, row.workspaceId)
  return row
}

async function recordActivity(
  workspaceId: string,
  jobId: string,
  actorUserId: string | null | undefined,
  activityType: GardenJobActivity['activityType'],
  summary: string,
  payload?: Record<string, unknown>,
) {
  const now = new Date().toISOString()
  const activity: GardenJobActivity = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    jobId,
    actorUserId: actorUserId ?? null,
    activityType,
    summary,
    payload,
  }
  await persistGardenRow('garden_job_activity', db.garden_job_activity, activity)
}

function dateOnly(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function getContractVisitDates(contract: GardenMaintenanceContract): Date[] {
  const [startYear, startMonth, startDay] = contract.startsOn.split('-').map(Number)
  const [endYear, endMonth, endDay] = contract.endsOn.split('-').map(Number)
  const start = new Date(startYear, startMonth - 1, startDay)
  const end = new Date(endYear, endMonth - 1, endDay)
  const [hour = 8, minute = 0] = contract.serviceTime.split(':').map(Number)
  const days = contract.visitDays.length ? contract.visitDays : [1, 8, 15, 22]
  const visits: Date[] = []

  for (let month = new Date(start.getFullYear(), start.getMonth(), 1); month <= end; month.setMonth(month.getMonth() + 1)) {
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    for (const visitDay of days.slice(0, contract.visitsPerMonth)) {
      const visit = new Date(month.getFullYear(), month.getMonth(), Math.min(Math.max(1, visitDay), lastDay), hour, minute)
      if (visit >= start && visit <= end) visits.push(visit)
    }
  }
  return visits
}

export function useGardenData(workspaceId?: string) {
  const sites = useLiveQuery(
    () => workspaceId
      ? db.garden_sites.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
  const projects = useLiveQuery(
    () => workspaceId
      ? db.garden_construction_projects.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
  const contracts = useLiveQuery(
    () => workspaceId
      ? db.garden_maintenance_contracts.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
  const jobs = useLiveQuery(
    () => workspaceId
      ? db.garden_jobs.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
  const assignments = useLiveQuery(
    () => workspaceId
      ? db.garden_job_assignments.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
  const activities = useLiveQuery(
    () => workspaceId
      ? db.garden_job_activity.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []

  useEffect(() => {
    if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    for (const tableName of GARDEN_TABLES) {
      void fetchTableFromSupabase(tableName, db.table(tableName), workspaceId)
        .catch((error) => console.warn(`[Garden] Could not refresh ${tableName}:`, error))
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    const client = getSupabaseClientForTable('garden_jobs')
    const channel = client
      .channel('garden-jobs-' + workspaceId)
      .on('postgres_changes', {
        event: '*',
        schema: 'garden',
        table: 'garden_jobs',
        filter: 'workspace_id=eq.' + workspaceId,
      }, () => {
        void Promise.all([
          fetchTableFromSupabase('garden_jobs', db.garden_jobs, workspaceId),
          fetchTableFromSupabase('garden_job_assignments', db.garden_job_assignments, workspaceId),
          fetchTableFromSupabase('garden_job_activity', db.garden_job_activity, workspaceId),
        ]).catch((error) => console.warn('[Garden] Could not refresh changed jobs:', error))
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'garden',
        table: 'garden_job_assignments',
        filter: 'workspace_id=eq.' + workspaceId,
      }, () => {
        void Promise.all([
          fetchTableFromSupabase('garden_jobs', db.garden_jobs, workspaceId),
          fetchTableFromSupabase('garden_job_assignments', db.garden_job_assignments, workspaceId),
        ]).catch((error) => console.warn('[Garden] Could not refresh assignments:', error))
      })
      .subscribe()
    return () => {
      void client.removeChannel(channel)
    }
  }, [workspaceId])

  return { sites, projects, contracts, jobs, assignments, activities }
}

export async function createGardenSite(
  workspaceId: string,
  input: Pick<GardenSite, 'name' | 'homeownerName' | 'homeownerPhone' | 'address' | 'city' | 'businessPartnerId' | 'accessNotes'> & { createdBy?: string | null },
) {
  const now = new Date().toISOString()
  const site: GardenSite = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    ...input,
    status: 'active',
  }
  return persistGardenRow('garden_sites', db.garden_sites, site)
}

export async function createGardenConstructionProject(
  workspaceId: string,
  input: Omit<GardenConstructionProject, keyof ReturnType<typeof makeMetadata> | 'id' | 'completedAt' | 'createdAt' | 'updatedAt' | 'isDeleted' | 'syncStatus' | 'lastSyncedAt' | 'version'>,
) {
  const now = new Date().toISOString()
  const project: GardenConstructionProject = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    ...input,
  }
  return persistGardenRow('garden_construction_projects', db.garden_construction_projects, project)
}

export async function createGardenMaintenanceContract(
  workspaceId: string,
  input: Omit<GardenMaintenanceContract, keyof ReturnType<typeof makeMetadata> | 'id' | 'createdAt' | 'updatedAt' | 'isDeleted' | 'syncStatus' | 'lastSyncedAt' | 'version'>,
) {
  const now = new Date().toISOString()
  const contract: GardenMaintenanceContract = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    ...input,
  }
  const jobs: GardenJob[] = contract.status === 'active'
    ? getContractVisitDates(contract).map((visit, index) => ({
      id: generateId(),
      ...makeMetadata(workspaceId, now),
      siteId: contract.siteId,
      contractId: contract.id,
      sourceKey: `${contract.id}:${dateOnly(visit)}:${index + 1}`,
      kind: 'maintenance',
      title: `${contract.contractNo} · ${index + 1}`,
      scheduledAt: visit.toISOString(),
      timeZone: contract.timeZone,
      plannedDurationMinutes: 60,
      status: 'scheduled',
      routeOrder: 1,
      instructions: contract.notes,
      createdBy: contract.createdBy,
    }))
    : []

  await db.transaction('rw', db.garden_maintenance_contracts, db.garden_jobs, async () => {
    await db.garden_maintenance_contracts.put(contract)
    if (jobs.length) await db.garden_jobs.bulkPut(jobs)
  })
  await persistGardenRow('garden_maintenance_contracts', db.garden_maintenance_contracts, contract)
  for (const job of jobs) await persistGardenRow('garden_jobs', db.garden_jobs, job)
  return { contract, jobs }
}

export async function createGardenJob(
  workspaceId: string,
  input: Omit<GardenJob, keyof ReturnType<typeof makeMetadata> | 'id' | 'completedAt' | 'completedBy' | 'outcome' | 'completionNote' | 'createdAt' | 'updatedAt' | 'isDeleted' | 'syncStatus' | 'lastSyncedAt' | 'version'> & { assignedUserId?: string | null; assignedUserName?: string | null },
) {
  const { assignedUserId, assignedUserName, ...jobInput } = input
  const now = new Date().toISOString()
  const job: GardenJob = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    ...jobInput,
    status: 'scheduled',
    routeOrder: input.routeOrder ?? 1,
  }
  await persistGardenRow('garden_jobs', db.garden_jobs, job)
  await recordActivity(workspaceId, job.id, job.createdBy, 'created', 'Job created')
  if (assignedUserId) {
    await assignGardenJob(workspaceId, job.id, assignedUserId, assignedUserName ?? '', job.createdBy ?? null)
  }
  return job
}

export async function updateGardenJob(
  workspaceId: string,
  jobId: string,
  patch: Partial<Pick<GardenJob, 'siteId' | 'projectId' | 'contractId' | 'kind' | 'title' | 'scheduledAt' | 'timeZone' | 'plannedDurationMinutes' | 'instructions' | 'routeOrder' | 'status' | 'outcome' | 'completedAt' | 'completedBy' | 'completionNote'>>,
  actorUserId?: string | null,
) {
  const existing = await db.garden_jobs.get(jobId)
  if (!existing || existing.workspaceId !== workspaceId) throw new Error('Garden job was not found.')
  const next: GardenJob = {
    ...existing,
    ...patch,
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
    syncStatus: isLocalWorkspaceMode(workspaceId) ? 'synced' : 'pending',
    lastSyncedAt: isLocalWorkspaceMode(workspaceId) ? new Date().toISOString() : null,
  }
  await persistGardenRow('garden_jobs', db.garden_jobs, next, 'update')

  if (patch.siteId && patch.siteId !== existing.siteId) {
    await recordActivity(workspaceId, jobId, actorUserId, 'rescheduled', 'Garden job location changed', {
      fromSiteId: existing.siteId,
      toSiteId: patch.siteId,
    })
  }
  if (patch.scheduledAt && patch.scheduledAt !== existing.scheduledAt) {
    await recordActivity(workspaceId, jobId, actorUserId, 'rescheduled', 'Job schedule changed', {
      from: existing.scheduledAt,
      to: patch.scheduledAt,
    })
  }
  if (patch.status === 'in_progress' && existing.status !== 'in_progress') {
    await recordActivity(workspaceId, jobId, actorUserId, 'started', 'Job started')
  }
  if (patch.status === 'completed' && existing.status !== 'completed') {
    await recordActivity(workspaceId, jobId, actorUserId, 'completed', 'Job completed', {
      outcome: patch.outcome ?? 'ok',
      note: patch.completionNote ?? null,
    })
  }
  return next
}

export async function assignGardenJob(
  workspaceId: string,
  jobId: string,
  userId: string,
  userNameSnapshot: string,
  assignedBy?: string | null,
) {
  const now = new Date().toISOString()
  const activeAssignments = await db.garden_job_assignments
    .where('[workspaceId+jobId]').equals([workspaceId, jobId])
    .and((assignment) => !assignment.isDeleted && !assignment.unassignedAt)
    .toArray()
  const existing = activeAssignments.find((assignment) => assignment.userId === userId)
  if (existing) return existing

  const assignment: GardenJobAssignment = {
    id: generateId(),
    ...makeMetadata(workspaceId, now),
    jobId,
    userId,
    userNameSnapshot,
    routeOrder: activeAssignments.length + 1,
    assignedBy: assignedBy ?? null,
    unassignedAt: null,
  }
  await persistGardenRow('garden_job_assignments', db.garden_job_assignments, assignment)
  await recordActivity(workspaceId, jobId, assignedBy, 'assigned', `Assigned to ${userNameSnapshot}`, { userId })
  return assignment
}

export async function unassignGardenJob(
  workspaceId: string,
  jobId: string,
  userId: string,
  actorUserId?: string | null,
) {
  const assignment = await db.garden_job_assignments
    .where('[workspaceId+jobId]').equals([workspaceId, jobId])
    .and((row) => row.userId === userId && !row.isDeleted && !row.unassignedAt)
    .first()
  if (!assignment) return null
  const now = new Date().toISOString()
  const ended: GardenJobAssignment = {
    ...assignment,
    unassignedAt: now,
    updatedAt: now,
    version: assignment.version + 1,
    syncStatus: isLocalWorkspaceMode(workspaceId) ? 'synced' : 'pending',
    lastSyncedAt: isLocalWorkspaceMode(workspaceId) ? now : null,
  }
  await persistGardenRow('garden_job_assignments', db.garden_job_assignments, ended, 'update')
  await recordActivity(workspaceId, jobId, actorUserId, 'unassigned', 'Staff member removed from job', { userId })
  return ended
}

export async function completeGardenJob(
  workspaceId: string,
  jobId: string,
  userId: string,
  outcome: 'ok' | 'needs_follow_up' = 'ok',
  note?: string,
) {
  return updateGardenJob(workspaceId, jobId, {
    status: 'completed',
    outcome,
    completedAt: new Date().toISOString(),
    completedBy: userId,
    completionNote: note?.trim() || null,
  }, userId)
}

export function formatGardenMoney(value: number | null | undefined, currency: CurrencyCode, locale?: string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(value)
}
