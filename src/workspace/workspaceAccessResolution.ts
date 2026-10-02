import { applyWorkspaceOverrides, getPlanCapabilities, type WorkspaceAccessOverride } from '@/plans/workspacePlans'
import type { WorkspacePlan } from '@/local-db/models'

/** Used by online and cached feature resolution, including Local and Hybrid fallback. */
export function resolveWorkspaceAccess(plan: WorkspacePlan | undefined, overrides: readonly WorkspaceAccessOverride[] = []) {
    return applyWorkspaceOverrides(getPlanCapabilities(plan), [...overrides])
}
