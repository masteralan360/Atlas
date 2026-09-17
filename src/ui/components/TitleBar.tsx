import { useState, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X, Sun, Moon, ArrowUpCircle, RotateCw, GitBranch, Bot, AlertTriangle, ArrowLeft, ArrowRight } from 'lucide-react'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useTheme } from '@/ui/components/theme-provider'
import { useTranslation } from 'react-i18next'
import { cn, formatDate } from '@/lib/utils'
import { GlobalSearch } from './GlobalSearch'
import { NotificationCenter } from './NotificationCenter'
import { ThemeAwareTitleLogo } from './ThemeAwareTitleLogo'
import { LanguageSwitcher } from './LanguageSwitcher'
import { useSubscriptionExpiryWarning } from '@/hooks/useSubscriptionExpiryWarning'
import { WorkspacePaygChargeButton, WorkspaceUsageButton, WorkspaceUsageCircleButton, WorkspaceUsageModal } from './WorkspaceUsageModal'
import { useWorkspaceUsageMeter } from './workspaceUsageMeter'
import { useNavigationHistory } from '@/hooks/useNavigationHistory'
import { WorkspaceResourceSyncPill } from './WorkspaceResourceSyncPill'

export function TitleBar() {
    const [isMaximized, setIsMaximized] = useState(false)
    const [usageModalOpen, setUsageModalOpen] = useState(false)
    const { workspaceName, branchInfo, pendingUpdate, isFullscreen, features, isLocalMode, isDemoMode, activeWorkspace } = useWorkspace()
    const { theme, setTheme, style } = useTheme()
    const { t } = useTranslation()
    // @ts-ignore
    const isTauri = !!window.__TAURI_INTERNALS__
    const subscriptionWarning = useSubscriptionExpiryWarning(
        isTauri && !isDemoMode ? features.subscription_expires_at : null
    )
    const { canGoBack, canGoForward, back, forward } = useNavigationHistory()
    const {
        usageMeter,
        paygSummary,
        refreshWorkspaceUsage,
        isRefreshingWorkspaceUsage
    } = useWorkspaceUsageMeter({
        enabled: isTauri && !isLocalMode && !isDemoMode,
        workspaceId: activeWorkspace?.id
    })

    useEffect(() => {
        if (!isTauri) return
        document.documentElement.setAttribute('data-tauri', 'true')

        const updateState = async () => {
            try {
                const window = getCurrentWindow()
                const maximized = await window.isMaximized()
                setIsMaximized(maximized)
            } catch (e) {
                console.error(e)
            }
        }

        updateState()

        let unlisten: () => void

        const setupListener = async () => {
            try {
                const window = getCurrentWindow()
                unlisten = await window.onResized(updateState)
            } catch (e) {
                console.error(e)
            }
        }
        setupListener()

        return () => {
            if (unlisten) unlisten()
        }
    }, [isTauri])

    const minimize = async () => {
        if (!isTauri) return
        await getCurrentWindow().minimize()
    }

    // Toggle Maximize / Restore
    const toggleMaximize = async () => {
        if (!isTauri) return
        const window = getCurrentWindow()
        const maximized = await window.isMaximized()

        if (maximized) {
            await window.unmaximize()
            setIsMaximized(false)
        } else {
            await window.maximize()
            setIsMaximized(true)
        }
    }

    const close = async () => {
        if (!isTauri) return
        await getCurrentWindow().close()
    }

    const toggleTheme = (event: React.MouseEvent) => {
        const x = event.clientX;
        const y = event.clientY;

        // @ts-ignore
        if (!document.startViewTransition) {
            setTheme(theme === 'dark' ? 'light' : 'dark');
            return;
        }

        document.documentElement.style.setProperty('--x', `${x}px`);
        document.documentElement.style.setProperty('--y', `${y}px`);

        // @ts-ignore
        document.startViewTransition(() => {
            setTheme(theme === 'dark' ? 'light' : 'dark');
        });
    };

    if (!isTauri) return null

    return (
        <>
        <div dir="ltr" data-tauri-drag-region className={cn(
            "fixed top-0 left-0 right-0 h-[48px] z-[100] flex items-center justify-between px-3 select-none bg-background/80 backdrop-blur-md border-b border-white/10 transition-all duration-300",
            isFullscreen && "opacity-0 pointer-events-none -translate-y-full"
        )}>
            <div data-tauri-drag-region className="flex items-center gap-3 w-1/3 min-w-0">
                <ThemeAwareTitleLogo className="w-10 h-10 opacity-90" />
                <div data-tauri-drag-region className="flex items-center gap-2 min-w-0">
                    <span data-tauri-drag-region className="text-sm font-medium opacity-80 truncate">
                        {workspaceName || t('auth.titleName')}
                    </span>
                    {branchInfo?.isBranch && (
                        <span
                            data-tauri-drag-region
                            className="inline-flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                            title={branchInfo.sourceWorkspaceName
                                ? `${workspaceName || branchInfo.branchName || t('branches.title')} \u2190 ${branchInfo.sourceWorkspaceName}`
                                : workspaceName || branchInfo.branchName || t('branches.title')}
                        >
                            <GitBranch className="h-3 w-3 shrink-0" />
                            <span className="truncate">{workspaceName || branchInfo.branchName || t('branches.title')}</span>
                            {branchInfo.sourceWorkspaceName && (
                                <>
                                    <span className="opacity-60">\u2190</span>
                                    <span className="truncate">{branchInfo.sourceWorkspaceName}</span>
                                </>
                            )}
                        </span>
                    )}
                </div>
                <div data-tauri-drag-region className="flex items-center gap-1">
                    <button
                        onClick={back}
                        disabled={!canGoBack}
                        className={cn(
                            "p-2 transition-colors",
                            canGoBack
                                ? style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                                : "text-muted-foreground/30 cursor-not-allowed"
                        )}
                        title="Back"
                        aria-label="Back"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                    <button
                        onClick={forward}
                        disabled={!canGoForward}
                        className={cn(
                            "p-2 transition-colors",
                            canGoForward
                                ? style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                                : "text-muted-foreground/30 cursor-not-allowed"
                        )}
                        title="Forward"
                        aria-label="Forward"
                    >
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </div>
                <WorkspaceResourceSyncPill />
            </div>

            {/* Center: Search Box */}
            <div data-tauri-drag-region className="flex-1 flex justify-center max-w-md">
                <GlobalSearch className="max-w-[400px]" />
            </div>

            {/* Right: Window Controls */}
            <div data-tauri-drag-region className="flex min-w-0 w-1/3 items-center justify-end gap-1">
                {(usageMeter || paygSummary) && (
                    <div className="flex min-w-0 flex-1 items-center justify-end">
                        {paygSummary && (
                            <WorkspacePaygChargeButton
                                summary={paygSummary}
                                onClick={() => setUsageModalOpen(true)}
                                compact
                                className="me-2 shrink-0 xl:hidden"
                            />
                        )}
                        {!paygSummary && usageMeter && (
                            <WorkspaceUsageCircleButton
                                usageMeter={usageMeter}
                                onClick={() => setUsageModalOpen(true)}
                                className="relative z-10 mr-1 h-8 w-8 xl:hidden"
                            />
                        )}
                        {paygSummary && (
                            <WorkspacePaygChargeButton
                                summary={paygSummary}
                                onClick={() => setUsageModalOpen(true)}
                                className="me-2 hidden shrink-0 xl:flex"
                            />
                        )}
                        {!paygSummary && usageMeter && (
                            <WorkspaceUsageButton
                                usageMeter={usageMeter}
                                onClick={() => setUsageModalOpen(true)}
                                className="relative z-10 mr-2 hidden h-7 min-w-[150px] w-[240px] max-w-[22vw] shrink xl:flex"
                            />
                        )}
                    </div>
                )}
                {subscriptionWarning && (
                    <button
                        onClick={() => window.dispatchEvent(new CustomEvent('open-subscription-expiry-warning'))}
                        className="mr-2 flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-400/15 px-2.5 py-1.5 text-amber-700 transition-colors hover:bg-amber-400/25 dark:text-amber-300"
                        title={t('subscriptionExpiryWarning.indicatorTooltip', {
                            count: subscriptionWarning.daysRemaining,
                            date: formatDate(subscriptionWarning.expiresAt),
                            defaultValue: 'Subscription expires in {{count}} days on {{date}}'
                        })}
                        aria-label={t('subscriptionExpiryWarning.indicatorTooltip', {
                            count: subscriptionWarning.daysRemaining,
                            date: formatDate(subscriptionWarning.expiresAt),
                            defaultValue: 'Subscription expires in {{count}} days on {{date}}'
                        })}
                    >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span className="text-xs font-semibold">
                            {t('subscriptionExpiryWarning.indicatorShort', {
                                count: subscriptionWarning.daysRemaining,
                                defaultValue: '{{count}}d left'
                            })}
                        </span>
                    </button>
                )}
                {pendingUpdate && (
                    <button
                        onClick={() => window.dispatchEvent(new CustomEvent('open-pending-update'))}
                        className="flex items-center gap-1.5 px-3 py-1.5 mr-2 rounded-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 transition-all border border-blue-500/20 group"
                        title={t('updater.available')}
                    >
                        <ArrowUpCircle className="w-3.5 h-3.5 group-hover:animate-bounce" />
                        <span className="text-xs font-medium">{t('updater.available')}</span>
                    </button>
                )}
                {import.meta.env.DEV && (
                    <div className="mr-2">
                        <LanguageSwitcher className="h-8 w-[118px] text-xs" />
                    </div>
                )}
                <button
                    onClick={() => window.location.reload()}
                    className={cn(
                        "p-2 transition-colors mr-1",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={t('common.refresh') || "Refresh"}
                >
                    <RotateCw className="w-4 h-4" />
                </button>
                <button
                    onClick={toggleTheme}
                    className={cn(
                        "p-2 transition-colors mr-1",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={theme === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}
                >
                    {theme === 'dark' ? (
                        <Sun className="w-4 h-4" />
                    ) : (
                        <Moon className="w-4 h-4" />
                    )}
                </button>
                <button
                    onClick={() => window.dispatchEvent(new CustomEvent('toggle-atlas-assistant'))}
                    className={cn(
                        "p-2 transition-colors mr-1",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-primary"
                    )}
                    title={t('assistant.title', 'Atlas Assistant')}
                    aria-label={t('assistant.title', 'Atlas Assistant')}
                >
                    <Bot className="w-4 h-4" />
                </button>
                <NotificationCenter />
                <button
                    onClick={minimize}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title="Minimize"
                >
                    <Minus className="w-4 h-4" />
                </button>
                <button
                    onClick={toggleMaximize}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={isMaximized ? "Restore" : "Maximize"}
                >
                    <Square className="w-3.5 h-3.5" />
                </button>
                <button
                    onClick={close}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator bg-red-500/10 border-red-500/50 hover:bg-red-500 hover:text-white" : "hover:bg-red-500/10 hover:text-red-500 rounded-md text-muted-foreground"
                    )}
                    title="Close"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
        <WorkspaceUsageModal
            open={usageModalOpen}
            onOpenChange={setUsageModalOpen}
            usageMeter={usageMeter}
            onRefresh={refreshWorkspaceUsage}
            isRefreshing={isRefreshingWorkspaceUsage}
            paygSummary={paygSummary}
        />
        </>
    )
}
