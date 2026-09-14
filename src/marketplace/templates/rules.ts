import type { StorefrontRules } from './types'

/**
 * Workspace-specific storefront presentation rules. These are resolved after
 * the public catalog identifies its workspace, so they also apply to any
 * additional storefront URLs owned by the workspace.
 */
export const workspaceStorefrontRules: Readonly<Record<string, StorefrontRules>> = {
    '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9': {
        hideCheckoutEmail: true,
        hideFilters: true
    }
}

export function getWorkspaceStorefrontRules(workspaceId?: string | null): StorefrontRules {
    if (!workspaceId) return {}
    return workspaceStorefrontRules[workspaceId.trim().toLowerCase()] ?? {}
}

export function getEffectiveStorefrontRules(
    assignedRules: StorefrontRules,
    workspaceId?: string | null
): StorefrontRules {
    return {
        ...assignedRules,
        ...getWorkspaceStorefrontRules(workspaceId)
    }
}
