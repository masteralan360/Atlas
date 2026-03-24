import React, { useState, useEffect } from 'react'
import {
    Trash2,
    LogOut,
    RefreshCw,
    ShieldCheck,
    Clock,
    User as UserIcon,
    Mail,
    Calendar,
    Building2,
    CheckCircle2,
    XCircle,
    Lock,
    Phone,
    Search,
    AlertCircle,
    MapPin
} from 'lucide-react'
import {
    Button,
    LanguageSwitcher,
    ThemeToggle,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Switch,
    useToast,
    DeleteConfirmationModal,
    Map,
    MapMarker,
    MarkerContent,
    MarkerPopup
} from '@/ui/components'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/lib/utils'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { r2Service } from '@/services/r2Service'

const SESSION_DURATION = 150 // seconds

interface AdminUser {
    id: string
    name: string
    role: string
    created_at: string
    email?: string
    workspace_name?: string
    profileUrl?: string
    phone?: string
}

interface AdminWorkspace {
    id: string
    name: string
    code: string
    created_at: string
    data_mode: 'cloud' | 'local'
    pos: boolean
    crm: boolean
    invoices_history: boolean
    is_configured: boolean
    locked_workspace: boolean
    subscription_expires_at: string | null
    deleted_at?: string | null
    coordination?: string
    logo_url?: string
}

