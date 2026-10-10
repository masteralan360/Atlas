import type { UserRole } from '@/local-db/models'
import { isSupportedWorkspacePermissionKey, WORKSPACE_PERMISSION_DEFINITIONS, type WorkspacePermissionKey } from './workspacePermissionDefinitions'

/** Shared permission decision for the provider and independently authenticated route checks. */
export function resolveWorkspacePermission(role: UserRole | undefined, enabled: boolean, keys: ReadonlySet<WorkspacePermissionKey>, permission: WorkspacePermissionKey | 'global.print') {
    if (permission === 'global.hideCosts') return role !== 'admin' && enabled && keys.has(permission)
    // Global printing is enabled by default; the workspace permission stores
    // only the explicit opt-out as `global.NOprint`.
    if (permission === 'global.print') return !keys.has('global.NOprint')
    const [module, action] = permission.split('.')
    const print = permission === 'global.NOprint' || action === 'print'
    if (print && keys.has('global.NOprint')) return false
    if (role === 'admin' || !enabled || keys.has(permission)) return true
    if (module !== 'global') {
        if (action === 'print') return true
        const fallback = `global.${action}` as WorkspacePermissionKey
        return isSupportedWorkspacePermissionKey(fallback) && keys.has(fallback)
            && !WORKSPACE_PERMISSION_DEFINITIONS.some(definition => definition.key === permission && definition.module !== 'global')
    }
    return false
}
