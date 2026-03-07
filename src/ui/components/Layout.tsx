import { type ReactNode, Suspense } from 'react'
import { Link, useLocation } from 'wouter'
import { cn } from '@/lib/utils'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { SyncStatusIndicator } from './SyncStatusIndicator'
import { ExchangeRateIndicator } from './ExchangeRateIndicator'
import { GlobalSearch } from './GlobalSearch'
import { P2PSyncIndicator } from './P2PSyncStatus'
import { assetManager } from '@/lib/assetManager'
import { platformService } from '@/services/platformService'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { ResourceSyncOverlay } from './p2p/ResourceSyncOverlay'
import { NotificationCenter } from './NotificationCenter'
import { ManualRateModals } from './exchange/ManualRateModals'
import { GlobalExpenseReminders } from './budget/GlobalExpenseReminders'

import {
    LayoutDashboard,
    Package,
    FileText,
    Settings,
    LogOut,
    Menu,
    X,
    Boxes,
    Copy,
    Check,
    UsersRound,
    CreditCard,
    Receipt,
    TrendingUp,
    ChevronLeft,
    ChevronRight,
    BarChart3,
    RotateCw,
    MessageSquare,
    Truck,
    Users,
    ShoppingBag,
    Warehouse,
    ArrowRightLeft,
    Wallet,
    HandCoins,
    AlertCircle,
    PanelRightOpen,
    PanelRightClose
} from 'lucide-react'
import { useState } from 'react'
import { Button } from './button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog'
import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { supabase } from '@/auth/supabase'
import { isMobile, isDesktop } from '@/lib/platform'

interface LayoutProps {
    children: ReactNode
}

import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useBudgetLimitReached as useBudgetLimitReachedHook } from '@/local-db'

// Route prefetch map for on-hover preloading (desktop only)
const routePrefetchMap: Record<string, () => Promise<unknown>> = {
    '/': () => import('@/ui/pages/Dashboard'),
    '/pos': () => import('@/ui/pages/POS'),
    '/sales': () => import('@/ui/pages/Sales'),
    '/loans': () => import('@/ui/pages/Loans'),
    '/revenue': () => import('@/ui/pages/Revenue'),
    '/monthly-comparison': () => import('@/ui/pages/MonthlyComparison'),
    '/budget': () => import('@/ui/pages/Budget'),
    '/performance': () => import('@/ui/pages/TeamPerformance'),
    '/whatsapp': () => import('@/ui/pages/WhatsAppWeb'),
    '/products': () => import('@/ui/pages/Products'),
    '/storages': () => import('@/ui/pages/Storages'),
    '/inventory-transfer': () => import('@/ui/pages/InventoryTransfer'),
    '/suppliers': () => import('@/ui/pages/Suppliers'),
    '/customers': () => import('@/ui/pages/Customers'),
    '/orders': () => import('@/ui/pages/Orders'),
    '/invoices-history': () => import('@/ui/pages/InvoicesHistory'),
    '/hr': () => import('@/ui/pages/HR'),
    '/members': () => import('@/ui/pages/Members'),
    '/settings': () => import('@/ui/pages/Settings'),
}

// Prefetch a route's chunk on hover (only triggers once per route)
const prefetchedRoutes = new Set<string>()
function prefetchRoute(href: string) {
    if (prefetchedRoutes.has(href)) return
    const prefetcher = routePrefetchMap[href]
    if (prefetcher) {
        prefetchedRoutes.add(href)
        prefetcher().catch(() => { /* ignore prefetch errors */ })
    }
}

