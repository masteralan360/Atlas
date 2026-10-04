import { db } from '@/local-db/database'
import type { DemoJob } from './demoConfig'
import { buildDemoCode, parseDemoOptionalModuleCodes } from './demoConfig'
import type { CurrencyCode } from '@/local-db/models'
import { clearLocalDemoWorkspaceData } from './demoCleanup'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'

export interface CreateDemoResult {
  userId: string
  email: string
  password: string
  workspaceId: string
  workspaceCode: string
  workspaceName: string
}

function generateId(): string {
  return crypto.randomUUID()
}

function generateDemoEmail(workspaceId: string): string {
  return `demo-${workspaceId.slice(0, 8)}@demo-workspace.com`
}

function generatePassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

export async function createDemoWorkspace(
  workspaceName: string,
  job: DemoJob,
  minutes: number,
  currency: CurrencyCode = 'usd',
  optionalModuleCodes = '',
): Promise<CreateDemoResult> {
  // Revalidate here so callers cannot create entitlements by bypassing the UI.
  const optionalModuleGrants = parseDemoOptionalModuleCodes(optionalModuleCodes)
  const code = buildDemoCode(job, minutes)
  const workspaceId = generateId()
  const userId = generateId()
  const email = generateDemoEmail(workspaceId)
  const password = generatePassword()
  const now = new Date().toISOString()
  const cachedAccessOverrides = optionalModuleGrants.map((grant) => ({
    id: generateId(),
    workspace_id: workspaceId,
    type: grant.type,
    key: grant.key,
    value: 'grant',
    created_by: userId,
    created_at: now,
  }))

  await db.workspaces.put({
    id: workspaceId,
    workspaceId,
    name: workspaceName,
    code,
    data_mode: 'demo',
    plan: 'enterprise',
    cachedAccessOverrides,
    default_currency: currency,
    iqd_display_preference: 'د.ع',
    locked_workspace: false,
    is_configured: true,
    subscription_expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    syncStatus: 'synced',
    lastSyncedAt: null,
    version: 1,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
  })

  await db.profiles.put({
    id: userId,
    workspaceId,
    currentWorkspaceId: workspaceId,
    name: 'Demo User',
    role: 'admin',
    profile_url: null,
    created_at: now,
  })

  // Best-effort: register the timer on the server so it can enforce expiry
  // independently of the client clock. Non-blocking — local timer still works.
  if (isSupabaseConfigured) {
    supabase.rpc('insert_demo', {
      p_workspace_id: workspaceId,
      p_expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    }).then(({ error }) => {
      if (error) console.warn('[Demo] insert_demo RPC failed (non-fatal):', error)
    })
  }

  return {
    userId,
    email,
    password,
    workspaceId,
    workspaceCode: code,
    workspaceName,
  }
}

export async function deleteDemoWorkspace(workspaceId: string): Promise<void> {
  // Best-effort: remove the server-side timer record
  if (isSupabaseConfigured) {
    supabase.rpc('delete_demo', { p_workspace_id: workspaceId }).then(({ error }) => {
      if (error) console.warn('[Demo] delete_demo RPC failed (non-fatal):', error)
    })
  }

  await clearLocalDemoWorkspaceData(workspaceId)
}
