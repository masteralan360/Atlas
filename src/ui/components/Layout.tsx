import { type ReactNode, Suspense } from 'react'
import { Link, useLocation } from 'wouter'
import { cn } from '@/lib/utils'
import { useAuth } from '@/auth'
import { useReorderTransferRules } from '@/local-db'
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
import { GlobalLoanReminders } from './loans/GlobalLoanReminders'
import { GlobalBudgetReminders } from './budget/GlobalBudgetReminders'
import { LoanPaymentModalProvider } from './loans/LoanPaymentModalProvider'
import { UnifiedSnoozeProvider } from '@/context/UnifiedSnoozeContext'
import { GlobalExchangeRateReminders } from './exchange/GlobalExchangeRateReminders'
import { UnifiedSnoozedRemindersBell } from './reminders/UnifiedSnoozedRemindersBell'
import { ThemeAwareLogo } from './ThemeAwareLogo'

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
    ShoppingCart,
    Zap,
    TrendingUp,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    BarChart3,
    RotateCw,
    MessageSquare,
    Users,
    Warehouse,
    ArrowRightLeft,
    HandCoins,
    Wallet,
    AlertCircle,
    Bot,
    PanelRightOpen,
    PanelRightClose,
    Monitor,
    Truck,
    Plane,
    Calculator
} from 'lucide-react'
import { useState } from 'react'
import { Button } from './button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog'
import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { supabase } from '@/auth/supabase'
import { isMobile, isDesktop } from '@/lib/platform'
import { useWebHaptics } from 'web-haptics/react'

interface LayoutProps {
    children: ReactNode
}


