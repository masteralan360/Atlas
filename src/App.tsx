import { Route, Switch, Router, Link } from 'wouter'
import { useHashLocation } from '@/hooks/useHashLocation'
import { AuthProvider, ProtectedRoute, GuestRoute } from '@/auth'
import { WorkspaceProvider } from '@/workspace'
import { Layout, Toaster, TitleBar, PatchNoteModal } from '@/ui/components'
import { lazy, Suspense, useEffect, useCallback, useState } from 'react'
import { usePatchNotes } from '@/hooks/usePatchNotes'
import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspace } from '@/workspace'
import { ExchangeRateProvider } from '@/context/ExchangeRateContext'
import { DateRangeProvider } from '@/context/DateRangeContext'
import { isBackendConfigurationRequired, isSupabaseConfigured } from '@/auth/supabase'
import { isMobile } from '@/lib/platform'
import { useFavicon } from '@/hooks/useFavicon'
import { whatsappManager } from '@/lib/whatsappWebviewManager'

// @ts-ignore
const isTauri = !!window.__TAURI_INTERNALS__

// Critical pages - eager load for Tauri desktop, lazy for web/mobile
import { Dashboard as DashboardEager } from '@/ui/pages/Dashboard'
import { POS as POSEager } from '@/ui/pages/POS'
import { Products as ProductsEager } from '@/ui/pages/Products'
import { Sales as SalesEager } from '@/ui/pages/Sales'
import { DashboardSkeleton } from '@/ui/components/skeletons/DashboardSkeleton'

// For web/mobile, wrap eager components in a lazy-like wrapper for consistency
const Dashboard = isTauri ? DashboardEager : lazy(() => import('@/ui/pages/Dashboard').then(m => ({ default: m.Dashboard })))
const POS = isTauri ? POSEager : lazy(() => import('@/ui/pages/POS').then(m => ({ default: m.POS })))
const Products = isTauri ? ProductsEager : lazy(() => import('@/ui/pages/Products').then(m => ({ default: m.Products })))
const Sales = isTauri ? SalesEager : lazy(() => import('@/ui/pages/Sales').then(m => ({ default: m.Sales })))

// Other pages - always lazy loaded
const Login = lazy(() => import('@/ui/pages/Login').then(m => ({ default: m.Login })))
const Register = lazy(() => import('@/ui/pages/Register').then(m => ({ default: m.Register })))
const InvoicesHistory = lazy(() => import('@/ui/pages/InvoicesHistory').then(m => ({ default: m.InvoicesHistory })))
const Members = lazy(() => import('@/ui/pages/Members').then(m => ({ default: m.Members })))
const Settings = lazy(() => import('@/ui/pages/Settings').then(m => ({ default: m.Settings })))
const Admin = lazy(() => import('@/ui/pages/Admin').then(m => ({ default: m.Admin })))
const WorkspaceRegistration = lazy(() => import('@/ui/pages/WorkspaceRegistration').then(m => ({ default: m.WorkspaceRegistration })))
const Revenue = lazy(() => import('@/ui/pages/Revenue').then(m => ({ default: m.Revenue })))
const MonthlyComparison = lazy(() => import('@/ui/pages/MonthlyComparison').then(m => ({ default: m.MonthlyComparison })))
const TeamPerformance = lazy(() => import('@/ui/pages/TeamPerformance').then(m => ({ default: m.TeamPerformance })))
const WorkspaceConfiguration = lazy(() => import('@/ui/pages/WorkspaceConfiguration').then(m => ({ default: m.WorkspaceConfiguration })))
const LockedWorkspace = lazy(() => import('@/ui/pages/LockedWorkspace').then(m => ({ default: m.LockedWorkspace })))
const CurrencyConverter = lazy(() => import('@/ui/pages/CurrencyConverter').then(m => ({ default: m.CurrencyConverter })))
const Notebook = lazy(() => import('@/ui/pages/Notebook').then(m => ({ default: m.Notebook })))
const ConnectionConfiguration = lazy(() => import('@/ui/pages/ConnectionConfiguration').then(m => ({ default: m.ConnectionConfiguration })))
const WhatsApp = lazy(() => import('@/ui/pages/WhatsAppWeb').then(m => ({ default: m.default })))
const Suppliers = lazy(() => import('@/ui/pages/Suppliers').then(m => ({ default: m.default })))
const Customers = lazy(() => import('@/ui/pages/Customers').then(m => ({ default: m.default })))
const Orders = lazy(() => import('@/ui/pages/Orders').then(m => ({ default: m.default })))
const Storages = lazy(() => import('@/ui/pages/Storages').then(m => ({ default: m.default })))
const InventoryTransfer = lazy(() => import('@/ui/pages/InventoryTransfer').then(m => ({ default: m.default })))
const HR = lazy(() => import('@/ui/pages/HR').then(m => ({ default: m.default })))
const Loans = lazy(() => import('@/ui/pages/Loans').then(m => ({ default: m.Loans })))



