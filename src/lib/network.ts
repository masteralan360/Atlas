// Application connectivity status. The ConnectionManager updates this only after
// a user confirms offline mode, or when the browser reports connectivity restored.
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    isAppMaintenanceActive,
    isAppMaintenanceBlockingDataAccess,
    subscribeAppMaintenance
} from '@/lib/appMaintenanceState'

let isActuallyOnline = true;
let activeBusinessWorkspaceId: string | null = null;
let activeBusinessUserId: string | null = null;
let activeBusinessUserRole: 'admin' | 'staff' | 'viewer' | null = null;
let activeBusinessUserWorkspaceId: string | null = null;
let businessPartnerGroupPrivacyWorkspaceId: string | null = null;
let businessPartnerGroupPrivacyEnabled = false;
const networkListeners = new Set<() => void>()

subscribeAppMaintenance(() => {
    networkListeners.forEach((listener) => listener())
})

function notifyNetworkListeners() {
    networkListeners.forEach((listener) => listener())
}

// Update the global state
export function setNetworkStatus(online: boolean) {
    if (isActuallyOnline === online) return
    isActuallyOnline = online;
    notifyNetworkListeners()
}

export function subscribeNetworkStatus(listener: () => void) {
    networkListeners.add(listener)
    return () => networkListeners.delete(listener)
}

export function getNetworkStatus() {
    return isActuallyOnline && (
        isLocalWorkspaceMode(activeBusinessWorkspaceId)
        || !isAppMaintenanceBlockingDataAccess()
    )
}

export function isMaintenanceModeActive(workspaceId?: string | null) {
    return isAppMaintenanceActive(workspaceId ?? activeBusinessWorkspaceId)
}

export function setActiveBusinessWorkspace(workspaceId: string | null | undefined) {
    const nextWorkspaceId = workspaceId ?? null
    if (activeBusinessWorkspaceId === nextWorkspaceId) return
    activeBusinessWorkspaceId = nextWorkspaceId
    notifyNetworkListeners()
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

    return isActuallyOnline && !isAppMaintenanceBlockingDataAccess();
}

// Get the current robust status
export function isOnline(workspaceId?: string | null): boolean {
    return isBusinessDataOnline(workspaceId);
}