export function Layout({ children }: LayoutProps) {
    const [location, setLocation] = useLocation()
    const { user, signOut } = useAuth()
    const { hasFeature, workspaceName, isFullscreen, features } = useWorkspace()

    // Budget Alert Monitoring
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const budgetLimitReached = useBudgetLimitReachedHook(
        user?.workspaceId,
        features.default_currency || 'usd',
        {
            usd_iqd: (exchangeData?.rate || 145000) / 100,
            eur_iqd: (eurRates.eur_iqd?.rate || 160000) / 100,
            try_iqd: (tryRates.try_iqd?.rate || 4500) / 100
        }
    )

    const { t } = useTranslation()
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('desktop_sidebar_open') !== 'false'
        }
        return true
    })
    const [isMini, setIsMini] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('sidebar_is_mini') === 'true'
        }
        return false
    })

    const [members, setMembers] = useState<{ id: string, name: string, role: string, profile_url?: string }[]>([])
    const [logoError, setLogoError] = useState(false)
    const [copied, setCopied] = useState(false)
    const [version, setVersion] = useState('')
    const [whatsappStatus, setWhatsappStatus] = useState<'live' | 'off'>(whatsappManager.isActive() ? 'live' : 'off')
    const [isSignOutModalOpen, setIsSignOutModalOpen] = useState(false)

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const toggleMini = () => {
        const newState = !isMini
        setIsMini(newState)
        localStorage.setItem('sidebar_is_mini', String(newState))
    }

    useEffect(() => {
        if (!user?.workspaceId) return

        const fetchMembers = async () => {
            const { data, error } = await supabase
                .from('profiles')
                .select('id, name, role, profile_url')
                .eq('workspace_id', user.workspaceId)

            if (!error && data) {
                setMembers(data)
            }
        }

        fetchMembers()

        // Initialize Asset Manager
        if (user?.id && user?.workspaceId) {
            assetManager.initialize(user.workspaceId);
        }

        // Fetch App Version
        // @ts-ignore
        if (window.__TAURI_INTERNALS__) {
            import('@tauri-apps/api/app').then(({ getVersion }) => {
                getVersion().then(setVersion).catch(console.error)
            })
        }

        // Handle mobile sidebar trigger from child components
        const handleOpen = () => setMobileSidebarOpen(true)
        window.addEventListener('open-mobile-sidebar', handleOpen)
        window.addEventListener('profile-updated', fetchMembers)

        // Handle WhatsApp status changes
        const handleWhatsAppStatusChange = (e: any) => {
            const newStatus = e.detail.active ? 'live' : 'off';
            console.log(`[Layout Debug] WhatsApp status changed: ${newStatus}`, e.detail);
            setWhatsappStatus(newStatus);
        }
        window.addEventListener('whatsapp-status-change', handleWhatsAppStatusChange);

        return () => {
            window.removeEventListener('open-mobile-sidebar', handleOpen)
            window.removeEventListener('profile-updated', fetchMembers)
            window.removeEventListener('whatsapp-status-change', handleWhatsAppStatusChange)
        }
    }, [user?.workspaceId])

    // @ts-ignore
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

    // WhatsApp Webview Global Visibility Sync
    useEffect(() => {
        if (!isTauri) return;

        // If user is NOT on the whatsapp page, ensure the webview is hidden
        // This acts as a global fail-safe during navigation or refreshes
    }, [location, isTauri]);

    // Locking Enforcement
    const { isLocked } = useWorkspace()
    useEffect(() => {
        if (isLocked && location !== '/locked-workspace') {
            console.log('[Layout] Workspace is LOCKED. Redirecting to /locked-workspace')
            setLocation('/locked-workspace')
        }
    }, [isLocked, location])

    const navigation = [
        { name: t('nav.dashboard'), href: '/', icon: LayoutDashboard },
        // POS - requires feature flag AND role
        ...((user?.role === 'admin' || user?.role === 'staff') && hasFeature('allow_pos') ? [
            { name: t('nav.pos') || 'POS', href: '/pos', icon: CreditCard }
        ] : []),
        // Sales - always visible (history of transactions)
        { name: t('nav.sales') || 'Sales', href: '/sales', icon: Receipt },
        { name: t('nav.loans') || 'Loans', href: '/loans', icon: HandCoins },
        // Revenue - admin only
        ...(user?.role === 'admin' ? [
            { name: t('nav.revenue') || 'Net Revenue', href: '/revenue', icon: BarChart3 },
            { name: t('monthlyComparison.title', 'Monthly Comparison'), href: '/monthly-comparison', icon: ArrowRightLeft },
            { name: t('nav.budget') || 'Budget', href: '/budget', icon: Wallet, alert: budgetLimitReached },
            { name: t('nav.performance') || 'Team Performance', href: '/performance', icon: TrendingUp }
        ] : []),
        // WhatsApp - requires feature flag AND role AND desktop platform
        ...((user?.role === 'admin' || user?.role === 'staff') && hasFeature('allow_whatsapp') && isDesktop() ? [
            { name: t('nav.whatsapp'), href: '/whatsapp', icon: MessageSquare, status: whatsappStatus }
        ] : []),
        // Products - always visible
        { name: t('nav.products'), href: '/products', icon: Package },
        // Storages - always visible
        { name: t('nav.storages') || 'Storages', href: '/storages', icon: Warehouse },
        // Inventory Transfer
        { name: t('nav.inventoryTransfer') || 'Transfer', href: '/inventory-transfer', icon: ArrowRightLeft },
        // Suppliers
        ...(hasFeature('allow_suppliers') ? [
            { name: t('nav.suppliers') || 'Suppliers', href: '/suppliers', icon: Truck }
        ] : []),
        // Customers
        ...(hasFeature('allow_customers') ? [
            { name: t('nav.customers') || 'Customers', href: '/customers', icon: Users }
        ] : []),
        // Orders
        ...(hasFeature('allow_orders') ? [
            { name: t('nav.orders') || 'Orders', href: '/orders', icon: ShoppingBag }
        ] : []),
        // Invoices - requires feature flag
        ...(hasFeature('allow_invoices') ? [
            { name: t('nav.invoicesHistory') || 'Invoices History', href: '/invoices-history', icon: FileText }
        ] : []),
        // Admin/Staff routes
        ...((user?.role === 'admin' || user?.role === 'staff') ? [
            { name: t('nav.hr') || 'HR', href: '/hr', icon: UsersRound },
            { name: t('members.title'), href: '/members', icon: Users },
        ] : []),
        ...((user?.role === 'admin' || user?.role === 'staff') ? [
            { name: t('nav.settings'), href: '/settings', icon: Settings }
        ] : []),
    ]

    return (
        <div className="h-screen overflow-hidden bg-transparent">
            <ResourceSyncOverlay />
            <ManualRateModals />
            <GlobalExpenseReminders />
            {/* Mobile sidebar backdrop */}
            {mobileSidebarOpen && (
                <div
                    className={cn("fixed inset-0 z-40 bg-black/50 lg:hidden", isTauri && "top-[var(--titlebar-height)]")}
                    onClick={() => setMobileSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside
                className={cn(
                    'fixed z-50 transition-all duration-300 ease-in-out flex flex-col',
                    mobileSidebarOpen ? 'bg-card border-r border-border/50' : 'glass',
                    'sidebar-gradient shadow-2xl',
                    isTauri ? 'top-[var(--titlebar-height)] h-[calc(100vh-var(--titlebar-height))]' : 'inset-y-0 h-full',
                    'pt-[var(--safe-area-top)] pb-[var(--safe-area-bottom)]',
                    // Desktop state - Width changes based on isMini
                    isMini
                        ? (desktopSidebarOpen ? 'w-[70px] lg:translate-x-0 lg:rtl:translate-x-0' : 'lg:-translate-x-full lg:rtl:translate-x-full w-[70px]')
                        : (desktopSidebarOpen ? 'w-64 lg:translate-x-0 lg:rtl:translate-x-0' : 'lg:-translate-x-full lg:rtl:translate-x-full w-64'),

                    // Positioning
                    'left-0 rtl:left-auto rtl:right-0',
                    'border-r rtl:border-r-0 rtl:border-l border-border',
                    // Mobile state
                    mobileSidebarOpen ? 'translate-x-0 w-64' : '-translate-x-full rtl:translate-x-full',
                )}
            >
                {/* Logo */}
                <div className={cn(
                    "flex items-center gap-3 px-6 py-5 border-b border-border transition-all duration-300",
                    isMini && !mobileSidebarOpen ? "justify-center px-2 flex-col gap-2" : ""
                )}>
                    {features.logo_url ? (
                        <img
                            src={features.logo_url.startsWith('http') ? features.logo_url : platformService.convertFileSrc(features.logo_url)}
                            alt="Workspace Logo"
                            className="w-10 h-10 object-contain rounded-sm"
                            onError={() => setLogoError(true)}
                        />
                    ) : !logoError ? (
                        <img
                            src="/logo.png"
                            alt="Logo"
                            className="w-10 h-10 object-contain rounded-sm"
                            onError={() => setLogoError(true)}
                        />
                    ) : (
                        <Boxes className="w-8 h-8 text-primary" />
                    )}

                    {!(isMini && !mobileSidebarOpen) && (
                        <div>
                            <h1 className="text-lg font-bold gradient-text">{workspaceName || 'Asaas'}</h1>
                            <p className="text-xs text-muted-foreground">Workspace</p>
                        </div>
                    )}

                    <button
                        className="ms-auto lg:hidden"
                        onClick={() => setMobileSidebarOpen(false)}
                    >
                        <X className="w-5 h-5" />
                    </button>

                    {/* Mini Toggle Button (Desktop Only) */}
                    <button
                        onClick={toggleMini}
                        className={cn(
                            "hidden lg:flex items-center justify-center w-6 h-6 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-all",
                            isMini ? "mt-2 rotate-180" : "ms-auto"
                        )}
                        title={isMini ? "Expand Sidebar" : "Collapse Sidebar"}
                    >
                        <PanelRightOpen className="w-4 h-4 rtl:hidden" />
                        <PanelRightClose className="w-4 h-4 hidden rtl:block" />
                    </button>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
                    {navigation.map((item) => {
                        const isActive = location === item.href ||
                            (item.href !== '/' && location.startsWith(item.href))
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                onClick={() => setMobileSidebarOpen(false)}
                                onMouseEnter={() => !isMobile() && prefetchRoute(item.href)}
                            >
                                <span
                                    className={cn(
                                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-300',
                                        isActive
                                            ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/30 scale-[1.02]'
                                            : 'text-muted-foreground hover:bg-primary/5 hover:text-primary',
                                        (isMini && !mobileSidebarOpen) && "justify-center px-0 py-3"
                                    )}
                                    title={(isMini && !mobileSidebarOpen) ? item.name : undefined}
                                >
                                    <item.icon className="w-5 h-5 flex-shrink-0" />
                                    {!(isMini && !mobileSidebarOpen) && (
                                        <>
                                            {item.name}
                                            {item.alert && (
                                                <div className="ms-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white">
                                                    <AlertCircle className="w-3.5 h-3.5" />
                                                </div>
                                            )}
                                            {item.status && (
                                                <div className={cn(
                                                    "ms-auto w-2 h-2 rounded-full",
                                                    item.status === 'live' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                                                )} />
                                            )}
                                        </>
                                    )}
                                    {(isMini && !mobileSidebarOpen) && item.alert && (
                                        <div className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border border-background shadow-sm" />
                                    )}
                                    {(isMini && !mobileSidebarOpen) && item.status && (
                                        <div className={cn(
                                            "absolute top-2 right-2 w-2 h-2 rounded-full border border-background shadow-sm",
                                            item.status === 'live' ? "bg-emerald-500" : "bg-red-500"
                                        )} />
                                    )}
                                </span>
                            </Link>
                        )
                    })}

                    {/* Workspace Members Section */}
                    {(user?.role === 'admin' || user?.role === 'staff') && (
                        <div className="pt-6 pb-2">
                            {!(isMini && !mobileSidebarOpen) ? (
                                <h2 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                                    {t('auth.members')}
                                </h2>
                            ) : (
                                <div className="h-px bg-border mx-2 mb-4" />
                            )}

                            {/* Workspace Code */}
                            {user?.workspaceCode && (
                                <div
                                    className={cn(
                                        "mx-3 mb-4 rounded-lg border border-border group hover:border-primary/50 transition-all cursor-pointer relative overflow-hidden",
                                        (isMini && !mobileSidebarOpen)
                                            ? "p-2 bg-transparent border-transparent hover:bg-secondary/50 flex justify-center mx-0"
                                            : "p-2.5 bg-secondary/30"
                                    )}
                                    onClick={() => copyToClipboard(user.workspaceCode)}
                                    title={(isMini && !mobileSidebarOpen) ? "Copy Workspace Code" : undefined}
                                >
                                    {(isMini && !mobileSidebarOpen) ? (
                                        <div className="relative">
                                            {copied ? (
                                                <Check className="w-5 h-5 text-emerald-500" />
                                            ) : (
                                                <Copy className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                                            )}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="relative z-10">
                                                <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1 flex items-center justify-between">
                                                    {t('auth.workspaceCode')}
                                                    {copied ? (
                                                        <span className="flex items-center gap-1 text-emerald-500 animate-in fade-in zoom-in duration-300">
                                                            <Check className="w-3 h-3" />
                                                            {t('auth.copied')}
                                                        </span>
                                                    ) : (
                                                        <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-all" />
                                                    )}
                                                </p>
                                                <p className="text-sm font-mono font-bold tracking-wider">{user.workspaceCode}</p>
                                            </div>
                                            <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </>
                                    )}
                                </div>
                            )}

                            <div className={cn("px-3 space-y-3", (isMini && !mobileSidebarOpen) && "px-0 space-y-2 flex flex-col items-center")}>
                                {members.map((member) => {
                                    // Use dynamic user profile for the current user to ensure immediate updates
                                    const profileUrl = member.id === user?.id && user?.profileUrl
                                        ? user.profileUrl
                                        : member.profile_url;

                                    return (
                                        <div key={member.id} className={cn("flex items-center gap-3", (isMini && !mobileSidebarOpen) && "justify-center w-full")}>
                                            <div
                                                className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-xs font-medium overflow-hidden ring-2 ring-transparent hover:ring-primary/20 transition-all"
                                                title={(isMini && !mobileSidebarOpen) ? `${member.name} (${member.role})` : undefined}
                                            >
                                                {profileUrl ? (
                                                    <img
                                                        src={platformService.convertFileSrc(profileUrl)}
                                                        alt={member.name}
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    member.name?.charAt(0).toUpperCase() || 'M'
                                                )}
                                            </div>
                                            {!(isMini && !mobileSidebarOpen) && (
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium truncate">{member.name}</p>
                                                    <p className="text-[10px] text-muted-foreground capitalize">{member.role}</p>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </nav>

                <div className={cn(
                    "p-4 border-t border-border shrink-0 transition-all duration-300",
                    mobileSidebarOpen ? "bg-card" : "bg-background/50 backdrop-blur-md",
                    (isMini && !mobileSidebarOpen) && "flex flex-col items-center gap-4 py-6"
                )}>
                    <div className={cn("flex items-center gap-3 px-3 py-2", (isMini && !mobileSidebarOpen) && "flex-col p-0 gap-2")}>
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-sm font-bold text-white overflow-hidden shadow-sm">
                            {user?.profileUrl ? (
                                <img
                                    src={user.profileUrl.startsWith('http') ? user.profileUrl : platformService.convertFileSrc(user.profileUrl)}
                                    alt={user.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                user?.name?.charAt(0).toUpperCase() || 'U'
                            )}
                        </div>

                        {(isMini && !mobileSidebarOpen) ? (
                            <div className="text-center">
                                <p className="text-xs font-medium truncate max-w-[80px]">{user?.name}</p>
                                <p className="text-[10px] text-muted-foreground capitalize">{user?.role}</p>
                            </div>
                        ) : (
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate text-start">{user?.name}</p>
                                <p className="text-xs text-muted-foreground capitalize text-start">{user?.role}</p>
                            </div>
                        )}

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setIsSignOutModalOpen(true)}
                            className={cn("text-muted-foreground hover:text-destructive", (isMini && !mobileSidebarOpen) && "h-8 w-8 mt-1")}
                            title="Sign Out"
                        >
                            <LogOut className="w-4 h-4" />
                        </Button>
                    </div>
                    {/* Version Display */}
                    {!(isMini && !mobileSidebarOpen) && (
                        <div className="mt-2 text-center">
                            <p className="text-[10px] text-muted-foreground font-mono opacity-50">
                                v{version}
                            </p>
                        </div>
                    )}
                </div>
            </aside>

            {/* Main content Scroll Container */}
            <div className={cn(
                "h-full bg-background transition-[padding] duration-300 ease-in-out flex flex-col overflow-hidden",
                isTauri && "mt-[var(--titlebar-height)] h-[calc(100vh-var(--titlebar-height))]",
                // Desktop Sidebar Padding Logic
                desktopSidebarOpen
                    ? (isMini ? "lg:pl-[70px] lg:rtl:pl-0 lg:rtl:pr-[70px]" : "lg:pl-64 lg:rtl:pl-0 lg:rtl:pr-64")
                    : "lg:pl-0",
                "pb-[var(--safe-area-bottom)]"
            )}>
                {/* Top bar */}
                <header className={cn(
                    "flex-shrink-0 z-30 flex items-center gap-4 px-4 py-3 bg-background/60 backdrop-blur-xl border-b border-border/50",
                    "pt-[calc(0.75rem+var(--safe-area-top))]",
                    location === '/pos' && "hidden lg:flex" // Hide on mobile if POS
                )}>
                    {/* Mobile Toggle */}
                    <button
                        className="lg:hidden p-2 -ms-2 rounded-lg hover:bg-secondary"
                        onClick={() => setMobileSidebarOpen(true)}
                    >
                        <Menu className="w-5 h-5" />
                    </button>

                    {/* Desktop Toggle */}
                    <button
                        className="hidden lg:block p-2 -ms-2 rounded-lg hover:bg-secondary"
                        onClick={() => {
                            const newState = !desktopSidebarOpen
                            setDesktopSidebarOpen(newState)
                            localStorage.setItem('desktop_sidebar_open', String(newState))
                        }}
                    >
                        {desktopSidebarOpen ? (
                            <ChevronLeft className="w-5 h-5" />
                        ) : (
                            <ChevronRight className="w-5 h-5" />
                        )}
                    </button>

                    <div className="flex-1 flex justify-center px-4">
                        {(!isTauri || isFullscreen) && (
                            <GlobalSearch className="max-w-[500px] animate-in fade-in slide-in-from-top-2 duration-300" />
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {isTauri && location === '/whatsapp' && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => whatsappManager.setEnabled(!whatsappManager.isEnabled())}
                                className={cn(
                                    "h-8 px-2 gap-2 border-border/50 hover:bg-secondary/50 transition-all duration-300",
                                    whatsappStatus === 'live' ? "text-emerald-500" : "text-red-500"
                                )}
                                title={whatsappStatus === 'live' ? "Turn Off WhatsApp Webview" : "Turn On WhatsApp Webview"}
                            >
                                <div className={cn(
                                    "w-2 h-2 rounded-full",
                                    whatsappStatus === 'live' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500"
                                )} />
                                <MessageSquare className="w-4 h-4" />
                                <span className="text-[10px] font-bold uppercase tracking-wider hidden sm:inline">
                                    {whatsappStatus === 'live' ? "Live" : "Off"}
                                </span>
                            </Button>
                        )}
                        {!isMobile() && <P2PSyncIndicator />}
                        {!isMobile() && <ExchangeRateIndicator />}
                        <div className="w-px h-4 bg-border mx-1" />
                        {(!isTauri || isFullscreen || isMobile()) && <NotificationCenter />}
                        {!isMobile() && <SyncStatusIndicator />}

                        {/* Refresh Button - Only for non-Tauri or Mobile where TitleBar is absent */}
                        {(!isTauri || isMobile()) && (
                            <button
                                onClick={() => window.location.reload()}
                                className="p-2 hover:bg-secondary rounded-full text-muted-foreground transition-colors"
                                title="Refresh"
                            >
                                <RotateCw className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </header>

                {/* Page content */}
                <main className={cn(
                    "page-enter flex-1 min-h-0",
                    location === '/whatsapp' ? "p-0" :
                        location === '/pos' ? "p-0 lg:p-6" : "p-4 lg:p-6 overflow-y-auto custom-scrollbar"
                )}>
                    <Suspense fallback={<PageLoading />}>
                        {children}
                    </Suspense>
                </main>
            </div>

            {/* Sign Out Confirmation Modal */}
            <Dialog open={isSignOutModalOpen} onOpenChange={setIsSignOutModalOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('auth.signOutConfirmTitle') || 'Sign Out'}</DialogTitle>
                        <DialogDescription>
                            {t('auth.signOutConfirmDesc') || 'Are you sure you want to sign out?'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setIsSignOutModalOpen(false)}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button variant="destructive" onClick={() => {
                            setIsSignOutModalOpen(false)
                            signOut()
                        }}>
                            {t('auth.signOut') || 'Sign Out'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function PageLoading() {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground animate-pulse font-medium">{t('common.loading', 'Loading Page...')}</p>
        </div>
    )
}
