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
import { buildWorkspaceNavigation } from '@/ui/navigation/workspaceNavigation'
import { useWorkspaceBranchSwitcher } from '@/hooks/useWorkspaceBranchSwitcher'

import {
    LogOut,
    Menu,
    X,
    Boxes,
    Copy,
    Check,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    RotateCw,
    MessageSquare,
    AlertCircle,
    Bot,
    PanelRightOpen,
    PanelRightClose,
    LayoutGrid,
    GitBranch,
    Loader2
} from 'lucide-react'
import { useState } from 'react'
import { Button } from './button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from './ui/dropdown-menu'
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
    '/finance': () => import('@/ui/pages/Finance'),
    '/ledger': () => import('@/ui/pages/Ledger'),
    '/payments': () => import('@/ui/pages/Payments'),
    '/direct-transactions': () => import('@/ui/pages/DirectTransactions'),
    '/modules': () => import('@/ui/pages/ModuleLauncher'),
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
    '/invoices-history/upload-files': () => import('@/ui/pages/InvoicesHistory'),
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
    const {
        branchInfo,
        branches,
        canReturnToSource,
        currentWorkspaceLabel,
        isLoadingBranches,
        switchingWorkspaceId,
        switchWorkspace
    } = useWorkspaceBranchSwitcher()
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
    const [expandedNavGroups, setExpandedNavGroups] = useState<Record<string, boolean>>(() => {
        if (typeof window !== 'undefined') {
            try {
                const stored = localStorage.getItem('sidebar_expanded_nav_groups')
                if (stored) {
                    const parsed = JSON.parse(stored)
                    if (parsed && typeof parsed === 'object') {
                        return parsed as Record<string, boolean>
                    }
                }
            } catch (error) {
                console.warn('[Layout] Failed to restore expanded nav groups:', error)
            }

            return {
                '/instant-pos': localStorage.getItem('instant_pos_nav_open') === 'true'
            }
        }
        return {}
    })
    const [isMini, setIsMini] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('sidebar_is_mini') === 'true'
        }
        return false
    })

    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('sidebar_expanded_nav_groups', JSON.stringify(expandedNavGroups))
            localStorage.setItem('instant_pos_nav_open', String(Boolean(expandedNavGroups['/instant-pos'])))
        }
    }, [expandedNavGroups])

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

        if (location === '/whatsapp') {
            void whatsappManager.show();
        } else {
            void whatsappManager.hide();
        }
    }, [location, isTauri]);

    // Locking Enforcement
    const { isLocked } = useWorkspace()
    useEffect(() => {
        if (isLocked && location !== '/locked-workspace') {
            console.log('[Layout] Workspace is LOCKED. Redirecting to /locked-workspace')
            setLocation('/locked-workspace')
        }
    }, [isLocked, location])

    const navigation = buildWorkspaceNavigation({
        t,
        role: user?.role,
        hasFeature,
        features,
        isDesktopDevice: isDesktop(),
        whatsappStatus
    })

    const today = new Date().toISOString().slice(0, 10)
    const reorderAutomationCount = reorderRules.filter((rule) =>
        rule.isIndefinite || !rule.expiresOn || rule.expiresOn >= today
    ).length
    const reorderAutomationCountLabel = reorderAutomationCount > 99 ? '99+' : reorderAutomationCount
    const inventoryTransferAutomationLabel = t('inventoryTransfer.tabs.automation', 'Reorder Automation')

    const isPosLikeRoute = location === '/pos' || location === '/instant-pos'
    const isModuleLauncherRoute = location === '/modules'

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

    const handleSidebarWorkspaceSwitch = async (targetWorkspaceId: string) => {
        const switched = await switchWorkspace(targetWorkspaceId)
        if (switched) {
            setMobileSidebarOpen(false)
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
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-start transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                            title={t('branches.openSwitcher', { defaultValue: 'Open workspace switcher' })}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <h1 className="truncate text-lg font-bold gradient-text">{currentWorkspaceLabel || workspaceName || 'Atlas'}</h1>
                                                <p className="truncate text-xs text-muted-foreground">Workspace</p>
                                            </div>
                                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="start"
                                        className="w-[280px] rounded-xl border-border/70 bg-background/95 p-2 backdrop-blur-xl"
                                    >
                                        <DropdownMenuLabel className="pb-2">
                                            <div className="space-y-1">
                                                <p>{t('branches.switchWorkspace', { defaultValue: 'Switch Workspace' })}</p>
                                                {branchInfo?.isBranch && branchInfo.sourceWorkspaceName && (
                                                    <p className="truncate text-xs font-normal text-muted-foreground">
                                                        {`${currentWorkspaceLabel} \u2190 ${branchInfo.sourceWorkspaceName}`}
                                                    </p>
                                                )}
                                            </div>
                                        </DropdownMenuLabel>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            disabled
                                            className="gap-3 rounded-lg px-3 py-2 data-[disabled]:opacity-100"
                                        >
                                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                                <Check className="h-4 w-4" />
                                            </span>
                                            <div className="min-w-0">
                                                <p className="truncate font-semibold text-foreground">{currentWorkspaceLabel || workspaceName || 'Atlas'}</p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {branchInfo?.isBranch
                                                        ? t('branches.onBranch', { defaultValue: 'You are on branch' })
                                                        : 'Workspace'}
                                                </p>
                                            </div>
                                        </DropdownMenuItem>

                                        {branchInfo?.isBranch ? (
                                            <>
                                                <DropdownMenuSeparator />
                                                {canReturnToSource && branchInfo.sourceWorkspaceId ? (
                                                    <DropdownMenuItem
                                                        onSelect={() => {
                                                            void handleSidebarWorkspaceSwitch(branchInfo.sourceWorkspaceId!)
                                                        }}
                                                        disabled={switchingWorkspaceId === branchInfo.sourceWorkspaceId}
                                                        className="gap-3 rounded-lg px-3 py-2"
                                                    >
                                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                                                            {switchingWorkspaceId === branchInfo.sourceWorkspaceId ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <GitBranch className="h-4 w-4" />
                                                            )}
                                                        </span>
                                                        <div className="min-w-0">
                                                            <p className="truncate font-semibold text-foreground">
                                                                {branchInfo.sourceWorkspaceName || t('branches.returnToSource', { defaultValue: 'Return to Source' })}
                                                            </p>
                                                            <p className="truncate text-xs text-muted-foreground">
                                                                {t('branches.returnToSource', { defaultValue: 'Return to Source' })}
                                                            </p>
                                                        </div>
                                                    </DropdownMenuItem>
                                                ) : (
                                                    <DropdownMenuItem
                                                        disabled
                                                        className="rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100"
                                                    >
                                                        {t('branches.noOtherWorkspaces', { defaultValue: 'No other workspaces available.' })}
                                                    </DropdownMenuItem>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                <DropdownMenuSeparator />
                                                <div className="max-h-[280px] overflow-y-auto">
                                                    {isLoadingBranches ? (
                                                        <DropdownMenuItem
                                                            disabled
                                                            className="gap-3 rounded-lg px-3 py-2 data-[disabled]:opacity-100"
                                                        >
                                                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                                            <span className="text-sm text-muted-foreground">
                                                                {t('common.loading', { defaultValue: 'Loading...' })}
                                                            </span>
                                                        </DropdownMenuItem>
                                                    ) : branches.length === 0 ? (
                                                        <DropdownMenuItem
                                                            disabled
                                                            className="rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100"
                                                        >
                                                            {t('branches.noBranches', { defaultValue: 'No branches yet' })}
                                                        </DropdownMenuItem>
                                                    ) : (
                                                        branches.map((branch) => {
                                                            const isSwitching = switchingWorkspaceId === branch.branchWorkspaceId
                                                            return (
                                                                <DropdownMenuItem
                                                                    key={branch.id}
                                                                    onSelect={() => {
                                                                        void handleSidebarWorkspaceSwitch(branch.branchWorkspaceId)
                                                                    }}
                                                                    disabled={isSwitching}
                                                                    className="gap-3 rounded-lg px-3 py-2"
                                                                >
                                                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                                                                        {isSwitching ? (
                                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                                        ) : (
                                                                            <GitBranch className="h-4 w-4" />
                                                                        )}
                                                                    </span>
                                                                    <div className="min-w-0">
                                                                        <p className="truncate font-semibold text-foreground">
                                                                            {branch.workspaceName || branch.name}
                                                                        </p>
                                                                        <p className="truncate text-xs text-muted-foreground">
                                                                            {branch.workspaceCode || branch.name}
                                                                        </p>
                                                                    </div>
                                                                </DropdownMenuItem>
                                                            )
                                                        })
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
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
                        <nav className="flex-1 px-2 py-4 space-y-6 overflow-y-auto custom-scrollbar antialiased">
                            {navigation.map((group) => (
                                <div key={group.title} className="space-y-1">
                                    {!(isMini && !mobileSidebarOpen) && group.title && (
                                        <div className="flex items-center gap-2 px-3 mb-4">
                                            <group.icon className="w-3.5 h-3.5 text-muted-foreground/40" />
                                            <h2 className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em]">
                                                {group.title}
                                            </h2>
                                        </div>
                                    )}
                                    {isMini && !mobileSidebarOpen && (
                                        <div className="h-px bg-border/40 mx-2 mb-4" />
                                    )}

                                    <div className="space-y-1">
                                        {group.items.map((item) => {
                                            const isExpandableGroup = Boolean(item.children?.length)
                                            const showReorderAutomationBadge = item.href === '/inventory-transfer' && reorderAutomationCount > 0
                                            const isChildActive = isExpandableGroup
                                                ? item.children!.some(child => location === child.href || (child.href !== '/' && location.startsWith(child.href)))
                                                : false
                                            const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href)) || isChildActive
                                            const isOpen = isExpandableGroup ? (Boolean(expandedNavGroups[item.href]) || isChildActive) : false
                                            const showChildren = isExpandableGroup && isOpen && !(isMini && !mobileSidebarOpen)

                                            const parentContent = (
                                                <span
                                                    className={cn(
                                                        'relative flex items-center gap-3 px-3 py-2 rounded-sm text-[13px] font-semibold transition-all duration-300 ease-in-out border-s-[3px] border-transparent',
                                                        isActive
                                                            ? 'bg-primary/10 text-primary border-primary'
                                                            : 'text-muted-foreground hover:bg-primary/5 hover:text-primary hover:border-primary/30',
                                                        (isMini && !mobileSidebarOpen) && "justify-center px-0 py-3 border-s-0"
                                                    )}
                                                    title={(isMini && !mobileSidebarOpen) ? item.name : undefined}
                                                >
                                                    <item.icon className="w-5 h-5 flex-shrink-0" />
                                                    {!(isMini && !mobileSidebarOpen) && (
                                                        <>
                                                            {item.name}
                                                            {isExpandableGroup && (
                                                                <ChevronDown className={cn(
                                                                    "ms-auto w-4 h-4 transition-transform",
                                                                    isOpen && "rotate-180"
                                                                )} />
                                                            )}
                                                            {!isExpandableGroup && showReorderAutomationBadge && (
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
                                                            {!isExpandableGroup && item.alert && (
                                                                <div className="ms-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white">
                                                                    <AlertCircle className="w-3.5 h-3.5" />
                                                                </div>
                                                            )}
                                                            {!isExpandableGroup && item.status && (
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
                                                            if (isExpandableGroup) {
                                                                setExpandedNavGroups((prev) => ({
                                                                    ...prev,
                                                                    [item.href]: !prev[item.href]
                                                                }))
                                                            }
                                                            if (!isExpandableGroup) {
                                                                setMobileSidebarOpen(false)
                                                            }
                                                            triggerHaptic('selection')
                                                        }}
                                                        onMouseEnter={() => !isMobile() && prefetchRoute(item.href)}
                                                    >
                                                        {parentContent}
                                                    </Link>

                                                    {showChildren && (
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
                                                                                'flex items-center gap-3 px-3 py-2 rounded-sm text-[13px] font-medium transition-all duration-300 ease-in-out border-s-[3px] border-transparent',
                                                                                isChildSelected
                                                                                    ? 'bg-primary/10 text-primary border-primary'
                                                                                    : 'text-muted-foreground hover:bg-primary/5 hover:text-primary hover:border-primary/30'
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
                                    </div>
                                </div>
                            ))}

                            {/* Workspace Members Section */}
                            {(user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && (
                                <div className="pt-6 pb-2">
                                    {!(isMini && !mobileSidebarOpen) ? (
                                        <h2 className="px-3 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em] mb-4">
                                            {t('auth.members')}
                                        </h2>
                                    ) : (
                                        <div className="h-px bg-border/40 mx-2 mb-4" />
                                    )}

                                    {/* Workspace Code */}
                                    {user?.workspaceCode && (
                                        <div
                                            className={cn(
                                                "mx-3 mb-4 rounded-sm border border-border group hover:border-primary/50 transition-all cursor-pointer relative overflow-hidden",
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
                                                        <p className="text-[10px] text-muted-foreground/60 uppercase font-bold mb-1 flex items-center justify-between">
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
                                                            <p className="text-[13px] font-semibold truncate">{member.name}</p>
                                                            <p className="text-[10px] text-muted-foreground/60 uppercase font-bold tracking-wider">{member.role}</p>
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
                                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center text-sm font-bold text-white overflow-hidden shadow-sm">
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
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (location !== '/modules') {
                                            setLocation('/modules')
                                        }
                                        triggerHaptic('selection')
                                    }}
                                    onMouseEnter={() => !isMobile() && prefetchRoute('/modules')}
                                    className={cn(
                                        "relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border transition-all duration-300",
                                        isModuleLauncherRoute
                                            ? "border-primary/30 bg-primary/10 shadow-[0_16px_36px_rgba(79,70,229,0.18)]"
                                            : "border-border/60 bg-background/75 hover:-translate-y-0.5 hover:border-primary/20 hover:bg-primary/5 hover:shadow-[0_14px_30px_rgba(15,23,42,0.08)]"
                                    )}
                                    title={t('nav.modulesLauncher', { defaultValue: 'Open module launcher' })}
                                    aria-label={t('nav.modulesLauncher', { defaultValue: 'Open module launcher' })}
                                >
                                    <div className={cn(
                                        "absolute inset-[1px] rounded-[calc(1rem-1px)] bg-gradient-to-br transition-opacity duration-300",
                                        isModuleLauncherRoute
                                            ? "from-primary/18 via-primary/8 to-transparent opacity-100"
                                            : "from-emerald-500/14 via-sky-500/8 to-transparent opacity-80"
                                    )} />
                                    <ThemeAwareLogo className="relative z-10 h-6 w-6" />
                                    <LayoutGrid className={cn(
                                        "absolute bottom-1.5 right-1.5 h-3.5 w-3.5 rounded-md bg-background/80 p-[2px] text-muted-foreground shadow-sm",
                                        isModuleLauncherRoute && "text-primary"
                                    )} />
                                </button>
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
