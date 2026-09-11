import { type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useLocation } from 'wouter'
import { cn } from '@/lib/utils'
import { useAuth } from '@/auth'
import {
  db,
  completeCashierShiftOccurrence,
  getCashierShiftListRows,
  getCashierShiftCompletionEligibility,
  getCashierShiftOccurrenceBounds,
  isCashierShiftWorkingDay,
  requestCashierShiftEarlyFinish,
  summarizeCashierShiftTransactions,
  startCashierShiftOccurrence,
  type CashierShiftAssignment,
  type CashierShiftOccurrence,
  useCashierShiftAssignments,
  useCashierShiftOccurrences,
  usePaymentTransactions,
  useReorderTransferRules
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import { isDemoWorkspace } from '@/demo'
import { useWorkspacePermissions } from '@/permissions'
import { SyncStatusIndicator } from './SyncStatusIndicator'
import { ExchangeRateIndicator } from './ExchangeRateIndicator'
import { GlobalSearch } from './GlobalSearch'
import { PageFind } from './PageFind'
import { P2PSyncIndicator } from './P2PSyncStatus'
import { assetManager } from '@/lib/assetManager'
import { startR2BackupInterval, stopR2BackupInterval } from '@/local-db/sqliteBackup'
import { platformService } from '@/services/platformService'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { recordTauriStartupVersion } from '@/lib/tauriVersionReporting'
import { ResourceSyncOverlay } from './p2p/ResourceSyncOverlay'
import { NotificationCenter } from './NotificationCenter'
import { ManualRateModals } from './exchange/ManualRateModals'
import { LoanPaymentModalProvider } from './loans/LoanPaymentModalProvider'
import { UnifiedSnoozeProvider } from '@/context/UnifiedSnoozeContext'
import { GlobalExchangeRateReminders } from './exchange/GlobalExchangeRateReminders'
import { CurrencyConverterPopup } from './CurrencyConverterPopup'
import { AtlasAssistantPopup } from './AtlasAssistantPopup'
import { UnifiedSnoozedRemindersBell } from './reminders/UnifiedSnoozedRemindersBell'
import { WorkspacePaygChargeButton, WorkspaceUsageButton, WorkspaceUsageCircleButton, WorkspaceUsageModal } from './WorkspaceUsageModal'
import { useWorkspaceUsageMeter } from './workspaceUsageMeter'
import { ThemeAwareLogo } from './ThemeAwareLogo'
import { LocalAccountSwitcher } from './LocalAccountSwitcher'
import { DeploymentRefreshVersion } from './DeploymentRefreshVersion'
import { ModuleLockerOverlay } from './module-locker/ModuleLockerOverlay'
import { ModuleLockerPasskeyDialog, type ModuleLockerPasskeyAction } from './module-locker/ModuleLockerPasskeyDialog'
import { buildWorkspaceNavigation, type WorkspaceNavigationGroup, type WorkspaceNavigationItem } from '@/ui/navigation/workspaceNavigation'
import { launcherSectionOrder, type NavigationSectionKey } from '@/ui/navigation/navigationMeta'
import {
  createSidebarSectionOrderStorageValue,
  getSidebarSectionOrderStorageKey,
  readSidebarSectionOrder,
  reorderVisibleSidebarSections
} from '@/ui/navigation/sidebarSectionOrder'
import {
  createSidebarModuleOrderStorageValue,
  getSidebarModuleOrderStorageKey,
  readSidebarModuleOrder,
  reconcileSidebarModuleOrder,
  reorderVisibleSidebarModuleItems,
  type SidebarModuleOrderBySection
} from '@/ui/navigation/sidebarModuleOrder'
import {
  addSidebarFavorite,
  createSidebarFavoritesStorageValue,
  getSidebarFavoritesStorageKey,
  readSidebarFavorites,
  removeSidebarFavorite,
  reorderVisibleSidebarFavorites,
  resetSidebarFavoritesOrder,
  type SidebarFavorites
} from '@/ui/navigation/sidebarFavorites'
import {
  getModuleLockerLockForPath,
  getModuleLockerSnapshot,
  isModuleLockerLockableHref,
  type ModuleLockerActor
} from '@/local-db/moduleLocker'
import { useWorkspaceBranchSwitcher } from '@/hooks/useWorkspaceBranchSwitcher'
import { useClinicalRegistryType } from '@/local-db/clinicalPresets'
import { refreshToLatestDeployment } from '@/lib/deploymentRefresh'
import { areApplicationUpdatesDisabled, UPDATE_PREFERENCE_CHANGED_EVENT } from '@/lib/updatePreference'

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
  Loader2,
  AlertTriangle,
  Clock,
  CircleCheck,
  ClipboardCheck,
  ShieldCheck,
  LockKeyhole,
  Sun,
  Moon,
  Monitor,
  GripVertical,
  ListOrdered,
  RotateCcw,
  Settings2,
  Star,
  Search
} from 'lucide-react'
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd'
import { Button } from './button'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from './dialog'
import { PressAndHoldButton } from './PressAndHoldButton'
import { Textarea } from './textarea'
import { Input } from './input'
import { Checkbox } from './checkbox'
import { DeleteConfirmationModal } from './DeleteConfirmationModal'
import { useToast } from './use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'

import { useTranslation } from 'react-i18next'
import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { isMobile, isDesktop } from '@/lib/platform'
import { useWebHaptics } from 'web-haptics/react'
import { useTheme } from './theme-provider'

interface LayoutProps {
  children: ReactNode
}

type SidebarCashierShiftStatus = 'available' | 'active'
type SidebarModuleOrderSection = NavigationSectionKey | 'favorites'

interface SidebarFavoritesGroup {
  sectionKey: 'favorites'
  title: string
  icon: typeof Star
  items: WorkspaceNavigationItem[]
}

