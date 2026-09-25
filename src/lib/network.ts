// Application connectivity status. The ConnectionManager updates this only after
// a user confirms offline mode, or when the browser reports connectivity restored.
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

let isActuallyOnline = true;
let activeBusinessWorkspaceId: string | null = null;
let activeBusinessUserId: string | null = null;
let activeBusinessUserRole: 'admin' | 'staff' | 'viewer' | null = null;
let activeBusinessUserWorkspaceId: string | null = null;
let businessPartnerGroupPrivacyWorkspaceId: string | null = null;
let businessPartnerGroupPrivacyEnabled = false;

// Update the global state
export function setNetworkStatus(online: boolean) {
    isActuallyOnline = online;
}

export function setActiveBusinessWorkspace(workspaceId: string | null | undefined) {
    activeBusinessWorkspaceId = workspaceId ?? null;
}

export function setActiveBusinessUser(
    userId: string | null | undefined,
    role?: 'admin' | 'staff' | 'viewer' | null,
    workspaceId?: string | null
) {
    activeBusinessUserId = userId ?? null;
    activeBusinessUserRole = userId ? role ?? null : null;
    activeBusinessUserWorkspaceId = userId ? workspaceId ?? null : null;
}

export function getActiveBusinessUserId() {
    return activeBusinessUserId;
}

/**
 * The authenticated identity is authoritative for immediate local permission
 * checks. Dexie membership rows can briefly lag after sign-in or a role edit.
 */
export function getActiveBusinessUserRole(workspaceId?: string | null) {
    if (
        !activeBusinessUserId
        || (workspaceId && activeBusinessUserWorkspaceId && workspaceId !== activeBusinessUserWorkspaceId)
    ) {
        return null;
    }
    return activeBusinessUserRole;
}

export function getActiveBusinessWorkspaceId() {
    return activeBusinessWorkspaceId;
}

export function setBusinessPartnerGroupPrivacyAccess(workspaceId: string | null | undefined, enabled: boolean) {
    businessPartnerGroupPrivacyWorkspaceId = workspaceId ?? null;
    businessPartnerGroupPrivacyEnabled = Boolean(workspaceId && enabled);
}

export function hasBusinessPartnerGroupPrivacyAccess(workspaceId?: string | null) {
    return Boolean(
        businessPartnerGroupPrivacyEnabled
        && businessPartnerGroupPrivacyWorkspaceId
        && (!workspaceId || businessPartnerGroupPrivacyWorkspaceId === workspaceId)
    );
}

function getWorkspaceIdForBusinessData(workspaceId?: string | null) {
    return workspaceId ?? activeBusinessWorkspaceId;
}

export function isBusinessDataOnline(workspaceId?: string | null): boolean {
    const resolvedWorkspaceId = getWorkspaceIdForBusinessData(workspaceId);
    if (resolvedWorkspaceId && isLocalWorkspaceMode(resolvedWorkspaceId)) {
        return false;
    }

    return isActuallyOnline;
}

// Get the current robust status
export function isOnline(workspaceId?: string | null): boolean {
    return isBusinessDataOnline(workspaceId);
}