// Route prefetch map for on-hover preloading (desktop only)
const routePrefetchMap: Record<string, () => Promise<unknown>> = {
    '/': () => import('@/ui/pages/Dashboard'),
    '/pos': () => import('@/ui/pages/POS'),
    '/instant-pos': () => import('@/ui/pages/InstantPOS'),
    '/kds': () => import('@/ui/pages/KDSDashboard'),
    '/sales': () => import('@/ui/pages/Sales'),
    '/business-partners': () => import('@/ui/pages/BusinessPartners'),
    '/customers': () => import('@/ui/pages/Customers'),
    '/suppliers': () => import('@/ui/pages/Suppliers'),
    '/orders': () => import('@/ui/pages/Orders'),
    '/travel-agency': () => import('@/ui/pages/TravelAgency'),
    '/loans': () => import('@/ui/pages/Loans'),
    '/installments': () => import('@/ui/pages/Loans'),
    '/revenue': () => import('@/ui/pages/Revenue'),
    '/budget': () => import('@/ui/pages/Budget'),
    '/monthly-comparison': () => import('@/ui/pages/MonthlyComparison'),
    '/performance': () => import('@/ui/pages/TeamPerformance'),
    '/whatsapp': () => import('@/ui/pages/WhatsAppWeb'),
    '/products': () => import('@/ui/pages/Products'),
    '/storages': () => import('@/ui/pages/Storages'),
    '/inventory-transfer': () => import('@/ui/pages/InventoryTransfer'),
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
    const { hasFeature, workspaceName, isFullscreen, features, activeWorkspace } = useWorkspace()
    const { trigger: triggerHaptic } = useWebHaptics({ debug: true })
    const reorderRules = useReorderTransferRules(activeWorkspace?.id)

    const { t } = useTranslation()
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('desktop_sidebar_open') !== 'false'
        }
        return true
    })
    const [instantPosOpen, setInstantPosOpen] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('instant_pos_nav_open') === 'true'
        }
        return false
    })
    const [isMini, setIsMini] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('sidebar_is_mini') === 'true'
        }
        return false
    })

    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('instant_pos_nav_open', String(instantPosOpen))
        }
    }, [instantPosOpen])

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

    const navigation: Array<{ name: string; href: string; icon: any; status?: string; alert?: boolean; mobileOnly?: boolean; children?: Array<{ name: string; href: string; icon?: any }> }> = [
        { name: t('nav.dashboard'), href: '/', icon: LayoutDashboard },
        // POS - requires feature flag AND role
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && hasFeature('pos') ? [
            { name: t('nav.pos') || 'POS', href: '/pos', icon: CreditCard },
            {
                name: t('nav.instantPos') || 'Instant POS',
                href: '/instant-pos',
                icon: Zap,
                children: [
                    { name: t('nav.kdsDashboard') || 'KDS Dashboard', href: '/kds', icon: Monitor }
                ]
            }
        ] : []),
        // Sales
        ...(hasFeature('sales_history') ? [{ name: t('nav.sales') || 'Sales', href: '/sales', icon: Receipt }] : []),
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && hasFeature('crm') ? [
            { name: t('businessPartners.title') || 'Business Partners', href: '/business-partners', icon: UsersRound },
            { name: t('nav.customers') || 'Customers', href: '/customers', icon: Users },
            { name: t('nav.suppliers') || 'Suppliers', href: '/suppliers', icon: Truck },
            { name: t('nav.orders') || 'Orders', href: '/orders', icon: ShoppingCart }
        ] : []),
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && hasFeature('travel_agency') ? [
            { name: t('nav.travelAgency', { defaultValue: 'Travel Agency' }), href: '/travel-agency', icon: Plane }
        ] : []),
        ...(hasFeature('loans') ? [
            { name: t('nav.loans', { defaultValue: 'Loans' }), href: '/loans', icon: HandCoins },
            { name: t('nav.installments', { defaultValue: t('loans.title', { defaultValue: 'Installments' }) }), href: '/installments', icon: Copy }
        ] : []),
        // Revenue - allow all roles for the menu item if feature is on (restriction is handled in route/page)
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') ? [
            ...(hasFeature('net_revenue') ? [{ name: t('nav.revenue') || 'Net Revenue', href: '/revenue', icon: BarChart3 }] : []),
            ...(hasFeature('budget') ? [{ name: t('nav.budget') || 'Budget', href: '/budget', icon: Wallet }] : []),
            ...(hasFeature('monthly_comparison') ? [{ name: t('monthlyComparison.title'), href: '/monthly-comparison', icon: ArrowRightLeft }] : []),
            ...(hasFeature('team_performance') ? [{ name: t('nav.performance') || 'Team Performance', href: '/performance', icon: TrendingUp }] : [])
        ] : []),
        { name: t('nav.currencyConverter') || 'Currency Converter', href: '/currency-converter', icon: Calculator, mobileOnly: true },
        // WhatsApp - requires feature flag AND role AND desktop platform
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && hasFeature('allow_whatsapp') && isDesktop() ? [
            { name: t('nav.whatsapp'), href: '/whatsapp', icon: MessageSquare, status: whatsappStatus }
        ] : []),
        // Products
        ...(hasFeature('products') ? [{ name: t('nav.products'), href: '/products', icon: Package }] : []),
        // Storages
        ...(hasFeature('storages') ? [{ name: t('nav.storages') || 'Storages', href: '/storages', icon: Warehouse }] : []),
        // Inventory Transfer
        ...(hasFeature('inventory_transfer') ? [{ name: t('nav.inventoryTransfer') || 'Transfer', href: '/inventory-transfer', icon: ArrowRightLeft }] : []),
        // Invoices - requires feature flag
        ...(hasFeature('invoices_history') ? [
            { name: t('nav.invoicesHistory') || 'Invoices History', href: '/invoices-history', icon: FileText }
        ] : []),
        // Admin/Staff routes
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') ? [
            ...(hasFeature('hr') ? [{ name: t('nav.hr') || 'HR', href: '/hr', icon: UsersRound }] : []),
            ...(hasFeature('members') ? [{ name: t('members.title'), href: '/members', icon: Users }] : []),
        ] : []),
        ...((user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') ? [
            { name: t('nav.settings'), href: '/settings', icon: Settings }
        ] : []),
    ]

    const today = new Date().toISOString().slice(0, 10)
    const reorderAutomationCount = reorderRules.filter((rule) =>
        rule.isIndefinite || !rule.expiresOn || rule.expiresOn >= today
    ).length
    const reorderAutomationCountLabel = reorderAutomationCount > 99 ? '99+' : reorderAutomationCount
    const inventoryTransferAutomationLabel = t('inventoryTransfer.tabs.automation', 'Reorder Automation')

    const isPosLikeRoute = location === '/pos' || location === '/instant-pos'

    const openInventoryTransferAutomationTab = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
        event.preventDefault()
        event.stopPropagation()

        const isInventoryTransferRoute = location === '/inventory-transfer' || location.startsWith('/inventory-transfer')

        if (typeof window !== 'undefined') {
            if (isInventoryTransferRoute) {
                window.sessionStorage.removeItem('inventory-transfer.pending-tab')
                window.dispatchEvent(new CustomEvent('inventory-transfer:open-tab', {
                    detail: { tab: 'automation' }
                }))
            } else {
                window.sessionStorage.setItem('inventory-transfer.pending-tab', 'automation')
            }
        }

        setMobileSidebarOpen(false)
        triggerHaptic('selection')

        if (!isInventoryTransferRoute) {
            setLocation('/inventory-transfer')
        }
    }

    return (
        <UnifiedSnoozeProvider>
            <LoanPaymentModalProvider>
                <div className="h-screen overflow-hidden bg-transparent">
                    <ResourceSyncOverlay />
                    <ManualRateModals />
                    <GlobalExchangeRateReminders />
                    <GlobalBudgetReminders />
                    <GlobalLoanReminders />
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
                                <ThemeAwareLogo className="w-10 h-10 object-contain" />
                            ) : (
                                <Boxes className="w-8 h-8 text-primary" />
                            )}

                            {!(isMini && !mobileSidebarOpen) && (
                                <div>
                                    <h1 className="text-lg font-bold gradient-text">{workspaceName || 'Atlas'}</h1>
                                    <p className="text-xs text-muted-foreground">Workspace</p>
                                </div>
                            )}

                            <button
                                className="ms-auto lg:hidden"
                                onClick={() => setMobileSidebarOpen(false)}
                            >
                                <X className="w-5 h-5" />
                            </button>

                            <button
                                onClick={() => {
                                    toggleMini()
                                    triggerHaptic('light')
                                }}
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
                                const isInstantPosGroup = item.href === '/instant-pos' && item.children?.length
                                const showReorderAutomationBadge = item.href === '/inventory-transfer' && reorderAutomationCount > 0
                                const isChildActive = isInstantPosGroup
                                    ? item.children!.some(child => location === child.href || (child.href !== '/' && location.startsWith(child.href)))
                                    : false
                                const isActive = isInstantPosGroup
                                    ? (location === item.href || isChildActive)
                                    : (location === item.href || (item.href !== '/' && location.startsWith(item.href)))
                                const isOpen = isInstantPosGroup ? (instantPosOpen || isChildActive) : false
                                const showChildren = isOpen && !(isMini && !mobileSidebarOpen)

                                const parentContent = (
                                    <span
                                        className={cn(
                                            'relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-300',
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
                                                {isInstantPosGroup && (
                                                    <ChevronDown className={cn(
                                                        "ms-auto w-4 h-4 transition-transform",
                                                        isOpen && "rotate-180"
                                                    )} />
                                                )}
                                                {!isInstantPosGroup && showReorderAutomationBadge && (
                                                    <span
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-label={inventoryTransferAutomationLabel}
                                                        title={inventoryTransferAutomationLabel}
                                                        onClick={openInventoryTransferAutomationTab}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter' || event.key === ' ') {
                                                                openInventoryTransferAutomationTab(event)
                                                            }
                                                        }}
                                                        className={cn(
                                                            "ms-auto relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:focus-visible:ring-sky-200/80",
                                                            isActive
                                                                ? "bg-sky-950/20 text-white ring-1 ring-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_24px_rgba(8,47,73,0.22)] backdrop-blur-md"
                                                                : "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/20 shadow-[0_10px_24px_rgba(14,165,233,0.12)] dark:bg-sky-400/14 dark:text-sky-200 dark:ring-sky-300/18 dark:shadow-[0_10px_24px_rgba(14,165,233,0.16)]"
                                                        )}
                                                    >
                                                        <Bot className="h-4 w-4" />
                                                        <span
                                                            className={cn(
                                                                "absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-none shadow-sm backdrop-blur-sm",
                                                                isActive
                                                                    ? "border-white/15 bg-sky-950/85 text-white"
                                                                    : "border-white/80 bg-sky-600 text-white dark:border-sky-100/70 dark:bg-sky-300 dark:text-slate-950"
                                                            )}
                                                        >
                                                            {reorderAutomationCountLabel}
                                                        </span>
                                                    </span>
                                                )}
                                                {!isInstantPosGroup && item.alert && (
                                                    <div className="ms-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white">
                                                        <AlertCircle className="w-3.5 h-3.5" />
                                                    </div>
                                                )}
                                                {!isInstantPosGroup && item.status && (
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
                                        {(isMini && !mobileSidebarOpen) && showReorderAutomationBadge && (
                                            <span
                                                role="button"
                                                tabIndex={0}
                                                aria-label={inventoryTransferAutomationLabel}
                                                title={inventoryTransferAutomationLabel}
                                                onClick={openInventoryTransferAutomationTab}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        openInventoryTransferAutomationTab(event)
                                                    }
                                                }}
                                                className={cn(
                                                    "absolute right-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:focus-visible:ring-sky-200/80",
                                                    isActive
                                                        ? "bg-sky-950/25 text-white ring-1 ring-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_8px_18px_rgba(8,47,73,0.22)] backdrop-blur-md"
                                                        : "bg-sky-600 text-white shadow-[0_8px_18px_rgba(14,165,233,0.22)] dark:bg-sky-300 dark:text-slate-950"
                                                )}
                                            >
                                                <Bot className="h-3 w-3" />
                                                <span
                                                    className={cn(
                                                        "absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full border px-1 text-[8px] font-semibold leading-none shadow-sm",
                                                        isActive
                                                            ? "border-white/15 bg-sky-950/90 text-white"
                                                            : "border-white/80 bg-sky-700 text-white dark:border-sky-100/75 dark:bg-sky-950 dark:text-sky-100"
                                                    )}
                                                >
                                                    {reorderAutomationCountLabel}
                                                </span>
                                            </span>
                                        )}
                                        {(isMini && !mobileSidebarOpen) && item.status && (
                                            <div className={cn(
                                                "absolute top-2 right-2 w-2 h-2 rounded-full border border-background shadow-sm",
                                                item.status === 'live' ? "bg-emerald-500" : "bg-red-500"
                                            )} />
                                        )}
                                    </span>
                                )

                                return (
                                    <div key={item.href} className={cn("space-y-1", item.mobileOnly && "lg:hidden")}>
                                        <Link
                                            href={item.href}
                                            onClick={() => {
                                                if (isInstantPosGroup) {
                                                    setInstantPosOpen(prev => !prev)
                                                }
                                                if (!isInstantPosGroup) {
                                                    setMobileSidebarOpen(false)
                                                }
                                                triggerHaptic('selection')
                                            }}
                                            onMouseEnter={() => !isMobile() && prefetchRoute(item.href)}
                                        >
                                            {parentContent}
                                        </Link>

                                        {isInstantPosGroup && showChildren && (
                                            <div className={cn(
                                                "relative flex flex-col space-y-1 mt-1.5",
                                                !(isMini && !mobileSidebarOpen) && "before:absolute before:inset-y-0 before:left-[22px] rtl:before:right-[22px] rtl:before:left-auto before:w-px before:bg-border/60",
                                                (isMini && !mobileSidebarOpen) ? "ps-0" : "ps-10"
                                            )}>
                                                {item.children!.map(child => {
                                                    const isChildSelected = location === child.href || (child.href !== '/' && location.startsWith(child.href))
                                                    return (
                                                        <Link
                                                            key={child.href}
                                                            href={child.href}
                                                            onClick={() => {
                                                                setMobileSidebarOpen(false)
                                                                triggerHaptic('selection')
                                                            }}
                                                            onMouseEnter={() => !isMobile() && prefetchRoute(child.href)}
                                                            className="relative block"
                                                        >
                                                            {/* Horizontal hierarchy line */}
                                                            {!(isMini && !mobileSidebarOpen) && (
                                                                <div className={cn(
                                                                    "absolute top-1/2 -translate-y-1/2 w-[18px] h-px",
                                                                    "left-[-18px] rtl:right-[-18px] rtl:left-auto",
                                                                    isChildSelected ? "bg-primary" : "bg-border/60"
                                                                )} />
                                                            )}
                                                            <span
                                                                className={cn(
                                                                    'flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-300',
                                                                    isChildSelected
                                                                        ? 'bg-gradient-to-r from-primary/15 to-primary/5 text-primary shadow-sm border border-primary/20 dark:from-primary/20 dark:to-primary/10'
                                                                        : 'text-muted-foreground hover:bg-primary/5 hover:text-primary'
                                                                )}
                                                            >
                                                                {child.icon ? (
                                                                    <child.icon className={cn(
                                                                        "w-4 h-4 flex-shrink-0 transition-colors",
                                                                        isChildSelected ? "text-primary" : "text-muted-foreground"
                                                                    )} />
                                                                ) : (
                                                                    <span className={cn(
                                                                        "w-1.5 h-1.5 rounded-full transition-colors",
                                                                        isChildSelected ? "bg-primary" : "bg-muted-foreground/30"
                                                                    )} />
                                                                )}
                                                                <span>{child.name}</span>
                                                            </span>
                                                        </Link>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}

                            {/* Workspace Members Section */}
                            {(user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && (
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
                                            onClick={() => {
                                                copyToClipboard(user.workspaceCode)
                                                triggerHaptic('success')
                                            }}
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
                                    allowViewer={true}
                                    onClick={() => {
                                        setIsSignOutModalOpen(true)
                                        triggerHaptic('warning')
                                    }}
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
                            isPosLikeRoute && "hidden lg:flex" // Hide on mobile if POS
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

                            <div className={cn("flex-1 justify-center px-4", !isMobile() ? "flex" : "hidden md:flex")}>
                                {(!isTauri || isFullscreen) && !isMobile() && (
                                    <GlobalSearch className="max-w-[500px] animate-in fade-in slide-in-from-top-2 duration-300" />
                                )}
                            </div>

                            <div className="flex items-center gap-1.5 md:gap-3 ml-auto">
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
                                <P2PSyncIndicator />
                                <ExchangeRateIndicator />
                                <div className="w-px h-4 bg-border mx-1" />
                                <NotificationCenter />
                                <UnifiedSnoozedRemindersBell />
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
                                isPosLikeRoute ? "p-0 lg:p-6" : "p-4 lg:p-6 overflow-y-auto custom-scrollbar"
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
                                <Button variant="ghost" allowViewer={true} onClick={() => setIsSignOutModalOpen(false)}>
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button variant="destructive" allowViewer={true} onClick={() => {
                                    setIsSignOutModalOpen(false)
                                    signOut()
                                }}>
                                    {t('auth.signOut') || 'Sign Out'}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                </div>
            </LoanPaymentModalProvider>
        </UnifiedSnoozeProvider>
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
