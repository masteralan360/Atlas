import { Route, Switch, Router, Link } from 'wouter'
import { useHashLocation } from '@/hooks/useHashLocation'
import { AuthProvider, ProtectedRoute, GuestRoute } from '@/auth'
import { WorkspaceProvider } from '@/workspace'
import { Layout, Toaster, TitleBar, PatchNoteModal } from '@/ui/components'
import { DeviceTokenBootstrap } from '@/ui/components/DeviceTokenBootstrap'
import { lazy, Suspense, useEffect, useCallback, useState } from 'react'
import { usePatchNotes } from '@/hooks/usePatchNotes'
import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWorkspace } from '@/workspace'
import { ExchangeRateProvider } from '@/context/ExchangeRateContext'
import { DateRangeProvider } from '@/context/DateRangeContext'
import { AutoSyncOverlay } from '@/ui/components/AutoSyncOverlay'
import { isBackendConfigurationRequired, isSupabaseConfigured } from '@/auth/supabase'
import { isMobile, isDesktop } from './lib/platform'
import { useFavicon } from '@/hooks/useFavicon'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { useKdsStream } from '@/hooks/useKdsStream'

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
const Budget = lazy(() => import('@/ui/pages/Budget').then(m => ({ default: m.Budget })))
const MonthlyComparison = lazy(() => import('@/ui/pages/MonthlyComparison').then(m => ({ default: m.MonthlyComparison })))
const TeamPerformance = lazy(() => import('@/ui/pages/TeamPerformance').then(m => ({ default: m.TeamPerformance })))
const WorkspaceConfiguration = lazy(() => import('@/ui/pages/WorkspaceConfiguration').then(m => ({ default: m.WorkspaceConfiguration })))
const LockedWorkspace = lazy(() => import('@/ui/pages/LockedWorkspace').then(m => ({ default: m.LockedWorkspace })))
const CurrencyConverter = lazy(() => import('@/ui/pages/CurrencyConverter').then(m => ({ default: m.CurrencyConverter })))
const Notebook = lazy(() => import('@/ui/pages/Notebook').then(m => ({ default: m.Notebook })))
const ConnectionConfiguration = lazy(() => import('@/ui/pages/ConnectionConfiguration').then(m => ({ default: m.ConnectionConfiguration })))
const WhatsApp = lazy(() => import('@/ui/pages/WhatsAppWeb').then(m => ({ default: m.default })))
const InstantPOS = lazy(() => import('@/ui/pages/InstantPOS').then(m => ({ default: m.InstantPOS })))
const KDSDashboard = lazy(() => import('@/ui/pages/KDSDashboard').then(m => ({ default: m.KDSDashboard })))
const Discounts = lazy(() => import('@/ui/pages/Discounts').then(m => ({ default: m.Discounts })))
const Storages = lazy(() => import('@/ui/pages/Storages').then(m => ({ default: m.default })))
const InventoryTransfer = lazy(() => import('@/ui/pages/InventoryTransfer').then(m => ({ default: m.default })))
const HR = lazy(() => import('@/ui/pages/HR').then(m => ({ default: m.default })))
const Loans = lazy(() => import('@/ui/pages/Loans').then(m => ({ default: m.Loans })))
const Installments = lazy(() => import('@/ui/pages/Loans').then(m => ({ default: m.Installments })))
const BusinessPartners = lazy(() => import('@/ui/pages/BusinessPartners').then(m => ({ default: m.BusinessPartners })))
const BusinessPartnerDetails = lazy(() => import('@/ui/pages/BusinessPartnerDetails').then(m => ({ default: m.BusinessPartnerDetails })))
const Customers = lazy(() => import('@/ui/pages/Customers').then(m => ({ default: m.Customers })))
const CustomerDetails = lazy(() => import('@/ui/pages/CustomerDetails').then(m => ({ default: m.CustomerDetails })))
const Suppliers = lazy(() => import('@/ui/pages/Suppliers').then(m => ({ default: m.Suppliers })))
const SupplierDetails = lazy(() => import('@/ui/pages/SupplierDetails').then(m => ({ default: m.SupplierDetails })))
const Orders = lazy(() => import('@/ui/pages/Orders').then(m => ({ default: m.Orders })))
const Ecommerce = lazy(() => import('@/ui/pages/Ecommerce').then(m => ({ default: m.Ecommerce })))
const TravelAgency = lazy(() => import('@/ui/pages/TravelAgency').then(m => ({ default: m.TravelAgency })))
const TravelAgencySaleCreate = lazy(() => import('@/ui/pages/TravelAgencySaleForm').then(m => ({ default: m.TravelAgencySaleCreate })))
const TravelAgencySaleEdit = lazy(() => import('@/ui/pages/TravelAgencySaleForm').then(m => ({ default: m.TravelAgencySaleEdit })))
const TravelAgencySaleView = lazy(() => import('@/ui/pages/TravelAgencySaleForm').then(m => ({ default: m.TravelAgencySaleView })))
const Finance = lazy(() => import('@/ui/pages/Finance').then(m => ({ default: m.Finance })))
const Ledger = lazy(() => import('@/ui/pages/Ledger').then(m => ({ default: m.Ledger })))
const Payments = lazy(() => import('@/ui/pages/Payments').then(m => ({ default: m.Payments })))
const DirectTransactions = lazy(() => import('@/ui/pages/DirectTransactions').then(m => ({ default: m.DirectTransactions })))
const ModuleLauncher = lazy(() => import('@/ui/pages/ModuleLauncher').then(m => ({ default: m.ModuleLauncher })))

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

