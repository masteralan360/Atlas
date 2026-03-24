import { type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { Redirect, useLocation, Link } from 'wouter'
import type { UserRole } from '@/local-db/models'
import { useWorkspace, type ModuleFeatureKey } from '@/workspace/WorkspaceContext'
import { BiometricLock } from '@/ui/components'

interface ProtectedRouteProps {
    children: ReactNode
    allowedRoles?: UserRole[]
    redirectTo?: string
    allowKicked?: boolean
    requiredFeature?: ModuleFeatureKey
}

export function ProtectedRoute({
    children,
    allowedRoles,
    redirectTo = '/login',
    allowKicked = false,
    requiredFeature
}: ProtectedRouteProps) {
    const { isAuthenticated, isLoading, hasRole, isKicked, user } = useAuth()
    const { hasFeature, features, isLoading: featuresLoading } = useWorkspace()
    const [location] = useLocation()

    if (isLoading || featuresLoading) {
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
    if (features.locked_workspace && location !== '/locked-workspace') {
        const isAdminRoute = location.startsWith('/admin') || location.startsWith('/workspace-configuration') || location.startsWith('/settings');

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
    if (requiredFeature && !hasFeature(requiredFeature)) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-amber-500 mb-4">Feature Disabled</h1>
                    <p className="text-muted-foreground mb-4">This feature is not enabled for your workspace.</p>
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
        return <Redirect to={redirectTo} />
    }

    return <>{children}</>
}
