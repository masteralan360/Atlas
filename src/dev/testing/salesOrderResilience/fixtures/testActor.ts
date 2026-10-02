import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WorkspaceAccessOverride } from '@/plans/workspacePlans'
import { resolveWorkspaceAccess } from '@/workspace/workspaceAccessResolution'
import { equal, ensure } from '../invariants/assert'

export interface ActorCredential { userId: string; email: string; password: string; workspaceId: string; workspaceName: string; role: 'admin' | 'staff' | 'viewer' }
export interface LabManifest {
    runId: string; namespace: string; url: string; key: string
    actors: Record<string, ActorCredential>
    workspaces: { id: string; name: string; plan: 'basic' | 'business' | 'enterprise'; mode: 'cloud' | 'hybrid'; label: string; override: 'grant' | 'revoke' | null }[]
}
export interface TestActor extends Omit<ActorCredential, 'password'> { client: SupabaseClient }
export function readManifest(): LabManifest {
    const manifest = JSON.parse(process.env.SORL_MANIFEST ?? '{}') as LabManifest
    ensure(/^DEV TEST SORL [0-9a-f-]{36}$/.test(manifest.namespace ?? ''), 'fixtures.namespace', manifest.namespace)
    ensure(manifest.url === process.env.ATLAS_LIVE_SUPABASE_URL && manifest.key === process.env.ATLAS_LIVE_SUPABASE_KEY, 'fixtures.origin', manifest.url)
    return manifest
}
export function dataOrThrow<R extends { data: unknown; error: { message: string } | null }>(result: R, label: string): NonNullable<R['data']> {
    if (result.error || result.data === null) throw new Error(`${label}: ${result.error?.message ?? 'Missing data'}`)
    return result.data as NonNullable<R['data']>
}
export async function authenticateActor(name: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<TestActor> {
    const manifest = readManifest()
    const credential = manifest.actors[name]
    ensure(credential, 'fixtures.actor', name)
    const client = createClient(manifest.url, manifest.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher } })
    const auth = dataOrThrow(await client.auth.signInWithPassword({ email: credential.email, password: credential.password }), 'fixtures.login')
    equal(auth.user?.id, credential.userId, 'authorization.authenticatedIdentity')
    ensure(auth.session?.access_token, 'authorization.realJwt', auth.user?.id)
    const profile = dataOrThrow(await client.from('profiles').select('id,role,current_workspace').eq('id', credential.userId).single(), 'fixtures.profile')
    equal(profile.role, credential.role, 'authorization.role'); equal(profile.current_workspace, credential.workspaceId, 'tenancy.actorWorkspace')
    const visible = dataOrThrow(await client.from('workspaces').select('id,name'), 'fixtures.workspaces')
    equal(visible.map(row => row.id), [credential.workspaceId], 'tenancy.visibleWorkspaces')
    equal(visible[0].name, credential.workspaceName, 'fixtures.workspaceName')
    const { password: _password, ...actor } = credential
    return { ...actor, client }
}
export async function assertSalesOrderActorReady(actor: TestActor) {
    const workspace = dataOrThrow(await actor.client.from('workspaces').select('*').eq('id', actor.workspaceId).single(), 'fixtures.workspace')
    equal(workspace.is_configured, true, 'fixtures.configured'); equal(workspace.locked_workspace, false, 'fixtures.unlocked')
    const overrides = dataOrThrow(await actor.client.from('workspace_access_overrides').select('*').eq('workspace_id', actor.workspaceId), 'fixtures.overrides') as WorkspaceAccessOverride[]
    ensure(resolveWorkspaceAccess(workspace.plan, overrides).modules.includes('orders'), 'authorization.ordersEntitlement', workspace.plan)
    return workspace
}