function compareVersions(v1: string, v2: string): number {
    const p1 = v1.replace(/[^0-9.]/g, '').split('.').map(Number)
    const p2 = v2.replace(/[^0-9.]/g, '').split('.').map(Number)
    const len = Math.max(p1.length, p2.length)
    for (let i = 0; i < len; i++) {
        const n1 = p1[i] || 0
        const n2 = p2[i] || 0
        if (n1 > n2) return 1
        if (n1 < n2) return -1
    }
    return 0
}

function UpdateHandler() {
    const { setPendingUpdate } = useWorkspace()
    const { t } = useTranslation()
    const [isBlocked, setIsBlocked] = useState(() => sessionStorage.getItem('version_blocked') === 'true')

    const checkForUpdates = useCallback(async (isManual = false) => {
        if (!isTauri) return

        // --- DEBUG: Easy to remove check log ---
        console.log(`[DEBUG-UPDATER] Triggered check. Manual: ${isManual}, Last Check: ${localStorage.getItem('last_auto_update_check')}`)
        // ---------------------------------------

        const lastCheck = localStorage.getItem('last_auto_update_check')
        const checkedThisSession = sessionStorage.getItem('startup_checked')
        const now = Date.now()
        const twentyFourHours = 24 * 60 * 60 * 1000

        // 1. Mandatory Minimum Version Check via latest.json
        // Always runs on startup (no session caching - security critical)
        if (!isManual) {
            try {
                const { getVersion } = await import('@tauri-apps/api/app')
                const currentVersion = await getVersion()

                const res = await fetch('https://asaas-r2-proxy.alanepic360.workers.dev/atlas-updates/latest.json', { cache: 'no-store' })
                if (res.ok) {
                    const remoteConfig = await res.json()

                    if (remoteConfig.min_version && compareVersions(currentVersion, remoteConfig.min_version) < 0) {
                        console.error(`[Security] Version blocked. App: ${currentVersion}, Required: ${remoteConfig.min_version}`)
                        sessionStorage.setItem('version_blocked', 'true')
                        setIsBlocked(true)
                    } else {
                        sessionStorage.removeItem('version_blocked')
                        setIsBlocked(false)
                    }
                }
            } catch (err) {
                console.warn('[Updater] Failed to check mandatory version from latest.json:', err)
            }
        }

        // Skip automatic checks if already checked this session (refresh protection)
        // OR if checked within the last 24 hours (interval protection)
        if (!isManual && !isBlocked) {
            if (checkedThisSession) {
                console.log('[Tauri] Skipping automatic update check (already checked this session/refresh)')
                return
            }

            if (lastCheck && now - parseInt(lastCheck) < twentyFourHours) {
                console.log('[Tauri] Skipping automatic update check (checked within last 24h)')
                // Still mark session as checked so refreshes don't keep pinging the logic
                sessionStorage.setItem('startup_checked', 'true')
                return
            }
        }

        try {
            const { ask, message } = await import('@tauri-apps/plugin-dialog')

            if (isMobile()) {
                console.log('[Tauri] Android custom update check...')
                const { getVersion } = await import('@tauri-apps/api/app')
                const { open } = await import('@tauri-apps/plugin-shell')

                const currentVersion = await getVersion()

                const response = await fetch('https://asaas-r2-proxy.alanepic360.workers.dev/atlas-updates/latest.json', { cache: 'no-store' })

                if (response.ok) {
                    const data = await response.json()

                    // Update timestamps
                    localStorage.setItem('last_auto_update_check', now.toString())
                    sessionStorage.setItem('startup_checked', 'true')

                    if (data.version && data.version !== currentVersion) {
                        console.log(`[Tauri] Android Update available: ${data.version}`)

                        let downloadUrl = data.android?.url || data.platforms?.android?.url

                        // Fallback check if it's strictly under android-*
                        if (!downloadUrl && data.platforms) {
                            const androidKey = Object.keys(data.platforms).find(k => k.startsWith('android'))
                            if (androidKey) {
                                downloadUrl = data.platforms[androidKey].url
                            }
                        }

                        if (downloadUrl) {
                            console.log('[Tauri] Opening Android APK URL automatically:', downloadUrl)
                            await open(downloadUrl)
                            setPendingUpdate(null)
                        } else {
                            console.error('[Tauri] Android APK URL not found in JSON')
                        }
                    } else {
                        console.log('[Tauri] No Android updates available')
                        if (isManual) {
                            await message(t('settings.messages.noUpdate'), {
                                title: t('updater.title'),
                                kind: 'info',
                            })
                        }
                    }
                }
                return
            }

            const { check } = await import('@tauri-apps/plugin-updater')
            console.log('[Tauri] Checking for updates...')
            const update = await check()

            // Update timestamps
            localStorage.setItem('last_auto_update_check', now.toString())
            sessionStorage.setItem('startup_checked', 'true')

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
            // 1. Startup check (3s delay)
            const startupTimer = setTimeout(() => {
                checkForUpdates()
            }, 3000)

            // 2. Background interval check (every 4 hours)
            const intervalTimer = setInterval(() => {
                const lastCheck = localStorage.getItem('last_auto_update_check')
                const now = Date.now()
                const twentyFourHours = 24 * 60 * 60 * 1000

                if (!lastCheck || now - parseInt(lastCheck) >= twentyFourHours) {
                    console.log('[Tauri] 24h interval passed while app open. Checking...')
                    checkForUpdates()
                }
            }, 4 * 60 * 60 * 1000)

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
                clearTimeout(startupTimer)
                clearInterval(intervalTimer)
                window.removeEventListener('keydown', handleKeyDown)
                window.removeEventListener('check-for-updates', handleManualCheck)
            }
        }
    }, [checkForUpdates])

    if (isBlocked) {
        return (
            <div className="fixed inset-0 z-[9999] bg-background/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
                <div className="max-w-md w-full p-8 border border-border/50 bg-card rounded-2xl shadow-2xl flex flex-col items-center gap-6">
                    <div className="w-16 h-16 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mb-2">
                        <RotateCw className="w-8 h-8 animate-spin-slow" />
                    </div>
                    <div className="space-y-3">
                        <h1 className="text-2xl font-bold tracking-tight text-foreground">Update Required</h1>
                        <p className="text-muted-foreground text-sm leading-relaxed">
                            Your application version is critically outdated and no longer supported. You must update to the latest version to continue using Atlas.
                        </p>
                    </div>
                    <button
                        onClick={() => checkForUpdates(true)}
                        className="w-full mt-4 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium shadow-md hover:shadow-lg active:scale-[0.98]"
                    >
                        Check for Updates
                    </button>
                </div>
            </div>
        )
    }

    return null
}

