import { type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { Redirect, useLocation, Link } from 'wouter'
import type { UserRole } from '@/local-db/models'
import { useWorkspace, type ModuleFeatureKey } from '@/workspace/WorkspaceContext'
import { useWorkspacePermissions, type WorkspacePermissionKey } from '@/permissions'
import type { PlanCapabilityKey } from '@/plans/workspacePlans'
import { BiometricLock } from '@/ui/components'
import { isDemoWorkspace, parseDemoCode } from '@/demo'

interface ProtectedRouteProps {
    children: ReactNode
    allowedRoles?: UserRole[]
    redirectTo?: string
    allowKicked?: boolean
    requiredFeature?: ModuleFeatureKey
    requiredAnyFeature?: ModuleFeatureKey[]
    requiredCapability?: PlanCapabilityKey
    requiresSupplierAccess?: boolean
    requiredPermission?: WorkspacePermissionKey
    requiredAnyPermission?: WorkspacePermissionKey[]
}

export function ProtectedRoute({
    children,
    allowedRoles,
    redirectTo = '/login',
    allowKicked = false,
    requiredFeature,
    requiredAnyFeature,
    requiredCapability,
    requiresSupplierAccess = false,
    requiredPermission,
    requiredAnyPermission
}: ProtectedRouteProps) {
    const { isAuthenticated, isLoading, hasRole, isKicked, user } = useAuth()
    const { hasFeature, hasCapability, features, isLoading: featuresLoading, isLocked } = useWorkspace()
    const { hasPermission, isLoading: permissionsLoading } = useWorkspacePermissions()
    const [location] = useLocation()
    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        )
    }

    if (!isAuthenticated) {
        return <Redirect to={`${redirectTo}?redirect=${encodeURIComponent(location)}`} />
    }

    if (featuresLoading || ((requiredPermission || requiredAnyPermission?.length) && permissionsLoading)) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        )
    }

    // Redirect kicked users to workspace registration (unless this route allows kicked users)
    if (isKicked && !allowKicked) {
        return <Redirect to="/workspace-registration" />
    }

    // Redirect admins to workspace configuration only after workspace state resolves.
    if (user?.role === 'admin' && !features.is_configured && location !== '/workspace-configuration') {
        return <Redirect to="/workspace-configuration" />
    }

    // Redirect admins away from workspace configuration once the workspace is configured.
    if (user?.role === 'admin' && features.is_configured && location === '/workspace-configuration') {
        return <Redirect to="/" />
    }

    // Redirect locked workspace members to locked workspace page
    if (isLocked && location !== '/locked-workspace') {
        const isAdminRoute = location.startsWith('/workspace-configuration') || location.startsWith('/settings') || location.startsWith('/logs');

        // If not an admin route, redirect everyone (including admins)
        // This ensures admins "feel" the lock on general pages like POS/Dashboard
        if (!isAdminRoute) {
            console.log('[ProtectedRoute] Redirecting to /locked-workspace (Locked Workspace)');
            return <Redirect to="/locked-workspace" />
        }

        // Non-admins should NEVER be on admin routes if locked (already handled by role check, but for safety)
        if (user?.role !== 'admin') {
            return <Redirect to="/locked-workspace" />
        }
    }

    if (allowedRoles && !hasRole(allowedRoles)) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-destructive mb-4">403</h1>
                    <p className="text-muted-foreground">You don't have permission to access this page.</p>
                </div>
            </div>
        )
    }

    // Check if required feature is enabled
    // 1. Check Workspace Level
    const lacksRequiredFeature = Boolean(requiredFeature && !hasFeature(requiredFeature))
    const lacksAnyRequiredFeature = Boolean(requiredAnyFeature?.length && !requiredAnyFeature.some((feature) => hasFeature(feature)))

    if (lacksRequiredFeature || lacksAnyRequiredFeature || (requiredCapability && !hasCapability(requiredCapability))) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-amber-500 mb-4">Plan Restricted</h1>
                    <p className="text-muted-foreground mb-4">This feature is not included in your workspace plan.</p>
                    <Link href="/" className="text-primary hover:underline">Return to Dashboard</Link>
                </div>
            </div>
        )
    }

    // Check demo-specific restrictions (e.g. Shop demo blocks ecommerce access)
    if (user?.workspaceCode && isDemoWorkspace(user.workspaceCode)) {
        const parsed = parseDemoCode(user.workspaceCode)
        if (parsed && parsed.job === 'shop' && (requiredFeature === 'ecommerce' || requiredAnyFeature?.includes('ecommerce'))) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-background">
                    <div className="text-center max-w-md p-8">
                        <h1 className="text-4xl font-bold text-amber-500 mb-4">Demo Restriction</h1>
                        <p className="text-muted-foreground mb-6">This module is not available in the current demo type.</p>
                        <Link href="/" className="text-primary hover:underline">Return to Dashboard</Link>
                    </div>
                </div>
            )
        }
    }

    // This workspace-level privacy control is intentionally stronger than a
    // member permission. A non-admin must not be able to confirm that the
    // supplier module exists by opening a saved or manually typed route.
    if (
        (requiredPermission === 'suppliers.access' || requiresSupplierAccess)
        && features.suppliers_admin_only
        && user?.role !== 'admin'
    ) {
        return <Redirect to="/" />
    }

    if (requiredPermission && !hasPermission(requiredPermission)) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-destructive mb-4">403</h1>
                    <p className="text-muted-foreground">You don't have permission to access this module.</p>
                    <Link href="/" className="text-primary hover:underline">Return to Dashboard</Link>
                </div>
            </div>
        )
    }

    if (requiredAnyPermission?.length && !requiredAnyPermission.some((p) => hasPermission(p))) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-destructive mb-4">403</h1>
                    <p className="text-muted-foreground">You don't have permission to access this module.</p>
                    <Link href="/" className="text-primary hover:underline">Return to Dashboard</Link>
                </div>
            </div>
        )
    }

    return (
        <BiometricLock>
            {children}
        </BiometricLock>
    )
}

interface GuestRouteProps {
    children: ReactNode
    redirectTo?: string
}

export function GuestRoute({ children, redirectTo = '/' }: GuestRouteProps) {
    const { isAuthenticated, isLoading } = useAuth()

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        )
    }

    if (isAuthenticated) {
        const isFirstTime = !localStorage.getItem('atlas_first_time_done')
        return <Redirect to={isFirstTime ? '/modules' : redirectTo} />
    }

    return <>{children}</>
}