export function Admin() {
    const [,] = useLocation()
    const { toast } = useToast()
    const { t } = useTranslation()
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [passkey, setPasskey] = useState('')
    const [error, setError] = useState('')

    // Data State
    const [users, setUsers] = useState<AdminUser[]>([])
    const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([])

    // UI State
    const [timeLeft, setTimeLeft] = useState(SESSION_DURATION)
    const [isLoading, setIsLoading] = useState(false)
    const [activeTab, setActiveTab] = useState('users')
    const [showDeleted, setShowDeleted] = useState(false)
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null)
    const [searchTerm, setSearchTerm] = useState('')
    const [customExpiries, setCustomExpiries] = useState<Record<string, string>>({})

    const showActionError = (err: unknown, fallbackTitle: string) => {
        const normalized = normalizeSupabaseActionError(err)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({
                variant: 'destructive',
                title: message.title,
                description: message.description
            })
            return normalized.message
        }

        toast({
            variant: 'destructive',
            title: fallbackTitle,
            description: normalized.message
        })
        return normalized.message
    }

    // Handle session timeout
    useEffect(() => {
        if (!isAuthenticated) return

        if (timeLeft <= 0) {
            handleLogout()
            return
        }

        const timer = setInterval(() => {
            setTimeLeft(prev => prev - 1)
        }, 1000)

        return () => clearInterval(timer)
    }, [isAuthenticated, timeLeft])

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)
        setError('')
        try {
            const { data: isValid, error: rpcError } = await runSupabaseAction(
                'admin.verifyPasskey',
                () => supabase.rpc('verify_admin_passkey', { provided_key: passkey })
            )

            if (rpcError) throw normalizeSupabaseActionError(rpcError)

            if (isValid) {
                setIsAuthenticated(true)
                setTimeLeft(SESSION_DURATION)
                fetchData()
            } else {
                setError('Invalid passkey. Access denied.')
            }
        } catch (err: any) {
            const description = showActionError(err, 'Verification failed')
            setError('Verification failed: ' + description)
        } finally {
            setIsLoading(false)
        }
    }

    const handleLogout = () => {
        setIsAuthenticated(false)
        setPasskey('')
        setUsers([])
        setWorkspaces([])
        setShowDeleted(false)
    }

    const fetchData = async () => {
        if (!isSupabaseConfigured) {
            console.warn('[Admin] Supabase is NOT configured. Showing demo empty list.')
            setUsers([])
            setWorkspaces([])
            return
        }

        setIsLoading(true)
        // Fetch both users and workspaces
        try {
            // 1. Fetch Users
            const { data: userData, error: userError } = await runSupabaseAction(
                'admin.getUsers',
                () => supabase.rpc('get_all_users', { provided_key: passkey })
            )
            if (userError) throw normalizeSupabaseActionError(userError)
            setUsers(userData as AdminUser[])

            // 2. Fetch Workspaces
            const { data: wsData, error: wsError } = await runSupabaseAction(
                'admin.getWorkspaces',
                () => supabase.rpc('get_all_workspaces', { provided_key: passkey })
            )
            if (wsError) throw normalizeSupabaseActionError(wsError)
            setWorkspaces(wsData as AdminWorkspace[])

        } catch (err: any) {
            console.error('[Admin] fetchData FAILED:', err)
            const description = showActionError(err, 'Error fetching data')
            setError('Failed to fetch data: ' + description)
        } finally {
            setIsLoading(false)
        }
    }

    const handleDeleteUser = (user: AdminUser) => {
        setUserToDelete(user)
        setDeleteModalOpen(true)
    }

    const confirmDeleteUser = async () => {
        if (!userToDelete) return
        setIsLoading(true)
        try {
            const { error } = await runSupabaseAction(
                'admin.deleteUser',
                () => supabase.rpc('delete_user_account', { target_user_id: userToDelete.id })
            )
            if (error) throw normalizeSupabaseActionError(error)

            setUsers(users.filter(u => u.id !== userToDelete.id))
            fetchData()
            setDeleteModalOpen(false)
            setUserToDelete(null)
            toast({ title: "User deleted successfully" })
        } catch (err: any) {
            showActionError(err, 'Failed to delete user')
        } finally {
            setIsLoading(false)
        }
    }

    const handleToggleWorkspaceFeature = async (
        workspaceId: string,
        feature: 'pos' | 'crm' | 'invoices_history' | 'locked_workspace',
        currentValue: boolean
    ) => {
        // Optimistic update
        setWorkspaces(prev => prev.map(ws =>
            ws.id === workspaceId ? { ...ws, [feature]: !currentValue } : ws
        ))

        const workspace = workspaces.find(w => w.id === workspaceId)
        if (!workspace) return

        // Prepare new values (toggling the specific feature)
        const newValues = {
            pos: feature === 'pos' ? !workspace.pos : workspace.pos,
            crm: feature === 'crm' ? !workspace.crm : workspace.crm,
            invoices_history: feature === 'invoices_history' ? !workspace.invoices_history : workspace.invoices_history,
            locked_workspace: feature === 'locked_workspace' ? !workspace.locked_workspace : workspace.locked_workspace,
        }

        try {
            const { error } = await runSupabaseAction('admin.updateWorkspaceFeatures', () =>
                supabase.rpc('admin_update_workspace_features', {
                    provided_key: passkey,
                    target_workspace_id: workspaceId,
                    new_pos: newValues.pos,
                    new_crm: newValues.crm,
                    new_invoices_history: newValues.invoices_history,
                    new_locked_workspace: newValues.locked_workspace
                })
            )

            if (error) throw normalizeSupabaseActionError(error)

            // Success toast optional to avoid spamming, but good for confirmation
            // toast({ title: "Workspace updated" })
        } catch (err: any) {
            console.error('Failed to update workspace:', err)
            // Revert on failure
            setWorkspaces(prev => prev.map(ws =>
                ws.id === workspaceId ? { ...ws, [feature]: currentValue } : ws
            ))
            showActionError(err, 'Update failed')
        }
    }

    const handleExtendSubscription = async (workspaceId: string, customDate?: string) => {
        setIsLoading(true)
        try {
            let newExpiry: Date
            if (customDate) {
                newExpiry = new Date(customDate)
            } else {
                // Find current expiry
                const ws = workspaces.find(w => w.id === workspaceId)
                let baseDate = ws?.subscription_expires_at ? new Date(ws.subscription_expires_at) : new Date()

                // If already expired, start from now
                if (baseDate < new Date()) {
                    baseDate = new Date()
                }

                newExpiry = new Date(baseDate)
                newExpiry.setMonth(newExpiry.getMonth() + 1)
            }

            const { error } = await runSupabaseAction('admin.updateWorkspaceSubscription', () =>
                supabase.rpc('admin_update_workspace_subscription', {
                    provided_key: passkey,
                    target_workspace_id: workspaceId,
                    new_expiry: newExpiry.toISOString()
                })
            )

            if (error) throw normalizeSupabaseActionError(error)

            toast({
                title: t('common.success') || "Subscription Updated",
                description: customDate ? t('admin.expiryUpdated') || "New expiry date set." : t('admin.subscriptionExtended') || "Workspace extended by 1 month."
            })
            fetchData()
        } catch (err: any) {
            showActionError(err, t('common.error') || 'Update Failed')
        } finally {
            setIsLoading(false)
        }
    }

    const getSubscriptionStatus = (ws: AdminWorkspace) => {
        if (ws.locked_workspace) return { label: t('admin.locked') || 'Locked', color: 'text-destructive bg-destructive/10', icon: XCircle }
        if (!ws.subscription_expires_at) return { label: t('admin.noLimit') || 'No Limit', color: 'text-neutral-500 bg-neutral-100', icon: CheckCircle2 }

        const expiry = new Date(ws.subscription_expires_at)
        const now = new Date()
        const diffDays = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

        if (diffDays < 0) return { label: t('admin.expired') || 'Expired', color: 'text-destructive bg-destructive/10', icon: AlertCircle }
        if (diffDays < 7) return { label: `${diffDays} ${t('admin.daysLeft') || 'days left'}`, color: 'text-amber-600 bg-amber-50', icon: Clock }

        return { label: t('admin.active') || 'Active', color: 'text-green-600 bg-green-50', icon: CheckCircle2 }
    }

    // Filter workspaces based on showDeleted toggle
    const filteredWorkspaces = workspaces.filter(ws => showDeleted ? true : !ws.deleted_at)

    if (!isAuthenticated) {
        return (
            <div className="h-screen overflow-y-auto flex items-center justify-center bg-background p-4 relative pt-[calc(var(--titlebar-height)+1rem)] pb-20">
                <div className="absolute top-[calc(var(--titlebar-height)+1rem)] right-4 flex items-center gap-2">
                    <LanguageSwitcher />
                    <ThemeToggle />
                </div>
                <div className="w-full max-w-sm bg-card rounded-2xl border border-border p-8 shadow-xl">
                    <div className="flex justify-center mb-6">
                        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <ShieldCheck className="w-6 h-6" />
                        </div>
                    </div>
                    <div className="text-center mb-8">
                        <h1 className="text-2xl font-bold mb-2">Admin Access</h1>
                        <p className="text-sm text-muted-foreground">Please enter the admin passkey to continue.</p>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <input
                                type="password"
                                placeholder="Enter passkey"
                                value={passkey}
                                onChange={(e) => setPasskey(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
                                autoFocus
                            />
                        </div>
                        {error && <p className="text-xs text-destructive text-center mb-4">{error}</p>}
                        {!isSupabaseConfigured && (
                            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-4">
                                <p className="text-xs text-amber-500 text-center">
                                    Supabase is not configured. Admin features require a live Supabase connection.
                                </p>
                            </div>
                        )}
                        <Button
                            type="submit"
                            className="w-full py-6 rounded-xl text-md font-semibold"
                            disabled={isLoading || !isSupabaseConfigured}
                        >
                            {isLoading ? 'Verifying...' : 'Submit'}
                        </Button>
                    </form>
                </div>
            </div>
        )
    }

    return (
        <div className="h-screen overflow-y-auto bg-background text-foreground p-4 lg:p-8 pt-[calc(var(--titlebar-height)+2rem)] lg:pt-[calc(var(--titlebar-height)+4rem)] pb-24">
            <div className="max-w-6xl mx-auto">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-12">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                            <ShieldCheck className="w-6 h-6" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold">Admin Dashboard</h1>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <span>Manage users and workspace configurations.</span>
                                <span className="flex items-center gap-1 text-primary animate-pulse">
                                    <Clock className="w-3 h-3" />
                                    Session expires in {timeLeft}s.
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Button variant="outline" onClick={fetchData} disabled={isLoading} className="rounded-xl">
                            <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                            Refresh Data
                        </Button>
                        <Button variant="outline" onClick={handleLogout} className="rounded-xl border-destructive/20 text-destructive hover:bg-destructive/5">
                            <LogOut className="w-4 h-4 mr-2" />
                            {t('admin.logout')}
                        </Button>
                    </div>
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                    <TabsList className="grid w-full grid-cols-4">
                        <TabsTrigger value="users">{t('admin.users') || 'Registered Users'}</TabsTrigger>
                        <TabsTrigger value="workspaces">{t('admin.workspaces') || 'Workspace Configuration'}</TabsTrigger>
                        <TabsTrigger value="subscriptions">{t('admin.subscriptions') || 'Subscriptions'}</TabsTrigger>
                        <TabsTrigger value="geolocation">{t('admin.geolocation') || 'Workspace Geolocation'}</TabsTrigger>
                    </TabsList>

                    {/* USERS TAB */}
                    <TabsContent value="users" className="space-y-4">
                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            <div className="p-6 border-b border-border bg-muted/5">
                                <h2 className="text-lg font-semibold flex items-center gap-2">
                                    <UserIcon className="w-5 h-5" />
                                    {t('admin.registeredUsers')}
                                </h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('admin.totalUsers', { count: users.length })}
                                </p>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full border-collapse">
                                    <thead>
                                        <tr className="bg-muted/30">
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.user')}</th>
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.contact')}</th>
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.role')}</th>
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.workspace')}</th>
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.joined')}</th>
                                            <th className="px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.actions')}</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {users.map((user) => (
                                            <tr key={user.id} className="hover:bg-muted/10 transition-colors group">
                                                <td className="px-6 py-4">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-bold border border-border overflow-hidden">
                                                            {user.name?.charAt(0).toUpperCase() || <UserIcon className="w-5 h-5" />}
                                                        </div>
                                                        <div>
                                                            <div className="font-medium">{user.name}</div>
                                                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                                                                <Mail className="w-3 h-3" />
                                                                {user.email}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex flex-col gap-1">
                                                        <span className="px-2 py-1 rounded bg-muted text-[10px] font-mono w-fit">
                                                            @{user.name?.toLowerCase().replace(/\s+/g, '')}
                                                        </span>
                                                        {user.phone && (
                                                            <div className="text-[10px] text-muted-foreground flex items-center gap-1 font-mono">
                                                                <Phone className="w-2.5 h-2.5" />
                                                                {user.phone}
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className="capitalize text-sm font-medium">
                                                        {user.role}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    {user.workspace_name ? (
                                                        <span className="px-2 py-1 rounded bg-primary/10 text-primary text-xs font-medium">
                                                            {user.workspace_name}
                                                        </span>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground italic">No Workspace</span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="text-sm flex items-center gap-1.5 text-muted-foreground">
                                                        <Calendar className="w-3.5 h-3.5" />
                                                        {formatDate(user.created_at)}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <button
                                                        onClick={() => handleDeleteUser(user)}
                                                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                                        title="Delete User"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                        {users.length === 0 && !isLoading && (
                                            <tr>
                                                <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                                                    No users found.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </TabsContent>

                    {/* WORKSPACES TAB */}
                    <TabsContent value="workspaces" className="space-y-4">
                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                            <div className="p-6 border-b border-border bg-muted/5 flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-semibold flex items-center gap-2">
                                        <Building2 className="w-5 h-5" />
                                        {t('admin.workspaces')}
                                    </h2>
                                    <p className="text-sm text-muted-foreground mt-1">
                                        {t('admin.manageFeatures')}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{t('admin.showDeleted')}</span>
                                    <Switch
                                        checked={showDeleted}
                                        onCheckedChange={setShowDeleted}
                                    />
                                </div>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full border-collapse">
                                    <thead>
                                        <tr className="bg-muted/30">
                                            <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-[30%]">{t('admin.workspace')}</th>
                                            <th className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.pos')}</th>
                                            <th className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">CRM</th>
                                            <th className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.invoices')}</th>
                                            <th className="px-6 py-4 text-center text-xs font-semibold text-amber-500 uppercase tracking-wider"><Lock className="w-4 h-4 inline" /></th>
                                            <th className="px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.configured')}</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {filteredWorkspaces.map((ws) => (
                                            <tr key={ws.id} className={`hover:bg-muted/10 transition-colors ${ws.deleted_at ? 'opacity-50 grayscale' : ''}`}>
                                                <td className="px-6 py-4">
                                                    <div>
                                                        <div className="font-medium flex items-center gap-2">
                                                            {ws.name}
                                                            <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground border border-border">
                                                                {ws.code}
                                                            </span>
                                                            {ws.deleted_at && (
                                                                <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive text-[10px] font-bold uppercase border border-destructive/20">
                                                                    Deleted
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${ws.data_mode === 'local' ? 'border-sky-500/20 bg-sky-500/10 text-sky-700' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700'}`}>
                                                                {ws.data_mode === 'local' ? 'Local' : 'Cloud'}
                                                            </span>
                                                        </div>
                                                        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                                                            <Calendar className="w-3 h-3" />
                                                            {new Date(ws.created_at).toLocaleDateString()}
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex justify-center">
                                                        <Switch
                                                            checked={ws.pos}
                                                            onCheckedChange={() => handleToggleWorkspaceFeature(ws.id, 'pos', ws.pos)}
                                                            disabled={!!ws.deleted_at}
                                                        />
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex justify-center">
                                                        <Switch
                                                            checked={ws.crm}
                                                            onCheckedChange={() => handleToggleWorkspaceFeature(ws.id, 'crm', ws.crm)}
                                                            disabled={!!ws.deleted_at}
                                                        />
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex justify-center">
                                                        <Switch
                                                            checked={ws.invoices_history}
                                                            onCheckedChange={() => handleToggleWorkspaceFeature(ws.id, 'invoices_history', ws.invoices_history)}
                                                            disabled={!!ws.deleted_at}
                                                        />
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex justify-center">
                                                        <Switch
                                                            checked={ws.locked_workspace}
                                                            onCheckedChange={() => handleToggleWorkspaceFeature(ws.id, 'locked_workspace', ws.locked_workspace)}
                                                            disabled={!!ws.deleted_at}
                                                        />
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex justify-end pr-2">
                                                        {ws.is_configured ? (
                                                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                                                        ) : (
                                                            <XCircle className="w-4 h-4 text-amber-500" />
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                        {filteredWorkspaces.length === 0 && !isLoading && (
                                            <tr>
                                                <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                                                    {showDeleted ? t('admin.noWorkspaces') : t('admin.noActiveWorkspaces')}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </TabsContent>

                    {/* SUBSCRIPTIONS TAB */}
                    <TabsContent value="subscriptions" className="space-y-4">
                        <div className="space-y-4">
                            <div className="flex items-center gap-4 bg-muted/20 p-4 rounded-xl border border-border">
                                <div className="relative flex-1">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder={t('admin.searchPlaceholder') || "Search workspace by name or code..."}
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                                    />
                                </div>
                            </div>

                            <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                                <div className="p-6 border-b border-border bg-muted/5">
                                    <h2 className="text-lg font-semibold flex items-center gap-2">
                                        <Clock className="w-5 h-5" />
                                        {t('admin.workspaceSubscriptions') || "Workspace Subscriptions"}
                                    </h2>
                                    <p className="text-sm text-muted-foreground mt-1">
                                        {t('admin.manageSubscriptions') || "Manage subscription periods and access for all workspaces."}
                                    </p>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full border-collapse">
                                        <thead>
                                            <tr className="bg-muted/30">
                                                <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.workspace')}</th>
                                                <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.status')}</th>
                                                <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.expiresAt')}</th>
                                                <th className="px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin.actions')}</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border">
                                            {workspaces
                                                .filter(ws =>
                                                    ws.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                                    ws.code.toLowerCase().includes(searchTerm.toLowerCase())
                                                )
                                                .map((ws) => {
                                                    const status = getSubscriptionStatus(ws)
                                                    const StatusIcon = status.icon

                                                    return (
                                                        <tr key={ws.id} className="hover:bg-muted/10 transition-colors group">
                                                            <td className="px-6 py-4">
                                                                <div className="font-medium">{ws.name}</div>
                                                                <div className="text-xs text-muted-foreground font-mono">{ws.code}</div>
                                                            </td>
                                                            <td className="px-6 py-4">
                                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${status.color}`}>
                                                                    <StatusIcon className="w-3.5 h-3.5" />
                                                                    {status.label}
                                                                </span>
                                                            </td>
                                                            <td className="px-6 py-4">
                                                                {ws.subscription_expires_at ? (
                                                                    <div className="text-sm flex items-center gap-1.5 text-muted-foreground">
                                                                        <Calendar className="w-3.5 h-3.5" />
                                                                        {formatDate(ws.subscription_expires_at)}
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-xs text-muted-foreground italic">Lifetime</span>
                                                                )}
                                                            </td>
                                                            <td className="px-6 py-4 text-right">
                                                                <div className="flex justify-end items-center gap-2">
                                                                    <div className="flex items-center gap-1 bg-background border border-border rounded-lg p-1">
                                                                        <input
                                                                            type="date"
                                                                            className="bg-transparent border-none text-[11px] focus:outline-none px-1"
                                                                            value={customExpiries[ws.id] || ''}
                                                                            onChange={(e) => setCustomExpiries(prev => ({ ...prev, [ws.id]: e.target.value }))}
                                                                        />
                                                                        <Button
                                                                            size="sm"
                                                                            variant="ghost"
                                                                            className="h-6 px-2 text-[10px] hover:bg-primary/10 hover:text-primary"
                                                                            onClick={() => handleExtendSubscription(ws.id, customExpiries[ws.id])}
                                                                            disabled={isLoading || !customExpiries[ws.id]}
                                                                        >
                                                                            {t('admin.setExpiry')}
                                                                        </Button>
                                                                    </div>
                                                                    <div className="h-4 w-[1px] bg-border mx-1" />
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        className="h-8 rounded-lg text-[11px]"
                                                                        onClick={() => handleExtendSubscription(ws.id)}
                                                                        disabled={isLoading}
                                                                    >
                                                                        {t('admin.extend')}
                                                                    </Button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    {/* GEOLOCATION TAB */}
                    <TabsContent value="geolocation" className="space-y-4">
                        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden h-[600px] flex flex-col">
                            <div className="p-6 border-b border-border bg-muted/5">
                                <h2 className="text-lg font-semibold flex items-center gap-2">
                                    <MapPin className="w-5 h-5" />
                                    {t('admin.workspaceGeolocation') || "Workspace Geolocation"}
                                </h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('admin.manageGeolocation') || "View all active workspaces on the map."}
                                </p>
                            </div>
                            <div className="flex-1 relative">
                                <Map
                                    viewport={{ zoom: 3, center: [44.361488, 33.315241] }}
                                    className="w-full h-full rounded-b-2xl"
                                >
                                    {filteredWorkspaces.map(ws => {
                                        if (!ws.coordination) return null;
                                        const [latStr, lngStr] = ws.coordination.split(',').map(s => s.trim());
                                        const lat = parseFloat(latStr);
                                        const lng = parseFloat(lngStr);
                                        if (isNaN(lat) || isNaN(lng)) return null;

                                        let logoSrc = undefined;
                                        if (ws.logo_url) {
                                            if (ws.logo_url.startsWith('http')) {
                                                logoSrc = ws.logo_url;
                                            } else {
                                                // DB: workspaces/workspaceId/logo.png -> R2: workspaceId/workspaces/logo.png
                                                const parts = ws.logo_url.split('/');
                                                let r2Key = ws.logo_url;
                                                if (parts.length >= 3) {
                                                    const folderPart = parts[0];
                                                    const wsIdPart = parts[1];
                                                    const filePart = parts.slice(2).join('/');
                                                    r2Key = `${wsIdPart}/${folderPart}/${filePart}`;
                                                }
                                                logoSrc = r2Service.getUrl(r2Key);
                                            }
                                        }

                                        return (
                                            <MapMarker
                                                key={ws.id}
                                                latitude={lat}
                                                longitude={lng}
                                            >
                                                <MarkerContent>
                                                    <div className="relative w-10 h-10 rounded-full border-2 border-primary bg-background shadow-lg overflow-hidden flex items-center justify-center">
                                                        {logoSrc ? (
                                                            <>
                                                                <img
                                                                    src={logoSrc}
                                                                    alt={ws.name}
                                                                    className="w-full h-full object-cover relative z-10"
                                                                    onError={(e) => {
                                                                        (e.target as HTMLImageElement).style.opacity = '0';
                                                                    }}
                                                                />
                                                                <span className="font-bold text-lg text-primary flex items-center justify-center w-full h-full absolute inset-0 z-0">
                                                                    {ws.name.charAt(0).toUpperCase()}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <span className="font-bold text-lg text-primary flex items-center justify-center w-full h-full">
                                                                {ws.name.charAt(0).toUpperCase()}
                                                            </span>
                                                        )}
                                                    </div>
                                                </MarkerContent>
                                                <MarkerPopup className="p-3 max-w-[200px]">
                                                    <div className="text-sm font-semibold">{ws.name}</div>
                                                    <div className="text-xs text-muted-foreground mt-1">
                                                        {ws.code}
                                                    </div>
                                                </MarkerPopup>
                                            </MapMarker>
                                        );
                                    })}
                                </Map>
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </div>

            <DeleteConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={confirmDeleteUser}
                itemName={userToDelete?.name}
                isLoading={isLoading}
                title={t('auth.confirmDeleteUser')}
                description={t('auth.deleteUserWarning')}
            />
        </div>
    )
}