interface SidebarCashierShift {
  assignment: CashierShiftAssignment
  occurrence?: CashierShiftOccurrence
  scheduledStartAt: string
  scheduledEndAt: string
  status: SidebarCashierShiftStatus
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatSidebarShiftCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function formatCashierShiftCompletionAmount(
  summaries: ReturnType<typeof summarizeCashierShiftTransactions>,
  direction: 'incoming' | 'outgoing'
) {
  if (summaries.length === 0) return '0'

  return summaries
    .map((summary) => formatCurrency(direction === 'incoming' ? summary.incomingAmount : summary.outgoingAmount, summary.currency))
    .join(' • ')
}

// Route prefetch map for on-hover preloading (desktop only)
const routePrefetchMap: Record<string, () => Promise<unknown>> = {
  '/': () => import('@/ui/pages/Dashboard'),
  '/help': () => import('@/ui/pages/Help'),
  '/pos': () => import('@/ui/pages/POS'),
  '/instant-pos': () => import('@/ui/pages/InstantPOS'),
  '/kds': () => import('@/ui/pages/KDSDashboard'),
  '/sales': () => import('@/ui/pages/Sales'),
  '/business-partners': () => import('@/ui/pages/BusinessPartners'),
  '/agents': () => import('@/ui/pages/Agents'),
  '/agents/commissions': () => import('@/ui/pages/AgentCommissions'),
  '/agents/fleet': () => import('@/ui/pages/FleetManagement'),
  '/agents/location-sharing': () => import('@/ui/pages/AgentLocationSharing'),
  '/customers': () => import('@/ui/pages/Customers'),
  '/suppliers': () => import('@/ui/pages/Suppliers'),
  '/orders': () => import('@/ui/pages/Orders'),
  '/travel-transportation': () => import('@/ui/pages/TravelTransportation'),
  '/real-estate': () => import('@/ui/pages/RealEstate'),
  '/activities': () => import('@/ui/pages/Activities'),
  '/manual-entry': () => import('@/ui/pages/ManualEntry'),
  '/manual-entry/templates': () => import('@/ui/pages/ManualEntryTemplates'),

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
  '/services': () => import('@/ui/pages/Services'),
  '/units': () => import('@/ui/pages/UnitsPage'),
  '/storages': () => import('@/ui/pages/Storages'),
  '/inventory-transfer': () => import('@/ui/pages/InventoryTransfer'),
  '/invoices-history': () => import('@/ui/pages/InvoicesHistory'),
  '/invoices-history/upload-files': () => import('@/ui/pages/InvoicesHistory'),
  '/hr': () => import('@/ui/pages/HR'),
  '/members': () => import('@/ui/pages/Members'),
  '/custom-templates': () => import('@/ui/pages/CustomTemplates'),
  '/settings': () => import('@/ui/pages/Settings')
}

// Prefetch a route's chunk on hover (only triggers once per route)
const prefetchedRoutes = new Set<string>()
const SIDEBAR_WORKSPACE_LABEL_MAX_LENGTH = 10

function getSidebarWorkspaceLabel(workspaceLabel: string) {
  const characters = Array.from(workspaceLabel)

  return characters.length > SIDEBAR_WORKSPACE_LABEL_MAX_LENGTH
    ? `${characters.slice(0, SIDEBAR_WORKSPACE_LABEL_MAX_LENGTH - 1).join('')}…`
    : workspaceLabel
}

function prefetchRoute(href: string) {
  if (prefetchedRoutes.has(href)) return
  const prefetcher = routePrefetchMap[href]
  if (prefetcher) {
    prefetchedRoutes.add(href)
    prefetcher().catch(() => {
      /* ignore prefetch errors */
    })
  }
}

export function Layout({ children }: LayoutProps) {
  const [location, setLocation] = useLocation()
  const { user, signOut, session } = useAuth()
  const clinicalRegistryType = useClinicalRegistryType(user?.workspaceId)
  const {
    hasFeature,
    hasCapability,
    workspaceName,
    isFullscreen,
    features,
    activeWorkspace,
    isLocalMode,
    isDemoMode,
    isLocked,
    isLoading: isWorkspaceLoading,
    loadedWorkspaceId
  } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const demoExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageContentRef = useRef<HTMLElement>(null)
  const moduleLockerSnapshot = useLiveQuery(
    () => (user?.workspaceId ? getModuleLockerSnapshot(user.workspaceId) : undefined),
    [user?.workspaceId]
  )
  const [moduleLockerDialog, setModuleLockerDialog] = useState<{
    action: ModuleLockerPasskeyAction
    moduleHref: string
    moduleName: string
  } | null>(null)
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
  const cashierShiftAssignments = useCashierShiftAssignments(user?.workspaceId)
  const cashierShiftOccurrences = useCashierShiftOccurrences(user?.workspaceId)
  const cashierShiftPaymentTransactions = usePaymentTransactions(
    user?.workspaceId,
    {},
    { hydrateSourceTables: false }
  )

  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { toast } = useToast()
  const moduleLockerActor = useMemo<ModuleLockerActor | undefined>(
    () => (user ? { userId: user.id, name: user.name || user.email || t('settings.moduleLocker.unknownActor') } : undefined),
    [t, user]
  )
  // @ts-ignore
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const {
    usageMeter: webUsageMeter,
    paygSummary: webPaygSummary,
    refreshWorkspaceUsage: refreshWebWorkspaceUsage,
    isRefreshingWorkspaceUsage: isRefreshingWebWorkspaceUsage
  } = useWorkspaceUsageMeter({
    enabled: !isTauri && !isLocalMode && !isDemoMode,
    workspaceId: activeWorkspace?.id
  })
  const [demoRemainingSec, setDemoRemainingSec] = useState<number | null>(null)
  const [updatesDisabled, setUpdatesDisabled] = useState(() => areApplicationUpdatesDisabled())
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
  const [sidebarSectionOrder, setSidebarSectionOrder] = useState<NavigationSectionKey[]>(() => [...launcherSectionOrder])
  const [sidebarModuleOrderBySection, setSidebarModuleOrderBySection] = useState<SidebarModuleOrderBySection>({})
  const [sidebarFavorites, setSidebarFavorites] = useState<SidebarFavorites>({ order: [], firstAddedOrder: [] })
  const [isSidebarCustomizationMode, setIsSidebarCustomizationMode] = useState(false)
  const [isSidebarResetDialogOpen, setIsSidebarResetDialogOpen] = useState(false)
  const [activeSidebarModuleOrderSection, setActiveSidebarModuleOrderSection] = useState<SidebarModuleOrderSection | null>(null)
  const [sidebarModuleOrderResetSection, setSidebarModuleOrderResetSection] = useState<SidebarModuleOrderSection | null>(null)
  const [isSidebarFavoritesDialogOpen, setIsSidebarFavoritesDialogOpen] = useState(false)
  const [favoritePickerOrder, setFavoritePickerOrder] = useState<string[]>([])
  const [favoritePickerQuery, setFavoritePickerQuery] = useState('')
  const [isClearSidebarFavoritesDialogOpen, setIsClearSidebarFavoritesDialogOpen] = useState(false)
  const [isSidebarHeaderCompact, setIsSidebarHeaderCompact] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  const showSidebarThemeSelector = !isTauri && !isMobile() && viewportWidth >= 1024
  const fullWorkspaceLabel = currentWorkspaceLabel || workspaceName || 'Atlas'
  const sidebarWorkspaceLabel = getSidebarWorkspaceLabel(fullWorkspaceLabel)
  const sidebarSectionOrderStorageKey = useMemo(() => {
    const workspaceId = activeWorkspace?.id ?? user?.workspaceId
    return user?.id && workspaceId ? getSidebarSectionOrderStorageKey(user.id, workspaceId) : null
  }, [activeWorkspace?.id, user?.id, user?.workspaceId])
  const sidebarModuleOrderStorageKey = useMemo(() => {
    const workspaceId = activeWorkspace?.id ?? user?.workspaceId
    return user?.id && workspaceId ? getSidebarModuleOrderStorageKey(user.id, workspaceId) : null
  }, [activeWorkspace?.id, user?.id, user?.workspaceId])
  const sidebarFavoritesStorageKey = useMemo(() => {
    const workspaceId = activeWorkspace?.id ?? user?.workspaceId
    return user?.id && workspaceId ? getSidebarFavoritesStorageKey(user.id, workspaceId) : null
  }, [activeWorkspace?.id, user?.id, user?.workspaceId])

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const syncUpdatePreference = () => setUpdatesDisabled(areApplicationUpdatesDisabled())
    window.addEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncUpdatePreference)
    return () => window.removeEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncUpdatePreference)
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sidebar_expanded_nav_groups', JSON.stringify(expandedNavGroups))
      localStorage.setItem('instant_pos_nav_open', String(Boolean(expandedNavGroups['/instant-pos'])))
    }
  }, [expandedNavGroups])

  useEffect(() => {
    setIsSidebarCustomizationMode(false)
    setActiveSidebarModuleOrderSection(null)
    setSidebarModuleOrderResetSection(null)
    setIsSidebarFavoritesDialogOpen(false)
    setFavoritePickerOrder([])
    setFavoritePickerQuery('')

    if (typeof window === 'undefined' || !sidebarSectionOrderStorageKey) {
      setSidebarSectionOrder([...launcherSectionOrder])
      setSidebarModuleOrderBySection({})
      setSidebarFavorites({ order: [], firstAddedOrder: [] })
      return
    }

    setSidebarSectionOrder(readSidebarSectionOrder(localStorage.getItem(sidebarSectionOrderStorageKey)))
    setSidebarModuleOrderBySection(
      sidebarModuleOrderStorageKey ? readSidebarModuleOrder(localStorage.getItem(sidebarModuleOrderStorageKey)) : {}
    )
    setSidebarFavorites(
      sidebarFavoritesStorageKey ? readSidebarFavorites(localStorage.getItem(sidebarFavoritesStorageKey)) : { order: [], firstAddedOrder: [] }
    )
  }, [sidebarFavoritesStorageKey, sidebarModuleOrderStorageKey, sidebarSectionOrderStorageKey])

  const [members, setMembers] = useState<{ id: string; name: string; role: string; profile_url?: string | null }[]>([])
  const [logoError, setLogoError] = useState(false)
  const [copied, setCopied] = useState(false)
  const [version, setVersion] = useState('')
  const [versionTooltip, setVersionTooltip] = useState('')
  const [whatsappStatus, setWhatsappStatus] = useState<'live' | 'off'>(whatsappManager.isActive() ? 'live' : 'off')
  const [isSignOutModalOpen, setIsSignOutModalOpen] = useState(false)
  const [pendingEcommerceCount, setPendingEcommerceCount] = useState(0)
  const [currencyConverterOpen, setCurrencyConverterOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantInitialQuery, setAssistantInitialQuery] = useState<string | undefined>(undefined)
  const [usageModalOpen, setUsageModalOpen] = useState(false)
  const [cashierShiftNow, setCashierShiftNow] = useState(() => new Date())
  const [cashierShiftStartDialogOpen, setCashierShiftStartDialogOpen] = useState(false)
  const [cashierShiftCompleteDialogOpen, setCashierShiftCompleteDialogOpen] = useState(false)
  const [cashierShiftEarlyFinishRequestDialogOpen, setCashierShiftEarlyFinishRequestDialogOpen] = useState(false)
  const [startingCashierShift, setStartingCashierShift] = useState(false)
  const [completingCashierShift, setCompletingCashierShift] = useState(false)
  const [requestingCashierShiftEarlyFinish, setRequestingCashierShiftEarlyFinish] = useState(false)
  const [cashierShiftCompletionReason, setCashierShiftCompletionReason] = useState('')
  const [cashierShiftEarlyFinishReason, setCashierShiftEarlyFinishReason] = useState('')
  const canUseCashierShiftQuickStart =
    hasFeature('payment_accounts') && hasFeature('cashier_shift_control') && hasPermission('cashierShiftControl.access')

  useEffect(() => {
    if (!canUseCashierShiftQuickStart) return

    const intervalId = window.setInterval(() => setCashierShiftNow(new Date()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [canUseCashierShiftQuickStart])

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
      if (isLocalMode) {
        const localProfiles = await db.profiles.where('workspaceId').equals(user.workspaceId).toArray()
        setMembers(localProfiles)
        return
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, role, profile_url, workspace_id, current_workspace')
        .eq('workspace_id', user.workspaceId)

      if (!error && data) {
        setMembers(data)
        db.profiles
          .bulkPut(
            data.map((p: any) => ({
              id: p.id,
              workspaceId: p.workspace_id,
              currentWorkspaceId: p.current_workspace || p.workspace_id,
              name: p.name,
              role: p.role || '',
              profile_url: p.profile_url
            }))
          )
          .catch(console.error)
      }
    }

    fetchMembers()

    // Do not initialize cloud resource sync until this workspace's mode has
    // resolved. `features` starts as cloud, which must never override a
    // Local Mode workspace during startup.
    if (user?.id && user.workspaceId && !isWorkspaceLoading && loadedWorkspaceId === user.workspaceId) {
      assetManager.initialize(user.workspaceId, features.data_mode)
    }

    // Start R2 database backup interval for local mode
    if (user?.workspaceId) {
      startR2BackupInterval(user.workspaceId)
    }

    // Fetch App Version
    // @ts-ignore
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/app').then(({ getVersion }) => {
        getVersion()
          .then((appVersion) => {
            setVersion(appVersion)
            if (session?.user?.id === user.id) {
              void recordTauriStartupVersion({
                userId: user.id,
                workspaceId: user.workspaceId,
                version: appVersion
              })
            }
          })
          .catch(console.error)
      })
    } else {
      // Web / PWA build: show the latest GitHub commit instead of the
      // Tauri app version.
      import('@/lib/gitBuildInfo').then(({ gitCommitMessage, gitCommitHash, gitCommitDate }) => {
        const message = gitCommitMessage.trim()
        const hash = gitCommitHash.trim()
        setVersion(message || hash || '')
        const parts = [hash && `commit ${hash}`, gitCommitDate && `on ${gitCommitDate}`].filter(Boolean)
        setVersionTooltip([message, ...parts].filter(Boolean).join(' '))
      })
    }

    // Handle mobile sidebar trigger from child components
    const handleOpen = () => setMobileSidebarOpen(true)
    window.addEventListener('open-mobile-sidebar', handleOpen)
    window.addEventListener('profile-updated', fetchMembers)

    // Handle WhatsApp status changes
    const handleWhatsAppStatusChange = (e: any) => {
      const newStatus = e.detail.active ? 'live' : 'off'
      console.log(`[Layout Debug] WhatsApp status changed: ${newStatus}`, e.detail)
      setWhatsappStatus(newStatus)
    }
    window.addEventListener('whatsapp-status-change', handleWhatsAppStatusChange)

    return () => {
      window.removeEventListener('open-mobile-sidebar', handleOpen)
      window.removeEventListener('profile-updated', fetchMembers)
      window.removeEventListener('whatsapp-status-change', handleWhatsAppStatusChange)
      stopR2BackupInterval()
    }
  }, [
    features.data_mode,
    isLocalMode,
    isWorkspaceLoading,
    loadedWorkspaceId,
    session?.user?.id,
    user?.id,
    user?.workspaceId
  ])

  useEffect(() => {
    if (
      !user?.workspaceId ||
      features.data_mode === 'local' ||
      features.data_mode === 'demo' ||
      !hasFeature('ecommerce')
    ) {
      setPendingEcommerceCount(0)
      return
    }

    const fetchPendingOrders = async () => {
      try {
        const { count, error } = await supabase
          .from('marketplace_orders')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending')

        if (!error && count !== null) {
          setPendingEcommerceCount(count)
        }
      } catch (error) {
        console.error('[Layout] Failed to fetch pending marketplace orders count:', error)
      }
    }

    fetchPendingOrders()

    const handleEcommerceUpdate = () => {
      void fetchPendingOrders()
    }
    window.addEventListener('focus', handleEcommerceUpdate)
    window.addEventListener('marketplace-orders:changed', handleEcommerceUpdate)
    const intervalId = window.setInterval(() => {
      void fetchPendingOrders()
    }, 60_000)

    return () => {
      window.removeEventListener('focus', handleEcommerceUpdate)
      window.removeEventListener('marketplace-orders:changed', handleEcommerceUpdate)
      window.clearInterval(intervalId)
    }
  }, [user?.workspaceId, features.data_mode, hasFeature])

  const handleAddToDesktop = async (name: string, href: string) => {
    if (!isDesktop()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // @ts-ignore
      await invoke('create_desktop_shortcut', {
        moduleName: name,
        moduleHref: href
      })

      // @ts-ignore
      const { message } = await import('@tauri-apps/plugin-dialog')
      await message(
        t('shortcut.createdMessage', {
          name,
          defaultValue: `Shortcut "Atlas - ${name}" created on desktop.`
        }),
        {
          title: t('shortcut.createdTitle', {
            defaultValue: 'Shortcut Created'
          }),
          kind: 'info'
        }
      )
    } catch (err) {
      console.error('[Layout] Failed to create desktop shortcut:', err)
      try {
        // @ts-ignore
        const { message } = await import('@tauri-apps/plugin-dialog')
        await message(String(err), {
          title: t('shortcut.errorTitle', { defaultValue: 'Error' }),
          kind: 'error'
        })
      } catch {}
    }
  }

  // WhatsApp Webview Global Visibility Sync
  useEffect(() => {
    if (!isTauri) return

    if (location === '/whatsapp') {
      void whatsappManager.show()
    } else {
      void whatsappManager.hide()
    }
  }, [location, isTauri])

  // Locking Enforcement
  useEffect(() => {
    if (isLocked && location !== '/locked-workspace') {
      console.log('[Layout] Workspace is LOCKED. Redirecting to /locked-workspace')
      setLocation('/locked-workspace')
    }
  }, [isLocked, location, setLocation])

  // Listen for currency converter popup event from ExchangeRateIndicator
  useEffect(() => {
    const handler = () => {
      if (location !== '/currency-converter') {
        setCurrencyConverterOpen(true)
      }
    }
    window.addEventListener('open-currency-converter-popup', handler)
    return () => window.removeEventListener('open-currency-converter-popup', handler)
  }, [location])

  // Close popup if user navigates to the currency converter page
  useEffect(() => {
    if (location === '/currency-converter') {
      setCurrencyConverterOpen(false)
    }
  }, [location])

  // Listen for global assistant popup events from the titlebar/topbar.
  useEffect(() => {
    const openHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ initialQuery?: string }>).detail
      setAssistantInitialQuery(detail?.initialQuery)
      setAssistantOpen(true)
    }
    const closeHandler = () => {
      setAssistantInitialQuery(undefined)
      setAssistantOpen(false)
    }
    const toggleHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ initialQuery?: string }>).detail
      setAssistantOpen((current) => {
        const nextOpen = !current
        setAssistantInitialQuery(nextOpen ? detail?.initialQuery : undefined)
        return nextOpen
      })
    }
    window.addEventListener('open-atlas-assistant', openHandler)
    window.addEventListener('close-atlas-assistant', closeHandler)
    window.addEventListener('toggle-atlas-assistant', toggleHandler)
    return () => {
      window.removeEventListener('open-atlas-assistant', openHandler)
      window.removeEventListener('close-atlas-assistant', closeHandler)
      window.removeEventListener('toggle-atlas-assistant', toggleHandler)
    }
  }, [])

  // Demo workspace expiration auto-delete
  useEffect(() => {
    if (demoExpiryRef.current) {
      clearTimeout(demoExpiryRef.current)
      demoExpiryRef.current = null
    }

    if (user?.workspaceCode && isDemoWorkspace(user.workspaceCode) && features.subscription_expires_at) {
      const expiresAt = new Date(features.subscription_expires_at).getTime()
      const now = Date.now()
      const remaining = expiresAt - now

      if (remaining <= 0) {
        console.log('[Demo] Workspace expired, deleting...')
        void signOut({ explicit: false })
      } else {
        console.log(`[Demo] Workspace expires in ${Math.round(remaining / 1000)}s`)
        demoExpiryRef.current = setTimeout(async () => {
          await signOut({ explicit: false })
        }, remaining)
      }
    }

    return () => {
      if (demoExpiryRef.current) {
        clearTimeout(demoExpiryRef.current)
      }
    }
  }, [features.subscription_expires_at, signOut, user?.workspaceCode])

  // Demo countdown timer for sidebar display
  useEffect(() => {
    if (!user?.workspaceCode || !isDemoWorkspace(user.workspaceCode) || !features.subscription_expires_at) {
      setDemoRemainingSec(null)
      return
    }

    const update = () => {
      const remaining = new Date(features.subscription_expires_at!).getTime() - Date.now()
      setDemoRemainingSec(Math.max(0, Math.floor(remaining / 1000)))
    }

    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [user?.workspaceCode, features.subscription_expires_at])

  // Server-side demo expiry poll: periodically check the demos table
  // to enforce the time limit independently of the client clock.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    if (!user?.workspaceCode || !isDemoWorkspace(user.workspaceCode)) return

    const poll = async () => {
      try {
        const { data, error } = await supabase.rpc('check_demo_expired', {
          p_workspace_id: user?.workspaceId
        })
        if (error) {
          console.warn('[Demo] check_demo_expired RPC failed (non-fatal):', error)
          return
        }
        if (data?.expired === true) {
          console.log('[Demo] Server reports demo expired — signing out')
          await signOut({ explicit: false })
        }
      } catch (e) {
        console.warn('[Demo] check_demo_expired threw (non-fatal):', e)
      }
    }

    poll()
    const interval = setInterval(poll, 30_000)
    return () => clearInterval(interval)
  }, [user?.workspaceCode, user?.workspaceId, signOut])

  const navigation = buildWorkspaceNavigation({
    t,
    role: user?.role,
    hasFeature,
    hasPermission,
    features,
    clinicalRegistryType,
    isDesktopDevice: isDesktop(),
    whatsappStatus
  })
  const allVisibleSidebarModules = useMemo(
    () =>
      navigation.flatMap((group) => {
        const sectionKey = group.sectionKey
        if (!sectionKey) return []

        return group.items.map((item) => ({ ...item, sectionKey, sectionTitle: group.title }))
      }),
    [navigation]
  )
  const sidebarFavoriteHrefSet = useMemo(() => new Set(sidebarFavorites.order), [sidebarFavorites.order])
  const sidebarFavoritesGroup = useMemo<SidebarFavoritesGroup | null>(() => {
    const modulesByHref = new Map(allVisibleSidebarModules.map((item) => [item.href, item]))
    const favoriteItems = sidebarFavorites.order.flatMap((href) => {
      const item = modulesByHref.get(href)
      return item ? [{ ...item, children: undefined }] : []
    })

    return favoriteItems.length > 0
      ? { sectionKey: 'favorites', title: t('nav.sidebarFavorites.title'), icon: Star, items: favoriteItems }
      : null
  }, [allVisibleSidebarModules, sidebarFavorites.order, t])
  const sidebarFavoritePlacementGroup = useMemo<SidebarFavoritesGroup>(
    () => sidebarFavoritesGroup ?? { sectionKey: 'favorites', title: t('nav.sidebarFavorites.title'), icon: Star, items: [] },
    [sidebarFavoritesGroup, t]
  )
  const sidebarNavigation = useMemo(() => {
    const standaloneGroups = navigation.filter((group) => !group.sectionKey)
    const groupsBySectionKey = new Map(
      navigation
        .filter((group): group is WorkspaceNavigationGroup & { sectionKey: NavigationSectionKey } => Boolean(group.sectionKey))
        .map((group) => [group.sectionKey, group])
    )

    return [
      ...standaloneGroups,
      ...sidebarSectionOrder.flatMap((sectionKey) => {
        const favoritePlacement = sectionKey === 'sell-and-serve' ? [sidebarFavoritePlacementGroup] : []
        const group = groupsBySectionKey.get(sectionKey)
        if (!group) return favoritePlacement

        const moduleOrder = reconcileSidebarModuleOrder(
          sidebarModuleOrderBySection[sectionKey],
          group.items.map((item) => item.href)
        )
        const moduleOrderIndex = new Map(moduleOrder.map((href, index) => [href, index]))

        const items = [...group.items]
          .filter((item) => !sidebarFavoriteHrefSet.has(item.href))
          .sort(
            (left, right) => (moduleOrderIndex.get(left.href) ?? 0) - (moduleOrderIndex.get(right.href) ?? 0)
          )

        return [
          ...favoritePlacement,
          ...(items.length > 0 ? [{ ...group, items }] : [])
        ]
      })
    ]
  }, [navigation, sidebarFavoriteHrefSet, sidebarFavoritePlacementGroup, sidebarModuleOrderBySection, sidebarSectionOrder])
  const visibleSidebarSectionGroups = sidebarNavigation.filter(
    (group): group is WorkspaceNavigationGroup & { sectionKey: NavigationSectionKey } =>
      Boolean(group.sectionKey) && group.sectionKey !== 'favorites'
  )
  const activeSidebarModuleOrderGroup = useMemo(() => {
    if (!activeSidebarModuleOrderSection) return null
    if (activeSidebarModuleOrderSection === 'favorites') return sidebarFavoritesGroup
    return visibleSidebarSectionGroups.find((group) => group.sectionKey === activeSidebarModuleOrderSection) ?? null
  }, [activeSidebarModuleOrderSection, sidebarFavoritesGroup, visibleSidebarSectionGroups])
  const visibleFavoritePickerGroups = useMemo(() => {
    const query = favoritePickerQuery.trim().toLocaleLowerCase()
    const bySection = new Map<NavigationSectionKey, WorkspaceNavigationItem[]>()

    allVisibleSidebarModules.forEach((item) => {
      if (query && !item.name.toLocaleLowerCase().includes(query)) return
      const items = bySection.get(item.sectionKey) ?? []
      items.push(item)
      bySection.set(item.sectionKey, items)
    })

    return sidebarSectionOrder.flatMap((sectionKey) => {
      const items = bySection.get(sectionKey)
      if (!items?.length) return []
      return [{
        sectionKey,
        title: navigation.find((group) => group.sectionKey === sectionKey)?.title ?? sectionKey,
        items
      }]
    })
  }, [allVisibleSidebarModules, favoritePickerQuery, navigation, sidebarSectionOrder])
  const activeModuleLock = getModuleLockerLockForPath(moduleLockerSnapshot?.locks ?? [], location)
  const isModuleLockerLoading = Boolean(user?.workspaceId && moduleLockerSnapshot === undefined)
  const isModuleLockerEnabled = Boolean(moduleLockerSnapshot?.settings)

  const openModuleLockerDialog = (action: ModuleLockerPasskeyAction, moduleHref: string, moduleName: string) => {
    if (!isModuleLockerEnabled || !moduleLockerActor) return
    setModuleLockerDialog({ action, moduleHref, moduleName })
  }

  const sidebarCashierShift = useMemo<SidebarCashierShift | null>(() => {
    if (!canUseCashierShiftQuickStart || !user?.id) return null

    const myAssignments = cashierShiftAssignments.filter(
      (assignment) => !assignment.isDeleted && assignment.isActive && assignment.cashierUserId === user.id
    )
    const myOccurrences = cashierShiftOccurrences.filter(
      (occurrence) => !occurrence.isDeleted && occurrence.cashierUserId === user.id
    )
    const activeOccurrence = myOccurrences.find(
      (occurrence) => occurrence.status === 'active' || occurrence.status === 'paused'
    )
    if (activeOccurrence) {
      const activeAssignment = cashierShiftAssignments.find(
        (assignment) => assignment.id === activeOccurrence.assignmentId
      )
      if (!activeAssignment) return null
      return {
        assignment: activeAssignment,
        occurrence: activeOccurrence,
        scheduledStartAt: activeOccurrence.scheduledStartAt ?? activeOccurrence.startedAt,
        scheduledEndAt: activeOccurrence.scheduledEndAt ?? activeOccurrence.startedAt,
        status: 'active'
      }
    }
    const occurrencesBySchedule = new Map(
      myOccurrences.map((occurrence) => [`${occurrence.assignmentId}:${occurrence.scheduledStartAt}`, occurrence])
    )
    const today = startOfLocalDay(cashierShiftNow)
    const candidateDates = [today, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)]
    const candidates: SidebarCashierShift[] = []

    for (const assignment of myAssignments) {
      const assignmentMode = assignment.assignmentMode ?? 'scheduled'
      if (assignmentMode === 'login_logout') continue
      if (assignmentMode === 'manual') {
        if (!isCashierShiftWorkingDay(assignment, today)) continue
        candidates.push({
          assignment,
          scheduledStartAt: cashierShiftNow.toISOString(),
          scheduledEndAt: cashierShiftNow.toISOString(),
          status: 'available'
        })
        continue
      }
      for (const date of candidateDates) {
        if (!isCashierShiftWorkingDay(assignment, date)) continue
        const bounds = getCashierShiftOccurrenceBounds(assignment, date)
        if (!bounds || cashierShiftNow < bounds.start || cashierShiftNow >= bounds.end) continue

        const occurrence = occurrencesBySchedule.get(`${assignment.id}:${bounds.start.toISOString()}`)
        candidates.push({
          assignment,
          scheduledStartAt: bounds.start.toISOString(),
          scheduledEndAt: bounds.end.toISOString(),
          occurrence,
          status: occurrence?.status === 'active' || occurrence?.status === 'paused' ? 'active' : 'available'
        })
      }
    }

    return (
      candidates.sort(
        (left, right) =>
          Number(right.status === 'active') - Number(left.status === 'active') ||
          new Date(left.scheduledEndAt).getTime() - new Date(right.scheduledEndAt).getTime()
      )[0] ?? null
    )
  }, [canUseCashierShiftQuickStart, cashierShiftAssignments, cashierShiftNow, cashierShiftOccurrences, user?.id])

  const sidebarHasReadyCashierShift = useMemo(() => {
    if (!canUseCashierShiftQuickStart || !user?.id) return false

    const hasActiveOccurrence = cashierShiftOccurrences.some(
      (occurrence) =>
        !occurrence.isDeleted &&
        occurrence.cashierUserId === user.id &&
        (occurrence.status === 'active' || occurrence.status === 'paused')
    )
    if (hasActiveOccurrence) return false

    const hasReadyScheduledOrManualShift = getCashierShiftListRows({
      assignments: cashierShiftAssignments,
      occurrences: cashierShiftOccurrences,
      cashierUserId: user.id,
      now: cashierShiftNow
    }).some((row) => row.status === 'available')
    if (hasReadyScheduledOrManualShift) return true

    return cashierShiftAssignments.some((assignment) => {
      if (
        assignment.isDeleted ||
        !assignment.isActive ||
        assignment.cashierUserId !== user.id ||
        assignment.assignmentMode !== 'login_logout'
      ) {
        return false
      }

      return !cashierShiftOccurrences.some(
        (occurrence) =>
          !occurrence.isDeleted &&
          occurrence.cashierUserId === user.id &&
          occurrence.assignmentMode === 'login_logout' &&
          occurrence.status === 'completed' &&
          occurrence.syncStatus !== 'synced'
      )
    })
  }, [canUseCashierShiftQuickStart, cashierShiftAssignments, cashierShiftNow, cashierShiftOccurrences, user?.id])

  const startSidebarCashierShift = async () => {
    if (!user?.workspaceId || !user.id || !sidebarCashierShift || sidebarCashierShift.status !== 'available') return

    setStartingCashierShift(true)
    try {
      await startCashierShiftOccurrence(user.workspaceId, {
        assignmentId: sidebarCashierShift.assignment.id,
        cashierUserId: user.id,
        scheduledStartAt:
          sidebarCashierShift.assignment.assignmentMode === 'manual' ? undefined : sidebarCashierShift.scheduledStartAt,
        source: sidebarCashierShift.assignment.assignmentMode === 'manual' ? 'manual' : 'scheduled'
      })
      toast({ title: t('paymentAccounts.shiftStarted') })
      setCashierShiftStartDialogOpen(false)
    } catch {
      toast({
        title: t('common.error'),
        description: t('paymentAccounts.startShiftFailed'),
        variant: 'destructive'
      })
    } finally {
      setStartingCashierShift(false)
    }
  }

  const sidebarCompletionEligibility =
    sidebarCashierShift?.status === 'active' &&
    sidebarCashierShift.occurrence &&
    sidebarCashierShift.occurrence.assignmentMode !== 'login_logout'
      ? getCashierShiftCompletionEligibility(sidebarCashierShift.occurrence, cashierShiftNow)
      : null
  const sidebarCanRequestEarlyFinish = Boolean(
    sidebarCashierShift?.status === 'active' &&
    sidebarCashierShift.occurrence?.assignmentMode === 'scheduled' &&
    sidebarCashierShift.occurrence?.earlyFinishPolicy === 'request_approval' &&
    sidebarCashierShift.occurrence.earlyFinishRequestStatus === 'not_requested' &&
    Boolean(sidebarCashierShift.occurrence?.scheduledEndAt) &&
    cashierShiftNow < new Date(sidebarCashierShift.scheduledEndAt)
  )
  const sidebarActiveShiftActionLabel = sidebarCompletionEligibility?.canComplete
    ? t('paymentAccounts.completeShift')
    : sidebarCanRequestEarlyFinish
      ? t('paymentAccounts.requestEarlyFinish')
      : t('paymentAccounts.viewShiftDetails')
  const sidebarAvatarShiftBadge: 'ready' | 'complete' | null = sidebarHasReadyCashierShift
    ? 'ready'
    : sidebarCompletionEligibility?.canComplete
      ? 'complete'
      : null
  const sidebarManualShiftActiveDuration =
    sidebarAvatarShiftBadge === 'complete' &&
    sidebarCashierShift?.status === 'active' &&
    sidebarCashierShift.occurrence?.assignmentMode === 'manual'
      ? formatSidebarShiftCountdown(
          cashierShiftNow.getTime() - new Date(sidebarCashierShift.occurrence.startedAt).getTime()
        )
      : null
  const sidebarCompletionFinancialSummaries = useMemo(
    () =>
      sidebarCashierShift?.occurrence
        ? summarizeCashierShiftTransactions(cashierShiftPaymentTransactions, sidebarCashierShift.occurrence.id)
        : [],
    [cashierShiftPaymentTransactions, sidebarCashierShift?.occurrence]
  )

  const openSidebarActiveShiftAction = () => {
    if (!sidebarCashierShift?.occurrence) return
    if (sidebarCompletionEligibility?.canComplete) {
      setCashierShiftCompletionReason('')
      setCashierShiftCompleteDialogOpen(true)
      return
    }
    if (sidebarCanRequestEarlyFinish) {
      setCashierShiftEarlyFinishReason('')
      setCashierShiftEarlyFinishRequestDialogOpen(true)
      return
    }
    setLocation(`/payment-accounts/cashier-shifts/${sidebarCashierShift.occurrence.id}`)
  }

  const completeSidebarCashierShift = async () => {
    if (!user?.workspaceId || !user.id || !sidebarCashierShift?.occurrence) return
    setCompletingCashierShift(true)
    try {
      await completeCashierShiftOccurrence(user.workspaceId, {
        occurrenceId: sidebarCashierShift.occurrence.id,
        cashierUserId: user.id,
        reason: cashierShiftCompletionReason
      })
      toast({ title: t('paymentAccounts.shiftCompleted') })
      setCashierShiftCompleteDialogOpen(false)
    } catch {
      toast({
        title: t('common.error'),
        description: t('paymentAccounts.completeShiftFailed'),
        variant: 'destructive'
      })
    } finally {
      setCompletingCashierShift(false)
    }
  }

  const requestSidebarCashierShiftEarlyFinish = async () => {
    if (!user?.workspaceId || !user.id || !sidebarCashierShift?.occurrence) return
    setRequestingCashierShiftEarlyFinish(true)
    try {
      await requestCashierShiftEarlyFinish(user.workspaceId, {
        occurrenceId: sidebarCashierShift.occurrence.id,
        cashierUserId: user.id,
        reason: cashierShiftEarlyFinishReason
      })
      toast({ title: t('paymentAccounts.earlyFinishRequestSubmitted') })
      setCashierShiftEarlyFinishRequestDialogOpen(false)
    } catch {
      toast({
        title: t('common.error'),
        description: t('paymentAccounts.earlyFinishRequestFailed'),
        variant: 'destructive'
      })
    } finally {
      setRequestingCashierShiftEarlyFinish(false)
    }
  }

  const sidebarShiftCountdown =
    sidebarCashierShift &&
    sidebarCashierShift.occurrence?.assignmentMode === 'scheduled' &&
    sidebarAvatarShiftBadge !== 'complete' &&
    cashierShiftNow < new Date(sidebarCashierShift.scheduledEndAt)
      ? formatSidebarShiftCountdown(new Date(sidebarCashierShift.scheduledEndAt).getTime() - cashierShiftNow.getTime())
      : null
  const sidebarShiftEndsInLabel = sidebarShiftCountdown
    ? t('paymentAccounts.shiftEndsIn', { time: sidebarShiftCountdown })
    : ''
  const formatSidebarShiftDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value))
  const formatSidebarShiftStartedDateTime = (value: string) => {
    const date = new Date(value)
    return t('paymentAccounts.shiftStartedDateTime', {
      weekday: new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(date),
      date: `${String(date.getFullYear()).slice(-2)}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(
        date.getDate()
      ).padStart(2, '0')}`,
      time: new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date)
    })
  }

  const today = new Date().toISOString().slice(0, 10)
  const reorderAutomationCount = reorderRules.filter(
    (rule) => rule.isIndefinite || !rule.expiresOn || rule.expiresOn >= today
  ).length
  const reorderAutomationCountLabel = reorderAutomationCount > 99 ? '99+' : reorderAutomationCount
  const inventoryTransferAutomationLabel = t('inventoryTransfer.tabs.automation', 'Reorder Automation')

  const ecommerceCountLabel = pendingEcommerceCount > 99 ? '99+' : pendingEcommerceCount
  const ecommercePendingLabel = t('ecommerce.pendingOrders', {
    defaultValue: 'Pending Orders'
  })

  const openSidebarCustomization = () => {
    setDesktopSidebarOpen(true)
    setIsSidebarCustomizationMode(true)
    triggerHaptic('medium')
  }

  const openSidebarFavoritesDialog = () => {
    openSidebarCustomization()
    setFavoritePickerOrder([...sidebarFavorites.order])
    setFavoritePickerQuery('')
    setIsSidebarFavoritesDialogOpen(true)
  }

  const openSidebarModuleOrder = (sectionKey: SidebarModuleOrderSection) => {
    setActiveSidebarModuleOrderSection(sectionKey)
    triggerHaptic('selection')
  }

  const saveSidebarFavorites = (nextFavorites: SidebarFavorites, savedMessage?: string) => {
    setSidebarFavorites(nextFavorites)

    if (typeof window === 'undefined' || !sidebarFavoritesStorageKey) return true

    try {
      localStorage.setItem(sidebarFavoritesStorageKey, createSidebarFavoritesStorageValue(nextFavorites))
      if (savedMessage) toast({ description: savedMessage })
      return true
    } catch {
      toast({
        title: t('common.error'),
        description: t('nav.sidebarCustomization.saveError'),
        variant: 'destructive'
      })
      return false
    }
  }

  const toggleSidebarFavorite = (item: WorkspaceNavigationItem) => {
    const isFavorite = sidebarFavorites.order.includes(item.href)
    const nextFavorites = isFavorite
      ? removeSidebarFavorite(sidebarFavorites, item.href)
      : addSidebarFavorite(sidebarFavorites, item.href)
    if (saveSidebarFavorites(nextFavorites, t(isFavorite ? 'nav.sidebarFavorites.removed' : 'nav.sidebarFavorites.added', { tab: item.name }))) {
      triggerHaptic('selection')
    }
  }

  const saveFavoritePicker = () => {
    const selectedHrefSet = new Set(favoritePickerOrder)
    const visibleHrefSet = new Set(allVisibleSidebarModules.map((item) => item.href))
    let nextFavorites = sidebarFavorites

    sidebarFavorites.order.forEach((href) => {
      if (visibleHrefSet.has(href) && !selectedHrefSet.has(href)) {
        nextFavorites = removeSidebarFavorite(nextFavorites, href)
      }
    })
    favoritePickerOrder.forEach((href) => {
      if (visibleHrefSet.has(href) && !nextFavorites.order.includes(href)) {
        nextFavorites = addSidebarFavorite(nextFavorites, href)
      }
    })

    if (saveSidebarFavorites(nextFavorites, t('nav.sidebarFavorites.saved'))) {
      setIsSidebarFavoritesDialogOpen(false)
      triggerHaptic('success')
    }
  }

  const saveSidebarSectionOrder = (nextOrder: NavigationSectionKey[], savedMessage: string) => {
    setSidebarSectionOrder(nextOrder)

    if (typeof window === 'undefined' || !sidebarSectionOrderStorageKey) return

    try {
      localStorage.setItem(sidebarSectionOrderStorageKey, createSidebarSectionOrderStorageValue(nextOrder))
      toast({ description: savedMessage })
    } catch {
      toast({
        title: t('common.error'),
        description: t('nav.sidebarCustomization.saveError'),
        variant: 'destructive'
      })
    }
  }

  const handleSidebarSectionDragEnd = ({ source, destination }: DropResult) => {
    if (!destination) return

    const nextOrder = reorderVisibleSidebarSections(
      sidebarSectionOrder,
      visibleSidebarSectionGroups.map((group) => group.sectionKey),
      source.index,
      destination.index
    )

    if (nextOrder.every((key, index) => key === sidebarSectionOrder[index])) return

    saveSidebarSectionOrder(nextOrder, t('nav.sidebarCustomization.orderSaved'))
    triggerHaptic('selection')
  }

  const saveSidebarModuleOrder = (
    sectionKey: NavigationSectionKey,
    nextOrder: string[],
    savedMessage: string
  ) => {
    const nextModuleOrderBySection = {
      ...sidebarModuleOrderBySection,
      [sectionKey]: nextOrder
    }
    setSidebarModuleOrderBySection(nextModuleOrderBySection)

    if (typeof window === 'undefined' || !sidebarModuleOrderStorageKey) return

    try {
      localStorage.setItem(
        sidebarModuleOrderStorageKey,
        createSidebarModuleOrderStorageValue(nextModuleOrderBySection)
      )
      toast({ description: savedMessage })
    } catch {
      toast({
        title: t('common.error'),
        description: t('nav.sidebarCustomization.saveError'),
        variant: 'destructive'
      })
    }
  }

  const handleSidebarModuleDragEnd = ({ source, destination }: DropResult) => {
    if (!destination || !activeSidebarModuleOrderGroup) return

    const sectionKey = activeSidebarModuleOrderGroup.sectionKey
    const visibleModuleHrefs = activeSidebarModuleOrderGroup.items.map((item) => item.href)
    if (sectionKey === 'favorites') {
      const nextFavorites = reorderVisibleSidebarFavorites(
        sidebarFavorites,
        visibleModuleHrefs,
        source.index,
        destination.index
      )
      if (nextFavorites.order.every((href, index) => href === sidebarFavorites.order[index])) return
      if (saveSidebarFavorites(nextFavorites, t('nav.sidebarCustomization.tabsOrderSaved'))) {
        triggerHaptic('selection')
      }
      return
    }
    const nextOrder = reorderVisibleSidebarModuleItems(
      sidebarModuleOrderBySection[sectionKey],
      visibleModuleHrefs,
      source.index,
      destination.index
    )

    if (
      nextOrder.length === (sidebarModuleOrderBySection[sectionKey]?.length ?? 0) &&
      nextOrder.every((href, index) => href === sidebarModuleOrderBySection[sectionKey]?.[index])
    ) {
      return
    }

    saveSidebarModuleOrder(sectionKey, nextOrder, t('nav.sidebarCustomization.tabsOrderSaved'))
    triggerHaptic('selection')
  }

  const resetSidebarModuleOrder = (sectionKey: SidebarModuleOrderSection) => {
    if (sectionKey === 'favorites') {
      if (saveSidebarFavorites(resetSidebarFavoritesOrder(sidebarFavorites))) {
        setSidebarModuleOrderResetSection(null)
        toast({ description: t('nav.sidebarCustomization.tabsOrderReset') })
        triggerHaptic('selection')
      }
      return
    }
    const nextModuleOrderBySection = { ...sidebarModuleOrderBySection }
    delete nextModuleOrderBySection[sectionKey]

    if (typeof window !== 'undefined' && sidebarModuleOrderStorageKey) {
      try {
        localStorage.setItem(
          sidebarModuleOrderStorageKey,
          createSidebarModuleOrderStorageValue(nextModuleOrderBySection)
        )
      } catch {
        toast({
          title: t('common.error'),
          description: t('nav.sidebarCustomization.saveError'),
          variant: 'destructive'
        })
        return
      }
    }

    setSidebarModuleOrderBySection(nextModuleOrderBySection)
    setSidebarModuleOrderResetSection(null)
    toast({ description: t('nav.sidebarCustomization.tabsOrderReset') })
    triggerHaptic('selection')
  }

  const resetSidebarSectionOrder = () => {
    if (typeof window !== 'undefined') {
      try {
        if (sidebarSectionOrderStorageKey) {
          localStorage.removeItem(sidebarSectionOrderStorageKey)
        }
        if (sidebarModuleOrderStorageKey) {
          localStorage.removeItem(sidebarModuleOrderStorageKey)
        }
        if (sidebarFavoritesStorageKey) {
          localStorage.removeItem(sidebarFavoritesStorageKey)
        }
      } catch {
        toast({
          title: t('common.error'),
          description: t('nav.sidebarCustomization.saveError'),
          variant: 'destructive'
        })
        return
      }
    }

    setSidebarSectionOrder([...launcherSectionOrder])
    setSidebarModuleOrderBySection({})
    setSidebarFavorites({ order: [], firstAddedOrder: [] })
    setIsSidebarResetDialogOpen(false)
    setActiveSidebarModuleOrderSection(null)
    setSidebarModuleOrderResetSection(null)
    setIsSidebarFavoritesDialogOpen(false)
    toast({ description: t('nav.sidebarCustomization.orderReset') })
    triggerHaptic('selection')
  }

  const isPosLikeRoute = location === '/pos' || location === '/instant-pos' || location === '/real-estate/new'
  // Android and iPad PWAs may expose a desktop-sized CSS width on a tablet.
  // Keep the actual sidebar in its compact rail whenever that happens.
  const isPosTabletLayout = isPosLikeRoute && viewportWidth >= 1024 && (viewportWidth < 1366 || isMobile())
  const isSidebarMini = !isSidebarCustomizationMode && (isMini || isPosTabletLayout)
  const showCompactWorkspaceHeader = isSidebarHeaderCompact && !isSidebarMini && !mobileSidebarOpen
  const isModuleLauncherRoute = location === '/modules'

  const openInventoryTransferAutomationTab = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()

    const isInventoryTransferRoute = location === '/inventory-transfer' || location.startsWith('/inventory-transfer')

    if (typeof window !== 'undefined') {
      if (isInventoryTransferRoute) {
        window.sessionStorage.removeItem('inventory-transfer.pending-tab')
        window.dispatchEvent(
          new CustomEvent('inventory-transfer:open-tab', {
            detail: { tab: 'automation' }
          })
        )
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
          {features.allowed_currencies.length > 1 && <ManualRateModals />}
          {features.allowed_currencies.length > 1 && <GlobalExchangeRateReminders />}
          {/* Mobile sidebar backdrop */}
          {mobileSidebarOpen && (
            <div
              className={cn('fixed inset-0 z-40 bg-black/50 lg:hidden', isTauri && 'top-[var(--titlebar-height)]')}
              onClick={() => setMobileSidebarOpen(false)}
            />
          )}

          {/* Sidebar */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
          <aside
            className={cn(
              'fixed z-50 transition-all duration-300 ease-in-out flex flex-col',
              mobileSidebarOpen ? 'bg-card border-r border-border/50' : 'glass',
              'sidebar-gradient shadow-2xl',
              isTauri ? 'top-[var(--titlebar-height)] h-[calc(100vh-var(--titlebar-height))]' : 'inset-y-0 h-full',
              'pt-[var(--safe-area-top)] pb-[var(--safe-area-bottom)]',
              // Desktop state - Width changes based on the effective
              // compact layout (including landscape POS tablets).
              isSidebarMini
                ? desktopSidebarOpen
                  ? 'w-[70px] lg:translate-x-0 lg:rtl:translate-x-0'
                  : 'lg:-translate-x-full lg:rtl:translate-x-full w-[70px]'
                : desktopSidebarOpen
                  ? isSidebarCustomizationMode
                    ? 'w-80 lg:translate-x-0 lg:rtl:translate-x-0'
                    : 'w-64 lg:translate-x-0 lg:rtl:translate-x-0'
                  : isSidebarCustomizationMode
                    ? 'lg:-translate-x-full lg:rtl:translate-x-full w-80'
                    : 'lg:-translate-x-full lg:rtl:translate-x-full w-64',

              // Positioning
              'left-0 rtl:left-auto rtl:right-0',
              'border-r rtl:border-r-0 rtl:border-l border-border',
              // Mobile state
              mobileSidebarOpen
                ? isSidebarCustomizationMode
                  ? 'translate-x-0 w-80'
                  : 'translate-x-0 w-64'
                : '-translate-x-full rtl:translate-x-full'
            )}
          >
            {/* Logo */}
            <div
              className={cn(
                'relative z-10 mx-3 mt-3 flex shrink-0 items-center gap-3 overflow-hidden rounded-2xl border border-border/70 bg-card/85 px-5 py-4 shadow-sm backdrop-blur-md transition-[padding,gap] duration-300 ease-out',
                isSidebarMini && !mobileSidebarOpen ? 'mx-2 mt-2 flex-col justify-center gap-2 px-2 py-3' : '',
                showCompactWorkspaceHeader && 'gap-2.5 py-2.5'
              )}
            >
              {features.logo_url ? (
                <img
                  src={
                    features.logo_url.startsWith('http')
                      ? features.logo_url
                      : platformService.convertFileSrc(features.logo_url)
                  }
                  alt="Workspace Logo"
                  className={cn(
                    'h-10 w-10 rounded-sm object-contain transition-[width,height] duration-300 ease-out',
                    showCompactWorkspaceHeader && 'h-8 w-8'
                  )}
                  onError={() => setLogoError(true)}
                />
              ) : !logoError ? (
                <ThemeAwareLogo
                  className={cn(
                    'h-10 w-10 object-contain transition-[width,height] duration-300 ease-out',
                    showCompactWorkspaceHeader && 'h-8 w-8'
                  )}
                />
              ) : (
                <Boxes
                  className={cn(
                    'h-8 w-8 text-primary transition-[width,height] duration-300 ease-out',
                    showCompactWorkspaceHeader && 'h-7 w-7'
                  )}
                />
              )}

              {!(isSidebarMini && !mobileSidebarOpen) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 flex-1 items-center rounded-md px-2 py-1 text-start transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
                        showCompactWorkspaceHeader ? 'gap-0' : 'gap-2'
                      )}
                      title={t('branches.openSwitcher', {
                        defaultValue: 'Open workspace switcher'
                      })}
                    >
                      <div className="min-w-0 flex-1">
                        <h1 className="max-w-[10ch] truncate text-lg font-bold gradient-text" title={fullWorkspaceLabel}>
                          {sidebarWorkspaceLabel}
                        </h1>
                      </div>
                      <ChevronDown
                        className={cn(
                          'h-4 shrink-0 overflow-hidden text-muted-foreground transition-[width,opacity,transform] duration-300 ease-out',
                          showCompactWorkspaceHeader ? 'w-0 -translate-x-1 opacity-0' : 'w-4 translate-x-0 opacity-100'
                        )}
                        aria-hidden={showCompactWorkspaceHeader}
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-[280px] rounded-xl border-border/70 bg-background/95 p-2 backdrop-blur-xl"
                  >
                    <DropdownMenuLabel className="pb-2">
                      <div className="space-y-1">
                        <p>
                          {t('branches.switchWorkspace', {
                            defaultValue: 'Switch Workspace'
                          })}
                        </p>
                        {branchInfo?.isBranch && branchInfo.sourceWorkspaceName && (
                          <p className="truncate text-xs font-normal text-muted-foreground">
                            {`${currentWorkspaceLabel} \u2190 ${branchInfo.sourceWorkspaceName}`}
                          </p>
                        )}
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="gap-3 rounded-lg px-3 py-2 data-[disabled]:opacity-100">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Check className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">
                          {currentWorkspaceLabel || workspaceName || 'Atlas'}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {branchInfo?.isBranch
                            ? t('branches.onBranch', {
                                defaultValue: 'You are on branch'
                              })
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
                                {branchInfo.sourceWorkspaceName ||
                                  t('branches.returnToSource', {
                                    defaultValue: 'Return to Source'
                                  })}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {t('branches.returnToSource', {
                                  defaultValue: 'Return to Source'
                                })}
                              </p>
                            </div>
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled
                            className="rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100"
                          >
                            {t('branches.noOtherWorkspaces', {
                              defaultValue: 'No other workspaces available.'
                            })}
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
                                {t('common.loading', {
                                  defaultValue: 'Loading...'
                                })}
                              </span>
                            </DropdownMenuItem>
                          ) : branches.length === 0 ? (
                            <DropdownMenuItem
                              disabled
                              className="rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100"
                            >
                              {t('branches.noBranches', {
                                defaultValue: 'No branches yet'
                              })}
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

              <button className="ms-auto lg:hidden" onClick={() => setMobileSidebarOpen(false)}>
                <X className="w-5 h-5" />
              </button>

              <button
                onClick={() => {
                  toggleMini()
                  triggerHaptic('light')
                }}
                disabled={isPosTabletLayout}
                className={cn(
                  'hidden lg:flex items-center justify-center w-6 h-6 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-all',
                  isSidebarMini ? 'mt-2 rotate-180' : 'ms-auto'
                )}
                title={
                  isPosTabletLayout
                    ? 'Sidebar is compact on tablets'
                    : isSidebarMini
                      ? 'Expand Sidebar'
                      : 'Collapse Sidebar'
                }
              >
                <PanelRightOpen className="w-4 h-4 rtl:hidden" />
                <PanelRightClose className="w-4 h-4 hidden rtl:block" />
              </button>
            </div>

            {/* Navigation */}
            <nav
              className="flex-1 space-y-6 overflow-y-auto px-2 py-4 antialiased custom-scrollbar"
              onScroll={(event) => {
                const shouldCompact = event.currentTarget.scrollTop > 12
                setIsSidebarHeaderCompact((isCompact) => (isCompact === shouldCompact ? isCompact : shouldCompact))
              }}
            >
              {isSidebarCustomizationMode ? (
                  <div className="space-y-4 px-2 py-1">
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 shadow-sm">
                      <div className="flex items-start gap-2">
                        <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <div className="min-w-0">
                          <h2 className="text-sm font-semibold text-foreground">
                            {t('nav.sidebarCustomization.title')}
                          </h2>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {t('nav.sidebarCustomization.description')}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => setIsSidebarCustomizationMode(false)}
                          className="gap-2"
                        >
                          <Check className="h-4 w-4" />
                          {t('nav.sidebarCustomization.done')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setIsSidebarResetDialogOpen(true)}
                          className="gap-2"
                        >
                          <RotateCcw className="h-4 w-4" />
                          {t('nav.sidebarCustomization.resetOrder')}
                        </Button>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 rounded-xl border border-amber-400/35 bg-amber-500/5 px-3 py-3 shadow-sm">
                      <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{t('nav.sidebarFavorites.title')}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {sidebarFavoritesGroup
                            ? t('nav.sidebarFavorites.customizationDescription')
                            : t('nav.sidebarFavorites.emptyCustomizationDescription')}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 w-9 shrink-0 border-amber-400/50 p-0 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700"
                        onClick={openSidebarFavoritesDialog}
                        aria-label={t('nav.sidebarFavorites.manage')}
                        title={t('nav.sidebarFavorites.manage')}
                      >
                        <Star className="h-4 w-4 fill-current" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 w-9 shrink-0 p-0"
                        onClick={() => openSidebarModuleOrder('favorites')}
                        disabled={!sidebarFavoritesGroup || sidebarFavoritesGroup.items.length < 2}
                        aria-label={t('nav.sidebarCustomization.reorderTabs')}
                        title={
                          !sidebarFavoritesGroup || sidebarFavoritesGroup.items.length < 2
                            ? t('nav.sidebarCustomization.notEnoughTabs')
                            : t('nav.sidebarCustomization.reorderTabs')
                        }
                      >
                        <ListOrdered className="h-4 w-4" />
                      </Button>
                    </div>

                    <DragDropContext onDragEnd={handleSidebarSectionDragEnd}>
                      <Droppable droppableId="sidebar-section-groups" direction="vertical">
                        {(provided) => (
                          <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                            {visibleSidebarSectionGroups.map((group, index) => {
                              const canReorderTabs = group.items.length >= 2

                              return (
                                <Draggable key={group.sectionKey} draggableId={group.sectionKey} index={index}>
                                  {(draggableProvided, snapshot) => (
                                    <div
                                      ref={draggableProvided.innerRef}
                                      {...draggableProvided.draggableProps}
                                      className={cn(
                                        'flex items-center gap-3 rounded-xl border bg-card px-3 py-3 shadow-sm transition-shadow',
                                        snapshot.isDragging
                                          ? 'border-primary/50 shadow-lg ring-2 ring-primary/20'
                                          : 'border-border/70'
                                      )}
                                    >
                                      <button
                                        type="button"
                                        {...draggableProvided.dragHandleProps}
                                        aria-label={t('nav.sidebarCustomization.moveSection', { section: group.title })}
                                        className="flex h-9 w-9 shrink-0 touch-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                      >
                                        <GripVertical className="h-5 w-5" />
                                      </button>
                                      <group.icon className="h-4 w-4 shrink-0 text-primary" />
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-semibold text-foreground">{group.title}</p>
                                        {!canReorderTabs && (
                                          <p className="mt-0.5 text-xs text-muted-foreground">
                                            {t('nav.sidebarCustomization.notEnoughTabs')}
                                          </p>
                                        )}
                                      </div>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-9 w-9 shrink-0 p-0"
                                        onClick={() => openSidebarModuleOrder(group.sectionKey)}
                                        disabled={!canReorderTabs}
                                        aria-label={t('nav.sidebarCustomization.reorderTabs')}
                                        title={
                                          !canReorderTabs
                                            ? t('nav.sidebarCustomization.notEnoughTabs')
                                            : t('nav.sidebarCustomization.reorderTabs')
                                        }
                                      >
                                        <ListOrdered className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  )}
                                </Draggable>
                              )
                            })}
                            {provided.placeholder}
                          </div>
                        )}
                      </Droppable>
                    </DragDropContext>
                  </div>
              ) : (
                <>
              {sidebarNavigation.map((group) =>
                group.sectionKey === 'favorites' && group.items.length === 0 ? (
                  <Button
                    key="sidebar-favorites-add"
                    type="button"
                    variant="ghost"
                    onClick={openSidebarFavoritesDialog}
                    className={cn(
                      'mb-3 flex h-8 w-full items-center justify-start gap-2 rounded-lg border border-dashed border-amber-400/50 bg-amber-500/5 px-3 text-start text-xs font-medium text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200',
                      isSidebarMini && !mobileSidebarOpen && 'mx-auto h-8 w-8 justify-center px-0'
                    )}
                    aria-label={t('nav.sidebarFavorites.add')}
                    title={t('nav.sidebarFavorites.add')}
                  >
                    <Star className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    {!(isSidebarMini && !mobileSidebarOpen) && (
                      <span>{t('nav.sidebarFavorites.add')}</span>
                    )}
                  </Button>
                ) : (
                <div key={group.title} className="space-y-1">
                  {!(isSidebarMini && !mobileSidebarOpen) && group.title && (
                    <div className="flex items-center gap-2 px-3 mb-4">
                      <group.icon className="w-3.5 h-3.5 text-muted-foreground/40" />
                      <h2 className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em]">
                        {group.title}
                      </h2>
                    </div>
                  )}
                  {isSidebarMini && !mobileSidebarOpen && <div className="h-px bg-border/40 mx-2 mb-4" />}

                  <div className="space-y-1">
                    {group.items.map((item) => {
                      const canFavoriteSidebarItem = Boolean(group.sectionKey)
                      const isExpandableGroup = Boolean(item.children?.length)
                      const showReorderAutomationBadge =
                        item.href === '/inventory-transfer' && reorderAutomationCount > 0
                      const showEcommerceBadge = item.href === '/ecommerce' && pendingEcommerceCount > 0
                      const isChildActive = isExpandableGroup
                        ? item.children!.some(
                            (child) =>
                              location === child.href || (child.href !== '/' && location.startsWith(child.href))
                          )
                        : false
                      const isActive =
                        location === item.href || (item.href !== '/' && location.startsWith(item.href)) || isChildActive
                      const isOpen = isExpandableGroup ? Boolean(expandedNavGroups[item.href]) || isChildActive : false
                      const showChildren = isExpandableGroup && isOpen && !(isSidebarMini && !mobileSidebarOpen)
                      const isModuleLockerTarget = Boolean(
                        isModuleLockerEnabled && !item.popup && isModuleLockerLockableHref(item.href)
                      )
                      const isModuleLocked = isModuleLockerTarget && moduleLockerSnapshot?.locks.some(
                        (lock) => lock.moduleHref === item.href
                      )
                      const parentContent = (
                        <span
                          className={cn(
                            'relative flex items-center gap-3 px-3 py-2 rounded-sm text-[13px] font-semibold transition-all duration-300 ease-in-out border-s-[3px] border-transparent',
                            isActive
                              ? 'bg-primary/10 text-primary border-primary'
                              : 'text-muted-foreground hover:bg-primary/5 hover:text-primary hover:border-primary/30',
                            isSidebarMini && !mobileSidebarOpen && 'justify-center px-0 py-3 border-s-0'
                          )}
                          title={isSidebarMini && !mobileSidebarOpen ? item.name : undefined}
                        >
                          <item.icon className="w-5 h-5 flex-shrink-0" />
                          {!(isSidebarMini && !mobileSidebarOpen) && (
                            <>
                              {item.name}
                              {isModuleLocked && <LockKeyhole className="ms-auto h-3.5 w-3.5 shrink-0 text-primary" />}
                              {isExpandableGroup && (
                                <ChevronDown
                                  className={cn(
                                    isModuleLocked ? 'w-4 h-4 transition-transform' : 'ms-auto w-4 h-4 transition-transform',
                                    isOpen && 'rotate-180'
                                  )}
                                />
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
                                    'ms-auto relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:focus-visible:ring-sky-200/80',
                                    isActive
                                      ? 'bg-sky-950/20 text-white ring-1 ring-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_24px_rgba(8,47,73,0.22)] backdrop-blur-md'
                                      : 'bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/20 shadow-[0_10px_24px_rgba(14,165,233,0.12)] dark:bg-sky-400/14 dark:text-sky-200 dark:ring-sky-300/18 dark:shadow-[0_10px_24px_rgba(14,165,233,0.16)]'
                                  )}
                                >
                                  <Bot className="h-4 w-4" />
                                  <span
                                    className={cn(
                                      'absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-none shadow-sm backdrop-blur-sm',
                                      isActive
                                        ? 'border-white/15 bg-sky-950/85 text-white'
                                        : 'border-white/80 bg-sky-600 text-white dark:border-sky-100/70 dark:bg-sky-300 dark:text-slate-950'
                                    )}
                                  >
                                    {reorderAutomationCountLabel}
                                  </span>
                                </span>
                              )}
                              {!isExpandableGroup && showEcommerceBadge && (
                                <span
                                  title={ecommercePendingLabel}
                                  className={cn(
                                    'ms-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold shadow-sm transition-all',
                                    isActive
                                      ? 'bg-amber-400 text-amber-950 ring-1 ring-amber-400/20 shadow-[0_2px_8px_rgba(251,191,36,0.3)]'
                                      : 'bg-amber-500 text-white shadow-[0_2px_8px_rgba(245,158,11,0.25)] dark:bg-amber-500/20 dark:text-amber-400 dark:shadow-none'
                                  )}
                                >
                                  {ecommerceCountLabel}
                                </span>
                              )}
                              {!isExpandableGroup && item.alert && (
                                <div className="ms-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white">
                                  <AlertCircle className="w-3.5 h-3.5" />
                                </div>
                              )}
                              {!isExpandableGroup && item.status && (
                                <div
                                  className={cn(
                                    'ms-auto w-2 h-2 rounded-full',
                                    item.status === 'live'
                                      ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                                      : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
                                  )}
                                />
                              )}
                            </>
                          )}
                          {isSidebarMini && !mobileSidebarOpen && item.alert && (
                            <div className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border border-background shadow-sm" />
                          )}
                          {isSidebarMini && !mobileSidebarOpen && showReorderAutomationBadge && (
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
                                'absolute right-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:focus-visible:ring-sky-200/80',
                                isActive
                                  ? 'bg-sky-950/25 text-white ring-1 ring-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_8px_18px_rgba(8,47,73,0.22)] backdrop-blur-md'
                                  : 'bg-sky-600 text-white shadow-[0_8px_18px_rgba(14,165,233,0.22)] dark:bg-sky-300 dark:text-slate-950'
                              )}
                            >
                              <Bot className="h-3 w-3" />
                              <span
                                className={cn(
                                  'absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full border px-1 text-[8px] font-semibold leading-none shadow-sm',
                                  isActive
                                    ? 'border-white/15 bg-sky-950/90 text-white'
                                    : 'border-white/80 bg-sky-700 text-white dark:border-sky-100/75 dark:bg-sky-950 dark:text-sky-100'
                                )}
                              >
                                {reorderAutomationCountLabel}
                              </span>
                            </span>
                          )}
                          {isSidebarMini && !mobileSidebarOpen && showEcommerceBadge && (
                            <span
                              title={ecommercePendingLabel}
                              className={cn(
                                'absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full border px-1 text-[8px] font-bold shadow-sm transition-all',
                                isActive
                                  ? 'bg-amber-400 text-amber-950 border-amber-300'
                                  : 'bg-amber-500 text-white border-white/80 dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-400/30'
                              )}
                            >
                              {ecommerceCountLabel}
                            </span>
                          )}
                          {isSidebarMini && !mobileSidebarOpen && item.status && (
                            <div
                              className={cn(
                                'absolute top-2 right-2 w-2 h-2 rounded-full border border-background shadow-sm',
                                item.status === 'live' ? 'bg-emerald-500' : 'bg-red-500'
                              )}
                            />
                          )}
                        </span>
                      )

                      return (
                        <div
                          key={item.href}
                          className={cn(
                            'space-y-1',
                            item.mobileOnly && 'lg:hidden',
                            item.popup && !item.mobileOnly && 'hidden lg:block'
                          )}
                        >
                          {
                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                {item.popup ? (
                                  <button
                                    onClick={() => {
                                      setMobileSidebarOpen(false)
                                      setCurrencyConverterOpen(true)
                                      triggerHaptic('selection')
                                    }}
                                    className="w-full text-left"
                                  >
                                    {parentContent}
                                  </button>
                                ) : (
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
                                )}
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onSelect={() => handleAddToDesktop(item.name, item.href)}>
                                  {t('shortcut.addToDesktop', {
                                    defaultValue: 'Add to desktop as shortcut'
                                  })}
                                </ContextMenuItem>
                                {isModuleLockerTarget && (
                                  <>
                                    <ContextMenuSeparator />
                                    {isModuleLocked ? (
                                      <ContextMenuItem disabled className="gap-2">
                                        <LockKeyhole className="h-4 w-4" />
                                        {t('settings.moduleLocker.lockedMenuItem')}
                                      </ContextMenuItem>
                                    ) : (
                                      <ContextMenuItem
                                        className="gap-2"
                                        onSelect={() => openModuleLockerDialog('lock', item.href, item.name)}
                                      >
                                        <LockKeyhole className="h-4 w-4" />
                                        {t('settings.moduleLocker.lockModule')}
                                      </ContextMenuItem>
                                    )}
                                  </>
                                )}
                                <ContextMenuSeparator />
                                <ContextMenuItem className="gap-2" onSelect={openSidebarCustomization}>
                                  <Settings2 className="h-4 w-4" />
                                  {t('nav.sidebarCustomization.customize')}
                                </ContextMenuItem>
                                {canFavoriteSidebarItem && (
                                  <>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem
                                      className="gap-2 text-amber-600 focus:text-amber-700 dark:text-amber-400 dark:focus:text-amber-300"
                                      onSelect={() => toggleSidebarFavorite(item)}
                                    >
                                      <Star className={cn('h-4 w-4', sidebarFavoriteHrefSet.has(item.href) && 'fill-current')} />
                                      {t(
                                        sidebarFavoriteHrefSet.has(item.href)
                                          ? 'nav.sidebarFavorites.remove'
                                          : 'nav.sidebarFavorites.addToFavorites'
                                      )}
                                    </ContextMenuItem>
                                  </>
                                )}
                              </ContextMenuContent>
                            </ContextMenu>
                          }

                          {showChildren && (
                            <div
                              className={cn(
                                'relative flex flex-col space-y-1 mt-1.5',
                                !(isSidebarMini && !mobileSidebarOpen) &&
                                  'before:absolute before:inset-y-0 before:left-[22px] rtl:before:right-[22px] rtl:before:left-auto before:w-px before:bg-border/60',
                                isSidebarMini && !mobileSidebarOpen ? 'ps-0' : 'ps-10'
                              )}
                            >
                              {item.children!.map((child) => {
                                const isChildSelected =
                                  location === child.href || (child.href !== '/' && location.startsWith(child.href))
                                const childLink = (
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
                                    {!(isSidebarMini && !mobileSidebarOpen) && (
                                      <div
                                        className={cn(
                                          'absolute top-1/2 -translate-y-1/2 w-[18px] h-px',
                                          'left-[-18px] rtl:right-[-18px] rtl:left-auto',
                                          isChildSelected ? 'bg-primary' : 'bg-border/60'
                                        )}
                                      />
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
                                        <child.icon
                                          className={cn(
                                            'w-4 h-4 flex-shrink-0 transition-colors',
                                            isChildSelected ? 'text-primary' : 'text-muted-foreground'
                                          )}
                                        />
                                      ) : (
                                        <span
                                          className={cn(
                                            'w-1.5 h-1.5 rounded-full transition-colors',
                                            isChildSelected ? 'bg-primary' : 'bg-muted-foreground/30'
                                          )}
                                        />
                                      )}
                                      <span>{child.name}</span>
                                    </span>
                                  </Link>
                                )
                                return isDesktop() ? (
                                  <ContextMenu key={child.href}>
                                    <ContextMenuTrigger asChild>{childLink}</ContextMenuTrigger>
                                    <ContextMenuContent>
                                      <ContextMenuItem onSelect={() => handleAddToDesktop(child.name, child.href)}>
                                        {t('shortcut.addToDesktop', {
                                          defaultValue: 'Add to desktop as shortcut'
                                        })}
                                      </ContextMenuItem>
                                      <ContextMenuSeparator />
                                      <ContextMenuItem className="gap-2" onSelect={openSidebarCustomization}>
                                        <Settings2 className="h-4 w-4" />
                                        {t('nav.sidebarCustomization.customize')}
                                      </ContextMenuItem>
                                    </ContextMenuContent>
                                  </ContextMenu>
                                ) : (
                                  childLink
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
                )
              )}

              {/* Workspace Members Section */}
              {(user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer') && (
                <div className="pt-6 pb-2">
                  {!(isSidebarMini && !mobileSidebarOpen) ? (
                    <h2 className="px-3 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em] mb-4">
                      {t('auth.members')}
                    </h2>
                  ) : (
                    <div className="h-px bg-border/40 mx-2 mb-4" />
                  )}

                  {/* Workspace Code / Demo Timer */}
                  {user?.workspaceCode &&
                    (() => {
                      const isDemo = isDemoWorkspace(user.workspaceCode)

                      if (isDemo) {
                        const mins = demoRemainingSec !== null ? Math.floor(demoRemainingSec / 60) : 0
                        const secs = demoRemainingSec !== null ? demoRemainingSec % 60 : 0
                        const expired = demoRemainingSec !== null && demoRemainingSec <= 0

                        return (
                          <div
                            className={cn(
                              'mx-3 mb-4 rounded-sm border border-border relative overflow-hidden',
                              isSidebarMini && !mobileSidebarOpen
                                ? 'p-2 bg-transparent border-transparent flex justify-center mx-0'
                                : 'p-2.5 bg-secondary/30'
                            )}
                          >
                            {isSidebarMini && !mobileSidebarOpen ? (
                              <Clock className="w-5 h-5 text-amber-500" />
                            ) : (
                              <div className="relative z-10">
                                <p className="text-[10px] text-muted-foreground/60 uppercase font-bold mb-1">
                                  {expired ? t('demo.expired', 'Expired') : t('demo.timeRemaining', 'Time Remaining')}
                                </p>
                                <p
                                  className={cn(
                                    'text-sm font-mono font-bold tracking-wider',
                                    expired ? 'text-destructive' : 'text-amber-500'
                                  )}
                                >
                                  {expired
                                    ? '00:00'
                                    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`}
                                </p>
                              </div>
                            )}
                            <div className="absolute inset-0 bg-amber-500/5" />
                          </div>
                        )
                      }

                      return (
                        <div
                          className={cn(
                            'mx-3 mb-4 rounded-sm border border-border group hover:border-primary/50 transition-all cursor-pointer relative overflow-hidden',
                            isSidebarMini && !mobileSidebarOpen
                              ? 'p-2 bg-transparent border-transparent hover:bg-secondary/50 flex justify-center mx-0'
                              : 'p-2.5 bg-secondary/30'
                          )}
                          onClick={() => {
                            copyToClipboard(user.workspaceCode)
                            triggerHaptic('success')
                          }}
                          title={isSidebarMini && !mobileSidebarOpen ? 'Copy Workspace Code' : undefined}
                        >
                          {isSidebarMini && !mobileSidebarOpen ? (
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
                      )
                    })()}

                  <div
                    className={cn(
                      'px-3 space-y-3',
                      isSidebarMini && !mobileSidebarOpen && 'px-0 space-y-2 flex flex-col items-center'
                    )}
                  >
                    {members.map((member) => {
                      // Use dynamic user profile for the current user to ensure immediate updates
                      const profileUrl =
                        member.id === user?.id && user?.profileUrl ? user.profileUrl : member.profile_url

                      return (
                        <div
                          key={member.id}
                          className={cn(
                            'flex items-center gap-3',
                            isSidebarMini && !mobileSidebarOpen && 'justify-center w-full'
                          )}
                        >
                          <div
                            className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-xs font-medium overflow-hidden ring-2 ring-transparent hover:ring-primary/20 transition-all"
                            title={isSidebarMini && !mobileSidebarOpen ? `${member.name} (${member.role})` : undefined}
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
                          {!(isSidebarMini && !mobileSidebarOpen) && (
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold truncate">{member.name}</p>
                              <p className="text-[10px] text-muted-foreground/60 uppercase font-bold tracking-wider">
                                {member.role}
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
                </>
              )}
            </nav>

            <div
              className={cn(
                'relative z-10 mx-3 mb-3 shrink-0 rounded-2xl border border-border/70 bg-card/85 p-3 shadow-sm backdrop-blur-md transition-all duration-300',
                isSidebarMini && !mobileSidebarOpen && 'mx-2 mb-2 flex flex-col items-center gap-3 py-4'
              )}
            >
              <div
                className={cn(
                  'flex items-center gap-2 px-2 py-1',
                  isSidebarMini && !mobileSidebarOpen && 'flex-col p-0 gap-2'
                )}
              >
                {isLocalMode && !isDemoWorkspace(user?.workspaceCode) ? (
                  <>
                    <LocalAccountSwitcher
                      isCompact={isSidebarMini && !mobileSidebarOpen}
                      shiftBadge={sidebarAvatarShiftBadge}
                      manualShiftActiveDuration={sidebarManualShiftActiveDuration}
                    />
                    {sidebarCashierShift?.status === 'available' ? (
                      <PressAndHoldButton
                        onComplete={() => {
                          void startSidebarCashierShift()
                        }}
                        onShortPress={() => setCashierShiftStartDialogOpen(true)}
                        idleLabel={t('paymentAccounts.holdToStartShift')}
                        holdingLabel={t('paymentAccounts.keepHoldingToStartShift')}
                        loadingLabel={t('paymentAccounts.startingShift')}
                        isLoading={startingCashierShift}
                        iconOnly
                        variant="ghost"
                        progressVariant="ring"
                        progressClassName="text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.9)]"
                        className="h-9 w-9 rounded-full bg-transparent p-0 ring-2 ring-amber-400 ring-offset-2 ring-offset-background hover:bg-transparent"
                        icon={<ShieldCheck className="h-4 w-4" />}
                        title={t('paymentAccounts.startShift')}
                      />
                    ) : sidebarCashierShift?.status === 'active' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={openSidebarActiveShiftAction}
                        className="h-9 w-9 rounded-full bg-transparent p-0 ring-2 ring-amber-400 ring-offset-2 ring-offset-background hover:bg-transparent"
                        title={sidebarActiveShiftActionLabel}
                        aria-label={sidebarActiveShiftActionLabel}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div
                      className={cn('relative shrink-0', sidebarManualShiftActiveDuration && 'mb-5')}
                      title={sidebarShiftEndsInLabel || undefined}
                    >
                      {sidebarCashierShift?.status === 'available' ? (
                        <PressAndHoldButton
                          onComplete={() => {
                            void startSidebarCashierShift()
                          }}
                          onShortPress={() => setCashierShiftStartDialogOpen(true)}
                          idleLabel={t('paymentAccounts.holdToStartShift')}
                          holdingLabel={t('paymentAccounts.keepHoldingToStartShift')}
                          loadingLabel={t('paymentAccounts.startingShift')}
                          isLoading={startingCashierShift}
                          iconOnly
                          variant="ghost"
                          progressVariant="ring"
                          progressClassName="text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.9)]"
                          className="h-9 w-9 rounded-full bg-transparent p-0 ring-2 ring-amber-400 ring-offset-2 ring-offset-background hover:bg-transparent"
                          icon={
                            user?.profileUrl ? (
                              <img
                                src={
                                  user.profileUrl.startsWith('http')
                                    ? user.profileUrl
                                    : platformService.convertFileSrc(user.profileUrl)
                                }
                                alt={user.name}
                                className="h-9 w-9 rounded-full object-cover"
                              />
                            ) : (
                              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-600 text-sm font-bold text-white shadow-sm">
                                {user?.name?.charAt(0).toUpperCase() || 'U'}
                              </span>
                            )
                          }
                          title={t('paymentAccounts.startShift')}
                        />
                      ) : sidebarCashierShift?.status === 'active' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={openSidebarActiveShiftAction}
                          className="h-9 w-9 rounded-full bg-transparent p-0 hover:bg-transparent"
                          title={sidebarActiveShiftActionLabel}
                          aria-label={sidebarActiveShiftActionLabel}
                        >
                          <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-primary to-emerald-600 text-sm font-bold text-white shadow-sm ring-2 ring-amber-400 ring-offset-2 ring-offset-background">
                            {user?.profileUrl ? (
                              <img
                                src={
                                  user.profileUrl.startsWith('http')
                                    ? user.profileUrl
                                    : platformService.convertFileSrc(user.profileUrl)
                                }
                                alt={user.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              user?.name?.charAt(0).toUpperCase() || 'U'
                            )}
                          </span>
                        </Button>
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-primary to-emerald-600 text-sm font-bold text-white shadow-sm">
                          {user?.profileUrl ? (
                            <img
                              src={
                                user.profileUrl.startsWith('http')
                                  ? user.profileUrl
                                  : platformService.convertFileSrc(user.profileUrl)
                              }
                              alt={user.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            user?.name?.charAt(0).toUpperCase() || 'U'
                          )}
                        </div>
                      )}
                      {sidebarShiftCountdown ? (
                        <span
                          className="pointer-events-none absolute bottom-0 left-1/2 z-[60] min-w-[26px] -translate-x-1/2 rounded-full border border-amber-300/80 bg-amber-400 px-1 py-0.5 text-center text-[8px] font-bold leading-none text-amber-950 shadow-sm dark:border-amber-200/30 dark:bg-amber-300"
                          title={sidebarShiftEndsInLabel}
                        >
                          {sidebarShiftCountdown}
                        </span>
                      ) : null}
                      {sidebarAvatarShiftBadge ? (
                        <span className="pointer-events-none absolute -bottom-1 left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap">
                          <span
                            className={cn(
                              'block rounded-[3px] border px-1.5 py-0.5 text-[8px] font-bold leading-none text-white shadow-sm',
                              sidebarAvatarShiftBadge === 'ready'
                                ? 'border-emerald-200 bg-emerald-500 dark:border-emerald-300/40'
                                : 'border-primary/30 bg-primary'
                            )}
                            title={t(
                              sidebarAvatarShiftBadge === 'ready'
                                ? 'paymentAccounts.readyShiftBadge'
                                : 'paymentAccounts.completeShiftBadge'
                            )}
                            aria-label={t(
                              sidebarAvatarShiftBadge === 'ready'
                                ? 'paymentAccounts.shiftStatuses.available'
                                : 'paymentAccounts.completeShift'
                            )}
                          >
                            {t(
                              sidebarAvatarShiftBadge === 'ready'
                                ? 'paymentAccounts.readyShiftBadge'
                                : 'paymentAccounts.completeShiftBadge'
                            )}
                          </span>
                          {sidebarManualShiftActiveDuration ? (
                            <span
                              className="absolute left-1/2 top-full -mt-px -translate-x-1/2 rounded-[3px] border border-muted-foreground/25 bg-muted px-1.5 py-0.5 font-mono text-[8px] font-bold leading-none text-muted-foreground shadow-sm"
                              title={t('paymentAccounts.manualShiftActiveDuration', {
                                time: sidebarManualShiftActiveDuration
                              })}
                              aria-label={t('paymentAccounts.manualShiftActiveDuration', {
                                time: sidebarManualShiftActiveDuration
                              })}
                            >
                              {sidebarManualShiftActiveDuration}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </div>

                    {isSidebarMini && !mobileSidebarOpen ? (
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
                  </>
                )}

                {!showSidebarThemeSelector && (
                  <Button
                    variant="ghost"
                    size="icon"
                    allowViewer={true}
                    onClick={() => {
                      setIsSignOutModalOpen(true)
                      triggerHaptic('warning')
                    }}
                    className={cn(
                      'h-8 w-8 shrink-0 rounded-xl border border-border/50 bg-muted/80 text-muted-foreground shadow-inner hover:bg-card hover:text-destructive dark:bg-background/70',
                      isSidebarMini && !mobileSidebarOpen && 'mt-1'
                    )}
                    title="Sign Out"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {showSidebarThemeSelector && (
                <div className="mt-2 flex items-center gap-2">
                  <div
                    className="grid min-w-0 flex-1 grid-cols-3 gap-0.5 rounded-xl border border-border/50 bg-muted/80 p-0.5 shadow-inner dark:bg-background/70"
                    role="group"
                    aria-label={t('settings.theme.title')}
                  >
                    <button
                      type="button"
                      onClick={() => setTheme('light')}
                      aria-label={t('settings.theme.light')}
                      aria-pressed={theme === 'light'}
                      title={t('settings.theme.light')}
                      className={cn(
                        'flex h-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        theme === 'light'
                          ? 'bg-card text-primary shadow-sm'
                          : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                      )}
                    >
                      <Sun className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('dark')}
                      aria-label={t('settings.theme.dark')}
                      aria-pressed={theme === 'dark'}
                      title={t('settings.theme.dark')}
                      className={cn(
                        'flex h-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        theme === 'dark'
                          ? 'bg-card text-primary shadow-sm'
                          : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                      )}
                    >
                      <Moon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('system')}
                      aria-label={t('settings.theme.system')}
                      aria-pressed={theme === 'system'}
                      title={t('settings.theme.system')}
                      className={cn(
                        'flex h-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        theme === 'system'
                          ? 'bg-card text-primary shadow-sm'
                          : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                      )}
                    >
                      <Monitor className="h-4 w-4" />
                    </button>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    allowViewer={true}
                    onClick={() => {
                      setIsSignOutModalOpen(true)
                      triggerHaptic('warning')
                    }}
                    className="h-8 w-8 shrink-0 rounded-xl border border-border/50 bg-muted/80 text-muted-foreground shadow-inner hover:bg-card hover:text-destructive dark:bg-background/70"
                    title="Sign Out"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              )}
              {/* Version Display */}
              {!(isSidebarMini && !mobileSidebarOpen) && version && (
                <div className="mt-2 text-center">
                  {isTauri ? (
                    <p
                      className="text-[10px] text-muted-foreground font-mono opacity-50 truncate px-2"
                      title={versionTooltip || undefined}
                    >
                      {`v${version}`}
                    </p>
                  ) : isLocalMode && updatesDisabled ? (
                    <p
                      className="text-[10px] text-muted-foreground font-mono opacity-50 truncate px-2"
                      title={versionTooltip || undefined}
                    >
                      {version}
                    </p>
                  ) : (
                    <DeploymentRefreshVersion
                      version={version}
                      title={versionTooltip || undefined}
                      holdLabel={t('common.holdToRefreshLatestVersion', {
                        defaultValue: 'Hold to refresh the latest version'
                      })}
                      isRtl={i18n.dir() === 'rtl'}
                      onComplete={() => {
                        triggerHaptic('success')
                        refreshToLatestDeployment()
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </aside>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={isSidebarCustomizationMode}
                className="gap-2"
                onSelect={openSidebarCustomization}
              >
                <Settings2 className="h-4 w-4" />
                {t('nav.sidebarCustomization.customize')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <AppDialog
            open={Boolean(activeSidebarModuleOrderGroup)}
            onOpenChange={(open) => !open && setActiveSidebarModuleOrderSection(null)}
          >
            <AppDialogContent className="max-w-xl">
              <AppDialogHeader>
                <AppDialogTitle className="flex items-center gap-2">
                  <ListOrdered className="h-5 w-5 text-primary" />
                  {t('nav.sidebarCustomization.reorderTabsTitle', {
                    section: activeSidebarModuleOrderGroup?.title ?? ''
                  })}
                </AppDialogTitle>
                <AppDialogDescription>
                  {t('nav.sidebarCustomization.reorderTabsDescription')}
                </AppDialogDescription>
              </AppDialogHeader>
              <AppDialogBody>
                {activeSidebarModuleOrderGroup && (
                  <DragDropContext onDragEnd={handleSidebarModuleDragEnd}>
                    <Droppable droppableId={`sidebar-module-tabs:${activeSidebarModuleOrderGroup.sectionKey}`} direction="vertical">
                      {(provided) => (
                        <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                          {activeSidebarModuleOrderGroup.items.map((item, index) => (
                            <Draggable
                              key={item.href}
                              draggableId={`sidebar-module-tab:${activeSidebarModuleOrderGroup.sectionKey}:${item.href}`}
                              index={index}
                            >
                              {(draggableProvided, snapshot) => (
                                <div
                                  ref={draggableProvided.innerRef}
                                  {...draggableProvided.draggableProps}
                                  className={cn(
                                    'flex min-h-14 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-shadow',
                                    snapshot.isDragging
                                      ? 'border-primary/50 shadow-lg ring-2 ring-primary/20'
                                      : 'border-border/70'
                                  )}
                                >
                                  <button
                                    type="button"
                                    {...draggableProvided.dragHandleProps}
                                    aria-label={t('nav.sidebarCustomization.moveTab', { tab: item.name })}
                                    className="flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                  >
                                    <GripVertical className="h-5 w-5" />
                                  </button>
                                  <item.icon className="h-5 w-5 shrink-0 text-primary" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-semibold text-foreground">{item.name}</p>
                                    {item.children?.length ? (
                                      <p className="mt-0.5 text-xs text-muted-foreground">
                                        {t('nav.sidebarCustomization.nestedTabsStayWithParent')}
                                      </p>
                                    ) : null}
                                  </div>
                                </div>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </DragDropContext>
                )}
              </AppDialogBody>
              <AppDialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() =>
                    activeSidebarModuleOrderGroup &&
                    setSidebarModuleOrderResetSection(activeSidebarModuleOrderGroup.sectionKey)
                  }
                >
                  <RotateCcw className="h-4 w-4" />
                  {t('nav.sidebarCustomization.resetTabsOrder')}
                </Button>
                <Button
                  type="button"
                  className="gap-2"
                  onClick={() => setActiveSidebarModuleOrderSection(null)}
                >
                  <Check className="h-4 w-4" />
                  {t('nav.sidebarCustomization.done')}
                </Button>
              </AppDialogFooter>
            </AppDialogContent>
          </AppDialog>

          <AppDialog
            open={isSidebarFavoritesDialogOpen}
            onOpenChange={(open) => {
              setIsSidebarFavoritesDialogOpen(open)
              if (!open) setFavoritePickerQuery('')
            }}
          >
            <AppDialogContent className="max-w-2xl">
              <AppDialogHeader>
                <AppDialogTitle className="flex items-center gap-2">
                  <Star className="h-5 w-5 fill-amber-400 text-amber-500" />
                  {t('nav.sidebarFavorites.manageTitle')}
                </AppDialogTitle>
                <AppDialogDescription>{t('nav.sidebarFavorites.manageDescription')}</AppDialogDescription>
              </AppDialogHeader>
              <AppDialogBody className="space-y-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={favoritePickerQuery}
                    onChange={(event) => setFavoritePickerQuery(event.target.value)}
                    placeholder={t('nav.sidebarFavorites.searchPlaceholder')}
                    className="ps-9"
                    aria-label={t('nav.sidebarFavorites.searchPlaceholder')}
                  />
                </div>
                <p className="rounded-xl border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  {t('nav.sidebarFavorites.selectionOrderHint')}
                </p>
                {visibleFavoritePickerGroups.length > 0 ? (
                  <div className="space-y-4">
                    {visibleFavoritePickerGroups.map((group) => (
                      <section key={group.sectionKey} className="overflow-hidden rounded-xl border border-border/70">
                        <h3 className="border-b border-border/70 bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.title}
                        </h3>
                        <div className="divide-y divide-border/60">
                          {group.items.map((item) => {
                            const isSelected = favoritePickerOrder.includes(item.href)
                            return (
                              <label
                                key={item.href}
                                className="flex cursor-pointer items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40"
                              >
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    setFavoritePickerOrder((current) =>
                                      checked ? [...current, item.href] : current.filter((href) => href !== item.href)
                                    )
                                  }}
                                  aria-label={item.name}
                                />
                                <item.icon className="h-4 w-4 shrink-0 text-primary" />
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.name}</span>
                                {isSelected && <Star className="h-4 w-4 fill-amber-400 text-amber-500" />}
                              </label>
                            )
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {t('nav.sidebarFavorites.noModulesFound')}
                  </p>
                )}
              </AppDialogBody>
              <AppDialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() => setIsClearSidebarFavoritesDialogOpen(true)}
                  disabled={sidebarFavorites.order.length === 0}
                >
                  <Star className="h-4 w-4" />
                  {t('nav.sidebarFavorites.clearAll')}
                </Button>
                <Button type="button" variant="outline" onClick={() => setIsSidebarFavoritesDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" className="gap-2" onClick={saveFavoritePicker}>
                  <Check className="h-4 w-4" />
                  {t('common.save')}
                </Button>
              </AppDialogFooter>
            </AppDialogContent>
          </AppDialog>

          <DeleteConfirmationModal
            isOpen={isClearSidebarFavoritesDialogOpen}
            onClose={() => setIsClearSidebarFavoritesDialogOpen(false)}
            onConfirm={() => {
              if (saveSidebarFavorites({ order: [], firstAddedOrder: [] }, t('nav.sidebarFavorites.cleared'))) {
                setFavoritePickerOrder([])
                setIsClearSidebarFavoritesDialogOpen(false)
                triggerHaptic('success')
              }
            }}
            title={t('nav.sidebarFavorites.clearTitle')}
            description={t('nav.sidebarFavorites.clearDescription')}
            itemName={t('nav.sidebarFavorites.title')}
            simpleConfirmation
          />

          <AppDialog open={isSidebarResetDialogOpen} onOpenChange={setIsSidebarResetDialogOpen}>
            <AppDialogContent className="max-w-md">
              <AppDialogHeader>
                <AppDialogTitle>{t('nav.sidebarCustomization.resetTitle')}</AppDialogTitle>
                <AppDialogDescription>{t('nav.sidebarCustomization.resetDescription')}</AppDialogDescription>
              </AppDialogHeader>
              <AppDialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsSidebarResetDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" variant="destructive" onClick={resetSidebarSectionOrder} className="gap-2">
                  <RotateCcw className="h-4 w-4" />
                  {t('nav.sidebarCustomization.confirmReset')}
                </Button>
              </AppDialogFooter>
            </AppDialogContent>
          </AppDialog>

          <AppDialog
            open={Boolean(sidebarModuleOrderResetSection)}
            onOpenChange={(open) => !open && setSidebarModuleOrderResetSection(null)}
          >
            <AppDialogContent className="max-w-md">
              <AppDialogHeader>
                <AppDialogTitle>
                  {t('nav.sidebarCustomization.resetTabsTitle', {
                    section:
                      sidebarModuleOrderResetSection === 'favorites'
                        ? t('nav.sidebarFavorites.title')
                        : visibleSidebarSectionGroups.find((group) => group.sectionKey === sidebarModuleOrderResetSection)?.title ?? ''
                  })}
                </AppDialogTitle>
                <AppDialogDescription>{t('nav.sidebarCustomization.resetTabsDescription')}</AppDialogDescription>
              </AppDialogHeader>
              <AppDialogFooter>
                <Button type="button" variant="outline" onClick={() => setSidebarModuleOrderResetSection(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="gap-2"
                  onClick={() => sidebarModuleOrderResetSection && resetSidebarModuleOrder(sidebarModuleOrderResetSection)}
                >
                  <RotateCcw className="h-4 w-4" />
                  {t('nav.sidebarCustomization.confirmReset')}
                </Button>
              </AppDialogFooter>
            </AppDialogContent>
          </AppDialog>

          {sidebarCashierShift?.status === 'available' ? (
            <AppDialog
              open={cashierShiftStartDialogOpen}
              onOpenChange={(open) => !startingCashierShift && setCashierShiftStartDialogOpen(open)}
            >
              <AppDialogContent
                className="max-w-xl"
                showCloseButton={!startingCashierShift}
                onPointerDownOutside={(event) => startingCashierShift && event.preventDefault()}
                onEscapeKeyDown={(event) => startingCashierShift && event.preventDefault()}
              >
                <AppDialogHeader>
                  <AppDialogTitle>{t('paymentAccounts.startShift')}</AppDialogTitle>
                  <AppDialogDescription>{t('paymentAccounts.startShiftConfirmationDescription')}</AppDialogDescription>
                </AppDialogHeader>
                <AppDialogBody>
                  {sidebarCashierShift.assignment.assignmentMode === 'manual' ? (
                    <p className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
                      {t('paymentAccounts.manualShiftStartDescription')}
                    </p>
                  ) : (
                    <div className="grid gap-4">
                      <div className="rounded-2xl border border-border/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {t('paymentAccounts.yourShiftWillStart')}
                        </p>
                        <p className="mt-2 font-semibold">
                          {formatSidebarShiftDateTime(sidebarCashierShift.scheduledStartAt)}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {t('paymentAccounts.yourShiftWillEnd')}
                        </p>
                        <p className="mt-2 font-semibold">
                          {formatSidebarShiftDateTime(sidebarCashierShift.scheduledEndAt)}
                        </p>
                      </div>
                    </div>
                  )}
                </AppDialogBody>
                <AppDialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setCashierShiftStartDialogOpen(false)}
                    disabled={startingCashierShift}
                  >
                    {t('common.cancel')}
                  </Button>
                  <PressAndHoldButton
                    onComplete={() => {
                      void startSidebarCashierShift()
                    }}
                    idleLabel={t('paymentAccounts.holdToStartShift')}
                    holdingLabel={t('paymentAccounts.keepHoldingToStartShift')}
                    loadingLabel={t('paymentAccounts.startingShift')}
                    isLoading={startingCashierShift}
                    icon={<ShieldCheck className="h-4 w-4" />}
                  />
                </AppDialogFooter>
              </AppDialogContent>
            </AppDialog>
          ) : null}

          {sidebarCashierShift?.status === 'active' && sidebarCashierShift.occurrence ? (
            <>
              <AppDialog
                open={cashierShiftCompleteDialogOpen}
                onOpenChange={(open) => !completingCashierShift && setCashierShiftCompleteDialogOpen(open)}
              >
                <AppDialogContent
                  className="max-w-xl"
                  showCloseButton={!completingCashierShift}
                  onPointerDownOutside={(event) => completingCashierShift && event.preventDefault()}
                  onEscapeKeyDown={(event) => completingCashierShift && event.preventDefault()}
                >
                  <AppDialogHeader>
                    <AppDialogTitle>{t('paymentAccounts.completeShift')}</AppDialogTitle>
                  </AppDialogHeader>
                  <AppDialogBody>
                    <div className="grid gap-3 text-sm">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{t('paymentAccounts.actualStart')}</span>
                        <span className="font-semibold tabular-nums">
                          {formatSidebarShiftStartedDateTime(sidebarCashierShift.occurrence.startedAt)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{t('paymentAccounts.incoming')}</span>
                        <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                          {formatCashierShiftCompletionAmount(sidebarCompletionFinancialSummaries, 'incoming')}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{t('paymentAccounts.outgoing')}</span>
                        <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-300">
                          {formatCashierShiftCompletionAmount(sidebarCompletionFinancialSummaries, 'outgoing')}
                        </span>
                      </div>
                      {sidebarCompletionEligibility?.requiresReason ? (
                        <div className="grid gap-2">
                          <label htmlFor="sidebar-cashier-shift-completion-reason" className="text-sm font-medium">
                            {t('paymentAccounts.earlyFinishReason')}
                          </label>
                          <Textarea
                            id="sidebar-cashier-shift-completion-reason"
                            value={cashierShiftCompletionReason}
                            onChange={(event) => setCashierShiftCompletionReason(event.target.value)}
                            disabled={completingCashierShift}
                          />
                        </div>
                      ) : null}
                    </div>
                  </AppDialogBody>
                  <AppDialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setCashierShiftCompleteDialogOpen(false)}
                      disabled={completingCashierShift}
                    >
                      {t('common.cancel')}
                    </Button>
                    <PressAndHoldButton
                      onComplete={() => {
                        void completeSidebarCashierShift()
                      }}
                      idleLabel={t('paymentAccounts.holdToCompleteShift')}
                      holdingLabel={t('paymentAccounts.keepHoldingToCompleteShift')}
                      loadingLabel={t('paymentAccounts.completingShift')}
                      isLoading={completingCashierShift}
                      disabled={sidebarCompletionEligibility?.requiresReason && !cashierShiftCompletionReason.trim()}
                      icon={<CircleCheck className="h-4 w-4" />}
                    />
                  </AppDialogFooter>
                </AppDialogContent>
              </AppDialog>

              <AppDialog
                open={cashierShiftEarlyFinishRequestDialogOpen}
                onOpenChange={(open) =>
                  !requestingCashierShiftEarlyFinish && setCashierShiftEarlyFinishRequestDialogOpen(open)
                }
              >
                <AppDialogContent
                  className="max-w-xl"
                  showCloseButton={!requestingCashierShiftEarlyFinish}
                  onPointerDownOutside={(event) => requestingCashierShiftEarlyFinish && event.preventDefault()}
                  onEscapeKeyDown={(event) => requestingCashierShiftEarlyFinish && event.preventDefault()}
                >
                  <AppDialogHeader>
                    <AppDialogTitle>{t('paymentAccounts.requestEarlyFinish')}</AppDialogTitle>
                    <AppDialogDescription>{t('paymentAccounts.requestEarlyFinishDescription')}</AppDialogDescription>
                  </AppDialogHeader>
                  <AppDialogBody>
                    <div className="grid gap-2">
                      <label htmlFor="sidebar-cashier-shift-early-finish-reason" className="text-sm font-medium">
                        {t('paymentAccounts.earlyFinishReason')}
                      </label>
                      <Textarea
                        id="sidebar-cashier-shift-early-finish-reason"
                        value={cashierShiftEarlyFinishReason}
                        onChange={(event) => setCashierShiftEarlyFinishReason(event.target.value)}
                        disabled={requestingCashierShiftEarlyFinish}
                      />
                    </div>
                  </AppDialogBody>
                  <AppDialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setCashierShiftEarlyFinishRequestDialogOpen(false)}
                      disabled={requestingCashierShiftEarlyFinish}
                    >
                      {t('common.cancel')}
                    </Button>
                    <PressAndHoldButton
                      onComplete={() => {
                        void requestSidebarCashierShiftEarlyFinish()
                      }}
                      idleLabel={t('paymentAccounts.holdToRequestEarlyFinish')}
                      holdingLabel={t('paymentAccounts.keepHoldingToRequestEarlyFinish')}
                      loadingLabel={t('paymentAccounts.requestingEarlyFinish')}
                      isLoading={requestingCashierShiftEarlyFinish}
                      disabled={!cashierShiftEarlyFinishReason.trim()}
                      icon={<ClipboardCheck className="h-4 w-4" />}
                    />
                  </AppDialogFooter>
                </AppDialogContent>
              </AppDialog>
            </>
          ) : null}

          {/* Main content Scroll Container */}
          <div
            className={cn(
              'h-full bg-background transition-[padding] duration-300 ease-in-out flex flex-col overflow-hidden',
              isTauri && 'mt-[var(--titlebar-height)] h-[calc(100vh-var(--titlebar-height))]',
              // Desktop Sidebar Padding Logic
              desktopSidebarOpen
                ? isSidebarMini
                  ? 'lg:pl-[70px] lg:rtl:pl-0 lg:rtl:pr-[70px]'
                  : isSidebarCustomizationMode
                    ? 'lg:pl-80 lg:rtl:pl-0 lg:rtl:pr-80'
                    : 'lg:pl-64 lg:rtl:pl-0 lg:rtl:pr-64'
                : 'lg:pl-0',
              'pb-[var(--safe-area-bottom)]'
            )}
          >
            {/* Top bar */}
            <header
              className={cn(
                'flex-shrink-0 z-30 flex items-center gap-4 px-4 py-3 bg-background/60 backdrop-blur-xl border-b border-border/50',
                'pt-[calc(0.75rem+var(--safe-area-top))]',
                isPosLikeRoute && 'hidden lg:flex' // Hide on mobile if POS
              )}
            >
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
                {desktopSidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </button>

              <div
                className={cn(
                  'flex-1 justify-center px-4',
                  webUsageMeter ? 'hidden lg:flex' : !isMobile() ? 'flex' : 'hidden md:flex'
                )}
              >
                {!isTauri && webUsageMeter ? (
                  <div className="flex w-full max-w-[500px] items-center justify-center animate-in fade-in slide-in-from-top-2 duration-300">
                    {webPaygSummary && <WorkspacePaygChargeButton summary={webPaygSummary} onClick={() => setUsageModalOpen(true)} />}
                    <WorkspaceUsageButton
                      usageMeter={webUsageMeter}
                      onClick={() => setUsageModalOpen(true)}
                      className="relative z-10 h-9 w-full"
                    />
                  </div>
                ) : (
                  (!isTauri || isFullscreen) &&
                  !isMobile() && (
                    <GlobalSearch className="max-w-[500px] animate-in fade-in slide-in-from-top-2 duration-300" />
                  )
                )}
              </div>

              <div className="flex items-center gap-1 md:gap-3 ml-auto">
                {!isTauri && webUsageMeter && (
                  <div className="flex items-center lg:hidden">
                    {webPaygSummary && <WorkspacePaygChargeButton compact summary={webPaygSummary} onClick={() => setUsageModalOpen(true)} />}
                    <WorkspaceUsageCircleButton
                      usageMeter={webUsageMeter}
                      onClick={() => setUsageModalOpen(true)}
                      className="relative z-10"
                    />
                  </div>
                )}
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
                    'relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border transition-all duration-300',
                    isModuleLauncherRoute
                      ? 'border-primary/30 bg-primary/10 shadow-[0_16px_36px_rgba(79,70,229,0.18)]'
                      : 'border-border/60 bg-background/75 hover:-translate-y-0.5 hover:border-primary/20 hover:bg-primary/5 hover:shadow-[0_14px_30px_rgba(15,23,42,0.08)]'
                  )}
                  title={t('nav.modulesLauncher', {
                    defaultValue: 'Open module launcher'
                  })}
                  aria-label={t('nav.modulesLauncher', {
                    defaultValue: 'Open module launcher'
                  })}
                >
                  <div
                    className={cn(
                      'absolute inset-[1px] rounded-[calc(1rem-1px)] bg-gradient-to-br transition-opacity duration-300',
                      isModuleLauncherRoute
                        ? 'from-primary/18 via-primary/8 to-transparent opacity-100'
                        : 'from-emerald-500/14 via-sky-500/8 to-transparent opacity-80'
                    )}
                  />
                  <ThemeAwareLogo className="relative z-10 h-6 w-6" />
                  <LayoutGrid
                    className={cn(
                      'absolute bottom-1.5 right-1.5 h-3.5 w-3.5 rounded-md bg-background/80 p-[2px] text-muted-foreground shadow-sm',
                      isModuleLauncherRoute && 'text-primary'
                    )}
                  />
                </button>
                {hasCapability('whatsappIntegration') && isTauri && location === '/whatsapp' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => whatsappManager.setEnabled(!whatsappManager.isEnabled())}
                    className={cn(
                      'h-8 px-2 gap-2 border-border/50 hover:bg-secondary/50 transition-all duration-300',
                      whatsappStatus === 'live' ? 'text-emerald-500' : 'text-red-500'
                    )}
                    title={whatsappStatus === 'live' ? 'Turn Off WhatsApp Webview' : 'Turn On WhatsApp Webview'}
                  >
                    <div
                      className={cn(
                        'w-2 h-2 rounded-full',
                        whatsappStatus === 'live'
                          ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                          : 'bg-red-500'
                      )}
                    />
                    <MessageSquare className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider hidden sm:inline">
                      {whatsappStatus === 'live' ? 'Live' : 'Off'}
                    </span>
                  </Button>
                )}
                {(!isTauri || isMobile()) && (
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('toggle-atlas-assistant'))
                      triggerHaptic('selection')
                    }}
                    className={cn(
                      'p-2 hover:bg-secondary border transition-all group',
                      assistantOpen
                        ? 'rounded-lg border-primary/20 bg-primary/10 text-primary'
                        : 'rounded-lg border-transparent text-muted-foreground hover:border-border hover:text-primary'
                    )}
                    title={t('assistant.title', {
                      defaultValue: 'Atlas Assistant'
                    })}
                    aria-label={t('assistant.title', {
                      defaultValue: 'Atlas Assistant'
                    })}
                  >
                    <Bot className="w-4 h-4" />
                  </button>
                )}
                <P2PSyncIndicator />
                {features.allowed_currencies.length > 1 && <ExchangeRateIndicator />}
                <div className="w-px h-4 bg-border mx-1" />
                {(!isTauri || isMobile()) && <NotificationCenter />}
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
            <main
              ref={pageContentRef}
              className={cn(
                'page-enter relative flex-1 min-h-0',
                location === '/whatsapp'
                  ? 'p-0'
                  : isPosLikeRoute
                    ? 'p-0 lg:p-6'
                    : 'p-4 lg:p-6 overflow-y-auto overscroll-contain custom-scrollbar'
              )}
            >
              <Suspense fallback={<PageLoading />}>{children}</Suspense>
              <ModuleLockerOverlay
                containerRef={pageContentRef}
                isLoading={isModuleLockerLoading}
                lock={activeModuleLock}
                onUnlock={(lock) => openModuleLockerDialog('unlock', lock.moduleHref, lock.moduleName)}
              />
            </main>
            {!activeModuleLock && !isModuleLockerLoading && <PageFind contentRef={pageContentRef} />}
          </div>

          {/* Sign Out Confirmation Modal */}
          {isDemoWorkspace(user?.workspaceCode) ? (
            <Dialog open={isSignOutModalOpen} onOpenChange={setIsSignOutModalOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    {t('demo.signOutTitle', 'Leaving Demo Workspace')}
                  </DialogTitle>
                  <DialogDescription>
                    {t(
                      'demo.signOutWarn',
                      'Signing out will permanently delete this demo workspace and all related demo data. Are you sure you want to continue?'
                    )}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" allowViewer={true} onClick={() => setIsSignOutModalOpen(false)}>
                    {t('common.cancel') || 'Cancel'}
                  </Button>
                  <Button
                    variant="destructive"
                    allowViewer={true}
                    onClick={async () => {
                      setIsSignOutModalOpen(false)
                      await signOut()
                    }}
                  >
                    {t('demo.deleteAndSignOut', 'Delete & Sign Out')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : (
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
                  <Button
                    variant="destructive"
                    allowViewer={true}
                    onClick={() => {
                      setIsSignOutModalOpen(false)
                      signOut()
                    }}
                  >
                    {t('auth.signOut') || 'Sign Out'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          <CurrencyConverterPopup open={currencyConverterOpen} onClose={() => setCurrencyConverterOpen(false)} />
          <WorkspaceUsageModal
            open={usageModalOpen}
            onOpenChange={setUsageModalOpen}
            usageMeter={webUsageMeter}
            onRefresh={refreshWebWorkspaceUsage}
            isRefreshing={isRefreshingWebWorkspaceUsage}
            paygSummary={webPaygSummary}
          />
          <AtlasAssistantPopup
            open={assistantOpen}
            initialQuery={assistantInitialQuery}
            onClose={() => setAssistantOpen(false)}
          />
          <ModuleLockerPasskeyDialog
            open={moduleLockerDialog !== null}
            action={moduleLockerDialog?.action ?? null}
            workspaceId={user?.workspaceId}
            moduleHref={moduleLockerDialog?.moduleHref}
            moduleName={moduleLockerDialog?.moduleName}
            actor={moduleLockerActor}
            onOpenChange={(open) => {
              if (!open) setModuleLockerDialog(null)
            }}
          />
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
      <p className="text-sm text-muted-foreground animate-pulse font-medium">
        {t('common.loading', 'Loading Page...')}
      </p>
    </div>
  )
}