function LoadingState() {
    const [isSlow, setIsSlow] = useState(false)
    const { t } = useTranslation()

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsSlow(true)
            console.warn('[Diagnostics] Loading is taking longer than 7s. Displaying safety refresh button.')
        }, 7000)
        return () => clearTimeout(timer)
    }, [])

    const handleRefresh = () => {
        console.log('[Diagnostics] User triggered manual refresh from SlowLoadingNotice.')
        window.location.reload()
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-6 max-w-sm text-center px-6">
                <div className="relative">
                    <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
                    {isSlow && (
                        <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                            <RotateCw className="w-5 h-5 text-primary" />
                        </div>
                    )}
                </div>

                <div className="space-y-2">
                    <p className="text-foreground font-medium animate-pulse">
                        {isSlow ? t('common.loadingSlow') || 'Taking longer than usual...' : t('common.loading') || 'Loading...'}
                    </p>
                    {isSlow && (
                        <p className="text-sm text-muted-foreground animate-in fade-in slide-in-from-top-2 duration-700">
                            {t('common.loadingStuckMessage') || 'The connection might be slow or interrupted. Try refreshing the application.'}
                        </p>
                    )}
                </div>

                {isSlow && (
                    <button
                        onClick={handleRefresh}
                        className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium shadow-lg animate-in fade-in zoom-in duration-500"
                    >
                        <RotateCw className="w-4 h-4" />
                        {t('common.refresh') || 'Refresh App'}
                    </button>
                )}
            </div>
        </div>
    )
}

function UpdateHandler() {
    const { setPendingUpdate } = useWorkspace()
    const { t } = useTranslation()

    const checkForUpdates = useCallback(async (isManual = false) => {
        if (!isTauri || isMobile()) return

        try {
            const { check } = await import('@tauri-apps/plugin-updater')
            const { ask, message } = await import('@tauri-apps/plugin-dialog')

            console.log('[Tauri] Checking for updates...')
            const update = await check()

            if (update) {
                console.log(`[Tauri] Update available: ${update.version}`)

                const shouldUpdate = await ask(
                    t('updater.message', { version: update.version }),
                    {
                        title: t('updater.title'),
                        kind: 'info',
                        okLabel: t('updater.updateNow'),
                        cancelLabel: t('updater.later'),
                    }
                )

                if (shouldUpdate) {
                    let downloaded = 0
                    let contentLength: number | undefined = 0

                    await update.downloadAndInstall((event) => {
                        switch (event.event) {
                            case 'Started':
                                contentLength = event.data.contentLength
                                console.log(`[Tauri] Started downloading ${event.data.contentLength} bytes`)
                                break
                            case 'Progress':
                                downloaded += event.data.chunkLength
                                console.log(`[Tauri] Downloaded ${downloaded} from ${contentLength}`)
                                break
                            case 'Finished':
                                console.log('[Tauri] Download finished')
                                break
                        }
                    })

                    console.log('[Tauri] Update installed. The installer will now replace the application.')
                } else {
                    console.log('[Tauri] User deferred update.')
                    setPendingUpdate({
                        version: update.version,
                        date: update.date,
                        body: update.body
                    })
                }
            } else {
                console.log('[Tauri] No updates available')
                if (isManual) {
                    await message(t('settings.messages.noUpdate'), {
                        title: t('updater.title'),
                        kind: 'info',
                    })
                }
            }
        } catch (error) {
            console.error('[Tauri] Failed to check for updates:', error)
        }
    }, [t, setPendingUpdate])

    useEffect(() => {
        if (isTauri) {
            // Delay startup check slightly to ensure network and WebView are fully ready
            const timer = setTimeout(() => {
                checkForUpdates()
            }, 3000)

            const handleManualCheck = () => {
                checkForUpdates(true)
            }

            window.addEventListener('check-for-updates', handleManualCheck)

            const handleKeyDown = async (e: KeyboardEvent) => {
                if (e.key === 'F11' && !isMobile()) {
                    e.preventDefault()
                    const { getCurrentWindow } = await import('@tauri-apps/api/window')
                    const window = getCurrentWindow()
                    const fullscreen = await window.isFullscreen()
                    const maximized = await window.isMaximized()

                    console.log('[Tauri] F11: Toggling fullscreen to:', !fullscreen, '(Maximized:', maximized, ')')

                    if (!fullscreen && maximized) {
                        await window.unmaximize()
                    }

                    await window.setFullscreen(!fullscreen)
                }
            }

            window.addEventListener('keydown', handleKeyDown)
            return () => {
                clearTimeout(timer)
                window.removeEventListener('keydown', handleKeyDown)
                window.removeEventListener('check-for-updates', handleManualCheck)
            }
        }
    }, [checkForUpdates])

    return null
}

/**
 * FaviconHandler - Updates favicon based on language and theme style
 */
function FaviconHandler() {
    useFavicon()
    return null
}




