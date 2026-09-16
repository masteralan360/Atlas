import {
  readWorkspaceTableHydrationFetch,
} from './workspaceDataFreshness'

export type WorkspaceTableHydrationPriority = 'foreground' | 'background'

export interface WorkspaceTableHydrationRequest {
  workspaceId: string
  tableName: string
  /**
   * A complete, tombstone-inclusive read is a different cache entry from an
   * active-rows read. Treating the two as identical can leave deleted rows
   * stale in payment and inventory views.
   */
  includeDeleted?: boolean
  freshnessMs?: number
  force?: boolean
  priority?: WorkspaceTableHydrationPriority
}

export interface WorkspaceTableHydrationLease {
  promise: Promise<boolean>
  release: () => void
  /** True when no remote work was needed because the scoped cache is still fresh. */
  isFresh: boolean
}

type HydrationJob = {
  key: string
  request: Required<Pick<WorkspaceTableHydrationRequest, 'workspaceId' | 'tableName'>>
    & Pick<WorkspaceTableHydrationRequest, 'includeDeleted' | 'freshnessMs' | 'force' | 'priority'>
  controller: AbortController
  consumers: number
  state: 'queued' | 'running' | 'settled'
  promise: Promise<boolean>
  resolve: (value: boolean) => void
  run: (signal: AbortSignal, operationId: string) => Promise<boolean>
}

const MAX_CONCURRENT_REMOTE_TABLE_READS = 3

// These values deliberately favour responsive navigation over blind polling.
// Mutations still update Dexie immediately; a short remote check on the next
// visit catches work from another device without refetching the same snapshot
// each time a React route remounts.
const TRANSACTIONAL_TABLES = new Set([
  'inventory',
  'payment_transactions',
  'sales_orders',
  'purchase_orders',
  'sales',
  'loans',
  'loan_installments',
  'loan_payments',
  'installment_sales',
  'installment_sale_installments',
  'expense_items',
  'payroll_statuses',
  'real_estate_transactions',
  'real_estate_installments',
  'real_estate_payments',
  'rental_contracts',
  'rental_vehicles',
])

const REFERENCE_TABLES = new Set([
  'products',
  'categories',
  'units',
  'product_barcodes',
  'storages',
  'customers',
  'suppliers',
  'agents',
  'business_partners',
  'agent_excluded_categories',
  'payment_accounts',
  'employees',
  'expense_categories',
  'budget_settings',
  'budget_allocations',
])

const jobs = new Map<string, HydrationJob>()
const queue: HydrationJob[] = []
let runningCount = 0

export function getWorkspaceTableHydrationFreshnessMs(tableName: string) {
  if (TRANSACTIONAL_TABLES.has(tableName)) return 15_000
  if (REFERENCE_TABLES.has(tableName)) return 120_000
  return 30_000
}

function getScope(includeDeleted?: boolean) {
  return includeDeleted ? 'all' : 'active'
}

function getKey(request: WorkspaceTableHydrationRequest) {
  return `supabase:${request.workspaceId}:${request.tableName}:${getScope(request.includeDeleted)}`
}

function isFresh(request: WorkspaceTableHydrationRequest) {
  if (request.force) return false

  const freshnessMs = request.freshnessMs ?? getWorkspaceTableHydrationFreshnessMs(request.tableName)
  const scope = getScope(request.includeDeleted)
  const fetched = readWorkspaceTableHydrationFetch(
    request.workspaceId,
    'supabase',
    request.tableName,
    scope,
  ) ?? (scope === 'active'
    ? readWorkspaceTableHydrationFetch(request.workspaceId, 'supabase', request.tableName, 'all')
    : null)
  if (!fetched) return false

  return Date.now() - new Date(fetched.fetchedAt).getTime() < freshnessMs
}

function dequeue(job: HydrationJob) {
  const index = queue.indexOf(job)
  if (index >= 0) queue.splice(index, 1)
}

function flushQueue() {
  while (runningCount < MAX_CONCURRENT_REMOTE_TABLE_READS && queue.length > 0) {
    const job = queue.shift()
    if (!job || job.state !== 'queued' || job.consumers === 0) continue

    job.state = 'running'
    runningCount += 1
    void job.run(job.controller.signal, job.key)
      .catch((error) => {
        if (!job.controller.signal.aborted) {
          console.error(`[${job.request.tableName}] Unhandled Supabase hydration failure:`, error)
        }
        return false
      })
      .then((completed) => {
        job.resolve(completed)
      })
      .finally(() => {
        job.state = 'settled'
        runningCount -= 1
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        flushQueue()
      })
  }
}

function createLease(job: HydrationJob): WorkspaceTableHydrationLease {
  let released = false
  job.consumers += 1

  return {
    promise: job.promise,
    isFresh: false,
    release: () => {
      if (released) return
      released = true
      job.consumers = Math.max(0, job.consumers - 1)

      if (job.consumers > 0 || job.state === 'settled') return

      if (job.state === 'queued') {
        dequeue(job)
        job.state = 'settled'
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        job.resolve(false)
        return
      }

      // Supabase query builders accept AbortSignal. The reader checks this
      // before every page and before reconciliation, so an abandoned read
      // cannot delete local rows from an incomplete remote snapshot.
      job.controller.abort()
    },
  }
}

/**
 * Shares an identical Cloud/Hybrid table refresh, caps global network work,
 * and gives React effects a lease they can release on unmount.
 */
export function acquireWorkspaceTableHydration(
  request: WorkspaceTableHydrationRequest,
  run: (signal: AbortSignal, operationId: string) => Promise<boolean>,
): WorkspaceTableHydrationLease {
  if (isFresh(request)) {
    return { promise: Promise.resolve(true), release: () => undefined, isFresh: true }
  }

  const key = getKey(request)
  const existing = jobs.get(key)
  // A user can leave and immediately return before the browser resolves the
  // aborted fetch. Never attach that new route to a doomed request.
  if (existing && !existing.controller.signal.aborted) return createLease(existing)

  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((nextResolve) => {
    resolve = nextResolve
  })
  const job: HydrationJob = {
    key,
    request,
    controller: new AbortController(),
    consumers: 0,
    state: 'queued',
    promise,
    resolve,
    run,
  }
  jobs.set(key, job)
  if (request.priority === 'foreground') {
    const firstBackground = queue.findIndex((candidate) => candidate.request.priority !== 'foreground')
    if (firstBackground >= 0) queue.splice(firstBackground, 0, job)
    else queue.push(job)
  } else {
    queue.push(job)
  }
  const lease = createLease(job)
  flushQueue()
  return lease
}

/** Test-only visibility; useful for proving remounts do not accumulate work. */
export function getWorkspaceTableHydrationCoordinatorState() {
  return {
    runningCount,
    queuedCount: queue.length,
    jobCount: jobs.size,
  }
}

/** Clears only coordinator process state. Production code must never call this. */
export function resetWorkspaceTableHydrationCoordinatorForTests() {
  for (const job of jobs.values()) {
    job.controller.abort()
    job.resolve(false)
  }
  jobs.clear()
  queue.splice(0, queue.length)
  runningCount = 0
}
