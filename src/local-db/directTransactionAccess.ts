import { getActiveBusinessUserId, getActiveBusinessUserRole } from '@/lib/network'
import { applyWorkspaceOverrides, getPlanCapabilities } from '@/plans/workspacePlans'
import { resolveWorkspacePermission } from '@/permissions/resolveWorkspacePermission'
import { readCachedPermissions } from '@/permissions/workspacePermissionCache'
import { readWorkspaceCache } from '@/workspace/workspaceCache'

/** Also used outside React, by Local/offline financial mutations. */
export function getDirectTransactionAccess(workspaceId: string) {
  const snapshot = readWorkspaceCache<{ plan?: string }>(workspaceId)
  const userId = getActiveBusinessUserId()
  const role = getActiveBusinessUserRole(workspaceId)
  const plan = applyWorkspaceOverrides(getPlanCapabilities(snapshot?.features.plan), snapshot?.overrides ?? [])
  const keys = new Set(userId ? readCachedPermissions(workspaceId, userId) : [])
  const enabled = plan.capabilities.includes('workspaceManagementPermissions')
  const canPost = Boolean(userId && role && plan.modules.includes('direct_transactions')
    && resolveWorkspacePermission(role, enabled, keys, 'directTransaction.access'))
  return {
    canPost,
    agents: Boolean(canPost && plan.modules.includes('agents') && resolveWorkspacePermission(role!, enabled, keys, 'agents.access')),
    partners: Boolean(canPost && plan.modules.includes('business_partners') && resolveWorkspacePermission(role!, enabled, keys, 'businessPartners.access')),
  }
}