function App() {
    const { showModal, currentPatch, version, dismissModal } = usePatchNotes()

    useEffect(() => {
        if (isMobile()) {
            document.documentElement.setAttribute('data-mobile', 'true')
        } else {
            document.documentElement.removeAttribute('data-mobile')
        }

        // WhatsApp Auto Launch Logic
        const autoLaunch = localStorage.getItem('whatsapp_auto_launch') === 'true'
        if (autoLaunch && isTauri && !isMobile()) {
            console.log('[WhatsApp Startup] Auto-launching WhatsApp in background...')
            whatsappManager.getOrCreate(0, 0, 0, 0).catch(err => {
                console.error('[WhatsApp Startup] Failed to auto-launch:', err)
            })
        }
    }, [])

    return (
        <AuthProvider>
            <WorkspaceProvider>
                <DateRangeProvider>
                    <UpdateHandler />
                    <FaviconHandler />
                    {(!isMobile()) && <TitleBar />}
                    {isTauri && isBackendConfigurationRequired && !isSupabaseConfigured ? (
                        <Suspense fallback={<LoadingState />}>
                            <ConnectionConfiguration />
                        </Suspense>
                    ) : (
                        <ExchangeRateProvider>
                            <Suspense fallback={<LoadingState />}>
                                <Router hook={useHashLocation}>
                                    <Switch>
                                        {/* Guest Routes */}
                                        <Route path="/login">
                                            <GuestRoute>
                                                <Login />
                                            </GuestRoute>
                                        </Route>
                                        <Route path="/register">
                                            <GuestRoute>
                                                <Register />
                                            </GuestRoute>
                                        </Route>

                                        {/* Locked Workspace Route - no layout, standalone page */}
                                        <Route path="/locked-workspace">
                                            <LockedWorkspace />
                                        </Route>

                                        {/* Connection Configuration Route */}
                                        {isBackendConfigurationRequired && (
                                            <Route path="/connection-configuration">
                                                <ConnectionConfiguration />
                                            </Route>
                                        )}



                                        {/* Protected Routes */}
                                        <Route path="/">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Suspense fallback={<DashboardSkeleton />}>
                                                        <Dashboard />
                                                    </Suspense>
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/pos">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']} requiredFeature="allow_pos">
                                                <Layout>
                                                    <POS />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/sales">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Sales />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/revenue">
                                            <ProtectedRoute allowedRoles={['admin']}>
                                                <Layout>
                                                    <Revenue />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/monthly-comparison">
                                            <ProtectedRoute allowedRoles={['admin']}>
                                                <Layout>
                                                    <MonthlyComparison />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/performance">
                                            <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                <Layout>
                                                    <TeamPerformance />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/whatsapp">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']} requiredFeature="allow_whatsapp">
                                                <Layout>
                                                    <WhatsApp />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/products">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Products />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/suppliers">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Suppliers />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/customers">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Customers />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/orders">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Orders />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>

                                        <Route path="/storages">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Storages />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/inventory-transfer">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <InventoryTransfer />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/hr">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']}>
                                                <Layout>
                                                    <HR />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/loans">
                                            <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                <Layout>
                                                    <Loans />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/loans/:loanId">
                                            <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                <Layout>
                                                    <Loans />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>

                                        <Route path="/invoices-history">
                                            <ProtectedRoute requiredFeature="allow_invoices">
                                                <Layout>
                                                    <InvoicesHistory />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/currency-converter">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']}>
                                                <Layout>
                                                    <CurrencyConverter />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/notebook">
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Notebook />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/members">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']}>
                                                <Layout>
                                                    <Members />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/workspace-registration">
                                            <ProtectedRoute allowKicked={true}>
                                                <WorkspaceRegistration />
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/settings">
                                            <ProtectedRoute allowedRoles={['admin', 'staff']}>
                                                <Layout>
                                                    <Settings />
                                                </Layout>
                                            </ProtectedRoute>
                                        </Route>
                                        <Route path="/admin">
                                            <Admin />
                                        </Route>
                                        <Route path="/workspace-configuration">
                                            <ProtectedRoute allowedRoles={['admin']}>
                                                <WorkspaceConfiguration />
                                            </ProtectedRoute>
                                        </Route>

                                        {/* 404 */}
                                        <Route>
                                            <div className="min-h-screen flex items-center justify-center bg-background">
                                                <div className="text-center">
                                                    <h1 className="text-6xl font-bold gradient-text mb-4">404</h1>
                                                    <p className="text-muted-foreground mb-4">Page not found</p>
                                                    <Link href="/" className="text-primary hover:underline">Go home</Link>
                                                </div>
                                            </div>
                                        </Route>
                                    </Switch>
                                </Router>
                            </Suspense>
                        </ExchangeRateProvider>
                    )}
                    <Toaster />
                    {isTauri && currentPatch && (
                        <PatchNoteModal
                            isOpen={showModal}
                            onClose={dismissModal}
                            version={version}
                            date={currentPatch.date}
                            highlights={currentPatch.highlights}
                            teamMessages={currentPatch.teamMessages}
                        />
                    )}
                </DateRangeProvider>
            </WorkspaceProvider>
        </AuthProvider>
    )
}

export default App