function FaviconHandler() {
    useFavicon()
    return null
}

function KdsSecurityGuard({ children }: { children: React.ReactNode }) {
    const [location] = useHashLocation()

    useEffect(() => {
        // Restricted mode: Web browser on port 4004
        // We use port 4004 as the hardcoded identifier for the KDS stream server
        const isRemoteKds = !isTauri && window.location.port === '4004'

        if (isRemoteKds && location !== '/kds/local') {
            console.warn('[Security] Restricting remote KDS client to /kds/local')
            // Use window.location.replace to prevent back-button loops
            window.location.replace('/#/kds/local')
        }
    }, [location])

    return <>{children}</>
}

function KdsStreamAutostart() {
    const { features } = useWorkspace()
    const isHost = isDesktop()
    const { status, startStream } = useKdsStream(isHost)

    useEffect(() => {
        if (isHost && features.kds_enabled && status === 'idle') {
            console.log('[KDS] Autostarting stream...')
            startStream(4004).catch((err: any) => {
                console.error('[KDS] Autostart failed:', err)
            })
        }
    }, [isHost, features.kds_enabled, status, startStream])

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
            <DeviceTokenBootstrap />
            <WorkspaceProvider>
                <DateRangeProvider>
                    <KdsStreamAutostart />
                    <UpdateHandler />
                    <FaviconHandler />
                    <AutoSyncOverlay />
                    {(!isMobile()) && <TitleBar />}
                    {isTauri && isBackendConfigurationRequired && !isSupabaseConfigured ? (
                        <Suspense fallback={<LoadingState />}>
                            <ConnectionConfiguration />
                        </Suspense>
                    ) : (
                        <ExchangeRateProvider>
                            <KdsSecurityGuard>
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
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="pos">
                                                    <Layout>
                                                        <POS />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/instant-pos">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="instant_pos">
                                                    <Layout>
                                                        <InstantPOS />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/kds">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="pos">
                                                    <Layout>
                                                        <KDSDashboard />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/kds/local">
                                                <div className="h-screen w-screen bg-background text-foreground overflow-hidden">
                                                    <KDSDashboard />
                                                </div>
                                            </Route>
                                            <Route path="/sales">
                                                <ProtectedRoute requiredFeature="sales_history">
                                                    <Layout>
                                                        <Sales />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/business-partners">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <BusinessPartners />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/business-partners/:partnerId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <BusinessPartnerDetails />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/customers">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <Customers />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/customers/:customerId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <CustomerDetails />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/suppliers">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <Suppliers />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/suppliers/:supplierId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <SupplierDetails />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/orders">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <Orders />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/orders/:orderId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="crm">
                                                    <Layout>
                                                        <Orders />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/ecommerce">
                                                <ProtectedRoute allowedRoles={['admin', 'staff']} requiredFeature="ecommerce">
                                                    <Layout>
                                                        <Ecommerce />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/ecommerce/:orderId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff']} requiredFeature="ecommerce">
                                                    <Layout>
                                                        <Ecommerce />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/travel-agency">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="travel_agency">
                                                    <Layout>
                                                        <TravelAgency />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/travel-agency/new">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="travel_agency">
                                                    <Layout>
                                                        <TravelAgencySaleCreate />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/travel-agency/:saleId/view">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="travel_agency">
                                                    <Layout>
                                                        <TravelAgencySaleView />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/travel-agency/:saleId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="travel_agency">
                                                    <Layout>
                                                        <TravelAgencySaleEdit />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/finance">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                    <Layout>
                                                        <Finance />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/ledger">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                    <Layout>
                                                        <Ledger />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/payments">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                    <Layout>
                                                        <Payments />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/direct-transactions">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
                                                    <Layout>
                                                        <DirectTransactions />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/modules">
                                                <ProtectedRoute>
                                                    <Layout>
                                                        <ModuleLauncher />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/revenue">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="net_revenue">
                                                    <Layout>
                                                        <Revenue />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/budget">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="budget">
                                                    <Layout>
                                                        <Budget />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/monthly-comparison">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="monthly_comparison">
                                                    <Layout>
                                                        <MonthlyComparison />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/performance">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="team_performance">
                                                    <Layout>
                                                        <TeamPerformance />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/whatsapp">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="allow_whatsapp">
                                                    <Layout>
                                                        <WhatsApp />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/products">
                                                <ProtectedRoute requiredFeature="products">
                                                    <Layout>
                                                        <Products />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/discounts">
                                                <ProtectedRoute allowedRoles={['admin', 'staff']} requiredFeature="discounts">
                                                    <Layout>
                                                        <Discounts />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/storages">
                                                <ProtectedRoute requiredFeature="storages">
                                                    <Layout>
                                                        <Storages />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/inventory-transfer">
                                                <ProtectedRoute requiredFeature="inventory_transfer">
                                                    <Layout>
                                                        <InventoryTransfer />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/hr">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="hr">
                                                    <Layout>
                                                        <HR />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/loans">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="loans">
                                                    <Layout>
                                                        <Loans />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/loans/:loanId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="loans">
                                                    <Layout>
                                                        <Loans />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/installments">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="loans">
                                                    <Layout>
                                                        <Installments />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/installments/:loanId">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="loans">
                                                    <Layout>
                                                        <Installments />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/invoices-history">
                                                <ProtectedRoute requiredFeature="invoices_history">
                                                    <Layout>
                                                        <InvoicesHistory />
                                                    </Layout>
                                                </ProtectedRoute>
                                            </Route>
                                            <Route path="/currency-converter">
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
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
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']} requiredFeature="members">
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
                                                <ProtectedRoute allowedRoles={['admin', 'staff', 'viewer']}>
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
                            </KdsSecurityGuard>
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
