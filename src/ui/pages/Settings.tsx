import { useAuth } from '@/auth'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { isBackendConfigurationRequired, supabase } from '@/auth/supabase'
import { useSyncStatus, clearQueue } from '@/sync'
import { db, hasCurrencyExchangeAccountingData, listLocalCustomTemplates, saveRestaurantTableSettings, usePriceBookCatalogState, useRestaurantPosTickets, useRestaurantTableSettings } from '@/local-db'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button, Label, LanguageSwitcher, Input, CurrencySelector, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger, TabsContent, Switch, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, AppDialog, AppDialogBody, AppDialogContent, AppDialogDescription, AppDialogFooter, AppDialogHeader, AppDialogTitle, Textarea, useToast, RegisterWorkspaceContactsModal } from '@/ui/components'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import { useWorkspace } from '@/workspace'
import { Coins } from 'lucide-react'
import type { IQDDisplayPreference, CurrencyCode } from '@/local-db/models'
import { Settings as SettingsIcon, Database, Cloud, Trash2, RefreshCw, User, Copy, Check, CreditCard, Globe, Download, Upload, AlertCircle, Printer, Contact, Fingerprint, Store, ExternalLink, Usb, Bluetooth, CalendarClock, Plus, Menu, ShieldCheck, UsersRound, Table2, Crown } from 'lucide-react'
import { formatDate, formatDateTime, formatTime, cn, generateId, getHourDisplayPreference, setHourDisplayPreference, type HourDisplayPreference } from '@/lib/utils'
import { useTheme } from '@/ui/components/theme-provider'
import { Moon, Sun, Monitor, Unlock, Server, MessageSquare, Bell, MonitorPlay, Wifi } from 'lucide-react'
import { lazy, Suspense, useState, useEffect, useRef, type ChangeEvent } from 'react'
import { isAndroidPwa, isMobile, isDesktop, isTauri, isTauriAndroid } from '@/lib/platform'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { getAppSettingSync, setAppSetting } from '@/local-db/settings'
import { decrypt } from '@/lib/encryption'
import { checkForTauriUpdate } from '@/lib/tauriUpdater'
import { createUpdateSafetyBackupIfNeeded } from '@/local-db/sqliteBackup'
import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'
import { getMediaUploadErrorCode } from '@/services/mediaUploadService'
import { Image as ImageIcon } from 'lucide-react'
import { assetManager } from '@/lib/assetManager'
import { downloadWorkspaceResources } from '@/lib/workspaceResourceSync'
import { getMonthDisplayPreference, setMonthDisplayPreference, type MonthDisplayPreference } from '@/lib/monthDisplay'
import { getDateFilterDayBoundary, setDateFilterDayBoundary } from '@/lib/dateRangeFilters'
import { DateTimePicker } from '@/ui/components/ui/date-time-picker'
import { useWorkspaceContacts } from '@/local-db/hooks'
import { getManualRateSource, getManualRateValue, setExchangeRateSource as setStoredExchangeRateSource } from '@/lib/manualExchangeRates'
import type { ExchangeRateSource } from '@/lib/exchangeRate'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { DEFAULT_THERMAL_ROLL_WIDTH, THERMAL_ROLL_WIDTHS, isLikelyThermalPrinter, isVirtualPrinter, printService, type StoredThermalPrinter, type ThermalPrinterInfo, type ThermalRollWidth } from '@/services/printService'
// Notification imports moved to dynamic imports for cross-platform support
import { registerDeviceTokenIfNeeded } from '@/services/notificationDevice'
import { useKdsStream } from '@/hooks/useKdsStream'
import { useUsbBackup } from '@/hooks/useUsbBackup'
import { downloadDatabaseFile, injectLocalModeDatabaseFile } from '@/local-db/localModeSqlite'
import { downloadInvoicePdfArchive } from '@/services/invoicePdfExport'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { StorefrontCatalogRulesEditor } from '@/ui/components/marketplace/StorefrontCatalogRulesEditor'
import { PosAdjust } from '@/ui/components/pos/PosAdjust'
import { ReactQRCode } from '@lglab/react-qr-code'
import { BranchManager } from '@/ui/components/workspace/BranchManager'
import { canManageClinicalRegistryType } from '@/i18n/clinicalRegistry'
import { setClinicalRegistryType, useClinicalRegistryType } from '@/local-db/clinicalPresets'
import { openWorkspacePaymentStatusDialog } from '@/lib/workspacePayments'
import {
    areApplicationUpdatesDisabled,
    setApplicationUpdatesDisabled,
    UPDATE_PREFERENCE_CHANGED_EVENT
} from '@/lib/updatePreference'
import { requestPwaDeploymentUpdate } from '@/lib/pwaUpdateControl'
import { enrollLocalAccountCredential } from '@/auth/localAccountAuth'
import { ModuleLockerSettingsCard } from '@/ui/components/module-locker/ModuleLockerSettingsCard'
import { canChangeRestaurantTableConfiguration, normalizeRestaurantTableCount, normalizeVipTableNumbers } from '@/lib/restaurantTableView'
import { OfflineReadinessCard } from '@/ui/components/settings/OfflineReadinessCard'

const DeveloperTestButton = import.meta.env.DEV && __ATLAS_DEV_TESTING__
    ? lazy(() => import('@/dev/testing/DeveloperTestButton'))
    : null

function getDateFilterDayBoundaryDate(value: string) {
    const [hours, minutes] = value.split(':').map(Number)
    const date = new Date()
    date.setHours(hours || 0, minutes || 0, 0, 0)
    return date
}

function formatDateFilterDayBoundary(date: Date | undefined) {
    if (!date) return '00:00'
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function Settings() {
    const { user, signOut, isSupabaseConfigured, updateUser } = useAuth()
    const { syncState, pendingCount, lastSyncTime, sync, isSyncing, isOnline } = useSyncStatus()
    const { theme, setTheme, style, setStyle } = useTheme()
    const { features, updateSettings, refreshFeatures, workspaceName, isLocked, isLocalMode, isDemoMode, isHybridMode, hasFeature, hasCapability, planCapabilities } = useWorkspace()
    const { streamUrl, status: kdsStatus, startStream } = useKdsStream(true)

    useEffect(() => {
        if (isDesktop() && hasFeature('kds') && kdsStatus === 'idle') {
            startStream(4004).catch(console.error)
        }
    }, [hasFeature, kdsStatus, startStream])

    const { toast } = useToast()
    const { t, i18n } = useTranslation()
    const { alerts, forceAlert } = useExchangeRate()
    const restaurantTableSettings = useRestaurantTableSettings(user?.workspaceId)
    const restaurantTickets = useRestaurantPosTickets(user?.workspaceId, restaurantTableSettings?.liveSyncEnabled === true)
    const [copied, setCopied] = useState(false)
    const [isCurrencyModalOpen, setIsCurrencyModalOpen] = useState(false)
    const [pendingCurrency, setPendingCurrency] = useState<'usd' | 'iqd' | 'eur' | 'try' | null>(null)
    const [isPasswordChangeModalOpen, setIsPasswordChangeModalOpen] = useState(false)
    const [currentPasswordInput, setCurrentPasswordInput] = useState('')
    const [newPasswordInput, setNewPasswordInput] = useState('')
    const [repeatNewPasswordInput, setRepeatNewPasswordInput] = useState('')
    const [isPasswordChangeSaving, setIsPasswordChangeSaving] = useState(false)
    const [posHotkey, setPosHotkey] = useState(localStorage.getItem('pos_hotkey') || '')
    const [barcodeHotkey, setBarcodeHotkey] = useState(localStorage.getItem('barcode_hotkey') || '')
    const [isPosAdjustOpen, setIsPosAdjustOpen] = useState(false)
    const [posProductsPerRow, setPosProductsPerRow] = useState<number>(() => {
        const saved = localStorage.getItem('pos_products_per_row')
        return saved ? parseInt(saved, 10) : 4
    })
    const [posShowQuantityIndicator, setPosShowQuantityIndicator] = useState<boolean>(() => {
        return localStorage.getItem('pos_show_quantity_indicator') !== 'false'
    })
    const [posShowCategories, setPosShowCategories] = useState<boolean>(() => {
        return localStorage.getItem('pos_show_categories') === 'true'
    })
    const [posShowPreprintReceipt, setPosShowPreprintReceipt] = useState<boolean>(() => {
        return localStorage.getItem('pos_show_preprint_receipt') === 'true'
    })
    const [exchangeRateSource, setExchangeRateSource] = useState(getManualRateSource('USD'))
    const [eurExchangeRateSource, setEurExchangeRateSource] = useState(getManualRateSource('EUR'))
    const [tryExchangeRateSource, setTryExchangeRateSource] = useState(getManualRateSource('TRY'))
    const [exchangeRateThreshold, setExchangeRateThreshold] = useState(localStorage.getItem('exchange_rate_threshold') || '2500')
    const [whatsappAutoLaunch, setWhatsappAutoLaunch] = useState(localStorage.getItem('whatsapp_auto_launch') === 'true')
    const [hourDisplayPreference, setHourDisplayPreferenceState] = useState<HourDisplayPreference>(getHourDisplayPreference())
    const [monthDisplayPreference, setMonthDisplayPreferenceState] = useState<MonthDisplayPreference>(getMonthDisplayPreference())
    const [dateFilterDayBoundary, setDateFilterDayBoundaryState] = useState(getDateFilterDayBoundary)
    const [hasFxAccountingData, setHasFxAccountingData] = useState(false)
    const [isClinicalRegistrySaving, setIsClinicalRegistrySaving] = useState(false)
    const [partnerPrivacySaving, setPartnerPrivacySaving] = useState<
        'private_staff_customers' | 'private_staff_suppliers' | 'suppliers_admin_only' | null
    >(null)
    const [restaurantTableViewEnabled, setRestaurantTableViewEnabled] = useState(false)
    const [restaurantLiveSyncEnabled, setRestaurantLiveSyncEnabled] = useState(false)
    const [restaurantTableCount, setRestaurantTableCount] = useState('20')
    const [restaurantVipTables, setRestaurantVipTables] = useState<number[]>([])
    const [isRestaurantTableViewDirty, setIsRestaurantTableViewDirty] = useState(false)
    const [isRestaurantTableViewSaving, setIsRestaurantTableViewSaving] = useState(false)
    const restaurantSettingsHydrationKeyRef = useRef<string | null>(null)
    const clinicalRegistryType = useClinicalRegistryType(user?.workspaceId)
    const canManageClinicalRegistry = canManageClinicalRegistryType(
        user?.role,
        hasFeature('clinical_appointments'),
        clinicalRegistryType,
    )

    useEffect(() => {
        if (!restaurantTableSettings || isRestaurantTableViewDirty) return
        const hydrationKey = `${restaurantTableSettings.id}:${restaurantTableSettings.version}:${restaurantTableSettings.updatedAt}`
        if (restaurantSettingsHydrationKeyRef.current === hydrationKey) return
        restaurantSettingsHydrationKeyRef.current = hydrationKey
        setRestaurantTableViewEnabled(restaurantTableSettings.enabled)
        setRestaurantLiveSyncEnabled(restaurantTableSettings.liveSyncEnabled)
        setRestaurantTableCount(String(restaurantTableSettings.tableCount))
        setRestaurantVipTables(restaurantTableSettings.vipTableNumbers)
    }, [isRestaurantTableViewDirty, restaurantTableSettings])

    const saveRestaurantTableView = async () => {
        if (!user?.workspaceId || isRestaurantTableViewSaving) return
        const tableCount = normalizeRestaurantTableCount(Number(restaurantTableCount))
        if (!tableCount) {
            toast({
                title: t('common.error'),
                description: t('settings.restaurantTableView.invalidTableCount'),
                variant: 'destructive'
            })
            return
        }

        const activeTableNumbers = restaurantTickets.filter((ticket) => !ticket.isDeleted).map((ticket) => ticket.tableNumber)
        if (!canChangeRestaurantTableConfiguration({
            currentEnabled: restaurantTableSettings?.enabled ?? false,
            nextEnabled: restaurantTableViewEnabled,
            currentTableCount: restaurantTableSettings?.tableCount ?? tableCount,
            nextTableCount: tableCount,
            activeTableNumbers,
        })) {
            toast({
                title: t('common.error'),
                description: t('settings.restaurantTableView.activeTicketsBlocked'),
                variant: 'destructive'
            })
            return
        }

        setIsRestaurantTableViewSaving(true)
        try {
            const vipTableNumbers = normalizeVipTableNumbers(restaurantVipTables, tableCount)
            await saveRestaurantTableSettings({
                enabled: restaurantTableViewEnabled,
                liveSyncEnabled: restaurantLiveSyncEnabled,
                tableCount,
                vipTableNumbers,
            }, user.workspaceId)
            setRestaurantVipTables(vipTableNumbers)
            setIsRestaurantTableViewDirty(false)
            toast({ title: t('settings.restaurantTableView.saveSuccess') })
        } catch (error) {
            console.error('[Settings] Failed to save Restaurant Table View settings:', error)
            toast({
                title: t('common.error'),
                description: t('settings.restaurantTableView.saveError'),
                variant: 'destructive'
            })
        } finally {
            setIsRestaurantTableViewSaving(false)
        }
    }

    // Biometric State
    const [biometricEnabled, setBiometricEnabled] = useState(localStorage.getItem('biometric_enabled') === 'true')
    const [biometricFrequency, setBiometricFrequency] = useState(localStorage.getItem('biometric_frequency') || '24h')
    const [isBiometricDeleteModalOpen, setIsBiometricDeleteModalOpen] = useState(false)

    // Connection Settings State
    const [isClearDataDialogOpen, setIsClearDataDialogOpen] = useState(false)
    const [isElectron, setIsElectron] = useState(false)
    const [isConnectionSettingsUnlocked, setIsConnectionSettingsUnlocked] = useState(false)
    const [passkey, setPasskey] = useState('')
    const [customUrl, setCustomUrl] = useState(decrypt(getAppSettingSync('supabase_url') || ''))
    const [customKey, setCustomKey] = useState(decrypt(getAppSettingSync('supabase_anon_key') || ''))

    /* --- Connection Settings (Web) State Start --- */
    const [isWebConnectionUnlocked, setIsWebConnectionUnlocked] = useState(false)
    const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false)
    const [webPasskeyInput, setWebPasskeyInput] = useState('')

    const [isSyncMediaModalOpen, setIsSyncMediaModalOpen] = useState(false)
    const [expiryHours, setExpiryHours] = useState(24)
    const [mediaSyncProgress, setMediaSyncProgress] = useState<{ total: number, current: number, fileName: string } | null>(null)
    const [mediaDownloadProgress, setMediaDownloadProgress] = useState<{ total: number, current: number, fileName: string } | null>(null)
    const [localMediaCount, setLocalMediaCount] = useState<number | null>(null)
    const [isThermalDialogOpen, setIsThermalDialogOpen] = useState(false)
    const [availableThermalPrinters, setAvailableThermalPrinters] = useState<ThermalPrinterInfo[]>([])
    const [selectedThermalPrinter, setSelectedThermalPrinter] = useState<StoredThermalPrinter | null>(null)
    const [selectedThermalRollWidth, setSelectedThermalRollWidth] = useState<ThermalRollWidth>(DEFAULT_THERMAL_ROLL_WIDTH)
    const [isScanningThermalPrinters, setIsScanningThermalPrinters] = useState(false)
    const [isThermalActionPending, setIsThermalActionPending] = useState(false)
    const [autoPrintUponCheckout, setAutoPrintUponCheckout] = useState(() =>
        printService.isAutoPrintUponCheckoutEnabled(user?.workspaceId || '')
    )
    const [isAutoPrintUponCheckoutSaving, setIsAutoPrintUponCheckoutSaving] = useState(false)
    const [bleServiceUuid, setBleServiceUuid] = useState('')
    const [bleCharacteristicUuid, setBleCharacteristicUuid] = useState('')
    const [isInvoicePdfExporting, setIsInvoicePdfExporting] = useState(false)
    const [isDatabaseInjectionDialogOpen, setIsDatabaseInjectionDialogOpen] = useState(false)
    const [databaseFileToInject, setDatabaseFileToInject] = useState<File | null>(null)
    const [databaseUrlToInject, setDatabaseUrlToInject] = useState('')
    const [databaseInjectionError, setDatabaseInjectionError] = useState<string | null>(null)
    const [isInjectingDatabase, setIsInjectingDatabase] = useState(false)
    const databaseInjectionInputRef = useRef<HTMLInputElement>(null)
    const [thermalPrinterMessage, setThermalPrinterMessage] = useState<string | null>(null)
    const [showAllDetectedPrinters, setShowAllDetectedPrinters] = useState(false)
    const [marketplaceVisibility, setMarketplaceVisibility] = useState<'private' | 'public' | 'link_only'>(features.visibility || 'private')
    const [marketplaceSlug, setMarketplaceSlug] = useState(features.store_slug || '')
    const [marketplaceDescription, setMarketplaceDescription] = useState(features.store_description || '')
    const [marketplaceSlugStatus, setMarketplaceSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
    const [isSavingMarketplace, setIsSavingMarketplace] = useState(false)
    const [secondaryStorefront, setSecondaryStorefront] = useState<{ id: string; visibility: 'private' | 'public' | 'link_only'; slug: string; description: string | null } | null>(null)
    const [isSecondaryStorefrontLoading, setIsSecondaryStorefrontLoading] = useState(false)
    const [isSecondaryStorefrontActionPending, setIsSecondaryStorefrontActionPending] = useState(false)
    const [isSecondaryStorefrontRemoveConfirmOpen, setIsSecondaryStorefrontRemoveConfirmOpen] = useState(false)
    const [secondaryStorefrontVisibility, setSecondaryStorefrontVisibility] = useState<'private' | 'public' | 'link_only'>('private')
    const [secondaryStorefrontSlug, setSecondaryStorefrontSlug] = useState('')
    const [secondaryStorefrontDescription, setSecondaryStorefrontDescription] = useState('')
    const [secondaryStorefrontSlugStatus, setSecondaryStorefrontSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
    const canUseBarcodeScanner = hasCapability('barcodeScanner')
    const canUseThermalPrinter = hasCapability('thermalPrinter')
    const isAndroidDirectThermalPwa = isAndroidPwa()
    const isTauriAndroidApp = isTauriAndroid()
    const directMobileThermalCapabilities = printService.getDirectMobileThermalCapabilities()
    const canUseA4Invoices = hasCapability('a4PdfInvoices')
    const canUseReceiptPrinting = hasCapability('receiptPrinting')
    const canUseMultiCurrency = features.allowed_currencies.length > 1
    const canUseMarketplace = hasCapability('marketplaceStorefronts')
    const canUsePriceBooks = hasCapability('priceBooks')
    const priceBookCatalog = usePriceBookCatalogState(user?.workspaceId, {
        enabled: Boolean(user?.workspaceId) && canUseMarketplace && canUsePriceBooks
    })
    const canUseWhatsapp = hasCapability('whatsappIntegration')
    const canUseMultipleContacts = hasCapability('multipleWorkspaceContacts')
    const canUseBranches = planCapabilities.limits.maxBranches > 0

    const usbBackup = useUsbBackup()

    useEffect(() => {
        let cancelled = false
        hasCurrencyExchangeAccountingData(user?.workspaceId).then((hasData) => {
            if (!cancelled) {
                setHasFxAccountingData(hasData)
            }
        })
        return () => {
            cancelled = true
        }
    }, [user?.workspaceId])

    const activeSupabaseUrl = isBackendConfigurationRequired
        ? (customUrl || '')
        : (import.meta.env.VITE_SUPABASE_URL || customUrl || '')
    const activeSupabaseKey = isBackendConfigurationRequired
        ? (customKey || '')
        : (import.meta.env.VITE_SUPABASE_ANON_KEY || customKey || '')
    /* --- Connection Settings (Web) State End --- */

    const [contactsModalOpen, setContactsModalOpen] = useState(false)
    const workspaceContacts = useWorkspaceContacts(user?.workspaceId)

    const [version, setVersion] = useState('')

    const showActionError = (error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({
                title: message.title,
                description: message.description,
                variant: 'destructive'
            })
            return
        }

        toast({
            title: t('common.error') || 'Error',
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }

    useEffect(() => {
        setAutoPrintUponCheckout(printService.isAutoPrintUponCheckoutEnabled(user?.workspaceId || ''))
    }, [user?.workspaceId])

    const handleAutoPrintUponCheckoutChange = async (enabled: boolean) => {
        if (!user?.workspaceId || isAutoPrintUponCheckoutSaving) return

        const previousValue = autoPrintUponCheckout
        setAutoPrintUponCheckout(enabled)
        setIsAutoPrintUponCheckoutSaving(true)

        try {
            await printService.setAutoPrintUponCheckoutEnabled(user.workspaceId, enabled)
        } catch (error) {
            setAutoPrintUponCheckout(previousValue)
            showActionError(error, t('settings.printing.autoPrintUponCheckoutSaveError'))
        } finally {
            setIsAutoPrintUponCheckoutSaving(false)
        }
    }

    const handleClinicalRegistryTypeChange = async (useBeautyCenterTerms: boolean) => {
        if (!user?.workspaceId || isClinicalRegistrySaving || clinicalRegistryType === 'beauty2') return

        setIsClinicalRegistrySaving(true)
        try {
            await setClinicalRegistryType(
                user.workspaceId,
                useBeautyCenterTerms ? 'beauty' : 'medical',
                user.id,
            )
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.clinicalRegistry.saveSuccess', {
                    defaultValue: 'Appointment registry type updated for this workspace.',
                }),
            })
        } catch (error) {
            showActionError(error, t('settings.clinicalRegistry.saveError', {
                defaultValue: 'Failed to update the appointment registry type.',
            }))
        } finally {
            setIsClinicalRegistrySaving(false)
        }
    }

    const handlePartnerPrivacyChange = async (
        key: 'private_staff_customers' | 'private_staff_suppliers' | 'suppliers_admin_only',
        value: boolean
    ) => {
        if (partnerPrivacySaving) return

        setPartnerPrivacySaving(key)
        try {
            await updateSettings({ [key]: value })
            toast({
                title: t('settings.partnerPrivacy.savedTitle'),
                description: t('settings.partnerPrivacy.savedDescription')
            })
        } catch (error) {
            showActionError(error, t('settings.partnerPrivacy.saveError'))
        } finally {
            setPartnerPrivacySaving(null)
        }
    }

    const loadSelectedThermalPrinter = async () => {
        if (!user?.workspaceId) {
            setSelectedThermalPrinter(null)
            setSelectedThermalRollWidth(DEFAULT_THERMAL_ROLL_WIDTH)
            return
        }

        const selection = await printService.getSelectedThermalPrinter(user.workspaceId)
        setSelectedThermalPrinter(selection)
        if (selection?.bluetooth) {
            setBleServiceUuid(selection.bluetooth.service_uuid)
            setBleCharacteristicUuid(selection.bluetooth.characteristic_uuid)
        }
        if (selection?.roll_width_mm) {
            setSelectedThermalRollWidth(selection.roll_width_mm)
        } else if (selection?.paper_size === 'Mm58') {
            setSelectedThermalRollWidth(58)
        } else {
            setSelectedThermalRollWidth(DEFAULT_THERMAL_ROLL_WIDTH)
        }
    }

    const scanThermalPrinters = async () => {
        setThermalPrinterMessage(null)
        setShowAllDetectedPrinters(false)

        setIsScanningThermalPrinters(true)
        try {
            const printers = await printService.listThermalPrinters()
            setAvailableThermalPrinters(printers)

            const likelyThermalCount = printers.filter(isLikelyThermalPrinter).length
            const visiblePrinterCount = printers.filter((printer) => !isVirtualPrinter(printer)).length

            if (printers.length === 0) {
                setThermalPrinterMessage(t('settings.printing.noThermalPrinters', {
                    defaultValue: 'No thermal printers were detected on this device.'
                }))
            } else if (likelyThermalCount === 0) {
                setThermalPrinterMessage(
                    visiblePrinterCount > 0
                        ? t('settings.printing.noLikelyThermalPrinters', {
                            defaultValue: 'No likely thermal printers were detected. Virtual and document printers were hidden from the list by default.'
                        })
                        : t('settings.printing.noThermalPrinters', {
                            defaultValue: 'No thermal printers were detected on this device.'
                        })
                )
            }
        } catch (error) {
            console.error('[Settings] Failed to scan thermal printers:', error)
            setAvailableThermalPrinters([])
            setThermalPrinterMessage(
                error instanceof Error && error.message
                    ? error.message
                    : normalizeSupabaseActionError(error).message
                        || t('settings.printing.thermalScanError', { defaultValue: 'Failed to scan thermal printers.' })
            )
        } finally {
            setIsScanningThermalPrinters(false)
        }
    }

    const openThermalPrinterDialog = () => {
        setIsThermalDialogOpen(true)
    }

    const addPairedThermalPrinter = (printer: ThermalPrinterInfo, message: string) => {
        setAvailableThermalPrinters((current) => [
            printer,
            ...current.filter((item) => item.identifier !== printer.identifier)
        ])
        setShowAllDetectedPrinters(true)
        setThermalPrinterMessage(message)
    }

    const handlePairUsbThermalPrinter = async () => {
        setIsThermalActionPending(true)
        setThermalPrinterMessage(null)
        try {
            const printer = await printService.pairUsbThermalPrinter()
            addPairedThermalPrinter(printer, 'USB printer paired. Choose Enable to use it for POS receipts.')
        } catch (error) {
            showActionError(error, t('settings.printing.usbThermalPairError', {
                defaultValue: 'Could not pair the USB thermal printer.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const handlePairBluetoothThermalPrinter = async () => {
        setIsThermalActionPending(true)
        setThermalPrinterMessage(null)
        try {
            const printer = await printService.pairBluetoothThermalPrinter({
                serviceUuid: bleServiceUuid,
                characteristicUuid: bleCharacteristicUuid
            })
            addPairedThermalPrinter(printer, 'Bluetooth LE printer paired. Choose Enable to use it for POS receipts.')
        } catch (error) {
            showActionError(error, t('settings.printing.bluetoothThermalPairError', {
                defaultValue: 'Could not pair the Bluetooth LE thermal printer.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const handleEnableThermalPrinter = async (printer: ThermalPrinterInfo) => {
        if (!user?.workspaceId) return

        setIsThermalActionPending(true)
        try {
            const selection = await printService.setSelectedThermalPrinter(user.workspaceId, printer, selectedThermalRollWidth)
            setSelectedThermalPrinter(selection)
            await updateSettings({ thermal_printing: true })

            toast({
                title: t('settings.printing.thermalEnabledTitle', { defaultValue: 'Thermal printing enabled' }),
                description: t('settings.printing.thermalEnabledDesc', {
                    defaultValue: `Receipt printing will use ${printer.name} on this device.`
                })
            })
        } catch (error) {
            showActionError(error, t('settings.printing.thermalEnableError', {
                defaultValue: 'Failed to enable thermal printing.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const handleThermalRollWidthChange = async (value: string) => {
        const nextValue = Number(value) as ThermalRollWidth
        setSelectedThermalRollWidth(nextValue)

        if (!user?.workspaceId || !selectedThermalPrinter) return

        setIsThermalActionPending(true)
        try {
            const selection = await printService.setSelectedThermalPrinter(user.workspaceId, {
                name: selectedThermalPrinter.name,
                interface_type: selectedThermalPrinter.interface_type,
                identifier: selectedThermalPrinter.identifier,
                status: selectedThermalPrinter.status,
                transport: selectedThermalPrinter.transport ?? (isDesktop() ? 'tauri' : isTauriAndroidApp ? 'tauri-android-bluetooth' : 'qz'),
                usb: selectedThermalPrinter.usb,
                bluetooth: selectedThermalPrinter.bluetooth
            }, nextValue)
            setSelectedThermalPrinter(selection)
        } catch (error) {
            showActionError(error, t('settings.printing.thermalRollWidthError', {
                defaultValue: 'Failed to update the receipt roll width.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const handleDisableThermalPrinting = async () => {
        setIsThermalActionPending(true)
        try {
            await updateSettings({ thermal_printing: false })
            toast({
                title: t('settings.printing.thermalDisabledTitle', { defaultValue: 'Thermal printing disabled' }),
                description: t('settings.printing.thermalDisabledDesc', {
                    defaultValue: 'POS receipts will fall back to the regular print flow on this device.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.printing.thermalDisableError', {
                defaultValue: 'Failed to disable thermal printing.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const handleTestThermalPrinter = async () => {
        if (!user?.workspaceId || !selectedThermalPrinter) return

        setIsThermalActionPending(true)
        try {
            await printService.testThermalPrinter(user.workspaceId, selectedThermalPrinter)
            toast({
                title: t('settings.printing.thermalTestSuccessTitle', { defaultValue: 'Test receipt sent' }),
                description: t('settings.printing.thermalTestSuccessDesc', {
                    defaultValue: `A test receipt was sent to ${selectedThermalPrinter.name}.`
                })
            })
        } catch (error) {
            showActionError(error, t('settings.printing.thermalTestError', {
                defaultValue: 'Could not print a thermal printer test receipt.'
            }))
        } finally {
            setIsThermalActionPending(false)
        }
    }

    const detectedNonVirtualPrinters = availableThermalPrinters.filter((printer) => !isVirtualPrinter(printer))
    const likelyThermalPrinters = detectedNonVirtualPrinters.filter(isLikelyThermalPrinter)
    const hiddenPrinterCount = detectedNonVirtualPrinters.length - likelyThermalPrinters.length
    const displayedThermalPrinters = showAllDetectedPrinters ? detectedNonVirtualPrinters : likelyThermalPrinters
    const selectedRollWidthLabel = THERMAL_ROLL_WIDTHS.find((option) => option.value === selectedThermalRollWidth)?.label
        || `${selectedThermalRollWidth} mm`

    useEffect(() => {
        // @ts-ignore
        const isTauri = !!window.__TAURI_INTERNALS__
        setIsElectron(isTauri)

        if (isTauri) {
            import('@tauri-apps/api/app').then(({ getVersion }) => {
                getVersion().then(setVersion).catch(console.error)
            })
        }
    }, [])

    useEffect(() => {
        void loadSelectedThermalPrinter()
    }, [user?.workspaceId])

    useEffect(() => {
        if (!isThermalDialogOpen) return

        void loadSelectedThermalPrinter()
        if (isDesktop()) {
            void scanThermalPrinters()
        } else if (isAndroidDirectThermalPwa) {
            setAvailableThermalPrinters([])
            setThermalPrinterMessage('Pair a USB printer first. Bluetooth LE is also available when you enter the printer service and write-characteristic UUIDs.')
        } else if (isTauriAndroidApp) {
            setAvailableThermalPrinters([])
            setThermalPrinterMessage(t('settings.printing.androidBluetoothClassicHint', {
                defaultValue: 'Pair a Bluetooth Classic printer in Android Settings, then refresh the paired-printer list here.'
            }))
        } else {
            setAvailableThermalPrinters([])
            setThermalPrinterMessage('Install and run QZ Tray, then select Connect & Scan to choose a printer for this PWA.')
        }
    }, [isThermalDialogOpen, user?.workspaceId, isElectron, isAndroidDirectThermalPwa, isTauriAndroidApp, t])

    const [updateStatus, setUpdateStatus] = useState<any>(null)
    const [updatesDisabled, setUpdatesDisabled] = useState(() => areApplicationUpdatesDisabled())
    const [localWorkspaceName, setLocalWorkspaceName] = useState(workspaceName || '')
    const marketplaceSlugPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
    const marketplaceBaseOrigin = (() => {
        const configuredOrigin = (import.meta.env.VITE_MARKETPLACE_SITE_URL || '').trim().replace(/\/+$/, '')
        if (configuredOrigin) return configuredOrigin
        if (typeof window !== 'undefined' && /^https?:$/i.test(window.location.protocol)) {
            if (window.location.hostname === 'shop.atlaserp.dev') {
                return window.location.origin
            }
        }
        return 'https://shop.atlaserp.dev'
    })()
    const normalizedMarketplaceSlug = marketplaceSlug
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 40)
    const marketplacePreviewUrl = normalizedMarketplaceSlug && marketplaceBaseOrigin
        ? `${marketplaceBaseOrigin}/s/${normalizedMarketplaceSlug}`
        : ''
    const normalizedSecondaryStorefrontSlug = secondaryStorefrontSlug
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 40)
    const secondaryStorefrontPreviewUrl = normalizedSecondaryStorefrontSlug && marketplaceBaseOrigin
        ? `${marketplaceBaseOrigin}/s/${normalizedSecondaryStorefrontSlug}`
        : ''

    useEffect(() => {
        if (workspaceName !== null) {
            setLocalWorkspaceName(workspaceName)
        }
    }, [workspaceName])

    useEffect(() => {
        setMarketplaceVisibility(features.visibility || 'private')
        setMarketplaceSlug(features.store_slug || '')
        setMarketplaceDescription(features.store_description || '')
    }, [features.store_description, features.store_slug, features.visibility])

    useEffect(() => {
        if (user?.role !== 'admin' || isLocalMode || !isSupabaseConfigured) {
            setMarketplaceSlugStatus('idle')
            return
        }

        if (!normalizedMarketplaceSlug) {
            setMarketplaceSlugStatus('idle')
            return
        }

        if (!marketplaceSlugPattern.test(normalizedMarketplaceSlug)) {
            setMarketplaceSlugStatus('invalid')
            return
        }

        if (normalizedMarketplaceSlug === (features.store_slug || '')) {
            setMarketplaceSlugStatus('available')
            return
        }

        let isCancelled = false
        setMarketplaceSlugStatus('checking')

        const timer = setTimeout(async () => {
            try {
                const { data, error } = await runSupabaseAction('settings.checkStoreSlug', () =>
                    supabase.rpc('check_store_slug_available', { p_slug: normalizedMarketplaceSlug }),
                    { timeoutMs: 12000, platform: 'all' }
                ) as { data: boolean | null; error: Error | null }

                if (isCancelled) return

                if (error) {
                    throw error
                }

                setMarketplaceSlugStatus(data ? 'available' : 'taken')
            } catch {
                if (!isCancelled) {
                    setMarketplaceSlugStatus('idle')
                }
            }
        }, 350)

        return () => {
            isCancelled = true
            clearTimeout(timer)
        }
    }, [features.store_slug, isLocalMode, isSupabaseConfigured, normalizedMarketplaceSlug, user?.role])

    useEffect(() => {
        if (user?.role !== 'admin' || isLocalMode || !isSupabaseConfigured || !secondaryStorefront) {
            setSecondaryStorefrontSlugStatus('idle')
            return
        }

        if (!normalizedSecondaryStorefrontSlug) {
            setSecondaryStorefrontSlugStatus('idle')
            return
        }

        if (!marketplaceSlugPattern.test(normalizedSecondaryStorefrontSlug)) {
            setSecondaryStorefrontSlugStatus('invalid')
            return
        }

        if (normalizedSecondaryStorefrontSlug === (secondaryStorefront.slug || '')) {
            setSecondaryStorefrontSlugStatus('available')
            return
        }

        let isCancelled = false
        setSecondaryStorefrontSlugStatus('checking')

        const timer = setTimeout(async () => {
            try {
                const { data, error } = await runSupabaseAction('settings.checkStorefrontSlug', () =>
                    supabase.rpc('check_storefront_slug_available', {
                        p_slug: normalizedSecondaryStorefrontSlug,
                        p_exclude_storefront_id: secondaryStorefront.id
                    }),
                    { timeoutMs: 12000, platform: 'all' }
                ) as { data: boolean | null; error: Error | null }

                if (isCancelled) return

                if (error) {
                    throw error
                }

                setSecondaryStorefrontSlugStatus(data ? 'available' : 'taken')
            } catch {
                if (!isCancelled) {
                    setSecondaryStorefrontSlugStatus('idle')
                }
            }
        }, 350)

        return () => {
            isCancelled = true
            clearTimeout(timer)
        }
    }, [isLocalMode, isSupabaseConfigured, normalizedSecondaryStorefrontSlug, secondaryStorefront, user?.role])

    useEffect(() => {
        if (user?.role !== 'admin' || isLocalMode || !isSupabaseConfigured || !user?.workspaceId) {
            setSecondaryStorefront(null)
            return
        }

        let isCancelled = false

        const load = async () => {
            setIsSecondaryStorefrontLoading(true)
            try {
                const { data, error } = await runSupabaseAction('settings.fetchSecondaryStorefront', () =>
                    supabase
                        .from('workspace_storefronts')
                        .select('id, visibility, slug, description')
                        .eq('workspace_id', user.workspaceId!)
                        .limit(1)
                        .maybeSingle(),
                    { timeoutMs: 12000, platform: 'all' }
                ) as { data: { id: string; visibility: 'private' | 'public' | 'link_only'; slug: string; description: string | null } | null; error: Error | null }

                if (isCancelled) return

                if (error) {
                    throw error
                }

                setSecondaryStorefront(data)
            } catch (error) {
                console.error('[Settings] Failed to load the additional storefront:', error)
            } finally {
                if (!isCancelled) {
                    setIsSecondaryStorefrontLoading(false)
                }
            }
        }

        void load()

        return () => {
            isCancelled = true
        }
    }, [isLocalMode, isSupabaseConfigured, user?.role, user?.workspaceId])

    useEffect(() => {
        setSecondaryStorefrontVisibility(secondaryStorefront?.visibility ?? 'private')
        setSecondaryStorefrontSlug(secondaryStorefront?.slug ?? '')
        setSecondaryStorefrontDescription(secondaryStorefront?.description ?? '')
    }, [secondaryStorefront])

    useEffect(() => {
        const syncUpdatePreference = () => setUpdatesDisabled(areApplicationUpdatesDisabled())
        window.addEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncUpdatePreference)
        return () => window.removeEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncUpdatePreference)
    }, [])

    const handleUpdatesDisabledChange = (disabled: boolean) => {
        setApplicationUpdatesDisabled(disabled)
        setUpdatesDisabled(disabled)
        setUpdateStatus(disabled ? { status: 'disabled' } : null)
        toast({
            title: disabled ? 'Updates disabled' : 'Updates enabled',
            description: disabled
                ? 'This installed app will stay on its current version until updates are enabled again.'
                : 'Atlas can now check for and apply the latest version.'
        })
    }

    // Tauri updater doesn't use event listeners for status in the same way, logic is inside handleCheckForUpdates

    const handleCheckForUpdates = async () => {
        if (updatesDisabled) {
            setUpdateStatus({ status: 'disabled' })
            return
        }

        if (!isElectron) {
            requestPwaDeploymentUpdate()
            toast({
                title: 'Checking for updates',
                description: 'Atlas will reload only if a newer deployed version is available.'
            })
            return
        }

        setUpdateStatus({ status: 'checking' })
        try {
            if (isMobile()) {
                console.log('[Settings] Android custom update check...')
                const { getVersion } = await import('@tauri-apps/api/app')

                const currentVersion = await getVersion()

                const response = await fetch('https://asaas-r2-proxy.alanepic360.workers.dev/atlas-updates/latest.json', { cache: 'no-store' })

                if (response.ok) {
                    const data = await response.json()
                    if (data.version && data.version !== currentVersion) {
                        setUpdateStatus({ status: 'available', version: data.version });

                        let downloadUrl = data.android?.url || data.platforms?.android?.url
                        if (!downloadUrl && data.platforms) {
                            const androidKey = Object.keys(data.platforms).find(k => k.startsWith('android'))
                            if (androidKey) {
                                downloadUrl = data.platforms[androidKey].url
                            }
                        }

                        if (downloadUrl) {
                            console.log('[Settings] Opening Android APK URL via system browser:', downloadUrl)
                            const { openUrl } = await import('@tauri-apps/plugin-opener')
                            await openUrl(downloadUrl)
                            setUpdateStatus({ status: 'downloaded' })
                        } else {
                            console.error('[Settings] Android APK URL not found in JSON')
                            setUpdateStatus({ status: 'error', message: 'APK download URL not found' })
                        }
                    } else {
                        setUpdateStatus({ status: 'not-available' });
                    }
                } else {
                    setUpdateStatus({ status: 'error', message: `Update check failed: ${response.statusText}` })
                }
                return
            }

            const update = await checkForTauriUpdate();
            if (update) {
                setUpdateStatus({ status: 'available', version: update.version });

                let downloaded = 0;
                let contentLength = 0;

                await update.download((event) => {
                    switch (event.event) {
                        case 'Started':
                            contentLength = event.data.contentLength || 0;
                            break;
                        case 'Progress':
                            downloaded += event.data.chunkLength;
                            if (contentLength > 0) {
                                const percent = (downloaded / contentLength) * 100;
                                setUpdateStatus({ status: 'progress', progress: percent });
                            }
                            break;
                        case 'Finished':
                            setUpdateStatus({ status: 'downloaded' });
                            break;
                    }
                });

                await createUpdateSafetyBackupIfNeeded(user?.workspaceId)
                await update.install()
                setUpdateStatus({ status: 'downloaded' });
            } else {
                setUpdateStatus({ status: 'not-available' });
            }
        } catch (error) {
            console.error('Update failed:', error);
            setUpdateStatus({ status: 'error', message: String(error) });
        }
    }

    const handleHotkeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.slice(0, 1).toLowerCase()
        setPosHotkey(val)
        localStorage.setItem('pos_hotkey', val)
    }

    const handleBarcodeHotkeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.slice(0, 1).toLowerCase()
        setBarcodeHotkey(val)
        localStorage.setItem('barcode_hotkey', val)
    }

    // Sync local state when localStorage changes from other components (like Manual Editor Modal)
    useEffect(() => {
        const syncSources = () => {
            setExchangeRateSource(getManualRateSource('USD'))
            setEurExchangeRateSource(getManualRateSource('EUR'))
            setTryExchangeRateSource(getManualRateSource('TRY'))
        }
        window.addEventListener('exchange-rate-refresh', syncSources)
        return () => window.removeEventListener('exchange-rate-refresh', syncSources)
    }, [])

    const handleExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = getManualRateValue('USD');
            if (!currentRate) {
                openManualEditor('USD');
                return;
            }
        }
        setExchangeRateSource(val as ExchangeRateSource)
        setStoredExchangeRateSource('USD', val as ExchangeRateSource)
        // Notify the indicator to refresh instantly
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleEurExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = getManualRateValue('EUR');
            if (!currentRate) {
                openManualEditor('EUR');
                return;
            }
        }
        setEurExchangeRateSource(val as ExchangeRateSource)
        setStoredExchangeRateSource('EUR', val as ExchangeRateSource)
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleTryExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = getManualRateValue('TRY');
            if (!currentRate) {
                openManualEditor('TRY');
                return;
            }
        }
        setTryExchangeRateSource(val as ExchangeRateSource)
        setStoredExchangeRateSource('TRY', val as ExchangeRateSource)
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleThresholdChange = (val: string) => {
        setExchangeRateThreshold(val)
        localStorage.setItem('exchange_rate_threshold', val)
    }

    const handleCurrencySelect = (val: CurrencyCode) => {
        if (hasFxAccountingData && val !== features.default_currency) {
            toast({
                title: t('currencyExchange.messages.workspaceCurrencyLockedTitle'),
                description: t('currencyExchange.messages.workspaceCurrencyLockedDescription'),
                variant: 'destructive'
            })
            return
        }
        setPendingCurrency(val)
        setIsCurrencyModalOpen(true)
    }

    const confirmCurrencyChange = async () => {
        if (pendingCurrency) {
            try {
                await updateSettings({ default_currency: pendingCurrency })
                setPendingCurrency(null)
                setIsCurrencyModalOpen(false)
            } catch (error: any) {
                const isFxCurrencyLock = String(error?.message || '').includes('Currency Exchange has safes or transactions')
                toast({
                    title: t('currencyExchange.messages.workspaceCurrencyLockedTitle'),
                    description: isFxCurrencyLock
                        ? t('currencyExchange.messages.workspaceCurrencyLockedDescription')
                        : error?.message || t('currencyExchange.messages.workspaceCurrencyLockedDescription'),
                    variant: 'destructive'
                })
            }
        }
    }

    const handleWhatsappAutoLaunchChange = (val: boolean) => {
        setWhatsappAutoLaunch(val)
        localStorage.setItem('whatsapp_auto_launch', String(val))
    }

    const openManualEditor = (currency: 'USD' | 'EUR' | 'TRY' = 'USD') => {
        window.dispatchEvent(new CustomEvent('open-manual-rate-editor', { detail: { currency } }))
    }

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const handleClearSyncQueue = async () => {
        if (confirm(t('settings.messages.clearQueueConfirm'))) {
            await clearQueue()
        }
    }

    const handleClearLocalData = () => {
        setIsClearDataDialogOpen(true)
    }

    const resetPasswordChangeForm = () => {
        setCurrentPasswordInput('')
        setNewPasswordInput('')
        setRepeatNewPasswordInput('')
    }

    const handlePasswordChangeModalOpenChange = (open: boolean) => {
        if (!open && isPasswordChangeSaving) return

        setIsPasswordChangeModalOpen(open)
        if (!open) {
            resetPasswordChangeForm()
        }
    }

    const handlePasswordChange = async () => {
        if (!user?.email || !isSupabaseConfigured || isDemoMode) {
            toast({
                title: t('settings.passwordChange.unavailableTitle', { defaultValue: 'Password change unavailable' }),
                description: t('settings.passwordChange.unavailableDescription', { defaultValue: 'A connected account is required to change the password.' }),
                variant: 'destructive',
            })
            return
        }

        if (!currentPasswordInput || !newPasswordInput || !repeatNewPasswordInput) {
            toast({
                title: t('settings.passwordChange.incompleteTitle', { defaultValue: 'Complete all fields' }),
                description: t('settings.passwordChange.incompleteDescription', { defaultValue: 'Enter the current password and the new password twice.' }),
                variant: 'destructive',
            })
            return
        }

        if (newPasswordInput !== repeatNewPasswordInput) {
            toast({
                title: t('settings.passwordChange.mismatchTitle', { defaultValue: 'Passwords do not match' }),
                description: t('settings.passwordChange.mismatchDescription', { defaultValue: 'Repeat the new password exactly.' }),
                variant: 'destructive',
            })
            return
        }

        if (newPasswordInput.length < 8) {
            toast({
                title: t('settings.passwordChange.tooShortTitle', { defaultValue: 'Password is too short' }),
                description: t('settings.passwordChange.tooShortDescription', { defaultValue: 'Use at least 8 characters for the new password.' }),
                variant: 'destructive',
            })
            return
        }

        if (currentPasswordInput === newPasswordInput) {
            toast({
                title: t('settings.passwordChange.samePasswordTitle', { defaultValue: 'Choose a different password' }),
                description: t('settings.passwordChange.samePasswordDescription', { defaultValue: 'The new password must be different from the current password.' }),
                variant: 'destructive',
            })
            return
        }

        let passwordWasChanged = false
        let passwordBackupWasStored = false
        setIsPasswordChangeSaving(true)
        try {
            const { error: verificationError } = await runSupabaseAction(
                'settings.verifyCurrentPassword',
                () => supabase.auth.signInWithPassword({
                    email: user.email,
                    password: currentPasswordInput,
                }),
                { timeoutMs: 15000, platform: 'all' },
            ) as { error: Error | null }

            if (verificationError) {
                throw new Error(t('settings.passwordChange.incorrectCurrentPassword', { defaultValue: 'The current password is incorrect.' }))
            }

            const { error: updatePasswordError } = await runSupabaseAction(
                'settings.updatePassword',
                () => supabase.auth.updateUser({ password: newPasswordInput }),
                { timeoutMs: 15000, platform: 'all' },
            ) as { error: Error | null }

            if (updatePasswordError) {
                throw updatePasswordError
            }
            passwordWasChanged = true

            const { error: passwordBackupError } = await runSupabaseAction(
                'settings.storePlaintextPassword',
                () => supabase.rpc('store_current_user_password_backup', {
                    p_new_password: newPasswordInput,
                }),
                { timeoutMs: 15000, platform: 'all' },
            ) as { error: Error | null }

            if (passwordBackupError) {
                throw passwordBackupError
            }
            passwordBackupWasStored = true

            if ((isLocalMode || isHybridMode) && user.workspaceId) {
                await enrollLocalAccountCredential({
                    workspaceId: user.workspaceId,
                    userId: user.id,
                    email: user.email,
                    password: newPasswordInput,
                })
            }

            setIsPasswordChangeModalOpen(false)
            resetPasswordChangeForm()
            toast({
                title: t('settings.passwordChange.successTitle', { defaultValue: 'Password changed' }),
                description: t('settings.passwordChange.successDescription', { defaultValue: 'Your new password has been saved.' }),
            })
        } catch (error) {
            console.error('[Settings] Failed to change password:', error)
            toast({
                title: !passwordWasChanged
                    ? t('settings.passwordChange.failedTitle', { defaultValue: 'Password change failed' })
                    : passwordBackupWasStored
                        ? t('settings.passwordChange.localAccessUpdateFailedTitle', { defaultValue: 'Password changed, but local access update failed' })
                        : t('settings.passwordChange.backupFailedTitle', { defaultValue: 'Password changed, but backup failed' }),
                description: !passwordWasChanged
                    ? normalizeSupabaseActionError(error).message
                    : passwordBackupWasStored
                        ? t('settings.passwordChange.localAccessUpdateFailedDescription', { defaultValue: 'Your password and its admin copy were saved, but the local offline credential could not be updated.' })
                        : t('settings.passwordChange.backupFailedDescription', { defaultValue: 'Your new password is active, but its copy could not be stored. Contact an administrator.' }),
                variant: 'destructive',
            })
        } finally {
            setIsPasswordChangeSaving(false)
        }
    }

    const handleConfirmClearAllData = async () => {
        try {
            // 1. Clear IndexedDB (Dexie)
            await db.delete()

            // 2. Clear LocalStorage
            localStorage.clear()

            // 3. Clear SessionStorage
            sessionStorage.clear()

            // 4. Clear Service Worker Caches
            if ('caches' in window) {
                const cacheNames = await caches.keys()
                await Promise.all(cacheNames.map(name => caches.delete(name)))
            }

            // 5. Force complete reload to root
            window.location.href = '/'
        } catch (error) {
            console.error('[Settings] Failed to clear all local data:', error)
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.messages.clearDataError') || 'Failed to clear local data. Please try again.',
                variant: 'destructive'
            })
            setIsClearDataDialogOpen(false)
        }
    }

    const handleSubscribeToNotifications = async () => {
        if (isDemoMode) {
            toast({
                title: t('notifications.localModeUnavailable', { defaultValue: 'Cloud notifications are unavailable in Demo Mode.' }),
            })
            return
        }

        try {
            let permissionGranted = false

            if (isElectron) {
                // Tauri-specific permission check
                const { isPermissionGranted: tauriIsGranted, requestPermission: tauriRequest } = await import('@tauri-apps/plugin-notification')
                permissionGranted = await tauriIsGranted()
                if (!permissionGranted) {
                    const permission = await tauriRequest()
                    permissionGranted = permission === 'granted'
                }
            } else {
                // Standard browser permission check
                if (!("Notification" in window)) {
                    toast({
                        title: 'Not Supported',
                        description: 'This browser does not support desktop notifications.',
                        variant: 'destructive'
                    })
                    return
                }
                const permission = await Notification.requestPermission()
                permissionGranted = permission === 'granted'
            }

            if (permissionGranted) {
                if (user?.id) {
                    await registerDeviceTokenIfNeeded(user.id, i18n.resolvedLanguage ?? i18n.language)
                }
                toast({
                    title: t('settings.notifications.subscribedTitle') || 'Subscribed',
                    description: t('settings.notifications.subscribedDesc') || 'Successfully subscribed to push notifications.'
                })
            } else {
                toast({
                    title: t('settings.notifications.deniedTitle') || 'Permission Denied',
                    description: t('settings.notifications.deniedDesc') || 'Please enable notification permissions in your device/browser settings.',
                    variant: 'destructive'
                })
            }
        } catch (error: any) {
            console.error('[Settings] Failed to subscribe to notifications:', error)
            showActionError(error, 'Failed to subscribe to notifications.')
        }
    }

    const handleUnlockConnection = () => {
        if (passkey === "Q9FZ7bM4K8xYtH6PVa5R2CJDW") {
            setIsConnectionSettingsUnlocked(true)
        } else {
            alert("Invalid Passkey")
        }
    }

    // Biometric Handlers
    const handleBiometricToggle = async (checked: boolean) => {
        if (!isElectron || !isMobile()) return;

        if (checked) {
            try {
                const { checkStatus, authenticate } = await import('@tauri-apps/plugin-biometric')
                const status = await checkStatus()
                if (status.isAvailable) {
                    await authenticate('Verify to enable Biometric Unlock')
                    localStorage.setItem('biometric_enabled', 'true')
                    setBiometricEnabled(true)
                    if (!localStorage.getItem('biometric_frequency')) {
                        localStorage.setItem('biometric_frequency', '24h')
                        setBiometricFrequency('24h')
                    }
                    localStorage.setItem('biometric_last_auth', Date.now().toString())
                } else {
                    toast({ title: 'Biometrics unavailable', description: 'This device does not support biometric authentication.', variant: 'destructive' })
                }
            } catch (err: any) {
                toast({ title: 'Authentication failed', description: err.message, variant: 'destructive' })
            }
        } else {
            localStorage.setItem('biometric_enabled', 'false')
            setBiometricEnabled(false)
        }
    }

    const handleBiometricFrequencyChange = (val: string) => {
        setBiometricFrequency(val)
        localStorage.setItem('biometric_frequency', val)
    }

    const handleDeleteBiometric = () => {
        localStorage.removeItem('biometric_enabled')
        localStorage.removeItem('biometric_frequency')
        localStorage.removeItem('biometric_last_auth')
        setBiometricEnabled(false)
        setBiometricFrequency('24h')
        setIsBiometricDeleteModalOpen(false)
        toast({ title: 'Biometric authentication deleted successfully' })
    }

    /* --- Connection Settings (Web) Handlers Start --- */
    const handleUnlockWebConnection = () => {
        if (webPasskeyInput === "Q9FZ7bM4K8xYtH6PVa5R2CJDW") {
            setIsWebConnectionUnlocked(true)
            setIsUnlockModalOpen(false)
            setWebPasskeyInput('')
        } else {
            alert("Invalid Passkey")
        }
    }
    /* --- Connection Settings (Web) Handlers End --- */

    const handleSaveConnection = async () => {
        if (confirm("Changing connection settings will reload the app. Continue?")) {
            await setAppSetting('supabase_url', decrypt(customUrl))
            await setAppSetting('supabase_anon_key', decrypt(customKey))
            window.location.reload()
        }
    }

    const handleResetConnection = async () => {
        if (confirm("Reset to default system settings? This will reload the app.")) {
            await setAppSetting('supabase_url', '')
            await setAppSetting('supabase_anon_key', '')
            window.location.reload()
        }
    }

    const handleOpenSyncMediaModal = async () => {
        if (!user) return
        setIsSyncMediaModalOpen(true)

        // Calculate count
        try {
            const products = await db.products.where('workspaceId').equals(user.workspaceId).and(p => !p.isDeleted).toArray()
            const productImages = products.filter(p => p.imageUrl && !p.imageUrl.startsWith('http'))
            let count = productImages.length
            if (features.logo_url && !features.logo_url.startsWith('http')) {
                count++
            }
            if (isLocalMode) {
                const templates = await listLocalCustomTemplates(user.workspaceId)
                const attachedImageCount = templates.reduce((sum, row) => {
                    const layout = row.layout_json as { images?: any[] } | null
                    const images = Array.isArray(layout?.images) ? layout.images : []
                    return sum + images.filter((image: any) => {
                        const path = typeof image?.path === 'string' ? image.path : ''
                        return path && !path.startsWith('http') && !path.startsWith('data:') && !path.startsWith('blob:')
                    }).length
                }, 0)
                count += attachedImageCount
            } else if (isSupabaseConfigured) {
                const { data } = await runSupabaseAction('customTemplates.mediaCount', () =>
                    supabase
                        .from('custom_templates')
                        .select('layout_json')
                        .eq('workspace_id', user.workspaceId)
                ) as any
                const attachedImageCount = ((data || []) as Array<{ layout_json?: any }>).reduce((sum, row) => {
                    const images = Array.isArray(row.layout_json?.images) ? row.layout_json.images : []
                    return sum + images.filter((image: any) => {
                        const path = typeof image?.path === 'string' ? image.path : ''
                        return path && !path.startsWith('http') && !path.startsWith('data:') && !path.startsWith('blob:')
                    }).length
                }, 0)
                count += attachedImageCount
            }
            setLocalMediaCount(count)
        } catch (e) {
            console.error('Failed to count media:', e)
        }
    }

    const handleSyncMedia = async () => {
        setIsSyncMediaModalOpen(false)
        if (isDemoMode) {
            return
        }
        if (!isOnline) {
            alert(t('settings.messages.onlineRequired') || 'Internet connection is required for media sync.')
            return
        }

        if (!user) return

        try {
            const products = await db.products.where('workspaceId').equals(user.workspaceId).and(p => !p.isDeleted).toArray()
            // Filter products with local image paths
            const productImages = products
                .filter(p => p.imageUrl && !p.imageUrl.startsWith('http'))
                .map(p => ({ path: p.imageUrl!, name: p.name }))

            const itemsToSync = [...productImages]

            // Add workspace logo if it exists locally
            if (features.logo_url && !features.logo_url.startsWith('http')) {
                itemsToSync.push({ path: features.logo_url, name: 'Workspace Logo' })
            }

            if (isLocalMode) {
                const templates = await listLocalCustomTemplates(user.workspaceId)
                for (const template of templates) {
                    const layout = template.layout_json as { images?: any[] } | null
                    const images = Array.isArray(layout?.images) ? layout.images : []
                    for (const image of images) {
                        const path = typeof image?.path === 'string' ? image.path : ''
                        if (!path || path.startsWith('http') || path.startsWith('data:') || path.startsWith('blob:')) {
                            continue
                        }

                        itemsToSync.push({
                            path,
                            name: template.label || template.module_type_key || 'Custom Template Image'
                        })
                    }
                }
            } else if (isSupabaseConfigured) {
                const { data } = await runSupabaseAction('customTemplates.mediaSyncList', () =>
                    supabase
                        .from('custom_templates')
                        .select('label, module_type_key, layout_json')
                        .eq('workspace_id', user.workspaceId)
                ) as any
                for (const template of (data || []) as Array<{ label?: string | null; module_type_key?: string | null; layout_json?: any }>) {
                    const images = Array.isArray(template.layout_json?.images) ? template.layout_json.images : []
                    for (const image of images) {
                        const path = typeof image?.path === 'string' ? image.path : ''
                        if (!path || path.startsWith('http') || path.startsWith('data:') || path.startsWith('blob:')) {
                            continue
                        }

                        itemsToSync.push({
                            path,
                            name: template.label || template.module_type_key || 'Custom Template Image'
                        })
                    }
                }
            }

            if (itemsToSync.length === 0) {
                alert(t('settings.messages.noMediaToSync') || 'No local media found to sync.')
                return
            }

            setMediaSyncProgress({ total: itemsToSync.length, current: 0, fileName: '' })

            let successCount = 0
            for (let i = 0; i < itemsToSync.length; i++) {
                const item = itemsToSync[i]
                setMediaSyncProgress(prev => prev ? { ...prev, current: i + 1, fileName: item.name } : null)

                const success = await assetManager.uploadFromPath(item.path)
                if (success) successCount++
            }

            alert(t('settings.messages.mediaSyncComplete', { count: successCount }) || `Media sync complete! ${successCount} files queued.`)
        } catch (error) {
            console.error('Media sync failed:', error)
            alert('Media sync failed: ' + error)
        } finally {
            setMediaSyncProgress(null)
        }
    }

    const handleDownloadWorkspaceMedia = async () => {
        if (isDemoMode) {
            return
        }

        if (!user?.workspaceId) return
        if (!isElectron) return

        if (!isOnline) {
            alert(t('settings.messages.onlineRequired') || 'Internet connection is required for media sync.')
            return
        }

        if (!r2Service.isConfigured()) {
            alert(t('settings.messages.r2ListNotAvailable') || 'Cloud media listing endpoint is not available. Please update your R2 worker.')
            return
        }

        const workspaceId = user.workspaceId

        try {
            const result = await downloadWorkspaceResources({
                workspaceId,
                onProgress: ({ current, total, fileName }) => {
                    setMediaDownloadProgress({ total, current, fileName })
                },
            })

            if (result.total === 0) {
                alert(t('settings.messages.noCloudMediaFound') || 'No cloud media found for this workspace.')
                return
            }

            alert(
                t('settings.messages.mediaDownloadComplete', { count: result.downloaded })
                || `Media download complete! ${result.downloaded} files saved locally.`
            )
        } catch (error) {
            console.error('[Settings] Media download failed:', error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (
                errorMessage.includes('R2 List Failed: 404')
                || errorMessage.includes('R2 List Endpoint Missing')
                || errorMessage.includes('Object Not Found')
            ) {
                alert(t('settings.messages.r2ListNotAvailable') || 'Cloud media listing endpoint is not available. Please update your R2 worker.')
            } else {
                alert(
                    t('settings.messages.mediaDownloadFailed', { error: errorMessage })
                    || `Media download failed: ${errorMessage}`
                )
            }
        } finally {
            setMediaDownloadProgress(null)
        }
    }

    const handleDownloadInvoicePdfs = async () => {
        if (!user?.workspaceId) return

        setIsInvoicePdfExporting(true)
        try {
            const result = await downloadInvoicePdfArchive(user.workspaceId)
            if (result.cancelled) return

            if (result.exportedCount === 0) {
                toast({
                    title: 'No PDF invoices found',
                    description: result.unavailableCount > 0
                        ? 'Invoice PDFs could not be retrieved. Connect to the internet and try again.'
                        : 'This workspace does not have any saved invoice PDFs.',
                    variant: 'destructive',
                })
                return
            }

            toast({
                title: 'PDF invoices downloaded',
                description: result.unavailableCount > 0
                    ? `${result.exportedCount} PDF invoices were exported. ${result.unavailableCount} could not be retrieved.`
                    : `${result.exportedCount} PDF invoices were exported in one ZIP file.`,
            })
        } catch (error) {
            console.error('[Settings] Failed to download invoice PDFs:', error)
            toast({
                title: t('common.error') || 'Error',
                description: 'Failed to download PDF invoices. Please try again.',
                variant: 'destructive',
            })
        } finally {
            setIsInvoicePdfExporting(false)
        }
    }

    const handleDatabaseInjectionFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const selectedFile = event.target.files?.[0] ?? null
        event.target.value = ''
        setDatabaseInjectionError(null)

        if (!selectedFile) return
        if (selectedFile.name.toLowerCase() !== 'atlas-local-mode.db') {
            setDatabaseFileToInject(null)
            setDatabaseInjectionError('Select the atlas-local-mode.db file created by Atlas.')
            return
        }

        setDatabaseFileToInject(selectedFile)
        setDatabaseUrlToInject('')
    }

    const handleDatabaseInjectionUrlChange = (value: string) => {
        setDatabaseUrlToInject(value)
        setDatabaseInjectionError(null)
        if (value.trim()) {
            setDatabaseFileToInject(null)
        }
    }

    const handleDatabaseInjectionDialogChange = (open: boolean) => {
        if (isInjectingDatabase) return
        setIsDatabaseInjectionDialogOpen(open)
        if (!open) {
            setDatabaseFileToInject(null)
            setDatabaseUrlToInject('')
            setDatabaseInjectionError(null)
        }
    }

    const handleInjectDatabase = async () => {
        const databaseUrl = databaseUrlToInject.trim()
        if (!databaseFileToInject && !databaseUrl) return

        setIsInjectingDatabase(true)
        setDatabaseInjectionError(null)
        try {
            let data: Uint8Array
            if (databaseFileToInject) {
                data = new Uint8Array(await databaseFileToInject.arrayBuffer())
            } else {
                let url: URL
                try {
                    url = new URL(databaseUrl)
                } catch {
                    throw new Error('Enter a valid direct HTTPS link to atlas-local-mode.db.')
                }

                if (url.protocol !== 'https:') {
                    throw new Error('The database link must use HTTPS.')
                }
                if (!url.pathname.toLowerCase().endsWith('/atlas-local-mode.db')) {
                    throw new Error('The link must point directly to an atlas-local-mode.db file.')
                }

                let response: Response
                try {
                    response = await fetch(url.href, {
                        cache: 'no-store',
                        credentials: 'omit',
                    })
                } catch {
                    throw new Error('Could not download the database. Check that the direct link is accessible from Atlas.')
                }
                if (!response.ok) {
                    throw new Error(`Could not download the database (${response.status}). Check that the link is accessible.`)
                }

                data = new Uint8Array(await response.arrayBuffer())
                if (data.byteLength === 0) {
                    throw new Error('The database link returned an empty file.')
                }
            }

            await injectLocalModeDatabaseFile(data)

            // SQLite is authoritative in Local Mode. Remove the old Dexie
            // cache before reloading so it is hydrated only from this backup.
            try {
                await db.delete()
            } catch (cacheError) {
                console.warn('[Settings] Could not clear the cache after database injection:', cacheError)
            }

            toast({
                title: 'Database injected',
                description: 'Atlas is reloading from the injected database.',
            })
            window.setTimeout(() => window.location.reload(), 250)
        } catch (error) {
            console.error('[Settings] Failed to inject local database:', error)
            setDatabaseInjectionError(
                error instanceof Error ? error.message : 'The database could not be injected. Please try again.',
            )
            setIsInjectingDatabase(false)
        }
    }

    const handleLogoUpload = async () => {
        if (!user?.workspaceId) return
        try {
            const targetPath = await platformService.pickAndSaveImage(user.workspaceId, 'workspace-logos', 'workspace-logo')
            if (targetPath) await updateSettings({ logo_url: targetPath })
        } catch (error) {
            const code = getMediaUploadErrorCode(error) || 'upload_failed'
            toast({ title: t('common.error'), description: t(`mediaUpload.errors.${code}`), variant: 'destructive' })
        }
    }

    const handleProfilePictureUpload = async () => {
        if (!user?.id || !user?.workspaceId) return

        try {
            const targetPath = await platformService.pickAndSaveImage(user.workspaceId, 'profile-images', 'profile-image')
            if (!targetPath) return

            // 4. Update Supabase profile
            if (isSupabaseConfigured && !isDemoMode && !isLocalMode) {
                // Update the profiles table
                const { error: profileError } = await runSupabaseAction('settings.updateProfileImage', () =>
                    supabase
                        .from('profiles')
                        .update({ profile_url: targetPath })
                        .eq('id', user.id)
                )

                if (profileError) {
                    console.error('[Settings] Error updating Supabase profile:', profileError)
                    throw normalizeSupabaseActionError(profileError)
                }

                // Update Auth metadata so it persists across refreshes
                const { error: authError } = await runSupabaseAction('settings.updateProfileMetadata', () =>
                    supabase.auth.updateUser({
                        data: { profile_url: targetPath }
                    })
                )

                if (authError) {
                    throw normalizeSupabaseActionError(authError)
                }
            }

            // Always update local profile database for offline-first modes
            if (isLocalMode || isHybridMode || isDemoMode) {
                await db.profiles.put({
                    id: user.id,
                    workspaceId: user.sourceWorkspaceId || user.workspaceId,
                    currentWorkspaceId: user.workspaceId,
                    name: user.name,
                    role: user.role,
                    profile_url: targetPath,
                })
            }

            // 5. Update local state
            updateUser({ profileUrl: targetPath })

            // 6. Dispatch global event for immediate UI updates
            window.dispatchEvent(new CustomEvent('profile-updated'))

            console.log('[Settings] Profile picture updated successfully:', targetPath)
        } catch (error) {
            console.error('[Settings] Profile picture upload failed:', error)
            const code = getMediaUploadErrorCode(error)
            if (code) {
                toast({ title: t('common.error'), description: t(`mediaUpload.errors.${code}`), variant: 'destructive' })
            } else {
                showActionError(error, t('mediaUpload.errors.upload_failed'))
            }
        }
    }

    const handleRemoveProfilePicture = async () => {
        if (!user || !user.profileUrl) return;

        try {
            // Delete from R2 and Local
            await assetManager.deleteAsset(user.profileUrl);

            // Update cloud profile (Supabase)
            if (isSupabaseConfigured && !isDemoMode && !isLocalMode) {
                const { error: profileError } = await runSupabaseAction('settings.removeProfileImage', () =>
                    supabase.from('profiles').update({ profile_url: null }).eq('id', user.id)
                )
                if (profileError) throw normalizeSupabaseActionError(profileError)

                const { error: authError } = await runSupabaseAction('settings.removeProfileMetadata', () =>
                    supabase.auth.updateUser({ data: { profile_url: null } })
                )
                if (authError) throw normalizeSupabaseActionError(authError)
            }

            // Sync to local profile DB for offline modes
            if (isLocalMode || isHybridMode || isDemoMode) {
                await db.profiles.update(user.id, { profile_url: null })
            }

            // Update local state
            updateUser({ profileUrl: '' });
            window.dispatchEvent(new CustomEvent('profile-updated'));

            console.log('[Settings] Profile picture removed and cleaned up');
        } catch (error) {
            console.error('[Settings] Profile picture removal failed:', error);
            showActionError(error, 'Profile picture removal failed.')
        }
    }

    const handleRemoveLogo = async () => {
        if (!user || !features.logo_url) return;

        try {
            // Delete from R2 and Local
            await assetManager.deleteAsset(features.logo_url);

            // Update workspace settings
            await updateSettings({ logo_url: '' });

            console.log('[Settings] Workspace logo removed and cleaned up');
        } catch (error) {
            console.error('[Settings] Workspace logo removal failed:', error);
        }
    }

    const getDisplayLogoUrl = (url?: string | null) => {
        if (!url) return ''
        if (url.startsWith('http')) return url
        return platformService.convertFileSrc(url)
    }

    const handleMarketplaceSave = async () => {
        if (!user?.workspaceId) return

        if (isLocalMode) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.localUnsupported', {
                    defaultValue: 'Marketplace publishing is available only for cloud and hybrid workspaces.'
                }),
                variant: 'destructive'
            })
            return
        }

        if ((marketplaceVisibility === 'public' || marketplaceVisibility === 'link_only') && !normalizedMarketplaceSlug) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugRequired', {
                    defaultValue: 'Set a store slug before going public'
                }),
                variant: 'destructive'
            })
            return
        }

        if (normalizedMarketplaceSlug && !marketplaceSlugPattern.test(normalizedMarketplaceSlug)) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugInvalid', {
                    defaultValue: 'Only lowercase letters, numbers, and hyphens allowed'
                }),
                variant: 'destructive'
            })
            return
        }

        if (normalizedMarketplaceSlug && marketplaceSlugStatus === 'taken') {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugTaken', {
                    defaultValue: 'This slug is already taken'
                }),
                variant: 'destructive'
            })
            return
        }

        setIsSavingMarketplace(true)
        try {
            const payload = {
                visibility: marketplaceVisibility,
                store_slug: normalizedMarketplaceSlug || null,
                store_description: marketplaceDescription.trim() || null
            }

            const { error } = await runSupabaseAction('settings.updateMarketplace', () =>
                supabase
                    .from('workspaces')
                    .update(payload)
                    .eq('id', user.workspaceId),
                { timeoutMs: 12000, platform: 'all' }
            ) as { error: Error | null }

            if (error) {
                throw error
            }

            await refreshFeatures()

            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.saveSuccess', {
                    defaultValue: 'Marketplace settings updated successfully.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.saveError', {
                defaultValue: 'Failed to update marketplace settings.'
            }))
        } finally {
            setIsSavingMarketplace(false)
        }
    }

    const handleMarketplacePreview = () => {
        if (!marketplacePreviewUrl) return
        window.open(marketplacePreviewUrl, '_blank', 'noopener,noreferrer')
    }

    const handleAddSecondaryStorefront = async () => {
        if (!user?.workspaceId) return

        setIsSecondaryStorefrontActionPending(true)
        try {
            const { data, error } = await runSupabaseAction('settings.addSecondaryStorefront', () =>
                supabase
                    .from('workspace_storefronts')
                    .insert({
                        workspace_id: user.workspaceId!,
                        visibility: 'private',
                        slug: '',
                        description: null
                    })
                    .select('id, visibility, slug, description')
                    .maybeSingle(),
                { timeoutMs: 12000, platform: 'all' }
            ) as { data: { id: string; visibility: 'private' | 'public' | 'link_only'; slug: string; description: string | null } | null; error: Error | null }

            if (error) {
                throw error
            }

            setSecondaryStorefront(data)
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontAdded', {
                    defaultValue: 'Additional storefront created.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.secondaryStorefrontAddError', {
                defaultValue: 'Failed to add the additional storefront.'
            }))
        } finally {
            setIsSecondaryStorefrontActionPending(false)
        }
    }

    const handleSaveSecondaryStorefront = async () => {
        if (!user?.workspaceId || !secondaryStorefront) return

        if (isLocalMode) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.localUnsupported', {
                    defaultValue: 'Marketplace publishing is available only for cloud and hybrid workspaces.'
                }),
                variant: 'destructive'
            })
            return
        }

        if ((secondaryStorefrontVisibility === 'public' || secondaryStorefrontVisibility === 'link_only')
            && !normalizedSecondaryStorefrontSlug) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.secondaryStorefrontSlugRequired', {
                    defaultValue: 'Set a store slug before publishing this storefront'
                }),
                variant: 'destructive'
            })
            return
        }

        if (normalizedSecondaryStorefrontSlug && !marketplaceSlugPattern.test(normalizedSecondaryStorefrontSlug)) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugInvalid', {
                    defaultValue: 'Only lowercase letters, numbers, and hyphens allowed'
                }),
                variant: 'destructive'
            })
            return
        }

        if (normalizedSecondaryStorefrontSlug && secondaryStorefrontSlugStatus === 'taken') {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugTaken', {
                    defaultValue: 'This slug is already taken'
                }),
                variant: 'destructive'
            })
            return
        }

        setIsSecondaryStorefrontActionPending(true)
        try {
            const { error } = await runSupabaseAction('settings.saveSecondaryStorefront', () =>
                supabase
                    .from('workspace_storefronts')
                    .update({
                        visibility: secondaryStorefrontVisibility,
                        slug: normalizedSecondaryStorefrontSlug,
                        description: secondaryStorefrontDescription.trim() || null
                    })
                    .eq('id', secondaryStorefront.id)
                    .eq('workspace_id', user.workspaceId!),
                { timeoutMs: 12000, platform: 'all' }
            ) as { error: Error | null }

            if (error) {
                throw error
            }

            setSecondaryStorefront((current) => current
                ? {
                    ...current,
                    visibility: secondaryStorefrontVisibility,
                    slug: normalizedSecondaryStorefrontSlug,
                    description: secondaryStorefrontDescription.trim() || null
                }
                : current)

            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontSaved', {
                    defaultValue: 'Storefront updated successfully.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.secondaryStorefrontSaveError', {
                defaultValue: 'Failed to update the additional storefront.'
            }))
        } finally {
            setIsSecondaryStorefrontActionPending(false)
        }
    }

    const handleRemoveSecondaryStorefront = () => {
        setIsSecondaryStorefrontRemoveConfirmOpen(true)
    }

    const handleConfirmRemoveSecondaryStorefront = async () => {
        if (!user?.workspaceId || !secondaryStorefront) return

        setIsSecondaryStorefrontActionPending(true)
        try {
            const { error } = await runSupabaseAction('settings.removeSecondaryStorefront', () =>
                supabase
                    .from('workspace_storefronts')
                    .delete()
                    .eq('id', secondaryStorefront.id)
                    .eq('workspace_id', user.workspaceId!),
                { timeoutMs: 12000, platform: 'all' }
            ) as { error: Error | null }

            if (error) {
                throw error
            }

            setIsSecondaryStorefrontRemoveConfirmOpen(false)
            setSecondaryStorefront(null)
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontRemoved', {
                    defaultValue: 'Storefront removed.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.secondaryStorefrontRemoveError', {
                defaultValue: 'Failed to remove the additional storefront.'
            }))
        } finally {
            setIsSecondaryStorefrontActionPending(false)
        }
    }

    return (
        <div className="space-y-6 max-w-3xl">
            {/* Header */}
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-primary" />
                    {t('settings.title')}
                </h1>
                <p className="text-muted-foreground">
                    {t('settings.subtitle')} <ModulePageFreshness className="ms-2" />
                </p>
            </div>

            <Tabs defaultValue="general" className="w-full space-y-6">
                <TabsList className={cn(
                    "flex md:grid w-full max-w-full md:max-w-[600px] overflow-x-auto overflow-y-hidden no-scrollbar justify-start md:justify-center h-auto p-1",
                    user?.role === 'admin' ? "md:grid-cols-4" : "md:grid-cols-3"
                )}>
                    <TabsTrigger value="general">{t('settings.tabs.general') || 'General'}</TabsTrigger>
                    {(user?.role === 'admin' || user?.role === 'staff') && (
                        <TabsTrigger value="profile">{t('settings.tabs.profile') || 'Profile Settings'}</TabsTrigger>
                    )}
                    {(user?.role === 'admin' || user?.role === 'staff') && (
                        <TabsTrigger value="workspace">{t('settings.tabs.workspace') || 'Workspace Settings'}</TabsTrigger>
                    )}
                    {user?.role === 'admin' && (
                        <TabsTrigger value="advanced">{t('settings.tabs.advanced') || 'Advanced'}</TabsTrigger>
                    )}
                </TabsList>

                <TabsContent value="general" className="space-y-6 mt-0">
                    {/* Theme Settings */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Monitor className="w-5 h-5" />
                                {t('settings.appearance')}
                            </CardTitle>
                            <CardDescription>{t('settings.appearanceDesc')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-4">
                                <div className="flex flex-col gap-2">
                                    <Label>{t('settings.theme.title')}</Label>
                                    <div className="grid grid-cols-3 gap-2 max-w-md">
                                        <Button
                                            variant={theme === 'light' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setTheme('light')}
                                        >
                                            <Sun className="w-4 h-4" />
                                            {t('settings.theme.light')}
                                        </Button>
                                        <Button
                                            variant={theme === 'dark' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setTheme('dark')}
                                        >
                                            <Moon className="w-4 h-4" />
                                            {t('settings.theme.dark')}
                                        </Button>
                                        <Button
                                            variant={theme === 'system' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setTheme('system')}
                                        >
                                            <Monitor className="w-4 h-4" />
                                            {t('settings.theme.system')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-border/50">
                                    <Label>{t('settings.theme.style')}</Label>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-2xl">
                                        <Button
                                            variant={style === 'emerald' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center col-span-1 sm:col-span-2 lg:col-span-1 shadow-lg shadow-emerald-500/20"
                                            allowViewer={true}
                                            onClick={() => setStyle('emerald')}
                                        >
                                            {t('settings.theme.emerald', 'Emerald (Teal & Charcoal)')}
                                        </Button>
                                        <Button
                                            variant={style === 'primary' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setStyle('primary')}
                                        >
                                            {t('settings.theme.primary', 'Primary')}
                                        </Button>
                                        <Button
                                            variant={style === 'modern' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setStyle('modern')}
                                        >
                                            {t('settings.theme.modern', 'Modern (Premium)')}
                                        </Button>
                                        <Button
                                            variant={style === 'legacy' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setStyle('legacy')}
                                        >
                                            {t('settings.theme.legacy', 'Legacy (Classic)')}
                                        </Button>
                                        <Button
                                            variant={style === 'neo-orange' ? 'default' : 'outline'}
                                            className="flex items-center gap-2 justify-center"
                                            allowViewer={true}
                                            onClick={() => setStyle('neo-orange')}
                                        >
                                            {t('settings.theme.neo-orange', 'Neo-Orange (Brutalist)')}
                                        </Button>
                                        {isTauri() && (
                                            <Button
                                                variant={style === 'low-power' ? 'default' : 'outline'}
                                                className="flex items-center gap-2 justify-center border-amber-500/50 hover:bg-amber-500/10"
                                                allowViewer={true}
                                                onClick={() => setStyle('low-power')}
                                            >
                                                <RefreshCw className={cn("w-4 h-4", style === 'low-power' && "animate-spin")} />
                                                {t('settings.theme.low-power', 'Low Power (Memory Saving)')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>{t('settings.language')}</Label>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <LanguageSwitcher />
                                        <span className="text-sm text-muted-foreground">
                                            {t('settings.languageDesc')}
                                        </span>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>{t('settings.hourDisplay.title', { defaultValue: 'Hour Display' })}</Label>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Select
                                            value={hourDisplayPreference}
                                            onValueChange={(value) => {
                                                const nextValue = value as HourDisplayPreference
                                                setHourDisplayPreferenceState(nextValue)
                                                void setHourDisplayPreference(nextValue).catch((error) => {
                                                    console.error('[Settings] Failed to save hour display preference:', error)
                                                })
                                            }}
                                        >
                                            <SelectTrigger className="w-[180px]" allowViewer={true}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="24-hour">{t('settings.hourDisplay.twentyFourHour', { defaultValue: '24-hour' })}</SelectItem>
                                                <SelectItem value="12-hour">{t('settings.hourDisplay.twelveHour', { defaultValue: '12-hour' })}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <span className="text-sm text-muted-foreground">
                                            {t('settings.hourDisplay.desc', {
                                                defaultValue: 'Choose how times appear across the interface.'
                                            })}
                                        </span>
                                        <span className="text-sm font-mono text-muted-foreground">
                                            {`${formatDate(new Date())} ${formatTime(new Date(), { preference: hourDisplayPreference })}`}
                                        </span>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>{t('settings.monthDisplay.title')}</Label>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Select
                                            value={monthDisplayPreference}
                                            onValueChange={(value) => {
                                                const nextValue = value as MonthDisplayPreference
                                                setMonthDisplayPreferenceState(nextValue)
                                                setMonthDisplayPreference(nextValue)
                                            }}
                                        >
                                            <SelectTrigger className="w-[180px]" allowViewer={true}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="native">{t('settings.monthDisplay.native')}</SelectItem>
                                                <SelectItem value="en">{t('settings.monthDisplay.english')}</SelectItem>
                                                <SelectItem value="ar">{t('settings.monthDisplay.arabic')}</SelectItem>
                                                <SelectItem value="ku">{t('settings.monthDisplay.kurdish')}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <span className="text-sm text-muted-foreground">
                                            {t('settings.monthDisplay.desc')}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Application Updates */}
                    {(isElectron || isLocalMode) && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Download className="w-5 h-5" />
                                    {t('settings.updater.title')}
                                </CardTitle>
                                <CardDescription>{t('settings.updater.description')}</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <p className="font-medium">{t('settings.updater.status')} <span className="text-xs font-normal text-muted-foreground font-mono ml-2">(v{version})</span></p>
                                        <p className="text-sm text-muted-foreground">
                                            {isLocalMode && (updatesDisabled
                                                ? 'Disabled - this device will remain on its installed version.'
                                                : 'Enabled - Atlas can download newer versions.')}
                                            {isLocalMode && updateStatus && ' '}
                                            {updateStatus?.status === 'checking' && t('settings.updater.checking')}
                                            {updateStatus?.status === 'available' && t('settings.updater.available')}
                                            {updateStatus?.status === 'not-available' && t('settings.updater.notAvailable')}
                                            {updateStatus?.status === 'downloaded' && t('settings.updater.downloaded')}
                                            {updateStatus?.status === 'disabled' && 'Updates are disabled for this device.'}
                                            {updateStatus?.status === 'error' && (
                                                <span className="flex items-center gap-1 text-red-500">
                                                    <AlertCircle className="w-4 h-4" />
                                                    {updateStatus.message}
                                                </span>
                                            )}
                                            {updateStatus?.status === 'progress' && `Downloading: ${Math.round(updateStatus.progress)}%`}
                                            {!updateStatus && !updatesDisabled && <>{' '}{t('settings.updater.clickButton')}</>}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {isLocalMode && (
                                            <div className="flex items-center gap-2">
                                                <Label htmlFor="disable-application-updates" className="text-sm">Disable Updates</Label>
                                                <Switch
                                                    id="disable-application-updates"
                                                    checked={updatesDisabled}
                                                    onCheckedChange={handleUpdatesDisabledChange}
                                                />
                                            </div>
                                        )}
                                        <Button
                                            allowViewer={true}
                                            onClick={handleCheckForUpdates}
                                            disabled={updatesDisabled || updateStatus?.status === 'checking' || updateStatus?.status === 'progress'}
                                            variant="outline"
                                        >
                                            {updateStatus?.status === 'checking' ? (
                                                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                                            ) : updateStatus?.status === 'downloaded' ? (
                                                <RefreshCw className="w-4 h-4 mr-2" />
                                            ) : (
                                                <RefreshCw className="w-4 h-4 mr-2" />
                                            )}
                                            {updateStatus?.status === 'downloaded' ? t('settings.updater.restart') : t('settings.updater.clickButton')}
                                        </Button>
                                    </div>
                                </div>
                                {updateStatus?.status === 'progress' && (
                                    <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                                        <div
                                            className="bg-primary h-full transition-all duration-300"
                                            style={{ width: `${updateStatus.progress}%` }}
                                        />
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {DeveloperTestButton && (
                        <div className="flex justify-end gap-2">
                            <Suspense fallback={null}>
                                <DeveloperTestButton suiteId="account-switching" labelKey="devTesting.accountSwitcher" />
                                <DeveloperTestButton suiteId="platform" />
                            </Suspense>
                        </div>
                    )}
                    <OfflineReadinessCard />

                    {/* Biometric Authentication (Mobile Only) */}
                    {isElectron && isMobile() && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Fingerprint className="w-5 h-5" />
                                    Biometric Authentication
                                </CardTitle>
                                <CardDescription>Use FaceID or Fingerprint to unlock the application.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-6">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-0.5">
                                        <Label className="text-sm font-medium">Enable App Lock</Label>
                                        <p className="text-xs text-muted-foreground">
                                            Require biometric authentication to open Atlas.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={biometricEnabled}
                                        onCheckedChange={handleBiometricToggle}
                                    />
                                </div>
                                {biometricEnabled && (
                                    <>
                                        <div className="space-y-2">
                                            <Label>Authentication Frequency</Label>
                                            <Select value={biometricFrequency} onValueChange={handleBiometricFrequencyChange}>
                                                <SelectTrigger className="w-[180px]">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="always">Every time app opens</SelectItem>
                                                    <SelectItem value="24h">Every 24 hours</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="pt-4 border-t border-border/50">
                                            <Button variant="destructive" onClick={() => setIsBiometricDeleteModalOpen(true)}>
                                                Delete Saved Biometric Authentication
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* Biometric Delete Modal */}
                    <Dialog open={isBiometricDeleteModalOpen} onOpenChange={setIsBiometricDeleteModalOpen}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>Disable Biometric Authentication?</DialogTitle>
                                <DialogDescription>
                                    This will disable biometric authentication and clear your saved preferences. You will need to re-authenticate if you want to enable it again.
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setIsBiometricDeleteModalOpen(false)}>
                                    Cancel
                                </Button>
                                <Button variant="destructive" onClick={handleDeleteBiometric}>
                                    Delete
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    {/* Sync Status (Admin & Staff Only) */}
                    {(user?.role === 'admin' || user?.role === 'staff') && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Cloud className="w-5 h-5" />
                                    {isLocalMode ? (t('settings.localMode') || 'Local Mode') : t('settings.syncStatus')}
                                </CardTitle>
                                <CardDescription>
                                    {isLocalMode
                                        ? (t('settings.localModeDesc') || 'This workspace stores business data locally on this device and does not use cloud sync.')
                                        : t('settings.syncDesc')}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div>
                                        <Label className="text-muted-foreground">{t('settings.connection')}</Label>
                                        <p className={`font-medium ${isOnline ? 'text-emerald-500' : 'text-red-500'}`}>
                                            {isOnline ? t('settings.online') : t('settings.offline')}
                                        </p>
                                    </div>
                                    <div>
                                        <Label className="text-muted-foreground">{isLocalMode ? (t('settings.storageMode') || 'Storage Mode') : t('settings.syncState')}</Label>
                                        <p className="font-medium capitalize">{isLocalMode ? 'local-only' : syncState}</p>
                                    </div>
                                    <div>
                                        <Label className="text-muted-foreground">{isLocalMode ? (t('settings.workspaceMode') || 'Workspace Mode') : t('settings.pendingChanges')}</Label>
                                        <p className="font-medium">{isLocalMode ? 'local' : `${pendingCount} items`}</p>
                                    </div>
                                    <div>
                                        <Label className="text-muted-foreground">{isLocalMode ? (t('settings.cloudSync') || 'Cloud Sync') : t('settings.lastSynced')}</Label>
                                        <p className="font-medium">
                                            {isLocalMode ? (t('settings.disabled') || 'Disabled') : (lastSyncTime ? formatDateTime(lastSyncTime) : t('settings.never'))}
                                        </p>
                                    </div>
                                </div>

                                {!isSupabaseConfigured && (
                                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                        <p className="text-sm text-amber-500">
                                            Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable cloud sync.
                                        </p>
                                    </div>
                                )}

                                <div className="flex gap-2">
                                    {!isLocalMode && (
                                        <Button onClick={sync} disabled={isSyncing || !isOnline || !isSupabaseConfigured}>
                                            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                                            {isSyncing ? t('settings.syncing') : t('settings.syncNow')}
                                        </Button>
                                    )}
                                    {!isLocalMode && isElectron && (
                                        <>
                                            <Button
                                                variant="outline"
                                                onClick={handleOpenSyncMediaModal}
                                                disabled={!isOnline || !isSupabaseConfigured || mediaSyncProgress !== null}
                                                className="gap-2"
                                            >
                                                <ImageIcon className={cn("w-4 h-4", mediaSyncProgress && "animate-pulse")} />
                                                {mediaSyncProgress
                                                    ? `${t('settings.syncingMedia') || 'Syncing...'} (${mediaSyncProgress.current}/${mediaSyncProgress.total})`
                                                    : t('settings.syncMedia') || 'Upload Media'}
                                            </Button>

                                            <Button
                                                variant="secondary"
                                                onClick={handleDownloadWorkspaceMedia}
                                                disabled={!isOnline || !isSupabaseConfigured || mediaDownloadProgress !== null || mediaSyncProgress !== null}
                                                className="gap-2"
                                                title={t('settings.downloadMedia') || 'Download Workspace Media'}
                                            >
                                                <Download className={cn("w-4 h-4", mediaDownloadProgress && "animate-pulse")} />
                                                {mediaDownloadProgress
                                                    ? `${t('settings.downloadingMedia') || 'Downloading Media...'} (${mediaDownloadProgress.current}/${mediaDownloadProgress.total})`
                                                    : t('settings.downloadMedia') || 'Download Workspace Media'}
                                            </Button>
                                        </>
                                    )}
                                    {!isLocalMode && pendingCount > 0 && (
                                        <Button variant="outline" onClick={handleClearSyncQueue}>
                                            {t('settings.clearQueue')}
                                        </Button>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Push Notification Service */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Bell className="w-5 h-5" />
                                Push Notification Service
                            </CardTitle>
                            <CardDescription>
                                Enable push notifications to receive real-time alerts and updates on this device.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label className="text-sm font-medium">Notification Subscription</Label>
                                    <p className="text-xs text-muted-foreground">
                                        {isElectron ? 'Receive OS-level alerts for important workspace events.' : 'Receive browser notifications for important platform events.'}
                                    </p>
                                </div>
                                <Button variant="outline" onClick={handleSubscribeToNotifications} className="gap-2 shrink-0">
                                    <Bell className="w-4 h-4" />
                                    Subscribe
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Media Sync Modal */}
                    <Dialog open={isSyncMediaModalOpen} onOpenChange={setIsSyncMediaModalOpen}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <ImageIcon className="w-5 h-5 text-primary" />
                                    {t('settings.syncMediaModal.title') || 'Sync All Media'}
                                </DialogTitle>
                                <DialogDescription>
                                    {localMediaCount !== null
                                        ? `${t('settings.syncMediaModal.countDesc', { count: localMediaCount }) || `Found ${localMediaCount} local files ready to sync.`} ${t('settings.syncMediaModal.desc') || 'This will upload all local product images and the workspace logo to the cloud.'}`
                                        : t('settings.syncMediaModal.desc') || 'This will upload all local product images and the workspace logo to the cloud so they can be synced to other devices in your workspace.'}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                    <Label>{t('settings.syncMediaModal.expiry') || 'Expiration Time (Hours)'}</Label>
                                    <div className="flex items-center gap-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={48}
                                            value={expiryHours}
                                            onChange={(e) => setExpiryHours(Math.max(1, Math.min(48, parseInt(e.target.value) || 24)))}
                                            className="w-24"
                                        />
                                        <span className="text-sm text-muted-foreground">
                                            {t('settings.syncMediaModal.expiryDesc') || 'Hours until the temporary cloud buffer is cleared.'}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-amber-500 font-medium italic">
                                        {t('settings.syncMediaModal.note') || 'Note: Other devices must be online during this period to receive the media.'}
                                    </p>
                                </div>
                            </div>

                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setIsSyncMediaModalOpen(false)}>
                                    {t('common.cancel')}
                                </Button>
                                <Button onClick={handleSyncMedia} className="gap-2">
                                    <Cloud className="w-4 h-4" />
                                    {t('settings.syncMediaModal.confirm') || 'Start Upload'}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>


                    {/* Local Date Filter Boundary */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <CalendarClock className="w-5 h-5" />
                                {t('settings.dateFilterDayBoundary.title', { defaultValue: 'Date Filter Day Boundary' })}
                            </CardTitle>
                            <CardDescription>
                                {t('settings.dateFilterDayBoundary.description', {
                                    defaultValue: 'Choose when daily date filters roll over on this device.'
                                })}
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Label htmlFor="date-filter-day-boundary" className="shrink-0">
                                    {t('settings.dateFilterDayBoundary.startTime', { defaultValue: 'Daily filters start at' })}
                                </Label>
                                <DateTimePicker
                                    id="date-filter-day-boundary"
                                    mode="time"
                                    date={getDateFilterDayBoundaryDate(dateFilterDayBoundary)}
                                    setDate={(date) => {
                                        const nextValue = formatDateFilterDayBoundary(date)
                                        setDateFilterDayBoundaryState(nextValue)
                                        void setDateFilterDayBoundary(nextValue).catch((error) => {
                                            console.error('[Settings] Failed to save date filter day boundary:', error)
                                        })
                                    }}
                                    buttonClassName="h-10 w-40 font-mono"
                                />
                                <p className="text-sm text-muted-foreground">
                                    {t('settings.dateFilterDayBoundary.note', {
                                        defaultValue: 'Affects filters only. It never changes stored transaction dates or records.'
                                    })}
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    {/* POS Settings */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <CreditCard className="w-5 h-5" />
                                {t('settings.pos.title')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-2">
                                <Label>{t('settings.pos.hotkey')}</Label>
                                <Input
                                    value={posHotkey}
                                    onChange={handleHotkeyChange}
                                    maxLength={1}
                                    className="w-20 text-center font-mono uppercase"
                                />
                                <p className="text-sm text-muted-foreground">
                                    {t('settings.pos.hotkeyDesc')}
                                </p>
                            </div>

                            {canUseBarcodeScanner && (
                                <div className="space-y-2">
                                    <Label>{t('settings.pos.barcodeHotkey')}</Label>
                                    <Input
                                        value={barcodeHotkey}
                                        onChange={handleBarcodeHotkeyChange}
                                        maxLength={1}
                                        className="w-20 text-center font-mono uppercase"
                                    />
                                    <p className="text-sm text-muted-foreground">
                                        {t('settings.pos.barcodeHotkeyDesc')}
                                    </p>
                                </div>
                            )}

                            <div className="border-t border-border/50 pt-4">
                                <Button
                                    variant="outline"
                                    type="button"
                                    className="h-12 w-full rounded-xl border-dashed border-primary/50 bg-primary/5 font-bold flex items-center justify-center gap-2"
                                    onClick={() => setIsPosAdjustOpen(true)}
                                >
                                    <Menu className="w-4 h-4 text-primary" />
                                    {t('pos.posAdjust', 'Pos Adjust')}
                                </Button>
                                <p className="text-sm text-muted-foreground mt-2">
                                    {t('settings.pos.posAdjustDesc') || 'Open Pos Adjust to configure POS layout and display settings.'}
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    <PosAdjust
                        open={isPosAdjustOpen}
                        onOpenChange={setIsPosAdjustOpen}
                        productsPerRow={posProductsPerRow}
                        onProductsPerRowChange={(value) => {
                            setPosProductsPerRow(value)
                            localStorage.setItem('pos_products_per_row', value.toString())
                        }}
                        showQuantityIndicator={posShowQuantityIndicator}
                        onShowQuantityIndicatorChange={(value) => {
                            setPosShowQuantityIndicator(value)
                            localStorage.setItem('pos_show_quantity_indicator', value.toString())
                        }}
                        showCategories={posShowCategories}
                        onShowCategoriesChange={(value) => {
                            setPosShowCategories(value)
                            localStorage.setItem('pos_show_categories', value.toString())
                        }}
                        showPreprintReceipt={posShowPreprintReceipt}
                        onShowPreprintReceiptChange={(value) => {
                            setPosShowPreprintReceipt(value)
                            localStorage.setItem('pos_show_preprint_receipt', value.toString())
                        }}
                    />

                </TabsContent>

                <TabsContent value="profile" className="space-y-6 mt-0">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <User className="w-5 h-5" />
                                {t('settings.profile.title') || 'Profile Settings'}
                            </CardTitle>
                            <CardDescription>
                                {t('settings.profile.desc') || 'Manage your personal and workspace profile information.'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* Profile Picture Section */}
                            <div className="space-y-4">
                                <Label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Profile Picture</Label>
                                <div className="flex items-center gap-6">
                                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-3xl font-bold text-white overflow-hidden shadow-lg border-2 border-background">
                                        {user?.profileUrl ? (
                                            <img
                                                src={platformService.convertFileSrc(user.profileUrl)}
                                                alt={user.name}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : (
                                            user?.name?.charAt(0).toUpperCase() || 'U'
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" onClick={handleProfilePictureUpload} className="gap-2">
                                                <ImageIcon className="w-4 h-4" />
                                                {t('settings.profile.change_picture') || 'Change Picture'}
                                            </Button>
                                            {user?.profileUrl && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={handleRemoveProfilePicture}
                                                    className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                    title={t('common.delete') || 'Delete'}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-muted-foreground max-w-[200px]">
                                            Optimized for all devices. Syncs automatically.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* User Information Section */}
                            <div className="pt-6 border-t border-border/50 space-y-4">
                                <Label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">User Information</Label>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-xs text-muted-foreground">Store Employee</Label>
                                        <p className="font-medium text-lg">{user?.name}</p>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs text-muted-foreground">Email Address</Label>
                                        <p className="font-medium text-lg">{user?.email}</p>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs text-muted-foreground">Account Role</Label>
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest",
                                                user?.role === 'admin' ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                                            )}>
                                                {user?.role}
                                            </span>
                                        </div>
                                    </div>
                                    {user?.role === 'admin' && (canUseMultipleContacts || workspaceContacts.length === 0 || isLocalMode) && (
                                        <div className="space-y-1">
                                            <Label className="text-xs text-muted-foreground">{t('workspaceConfig.contacts.title', 'Workspace Contacts')}</Label>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                className={cn("w-full justify-start text-left font-normal h-10", workspaceContacts.length > 0 ? "text-foreground" : "text-muted-foreground")}
                                                onClick={() => setContactsModalOpen(true)}
                                            >
                                                <Contact className="mr-2 h-4 w-4 opacity-50" />
                                                {workspaceContacts.length > 0
                                                    ? `${workspaceContacts.length} contact${workspaceContacts.length > 1 ? 's' : ''} configured`
                                                    : (t('workspaceConfig.contacts.addContacts', 'Add Contacts'))}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>


                            {/* Workspace Logo Section (Admin Only) */}
                            {user?.role === 'admin' && (
                                <div className="pt-6 border-t border-border/50 space-y-4">
                                    <div className="flex flex-col gap-1">
                                        <Label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{t('settings.branding.title')}</Label>
                                        <p className="text-sm text-muted-foreground">{t('settings.branding.subtitle')}</p>
                                    </div>

                                    <div className="space-y-4 max-w-sm">
                                        <div className="space-y-2">
                                            <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.branding.name')}</Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    value={localWorkspaceName}
                                                    onChange={(e) => setLocalWorkspaceName(e.target.value)}
                                                    placeholder={t('settings.branding.namePlaceholder') || "Enter workspace name"}
                                                    className="flex-1"
                                                />
                                                <Button
                                                    size="sm"
                                                    onClick={async () => {
                                                        await updateSettings({ name: localWorkspaceName });
                                                        toast({
                                                            title: t('settings.branding.nameSuccess') || "Workspace name updated",
                                                            duration: 3000
                                                        });
                                                    }}
                                                    disabled={localWorkspaceName === workspaceName}
                                                >
                                                    {t('common.save') || "Save"}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-6 pt-4">
                                        <div className="w-24 h-24 rounded-2xl bg-muted/50 border-2 border-dashed border-border flex items-center justify-center overflow-hidden relative group">
                                            {features.logo_url ? (
                                                <img
                                                    src={getDisplayLogoUrl(features.logo_url)}
                                                    alt="Workspace Logo"
                                                    className="w-full h-full object-contain p-2"
                                                />
                                            ) : (
                                                <ImageIcon className="w-8 h-8 opacity-20" />
                                            )}
                                            <div
                                                className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                                                onClick={handleLogoUpload}
                                            >
                                                <RefreshCw className="w-5 h-5 text-white" />
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-2">
                                            <div className="flex gap-2">
                                                <Button variant="outline" size="sm" onClick={handleLogoUpload} className="gap-2">
                                                    <ImageIcon className="w-4 h-4" />
                                                    {features.logo_url ? 'Change Logo' : 'Upload Logo'}
                                                </Button>
                                                {features.logo_url && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={handleRemoveLogo}
                                                        className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                        title={t('common.delete') || 'Delete'}
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-6 border-t border-border/50 space-y-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <ShieldCheck className="h-5 w-5" />
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                                                    {t('settings.partnerPrivacy.title')}
                                                </Label>
                                                <p className="text-sm text-muted-foreground">
                                                    {t('settings.partnerPrivacy.description')}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="grid gap-4 lg:grid-cols-3">
                                            <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center gap-2 font-semibold">
                                                        <UsersRound className="h-4 w-4 text-primary" />
                                                        {t('settings.partnerPrivacy.privateStaffCustomers')}
                                                    </div>
                                                    <p className="text-sm leading-5 text-muted-foreground">
                                                        {t('settings.partnerPrivacy.privateStaffCustomersDescription')}
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.private_staff_customers}
                                                    disabled={partnerPrivacySaving !== null}
                                                    onCheckedChange={(value) => void handlePartnerPrivacyChange('private_staff_customers', value)}
                                                    aria-label={t('settings.partnerPrivacy.privateStaffCustomers')}
                                                />
                                            </div>

                                            <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center gap-2 font-semibold">
                                                        <UsersRound className="h-4 w-4 text-primary" />
                                                        {t('settings.partnerPrivacy.privateStaffSuppliers')}
                                                    </div>
                                                    <p className="text-sm leading-5 text-muted-foreground">
                                                        {t('settings.partnerPrivacy.privateStaffSuppliersDescription')}
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.private_staff_suppliers}
                                                    disabled={partnerPrivacySaving !== null}
                                                    onCheckedChange={(value) => void handlePartnerPrivacyChange('private_staff_suppliers', value)}
                                                    aria-label={t('settings.partnerPrivacy.privateStaffSuppliers')}
                                                />
                                            </div>

                                            <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center gap-2 font-semibold">
                                                        <ShieldCheck className="h-4 w-4 text-primary" />
                                                        {t('settings.partnerPrivacy.suppliersAdminOnly')}
                                                    </div>
                                                    <p className="text-sm leading-5 text-muted-foreground">
                                                        {t('settings.partnerPrivacy.suppliersAdminOnlyDescription')}
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.suppliers_admin_only}
                                                    disabled={partnerPrivacySaving !== null}
                                                    onCheckedChange={(value) => void handlePartnerPrivacyChange('suppliers_admin_only', value)}
                                                    aria-label={t('settings.partnerPrivacy.suppliersAdminOnly')}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {canUseMarketplace && (
                                    <div className="pt-6 border-t border-border/50 space-y-4">
                                        <div className="flex flex-col gap-1">
                                            <Label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                                                {t('settings.marketplace.title', { defaultValue: 'Marketplace' })}
                                            </Label>
                                            <p className="text-sm text-muted-foreground">
                                                {t('settings.marketplace.visibilityDesc', {
                                                    defaultValue: 'When set to Public, your products will appear in the Atlas Marketplace.'
                                                })}
                                            </p>
                                        </div>

                                        {isLocalMode && (
                                            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-300">
                                                {t('settings.marketplace.localUnsupported', {
                                                    defaultValue: 'Marketplace publishing is available only for cloud and hybrid workspaces.'
                                                })}
                                            </div>
                                        )}

                                        <div className="grid gap-4 lg:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label>{t('settings.marketplace.visibility', { defaultValue: 'Store Visibility' })}</Label>
                                                <Select
                                                    value={marketplaceVisibility}
                                                    onValueChange={(value: 'private' | 'public' | 'link_only') => setMarketplaceVisibility(value)}
                                                    disabled={isLocalMode}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="private">
                                                            {t('settings.marketplace.private', { defaultValue: 'Private' })}
                                                        </SelectItem>
                                                        <SelectItem value="public">
                                                            {t('settings.marketplace.public', { defaultValue: 'Public' })}
                                                        </SelectItem>
                                                        <SelectItem value="link_only">
                                                            {t('settings.marketplace.linkOnly', { defaultValue: 'Public (By link)' })}
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="space-y-2">
                                                <Label>{t('settings.marketplace.slug', { defaultValue: 'Store URL Slug' })}</Label>
                                                <Input
                                                    value={marketplaceSlug}
                                                    onChange={(event) => setMarketplaceSlug(event.target.value)}
                                                    placeholder="baghdad-tools"
                                                    disabled={isLocalMode}
                                                />
                                                <div className="text-xs text-muted-foreground">
                                                    {marketplacePreviewUrl ? marketplacePreviewUrl : t('settings.marketplace.slugDesc', { defaultValue: 'Your store will be available at /s/your-slug' })}
                                                </div>
                                                {!isLocalMode && normalizedMarketplaceSlug && (
                                                    <div className={cn(
                                                        'text-xs',
                                                        marketplaceSlugStatus === 'taken' && 'text-destructive',
                                                        marketplaceSlugStatus === 'invalid' && 'text-destructive',
                                                        marketplaceSlugStatus === 'available' && 'text-emerald-600 dark:text-emerald-300',
                                                        marketplaceSlugStatus === 'checking' && 'text-muted-foreground'
                                                    )}>
                                                        {marketplaceSlugStatus === 'checking' && (
                                                            <span className="inline-flex items-center gap-2">
                                                                <RefreshCw className="h-3 w-3 animate-spin" />
                                                                {t('settings.marketplace.slugChecking', { defaultValue: 'Checking availability...' })}
                                                            </span>
                                                        )}
                                                        {marketplaceSlugStatus === 'taken' && t('settings.marketplace.slugTaken', { defaultValue: 'This slug is already taken' })}
                                                        {marketplaceSlugStatus === 'invalid' && t('settings.marketplace.slugInvalid', { defaultValue: 'Only lowercase letters, numbers, and hyphens allowed' })}
                                                        {marketplaceSlugStatus === 'available' && t('settings.marketplace.slugAvailable', { defaultValue: 'This slug is available' })}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('settings.marketplace.description', { defaultValue: 'Store Description' })}</Label>
                                            <Textarea
                                                value={marketplaceDescription}
                                                onChange={(event) => setMarketplaceDescription(event.target.value)}
                                                placeholder={t('settings.marketplace.descriptionDesc', {
                                                    defaultValue: 'Shown on the marketplace gallery page.'
                                                })}
                                                rows={4}
                                                disabled={isLocalMode}
                                            />
                                        </div>

                                        {canUsePriceBooks && priceBookCatalog.isReady
                                            && priceBookCatalog.priceBooks.length > 0
                                            && (
                                                <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                                    <StorefrontCatalogRulesEditor
                                                        workspaceId={user?.workspaceId ?? null}
                                                        storefrontId={null}
                                                        priceBooks={priceBookCatalog.priceBooks}
                                                                                                                disabled={isLocalMode}
                                                    />
                                                </div>
                                            )}

                                        <div className="space-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                            <div className="flex flex-col gap-1">
                                                <Label className="text-sm font-semibold">
                                                    {t('settings.marketplace.secondaryStorefront', { defaultValue: 'Additional Storefront' })}
                                                </Label>
                                                <p className="text-xs text-muted-foreground">
                                                    {t('settings.marketplace.secondaryStorefrontDesc', {
                                                        defaultValue: 'Add a second storefront with its own URL, visibility, description, and catalog.'
                                                    })}
                                                </p>
                                            </div>

                                            {isSecondaryStorefrontLoading ? (
                                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                                    {t('common.loading', { defaultValue: 'Loading...' })}
                                                </div>
                                            ) : !secondaryStorefront ? (
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleAddSecondaryStorefront}
                                                    disabled={isLocalMode || isSecondaryStorefrontActionPending}
                                                    className="gap-2"
                                                >
                                                    <Plus className="h-4 w-4" />
                                                    {t('settings.marketplace.secondaryStorefrontAdd', { defaultValue: 'Add Storefront' })}
                                                </Button>
                                            ) : (
                                                <div className="space-y-4">
                                                    <div className="grid gap-4 lg:grid-cols-2">
                                                        <div className="space-y-2">
                                                            <Label>{t('settings.marketplace.visibility', { defaultValue: 'Store Visibility' })}</Label>
                                                            <Select
                                                                value={secondaryStorefrontVisibility}
                                                                onValueChange={(value: 'private' | 'public' | 'link_only') => setSecondaryStorefrontVisibility(value)}
                                                                disabled={isLocalMode || isSecondaryStorefrontActionPending}
                                                            >
                                                                <SelectTrigger>
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="private">
                                                                        {t('settings.marketplace.private', { defaultValue: 'Private' })}
                                                                    </SelectItem>
                                                                    <SelectItem value="public">
                                                                        {t('settings.marketplace.public', { defaultValue: 'Public' })}
                                                                    </SelectItem>
                                                                    <SelectItem value="link_only">
                                                                        {t('settings.marketplace.linkOnly', { defaultValue: 'Public (By link)' })}
                                                                    </SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                        </div>

                                                        <div className="space-y-2">
                                                            <Label>{t('settings.marketplace.slug', { defaultValue: 'Store URL Slug' })}</Label>
                                                            <Input
                                                                value={secondaryStorefrontSlug}
                                                                onChange={(event) => setSecondaryStorefrontSlug(event.target.value)}
                                                                placeholder="baghdad-tools"
                                                                disabled={isLocalMode || isSecondaryStorefrontActionPending}
                                                            />
                                                            <div className="text-xs text-muted-foreground">
                                                                {secondaryStorefrontPreviewUrl
                                                                    ? secondaryStorefrontPreviewUrl
                                                                    : t('settings.marketplace.slugDesc', { defaultValue: 'Your store will be available at /s/your-slug' })}
                                                            </div>
                                                            {!isLocalMode && normalizedSecondaryStorefrontSlug && (
                                                                <div className={cn(
                                                                    'text-xs',
                                                                    secondaryStorefrontSlugStatus === 'taken' && 'text-destructive',
                                                                    secondaryStorefrontSlugStatus === 'invalid' && 'text-destructive',
                                                                    secondaryStorefrontSlugStatus === 'available' && 'text-emerald-600 dark:text-emerald-300',
                                                                    secondaryStorefrontSlugStatus === 'checking' && 'text-muted-foreground'
                                                                )}>
                                                                    {secondaryStorefrontSlugStatus === 'checking' && (
                                                                        <span className="inline-flex items-center gap-2">
                                                                            <RefreshCw className="h-3 w-3 animate-spin" />
                                                                            {t('settings.marketplace.slugChecking', { defaultValue: 'Checking availability...' })}
                                                                        </span>
                                                                    )}
                                                                    {secondaryStorefrontSlugStatus === 'taken' && t('settings.marketplace.slugTaken', { defaultValue: 'This slug is already taken' })}
                                                                    {secondaryStorefrontSlugStatus === 'invalid' && t('settings.marketplace.slugInvalid', { defaultValue: 'Only lowercase letters, numbers, and hyphens allowed' })}
                                                                    {secondaryStorefrontSlugStatus === 'available' && t('settings.marketplace.slugAvailable', { defaultValue: 'This slug is available' })}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>

                                                    <div className="space-y-2">
                                                        <Label>{t('settings.marketplace.description', { defaultValue: 'Store Description' })}</Label>
                                                        <Textarea
                                                            value={secondaryStorefrontDescription}
                                                            onChange={(event) => setSecondaryStorefrontDescription(event.target.value)}
                                                            placeholder={t('settings.marketplace.descriptionDesc', {
                                                                defaultValue: 'Shown on the marketplace gallery page.'
                                                            })}
                                                            rows={3}
                                                            disabled={isLocalMode || isSecondaryStorefrontActionPending}
                                                        />
                                                    </div>

                                                    <div className="flex flex-wrap gap-2">
                                                        <Button
                                                            type="button"
                                                            onClick={handleSaveSecondaryStorefront}
                                                            disabled={isLocalMode || isSecondaryStorefrontActionPending || secondaryStorefrontSlugStatus === 'checking'}
                                                            className="gap-2"
                                                        >
                                                            <Store className="h-4 w-4" />
                                                            {isSecondaryStorefrontActionPending
                                                                ? (t('common.loading') || 'Loading...')
                                                                : (t('common.save') || 'Save')}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="destructive"
                                                            onClick={handleRemoveSecondaryStorefront}
                                                            disabled={isLocalMode || isSecondaryStorefrontActionPending}
                                                            className="gap-2"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                            {t('settings.marketplace.secondaryStorefrontRemove', { defaultValue: 'Remove Storefront' })}
                                                        </Button>
                                                    </div>

                                                    {canUsePriceBooks && (
                                                        <div className="border-t border-border/50 pt-4">
                                                            <StorefrontCatalogRulesEditor
                                                                workspaceId={user?.workspaceId ?? null}
                                                                storefrontId={secondaryStorefront.id}
                                                                priceBooks={priceBookCatalog.priceBooks}
                                                                                                                                disabled={isLocalMode}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap gap-2">
                                            <Button
                                                type="button"
                                                onClick={handleMarketplaceSave}
                                                disabled={isLocalMode || isSavingMarketplace || marketplaceSlugStatus === 'checking'}
                                                className="gap-2"
                                            >
                                                <Store className="h-4 w-4" />
                                                {isSavingMarketplace
                                                    ? (t('common.loading') || 'Loading...')
                                                    : (t('common.save') || 'Save')}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={handleMarketplacePreview}
                                                disabled={!marketplacePreviewUrl}
                                                className="gap-2"
                                            >
                                                <ExternalLink className="h-4 w-4" />
                                                {t('settings.marketplace.preview', { defaultValue: 'Preview Store' })}
                                            </Button>
                                        </div>
                                    </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {user?.role === 'admin' && !isLocalMode && canUseBranches && (
                        <BranchManager />
                    )}

                    <Dialog open={isSecondaryStorefrontRemoveConfirmOpen} onOpenChange={setIsSecondaryStorefrontRemoveConfirmOpen}>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>
                                    {t('settings.marketplace.secondaryStorefrontRemove', { defaultValue: 'Remove Storefront' })}
                                </DialogTitle>
                                <DialogDescription>
                                    {t('settings.marketplace.secondaryStorefrontRemoveConfirm', {
                                        defaultValue: 'Remove this storefront? Its URL, visibility, and catalog rules will be deleted as well.'
                                    })}
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsSecondaryStorefrontRemoveConfirmOpen(false)}
                                    disabled={isSecondaryStorefrontActionPending}
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={handleConfirmRemoveSecondaryStorefront}
                                    disabled={isSecondaryStorefrontActionPending}
                                    className="gap-2"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {isSecondaryStorefrontActionPending
                                        ? (t('common.loading') || 'Loading...')
                                        : (t('settings.marketplace.secondaryStorefrontRemove', { defaultValue: 'Remove Storefront' }))}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    {/* Contact Modal (rendered outside card but inside profile tab) */}
                    {user?.role === 'admin' && (
                        <RegisterWorkspaceContactsModal
                            open={contactsModalOpen}
                            onOpenChange={setContactsModalOpen}
                            contacts={workspaceContacts.map(p => ({ type: p.type, value: p.value, label: p.label || '', isPrimary: p.isPrimary }))}
                            onContactsChange={async (newContacts) => {
                                if (!user?.workspaceId) return
                                const planContacts = isLocalMode || canUseMultipleContacts
                                    ? newContacts
                                    : newContacts.slice(0, 1).map((contact) => ({ ...contact, isPrimary: true }))

                                if (isLocalMode) {
                                    const now = new Date().toISOString()
                                    await db.workspace_contacts.where('workspaceId').equals(user.workspaceId).delete()
                                    const localRecords = planContacts.map((p: any) => ({
                                        id: generateId(),
                                        workspaceId: user.workspaceId,
                                        type: p.type,
                                        value: p.value,
                                        label: p.label || null,
                                        isPrimary: p.isPrimary,
                                        syncStatus: 'synced' as const,
                                        lastSyncedAt: now,
                                        version: 1,
                                        createdAt: now,
                                        updatedAt: now
                                    }))
                                    await db.workspace_contacts.bulkPut(localRecords)
                                    return
                                }

                                try {
                                    const { error: deleteError } = await runSupabaseAction('settings.replaceWorkspaceContacts.delete', () =>
                                        supabase.from('workspace_contacts').delete().eq('workspace_id', user.workspaceId)
                                    )
                                    if (deleteError) throw normalizeSupabaseActionError(deleteError)

                                    if (planContacts.length > 0) {
                                        const payload = planContacts.map(p => ({
                                            workspace_id: user.workspaceId,
                                            type: p.type,
                                            value: p.value,
                                            label: p.label || null,
                                            is_primary: p.isPrimary
                                        }))
                                        const { error: insertError } = await runSupabaseAction('settings.replaceWorkspaceContacts.insert', () =>
                                            supabase.from('workspace_contacts').insert(payload)
                                        )
                                        if (insertError) throw normalizeSupabaseActionError(insertError)
                                    }

                                    // Re-fetch from Supabase and write to local DB for instant UI update
                                    const { data, error: fetchError } = await runSupabaseAction('settings.replaceWorkspaceContacts.fetch', () =>
                                        supabase.from('workspace_contacts').select('*').eq('workspace_id', user.workspaceId)
                                    )
                                    if (fetchError) throw normalizeSupabaseActionError(fetchError)

                                    await db.workspace_contacts.where('workspaceId').equals(user.workspaceId).delete()
                                    if (data && data.length > 0) {
                                        const localRecords = data.map((r: any) => ({
                                            id: r.id,
                                            workspaceId: r.workspace_id,
                                            type: r.type,
                                            value: r.value,
                                            label: r.label,
                                            isPrimary: r.is_primary,
                                            syncStatus: 'synced' as const,
                                            lastSyncedAt: new Date().toISOString(),
                                            version: r.version || 1,
                                            createdAt: r.created_at,
                                            updatedAt: r.updated_at
                                        }))
                                        await db.workspace_contacts.bulkPut(localRecords)
                                    }
                                } catch (error) {
                                    console.error('[Settings] Failed to update workspace contacts:', error)
                                    showActionError(error, 'Failed to update workspace contacts.')
                                    throw error
                                }
                            }}
                        />
                    )}
                </TabsContent>


                <TabsContent value="workspace" className="space-y-6 mt-0">
                    {user?.role === 'admin' && hasFeature('instant_pos') && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Table2 className="h-5 w-5 text-primary" />
                                    {t('settings.restaurantTableView.title')}
                                </CardTitle>
                                <CardDescription>{t('settings.restaurantTableView.description')}</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/20 p-4">
                                    <div className="space-y-1">
                                        <Label className="font-semibold">{t('settings.restaurantTableView.enabled')}</Label>
                                        <p className="text-sm text-muted-foreground">{t('settings.restaurantTableView.enabledDescription')}</p>
                                    </div>
                                    <Switch
                                        checked={restaurantTableViewEnabled}
                                        disabled={isRestaurantTableViewSaving}
                                        onCheckedChange={(enabled) => {
                                            setRestaurantTableViewEnabled(enabled)
                                            setIsRestaurantTableViewDirty(true)
                                        }}
                                        aria-label={t('settings.restaurantTableView.enabled')}
                                    />
                                </div>

                                <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/20 p-4">
                                    <div className="space-y-1">
                                        <Label className="font-semibold">{t('settings.restaurantTableView.liveSyncEnabled')}</Label>
                                        <p className="text-sm text-muted-foreground">{t('settings.restaurantTableView.liveSyncEnabledDescription')}</p>
                                    </div>
                                    <Switch
                                        checked={restaurantLiveSyncEnabled}
                                        onCheckedChange={(enabled) => {
                                            setRestaurantLiveSyncEnabled(enabled)
                                            setIsRestaurantTableViewDirty(true)
                                        }}
                                        disabled={isRestaurantTableViewSaving}
                                        aria-label={t('settings.restaurantTableView.liveSyncEnabled')}
                                    />
                                </div>

                                <div className="max-w-sm space-y-2">
                                    <Label htmlFor="restaurant-table-count">{t('settings.restaurantTableView.tableCountRequired')}</Label>
                                    <Input
                                        id="restaurant-table-count"
                                        type="number"
                                        min={1}
                                        max={100}
                                        inputMode="numeric"
                                        value={restaurantTableCount}
                                        onChange={(event) => {
                                            setRestaurantTableCount(event.target.value)
                                            setIsRestaurantTableViewDirty(true)
                                        }}
                                        placeholder="0"
                                        disabled={isRestaurantTableViewSaving}
                                    />
                                    <p className="text-xs text-muted-foreground">{t('settings.restaurantTableView.tableCountHint')}</p>
                                </div>

                                {normalizeRestaurantTableCount(Number(restaurantTableCount)) && (
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2">
                                            <Crown className="h-4 w-4 text-amber-600" />
                                            <Label>{t('settings.restaurantTableView.vipTables')}</Label>
                                        </div>
                                        <p className="text-sm text-muted-foreground">{t('settings.restaurantTableView.vipTablesDescription')}</p>
                                        <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-10">
                                            {Array.from({ length: normalizeRestaurantTableCount(Number(restaurantTableCount))! }, (_, index) => index + 1).map((tableNumber) => {
                                                const selected = restaurantVipTables.includes(tableNumber)
                                                return (
                                                    <Button
                                                        key={tableNumber}
                                                        type="button"
                                                        variant={selected ? 'default' : 'outline'}
                                                        size="sm"
                                                        disabled={isRestaurantTableViewSaving}
                                                        onClick={() => {
                                                            setRestaurantVipTables((current) => selected
                                                                ? current.filter((value) => value !== tableNumber)
                                                                : [...current, tableNumber]
                                                            )
                                                            setIsRestaurantTableViewDirty(true)
                                                        }}
                                                    >
                                                        {tableNumber}
                                                    </Button>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )}

                                <Button
                                    onClick={() => void saveRestaurantTableView()}
                                    disabled={isRestaurantTableViewSaving || !normalizeRestaurantTableCount(Number(restaurantTableCount))}
                                    className="gap-2"
                                >
                                    <Table2 className="h-4 w-4" />
                                    {isRestaurantTableViewSaving
                                        ? t('settings.restaurantTableView.saving')
                                        : t('common.save')}
                                </Button>
                            </CardContent>
                        </Card>
                    )}

                    {canManageClinicalRegistry && user?.workspaceId && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <CalendarClock className="w-5 h-5" />
                                    {t('settings.clinicalRegistry.title', { defaultValue: 'Appointment Registry Type' })}
                                </CardTitle>
                                <CardDescription>
                                    {t('settings.clinicalRegistry.description', {
                                        defaultValue: 'Choose whether this appointment registry uses medical patient clinic or Beauty Center terminology.',
                                    })}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="flex items-center justify-between gap-6 rounded-lg border border-border bg-muted/50 p-4">
                                    <div className="space-y-1">
                                        <Label htmlFor="clinical-registry-type">
                                            {clinicalRegistryType === 'beauty'
                                                ? t('settings.clinicalRegistry.beauty', { defaultValue: 'Beauty Center' })
                                                : t('settings.clinicalRegistry.medical', { defaultValue: 'Medical Patient Clinic' })}
                                        </Label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settings.clinicalRegistry.workspaceWide', {
                                                defaultValue: 'Applies to this workspace on every device. It does not change or migrate appointment data.',
                                            })}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-3">
                                        <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
                                            {t('settings.clinicalRegistry.medical', { defaultValue: 'Medical Patient Clinic' })}
                                        </span>
                                        <Switch
                                            id="clinical-registry-type"
                                            checked={clinicalRegistryType === 'beauty'}
                                            onCheckedChange={handleClinicalRegistryTypeChange}
                                            disabled={isClinicalRegistrySaving}
                                            aria-label={t('settings.clinicalRegistry.toggleLabel', {
                                                defaultValue: 'Use Beauty Center terminology',
                                            })}
                                        />
                                        <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
                                            {t('settings.clinicalRegistry.beauty', { defaultValue: 'Beauty Center' })}
                                        </span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Printing Settings */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Printer className="w-5 h-5" />
                                {t('settings.printing.title') || 'Printing Settings'}
                            </CardTitle>
                            <CardDescription>
                                {t('settings.printing.desc') || 'Define your preferred language for printed documents (Invoices & Receipts).'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-col gap-6">
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="flex flex-col gap-2">
                                        <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.printing.receiptTemplate') || 'Normal Receipt Template'}</Label>
                                        <Select
                                            value={features.receipt_template || 'primary'}
                                            onValueChange={(val: any) => updateSettings({ receipt_template: val })}
                                            disabled
                                        >
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select template" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="primary">{t('settings.printing.primary') || 'Primary'}</SelectItem>
                                                <SelectItem value="modern" disabled>{t('settings.printing.modern') || 'Modern (Coming Soon)'}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-[10px] text-muted-foreground italic">
                                            {t('settings.printing.templateDesc') || 'Standard 80mm receipt design.'}
                                        </p>
                                    </div>

                                    {canUseA4Invoices && (
                                    <div className="flex flex-col gap-2">
                                        <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.printing.a4Template') || 'A4 Invoice Template'}</Label>
                                        <Select
                                            value={features.a4_template || 'professional'}
                                            onValueChange={(val: any) => updateSettings({ a4_template: val })}
                                        >
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select template" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="primary">{t('settings.printing.primary') || 'Primary'}</SelectItem>
                                                <SelectItem value="modern">{t('settings.printing.modern') || 'Modern'}</SelectItem>
                                                <SelectItem value="professional">{t('settings.printing.professional', { defaultValue: 'Professional' })}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-[10px] text-muted-foreground italic">
                                            {t('settings.printing.templateDesc') || 'Full page A4 invoice design.'}
                                        </p>
                                    </div>
                                    )}

                                </div>

                                {(canUseA4Invoices || canUseReceiptPrinting) && (<>
                                <div className="flex flex-col gap-2 max-w-sm">
                                    <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.printing.language') || 'Print Language'}</Label>
                                    <Select
                                        value={features.print_lang || 'auto'}
                                        onValueChange={(val: any) => updateSettings({ print_lang: val })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select language" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="auto">{t('settings.printing.auto') || 'As of the selected language'}</SelectItem>
                                            <SelectItem value="en">English</SelectItem>
                                            <SelectItem value="ar">العربية</SelectItem>
                                            <SelectItem value="ku">کوردی</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                </>)}

                                <div className="grid gap-4 md:grid-cols-2 max-w-3xl">
                                    {canUseReceiptPrinting && (
                                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border">
                                        <div className="space-y-0.5 pr-4">
                                            <Label className="text-sm font-medium">
                                                {t('settings.printing.autoPrintUponCheckoutTitle')}
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.printing.autoPrintUponCheckoutDesc')}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={autoPrintUponCheckout}
                                            onCheckedChange={handleAutoPrintUponCheckoutChange}
                                            disabled={isAutoPrintUponCheckoutSaving || !user?.workspaceId}
                                        />
                                    </div>
                                    )}
                                    {canUseThermalPrinter && (<>
                                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border">
                                        <div className="space-y-0.5 pr-4">
                                            <Label className="text-sm font-medium">{t('settings.printing.qrTitle') || 'Generate QR Code'}</Label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.printing.qrDesc') || 'Include a QR code on invoices for digital verification.'}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={features.print_qr}
                                            onCheckedChange={(val) => updateSettings({ print_qr: val })}
                                        />
                                    </div>

                                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border">
                                        <div className="space-y-0.5 pr-4">
                                            <Label className="text-sm font-medium">
                                                {t('settings.printing.thermalTitle', { defaultValue: 'Thermal Printing' })}
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                {features.thermal_printing
                                                    ? selectedThermalPrinter
                                                        ? t('settings.printing.thermalEnabledSummary', {
                                                            defaultValue: `Enabled on this device with ${selectedThermalPrinter.name}. Click the toggle to manage printers.`
                                                        })
                                                        : t('settings.printing.thermalMissingSelection', {
                                                            defaultValue: 'Thermal printing is enabled for this workspace, but no printer is selected on this device yet.'
                                                        })
                                                    : selectedThermalPrinter
                                                        ? t('settings.printing.thermalSavedSummary', {
                                                            defaultValue: `Saved printer: ${selectedThermalPrinter.name}. Click the toggle to enable or change it.`
                                                        })
                                                        : t('settings.printing.thermalDesc', {
                                                            defaultValue: 'Scan this device for available thermal printers and enable one for POS receipt printing.'
                                                        })}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={features.thermal_printing}
                                            onCheckedChange={openThermalPrinterDialog}
                                        />
                                    </div>
                                    </>)}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {hasFeature('kds') && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <MonitorPlay className="w-5 h-5" />
                                    {t('settings.kds.title') || 'Kitchen Display System'}
                                </CardTitle>
                                <CardDescription>
                                    {t('settings.kds.accessManaged') || 'KDS access is managed by the platform admin dashboard.'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                {!isDesktop() ? (
                                    <p className="text-sm font-medium text-amber-500">
                                        {t('settings.kds.desktopOnly') || 'KDS Hosting is only available on Desktop app.'}
                                    </p>
                                ) : (
                                    <div className="animate-in fade-in slide-in-from-top-2 p-4 border border-emerald-500/20 bg-emerald-500/5 rounded-xl flex flex-col md:flex-row gap-6 items-center">
                                        <div className="flex-1 space-y-4">
                                            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
                                                <Wifi className="w-4 h-4" />
                                                <span>{kdsStatus === 'host' ? 'Hosting Active' : kdsStatus === 'reconnecting' ? 'Starting Server...' : 'Ready'}</span>
                                            </div>
                                            <div>
                                                <Label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Access URL</Label>
                                                <div className="flex items-center gap-2">
                                                    <Input
                                                        readOnly
                                                        value={streamUrl || 'Waiting for connection...'}
                                                        className="font-mono text-sm bg-background border-emerald-500/20 focus-visible:ring-emerald-500/30"
                                                    />
                                                    {streamUrl && (
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={async () => {
                                                                await navigator.clipboard.writeText(streamUrl)
                                                                toast({ description: 'Copied to clipboard' })
                                                            }}
                                                            className="shrink-0 hover:bg-emerald-500 hover:text-white border-emerald-500/20"
                                                        >
                                                            <Copy className="w-4 h-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                                <p className="text-[10px] text-muted-foreground mt-2 italic">
                                                    Connect other devices to the same Wi-Fi network and enter this URL in the browser.
                                                </p>
                                            </div>
                                        </div>
                                        {streamUrl && (
                                            <div className="shrink-0 p-2 bg-white rounded-xl shadow-sm border border-border">
                                                <ReactQRCode value={streamUrl} size={100} level="M" />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* Currency Settings (Admin Only) */}
                    {user?.role === 'admin' && canUseMultiCurrency && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Coins className="w-5 h-5" />
                                    {t('settings.currency.title') || 'Currency Settings'}
                                </CardTitle>
                                <CardDescription>
                                    {t('settings.currency.desc') || 'Configure default currency and display preferences for your workspace.'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-6">
                                <div className="grid gap-6 md:grid-cols-2">
                                    <CurrencySelector
                                        label={t('settings.currency.default') || 'Default Currency'}
                                        value={features.default_currency}
                                        onChange={handleCurrencySelect}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        disabled={hasFxAccountingData}
                                    />
                                    {hasFxAccountingData && (
                                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
                                            {t('currencyExchange.messages.workspaceCurrencyLockedDescription')}
                                        </div>
                                    )}

                                    {features.default_currency === 'iqd' && (
                                        <div className="space-y-2">
                                            <Label>{t('settings.currency.iqdPreference') || 'IQD Display Preference'}</Label>
                                            <Select
                                                value={features.iqd_display_preference}
                                                onValueChange={(val) => updateSettings({ iqd_display_preference: val as IQDDisplayPreference })}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="IQD">IQD (English)</SelectItem>
                                                    <SelectItem value="د.ع">د.ع (Arabic)</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Exchange Rate Settings (Admin Only) */}
                    {user?.role === 'admin' && canUseMultiCurrency && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Globe className="w-5 h-5" />
                                    {t('settings.exchangeRate.title') || 'Exchange Rate Source'}
                                </CardTitle>
                                <CardDescription>
                                    {t('settings.exchangeRate.primaryDesc') || 'Select which website to use for live market rates.'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-4 max-w-md">
                                    <div className="space-y-2">
                                        <Label>{t('settings.exchangeRate.primary') || 'Primary Source'}</Label>
                                        <div className="flex items-center gap-2">
                                            <Select value={exchangeRateSource} onValueChange={handleExchangeRateSourceChange}>
                                                <SelectTrigger className="flex-1">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <Button
                                                        variant="ghost"
                                                        className="w-full justify-start font-bold text-emerald-600 border-b rounded-none px-2 mb-1"
                                                        onClick={() => openManualEditor('USD')}
                                                    >
                                                        + {t('settings.exchangeRate.addManual')}
                                                    </Button>
                                                    <SelectItem value="manual">
                                                        {t('settings.exchangeRate.manual')}
                                                    </SelectItem>
                                                    <SelectItem value="pmcgroup">
                                                        {t('settings.exchangeRate.pmcgroup')}
                                                    </SelectItem>
                                                    <SelectItem value="xeiqd">
                                                        {t('settings.exchangeRate.xeiqd')}
                                                    </SelectItem>
                                                    <SelectItem value="forexfy">
                                                        {t('settings.exchangeRate.forexfy')}
                                                    </SelectItem>
                                                    <SelectItem value="dolardinar">
                                                        {t('settings.exchangeRate.dolardinar')}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                            {alerts.snoozedPairs.includes('USD/IQD') && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="text-yellow-500 animate-pulse shrink-0 h-10 w-10"
                                                    onClick={() => forceAlert('USD/IQD')}
                                                >
                                                    <Bell className="w-5 h-5 fill-yellow-500" />
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="pt-2 space-y-4 border-t border-border/50">
                                        <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                                            <Label>{t('settings.exchangeRate.eurSource') || 'Euro Exchange Source'}</Label>
                                            <div className="flex items-center gap-2">
                                                <Select value={eurExchangeRateSource} onValueChange={handleEurExchangeRateSourceChange}>
                                                    <SelectTrigger className="flex-1">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <Button
                                                            variant="ghost"
                                                            className="w-full justify-start font-bold text-emerald-600 border-b rounded-none px-2 mb-1"
                                                            onClick={() => openManualEditor('EUR')}
                                                        >
                                                            + {t('settings.exchangeRate.addManual')}
                                                        </Button>
                                                        <SelectItem value="manual">
                                                            {t('settings.exchangeRate.manual')}
                                                        </SelectItem>
                                                        <SelectItem value="forexfy">
                                                            {t('settings.exchangeRate.forexfy_eur')}
                                                        </SelectItem>
                                                        <SelectItem value="dolardinar">
                                                            {t('settings.exchangeRate.dolardinar_eur')}
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                                {alerts.snoozedPairs.includes('EUR/IQD') && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="text-yellow-500 animate-pulse shrink-0 h-10 w-10"
                                                        onClick={() => forceAlert('EUR/IQD')}
                                                    >
                                                        <Bell className="w-5 h-5 fill-yellow-500" />
                                                    </Button>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-muted-foreground italic">
                                                {t('settings.exchangeRate.eurSourceAdminOnly') || 'Forexfy and DolarDinar are currently the supported sources for Euro rates.'}
                                            </p>
                                        </div>

                                        <div className="pt-2 space-y-4 border-t border-border/50">
                                            <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                                                <Label>{t('settings.exchangeRate.trySource') || 'TRY Exchange Source'}</Label>
                                                <div className="flex items-center gap-2">
                                                    <Select value={tryExchangeRateSource} onValueChange={handleTryExchangeRateSourceChange}>
                                                        <SelectTrigger className="flex-1">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <Button
                                                                variant="ghost"
                                                                className="w-full justify-start font-bold text-emerald-600 border-b rounded-none px-2 mb-1"
                                                                onClick={() => openManualEditor('TRY')}
                                                            >
                                                                + {t('settings.exchangeRate.addManual')}
                                                            </Button>
                                                            <SelectItem value="manual">
                                                                {t('settings.exchangeRate.manual')}
                                                            </SelectItem>
                                                            <SelectItem value="forexfy">
                                                                {t('settings.exchangeRate.forexfy_try')}
                                                            </SelectItem>
                                                            <SelectItem value="dolardinar">
                                                                {t('settings.exchangeRate.dolardinar_try')}
                                                            </SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                    {alerts.snoozedPairs.includes('TRY/IQD') && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="text-yellow-500 animate-pulse shrink-0 h-10 w-10"
                                                            onClick={() => forceAlert('TRY/IQD')}
                                                        >
                                                            <Bell className="w-5 h-5 fill-yellow-500" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="pt-4 mt-4 border-t border-border/50 space-y-2">
                                            <Label>{t('settings.exchangeRate.threshold')}</Label>
                                            <div className="flex items-center gap-4">
                                                <Input
                                                    type="number"
                                                    value={exchangeRateThreshold}
                                                    onChange={(e) => handleThresholdChange(e.target.value)}
                                                    className="w-32"
                                                />
                                                <p className="text-xs text-muted-foreground italic">
                                                    {t('settings.exchangeRate.thresholdDesc')}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                </TabsContent>

                <TabsContent value="advanced" className="space-y-6 mt-0">
                    {isSupabaseConfigured && !isDemoMode && (
                        <Card>
                            <CardHeader>
                                <CardTitle>{t('settings.passwordChange.title', { defaultValue: 'Password' })}</CardTitle>
                                <CardDescription>
                                    {t('settings.passwordChange.description', { defaultValue: 'Verify your current password before choosing a new one.' })}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsPasswordChangeModalOpen(true)}
                                >
                                    {t('settings.passwordChange.trigger', { defaultValue: 'Change password' })}
                                </Button>
                            </CardContent>
                        </Card>
                    )}

                    <ModuleLockerSettingsCard />

                    {user?.role === 'admin' && (
                        <>
                            {!isLocalMode && (
                                <Card className="border-primary/20 bg-primary/[0.03]">
                                    <CardHeader>
                                        <CardTitle className="flex items-center gap-2">
                                            <Database className="h-5 w-5 text-primary" />
                                            {t('settings.mutationQueue.title')}
                                        </CardTitle>
                                        <CardDescription>{t('settings.mutationQueue.description')}</CardDescription>
                                    </CardHeader>
                                    <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-sm text-muted-foreground">{t('settings.mutationQueue.deviceOnly')}</p>
                                        <Button asChild type="button" className="shrink-0 gap-2">
                                            <Link href="/mutation-queue">
                                                <ExternalLink className="h-4 w-4" />
                                                {t('settings.mutationQueue.open')}
                                            </Link>
                                        </Button>
                                    </CardContent>
                                </Card>
                            )}

                            {/* WhatsApp Integration Setting */}
                            {canUseWhatsapp && (
                            <Card className="border-primary/20 bg-primary/5">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <MessageSquare className="w-5 h-5 text-primary" />
                                        WhatsApp Integration
                                    </CardTitle>
                                    <CardDescription>
                                        Enable WhatsApp chat for Admins and Staff. Chat history is stored locally on each device.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label className="text-base text-primary">WhatsApp Feature Included</Label>
                                            <p className="text-sm text-muted-foreground max-w-md">
                                                WhatsApp chat is available for this Enterprise workspace.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between pt-4 border-t border-primary/10 mt-4">
                                        <div className="space-y-0.5">
                                            <Label className="text-base text-primary">Auto Launch on Startup</Label>
                                            <p className="text-sm text-muted-foreground max-w-md">
                                                Automatically initialize WhatsApp in the background when the application starts.
                                            </p>
                                        </div>
                                        <Switch
                                            checked={whatsappAutoLaunch}
                                            onCheckedChange={handleWhatsappAutoLaunchChange}
                                        />
                                    </div>
                                </CardContent>
                            </Card>
                            )}

                            {/* User Info */}
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <User className="w-5 h-5" />
                                        {t('settings.account')}
                                    </CardTitle>
                                    <CardDescription>{t('settings.accountDesc')}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <div>
                                            <Label className="text-muted-foreground">{t('auth.name') || 'Name'}</Label>
                                            <p className="font-medium">{user?.name}</p>
                                        </div>
                                        <div>
                                            <Label className="text-muted-foreground">{t('auth.email')}</Label>
                                            <p className="font-medium">{user?.email}</p>
                                        </div>
                                        <div>
                                            <Label className="text-muted-foreground">{t('settings.role')}</Label>
                                            <p className="font-medium capitalize">{user?.role}</p>
                                        </div>
                                        <div>
                                            <Label className="text-muted-foreground">{t('settings.plan') || 'Plan'}</Label>
                                            <p className="font-medium capitalize">{features.plan}</p>
                                        </div>
                                        <div className="md:col-span-2">
                                            <Label className="text-muted-foreground">Workspace Subscription</Label>
                                            <div className="flex flex-wrap items-center gap-3 mt-1.5 p-3 bg-secondary/20 rounded-lg border border-border w-full max-w-sm">
                                                <div className={cn(
                                                    "px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                                    isLocked
                                                        ? "bg-destructive/20 text-destructive border border-destructive/30"
                                                        : "bg-emerald-500/20 text-emerald-500 border border-emerald-500/30"
                                                )}>
                                                    {isLocked ? 'Expired' : 'Active'}
                                                </div>
                                                <p className="text-sm font-medium">
                                                    {features.subscription_expires_at
                                                        ? formatDateTime(features.subscription_expires_at)
                                                        : 'Lifetime'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="md:col-span-2">
                                            <Label className="text-muted-foreground">{t('auth.workspaceCode')}</Label>
                                            <div
                                                className="flex items-center gap-3 mt-1 p-3 bg-secondary/30 rounded-lg border border-border group hover:border-primary/50 transition-all cursor-pointer w-full max-w-sm"
                                                onClick={() => user?.workspaceCode && copyToClipboard(user.workspaceCode)}
                                            >
                                                <span className="font-mono font-bold tracking-wider flex-1">{user?.workspaceCode}</span>
                                                {copied ? (
                                                    <span className="flex items-center gap-1.5 text-emerald-500 text-sm font-medium animate-in fade-in slide-in-from-right-2">
                                                        <Check className="w-4 h-4" />
                                                        {t('auth.copied')}
                                                    </span>
                                                ) : (
                                                    <Button variant="ghost" size="sm" className="h-8 gap-2 group-hover:bg-primary/10 group-hover:text-primary">
                                                        <Copy className="w-4 h-4" />
                                                        {t('auth.copyCode')}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <Button variant="destructive" onClick={() => void signOut()}>
                                        {t('auth.signOut')}
                                    </Button>
                                </CardContent>
                            </Card>

                            {!isDemoMode && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle className="flex items-center gap-2">
                                            <CreditCard className="h-5 w-5" />
                                            {t('workspacePayments.paymentHistory')}
                                        </CardTitle>
                                        <CardDescription>
                                            {t('workspacePayments.historyDescription')}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Button
                                            allowViewer={true}
                                            type="button"
                                            variant="outline"
                                            className="gap-2"
                                            onClick={openWorkspacePaymentStatusDialog}
                                        >
                                            <CreditCard className="h-4 w-4" />
                                            {t('workspacePayments.viewPaymentStatus')}
                                        </Button>
                                    </CardContent>
                                </Card>
                            )}

                            {/* Data Management */}
                            <Card>
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Database className="w-5 h-5" />
                                        {t('settings.localData')}
                                    </CardTitle>
                                    <CardDescription>{t('settings.localDataDesc')}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <p className="text-sm text-muted-foreground">
                                        {t('settings.localDataInfo')}
                                    </p>
                                    <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                                        <div className="flex items-start gap-3">
                                            <Trash2 className="w-5 h-5 text-destructive mt-0.5" />
                                            <div>
                                                <p className="font-medium text-destructive">{t('settings.dangerZone')}</p>
                                                <p className="text-sm text-muted-foreground mb-3">
                                                    {t('settings.clearDataWarning')}
                                                </p>
                                                <Button variant="destructive" onClick={handleClearLocalData}>
                                                    {t('settings.clearData')}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Local Database Export (all platforms) */}
                              <Card>
                                <CardHeader>
                                  <CardTitle className="flex items-center gap-2">
                                    <Database className="w-5 h-5" />
                                    Local Database
                                  </CardTitle>
                                  <CardDescription>
                                    Download the atlas-local-mode.db SQLite file saved on this device.
                                    This file contains all your local data and can be opened with any SQLite tool.
                                  </CardDescription>
                                </CardHeader>
                                <CardContent>
                                  <div className="flex flex-col items-start gap-2">
                                    <Button onClick={downloadDatabaseFile} variant="default" size="sm">
                                      <Download className="mr-2 h-4 w-4" />
                                      Download Database
                                    </Button>
                                    <Button
                                      onClick={handleDownloadInvoicePdfs}
                                      disabled={isInvoicePdfExporting}
                                      variant="outline"
                                      size="sm"
                                    >
                                      <Download className="mr-2 h-4 w-4" />
                                      {isInvoicePdfExporting ? 'Preparing PDF Invoices...' : 'Download PDF Invoices'}
                                    </Button>
                                    <Button
                                      onClick={() => setIsDatabaseInjectionDialogOpen(true)}
                                      variant="destructive"
                                      size="sm"
                                    >
                                      <Upload className="mr-2 h-4 w-4" />
                                      Inject Database
                                    </Button>
                                  </div>
                                </CardContent>
                              </Card>

                            <Dialog
                              open={isDatabaseInjectionDialogOpen}
                              onOpenChange={handleDatabaseInjectionDialogChange}
                            >
                              <DialogContent className="sm:max-w-md">
                                <DialogHeader>
                                  <DialogTitle>Inject local database</DialogTitle>
                                  <DialogDescription>
                                    This permanently replaces this device&apos;s atlas-local-mode.db with the selected backup.
                                    Atlas will reload immediately after the replacement.
                                  </DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-2">
                                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                                    All current Local Mode data on this device will be replaced. Only inject a database you trust.
                                  </div>
                                  <input
                                    ref={databaseInjectionInputRef}
                                    type="file"
                                    accept=".db,application/x-sqlite3,application/vnd.sqlite3"
                                    className="hidden"
                                    onChange={handleDatabaseInjectionFileChange}
                                  />
                                  <div className="flex flex-wrap items-center gap-3">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      onClick={() => databaseInjectionInputRef.current?.click()}
                                      disabled={isInjectingDatabase}
                                    >
                                      <Upload className="mr-2 h-4 w-4" />
                                      Select atlas-local-mode.db
                                    </Button>
                                    {databaseFileToInject && (
                                      <span className="break-all text-sm text-muted-foreground">
                                        {databaseFileToInject.name} ({Math.ceil(databaseFileToInject.size / 1024)} KB)
                                      </span>
                                    )}
                                  </div>
                                  <div className="space-y-2 border-t pt-4">
                                    <Label htmlFor="database-injection-url">Or inject from a direct link</Label>
                                    <Input
                                      id="database-injection-url"
                                      type="url"
                                      inputMode="url"
                                      autoCapitalize="none"
                                      autoCorrect="off"
                                      spellCheck={false}
                                      value={databaseUrlToInject}
                                      onChange={(event) => handleDatabaseInjectionUrlChange(event.target.value)}
                                      placeholder="https://…/atlas-local-mode.db"
                                      disabled={isInjectingDatabase}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                      Paste a direct HTTPS link to an atlas-local-mode.db backup, such as a local-backup link from R2.
                                    </p>
                                  </div>
                                  {databaseInjectionError && (
                                    <p role="alert" className="text-sm text-destructive">
                                      {databaseInjectionError}
                                    </p>
                                  )}
                                </div>
                                <DialogFooter className="gap-2 sm:gap-0">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => handleDatabaseInjectionDialogChange(false)}
                                    disabled={isInjectingDatabase}
                                  >
                                    Cancel
                                  </Button>
                                  <PressAndHoldButton
                                    variant="destructive"
                                    onComplete={() => void handleInjectDatabase()}
                                    idleLabel="Press and hold to inject database"
                                    holdingLabel="Keep holding to replace database..."
                                    loadingLabel="Injecting database..."
                                    isLoading={isInjectingDatabase}
                                    disabled={!databaseFileToInject && !databaseUrlToInject.trim()}
                                    durationMs={3000}
                                  />
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>

                            {/* USB Backup (Desktop + Local/Hybrid mode only) */}
                            {usbBackup.isDesktopApp && (isLocalMode || isHybridMode) && (
                              <Card>
                                <CardHeader>
                                  <CardTitle className="flex items-center gap-2">
                                    <Usb className="w-5 h-5" />
                                    USB Backup
                                  </CardTitle>
                                  <CardDescription>
                                    Backup atlas-local-mode.db to a USB drive automatically whenever data changes.
                                    This is a one-way export — the USB copy is never read by the app.
                                  </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                  {usbBackup.isConfigured ? (
                                    <>
                                      <div className="flex items-start gap-3 rounded-lg bg-muted/30 p-3">
                                        <Usb className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0 space-y-1">
                                          <p className="text-sm font-medium">Backup destination</p>
                                          <p className="truncate font-mono text-xs text-muted-foreground">
                                            {usbBackup.usbDestination}
                                          </p>
                                          {usbBackup.lastBackupTime && (
                                            <p className="text-xs text-muted-foreground">
                                              Last backup: {formatDateTime(new Date(usbBackup.lastBackupTime))}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        <Button variant="outline" size="sm" onClick={usbBackup.changeDestination}>
                                          Change Destination
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={usbBackup.disableUsbBackup}>
                                          Disable USB Backup
                                        </Button>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="space-y-3">
                                      <p className="text-sm text-muted-foreground">
                                        No USB backup destination configured. Select a folder on your USB drive to
                                        automatically receive backup copies of the local database.
                                      </p>
                                      <Button onClick={usbBackup.pickDestination}>
                                        <Usb className="mr-2 h-4 w-4" />
                                        Select USB Backup Destination
                                      </Button>
                                    </div>
                                  )}
                                </CardContent>
                              </Card>
                            )}
                        </>
                    )}

                    {/* Connection Settings (Electron Only) */}
                    {isElectron && isBackendConfigurationRequired && (
                        <>
                            {/* --- Connection Settings (Web) Section Start --- */}
                            <Card className="border-muted bg-muted/5">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Globe className="w-5 h-5 text-muted-foreground" />
                                        System Connection Info (Read-only)
                                    </CardTitle>
                                    <CardDescription>
                                        Active Supabase instance information.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-4">
                                        <div className="space-y-4 transition-all duration-300">
                                            <div className="grid gap-4">
                                                <div className="space-y-2">
                                                    <Label className="text-muted-foreground">Supabase Project URL</Label>
                                                    <Input
                                                        readOnly
                                                        value={isWebConnectionUnlocked ? activeSupabaseUrl : "https://••••••••••••••••••••"}
                                                        className="bg-secondary/30 font-mono text-xs"
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label className="text-muted-foreground">Supabase Anon Key</Label>
                                                    <Input
                                                        readOnly
                                                        value={isWebConnectionUnlocked ? activeSupabaseKey : "••••••••••••••••••••••••••••••••"}
                                                        className="bg-secondary/30 font-mono text-xs"
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        {!isWebConnectionUnlocked && (
                                            <div className="flex flex-col items-center justify-center pt-2">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="gap-2"
                                                    onClick={() => setIsUnlockModalOpen(true)}
                                                >
                                                    <Unlock className="w-4 h-4" />
                                                    Unlock to View
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>

                            <Dialog open={isUnlockModalOpen} onOpenChange={setIsUnlockModalOpen}>
                                <DialogContent className="sm:max-w-md">
                                    <DialogHeader>
                                        <DialogTitle>Unlock Connection Settings</DialogTitle>
                                        <DialogDescription>
                                            Please enter the master passkey to view the system configuration.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <div className="flex flex-col gap-4 py-4">
                                        <div className="space-y-2">
                                            <Label>Master Passkey</Label>
                                            <Input
                                                type="password"
                                                autoFocus
                                                value={webPasskeyInput}
                                                onChange={(e) => setWebPasskeyInput(e.target.value)}
                                                placeholder="••••••••••••••••••••"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleUnlockWebConnection()
                                                }}
                                            />
                                        </div>
                                    </div>
                                    <DialogFooter>
                                        <Button variant="ghost" onClick={() => setIsUnlockModalOpen(false)}>
                                            Cancel
                                        </Button>
                                        <Button onClick={handleUnlockWebConnection}>
                                            Unlock Settings
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                            {/* --- Connection Settings (Web) Section End --- */}

                            <Card className="border-primary/20 bg-primary/5 mt-6">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Server className="w-5 h-5 text-primary" />
                                        Connection Settings
                                    </CardTitle>
                                    <CardDescription>
                                        Override the default Supabase instance. Requires master passkey.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {!isConnectionSettingsUnlocked ? (
                                        <div className="space-y-4">
                                            <div className="space-y-2">
                                                <Label>Master Passkey</Label>
                                                <div className="flex gap-2">
                                                    <Input
                                                        type="password"
                                                        value={passkey}
                                                        onChange={(e) => setPasskey(e.target.value)}
                                                        placeholder="Enter passkey to unlock..."
                                                        className="max-w-xs"
                                                    />
                                                    <Button onClick={handleUnlockConnection}>
                                                        <Unlock className="w-4 h-4 mr-2" />
                                                        Unlock
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                                            <div className="grid gap-4">
                                                <div className="space-y-2">
                                                    <Label>Supabase URL</Label>
                                                    <Input
                                                        value={customUrl}
                                                        onChange={(e) => setCustomUrl(e.target.value)}
                                                        placeholder="https://your-project.supabase.co"
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label>Supabase Anon Key</Label>
                                                    <Input
                                                        type="password"
                                                        value={customKey}
                                                        onChange={(e) => setCustomKey(e.target.value)}
                                                        placeholder="your-anon-key"
                                                    />
                                                </div>
                                            </div>
                                            <div className="flex gap-2 pt-2">
                                                <Button onClick={handleSaveConnection}>
                                                    Save & Reconnect
                                                </Button>
                                                <Button variant="outline" onClick={handleResetConnection}>
                                                    Reset to Default
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </>
                    )}
                </TabsContent>

                <AppDialog
                    open={isThermalDialogOpen}
                    onOpenChange={(open) => {
                        if (!open && (isThermalActionPending || isScanningThermalPrinters)) return
                        setIsThermalDialogOpen(open)
                    }}
                >
                    <AppDialogContent
                        className="max-w-2xl"
                        showCloseButton={!isThermalActionPending && !isScanningThermalPrinters}
                    >
                        <AppDialogHeader>
                            <AppDialogTitle className="flex items-center gap-2">
                                <Printer className="h-5 w-5 text-primary" />
                                {t('settings.printing.thermalDialogTitle', { defaultValue: 'Thermal Printers' })}
                            </AppDialogTitle>
                            <AppDialogDescription>
                                {isDesktop()
                                    ? t('settings.printing.thermalDialogDesc', {
                                        defaultValue: 'Scan this device for available thermal printers and choose which one should handle POS receipt printing for this workspace.'
                                    })
                                    : isAndroidDirectThermalPwa
                                        ? t('settings.printing.thermalAndroidPwaDialogDesc', {
                                            defaultValue: 'Pair a wired USB printer directly with this Android device. Bluetooth LE is also supported when the printer provides its GATT service and write-characteristic UUIDs.'
                                        })
                                        : isTauriAndroidApp
                                            ? t('settings.printing.thermalAndroidTauriDialogDesc', {
                                                defaultValue: 'Use a Bluetooth Classic receipt printer already paired in Android Settings. Atlas sends POS receipts directly through the printer’s SPP connection.'
                                            })
                                    : t('settings.printing.thermalPwaDialogDesc', {
                                        defaultValue: 'Connect QZ Tray on this device to scan printers and print POS receipts directly from the installed PWA.'
                                    })}
                            </AppDialogDescription>
                        </AppDialogHeader>

                        <AppDialogBody className="space-y-4">
                            {isAndroidDirectThermalPwa && (
                                <div className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
                                    <div>
                                        <p className="text-sm font-semibold">
                                            {t('settings.printing.androidDirectTitle', { defaultValue: 'Android direct printer pairing' })}
                                        </p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {t('settings.printing.androidDirectDesc', {
                                                defaultValue: 'USB is recommended for wired thermal printers. Connect the printer with an OTG adapter, turn it on, then pair it below.'
                                            })}
                                        </p>
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            type="button"
                                            onClick={handlePairUsbThermalPrinter}
                                            disabled={isThermalActionPending || !directMobileThermalCapabilities.usb}
                                        >
                                            <Usb className="mr-2 h-4 w-4" />
                                            {t('settings.printing.pairUsbThermalPrinter', { defaultValue: 'Pair USB Printer' })}
                                        </Button>
                                        {!directMobileThermalCapabilities.usb && (
                                            <p className="self-center text-xs text-amber-600 dark:text-amber-400">
                                                {t('settings.printing.usbThermalUnsupported', { defaultValue: 'WebUSB is not available in this browser.' })}
                                            </p>
                                        )}
                                    </div>

                                    <div className="space-y-3 border-t border-primary/20 pt-4">
                                        <div>
                                            <p className="text-sm font-medium">
                                                {t('settings.printing.bluetoothLeThermalTitle', { defaultValue: 'Bluetooth LE (optional)' })}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {t('settings.printing.bluetoothLeThermalDesc', {
                                                    defaultValue: 'Only BLE/GATT printers are supported. Enter the UUIDs from the printer documentation; Bluetooth Classic printers cannot be paired by a browser PWA.'
                                                })}
                                            </p>
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            <div className="space-y-1.5">
                                                <Label htmlFor="thermal-ble-service" className="text-xs">
                                                    {t('settings.printing.bluetoothServiceUuid', { defaultValue: 'BLE Service UUID' })}
                                                </Label>
                                                <Input
                                                    id="thermal-ble-service"
                                                    value={bleServiceUuid}
                                                    onChange={(event) => setBleServiceUuid(event.target.value)}
                                                    placeholder="From printer documentation"
                                                    disabled={isThermalActionPending}
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <Label htmlFor="thermal-ble-characteristic" className="text-xs">
                                                    {t('settings.printing.bluetoothCharacteristicUuid', { defaultValue: 'BLE Write Characteristic UUID' })}
                                                </Label>
                                                <Input
                                                    id="thermal-ble-characteristic"
                                                    value={bleCharacteristicUuid}
                                                    onChange={(event) => setBleCharacteristicUuid(event.target.value)}
                                                    placeholder="From printer documentation"
                                                    disabled={isThermalActionPending}
                                                />
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={handlePairBluetoothThermalPrinter}
                                            disabled={isThermalActionPending || !directMobileThermalCapabilities.bluetooth || !bleServiceUuid.trim() || !bleCharacteristicUuid.trim()}
                                        >
                                            {t('settings.printing.pairBluetoothThermalPrinter', { defaultValue: 'Pair Bluetooth LE Printer' })}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {isTauriAndroidApp && (
                                <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
                                    <div className="flex items-start gap-3">
                                        <div className="rounded-lg bg-background p-2 shadow-sm">
                                            <Bluetooth className="h-4 w-4 text-primary" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold">
                                                {t('settings.printing.androidBluetoothClassicTitle', { defaultValue: 'Android Bluetooth Classic printers' })}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {t('settings.printing.androidBluetoothClassicDesc', {
                                                    defaultValue: 'Pair an SPP/RFCOMM receipt printer in Android Settings first. Then refresh below, select it, and use Print Test Receipt to verify the connection.'
                                                })}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4 md:flex-row md:items-start md:justify-between">
                                <div className="space-y-1">
                                    <p className="text-sm font-semibold">
                                        {t('settings.printing.currentThermalPrinter', { defaultValue: 'Current device printer' })}
                                    </p>
                                    {selectedThermalPrinter ? (
                                        <>
                                            <p className="text-sm text-foreground">{selectedThermalPrinter.name}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {selectedThermalPrinter.interface_type || 'Unknown'} | {selectedThermalPrinter.status || 'Saved'}
                                            </p>
                                            <p className="break-all font-mono text-[11px] text-muted-foreground">
                                                {selectedThermalPrinter.identifier || 'No identifier'}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settings.printing.thermalRollWidthValue', {
                                                    defaultValue: `Roll width: ${selectedRollWidthLabel}`
                                                })}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {selectedThermalPrinter.transport === 'webusb'
                                                    ? t('settings.printing.thermalWebUsbTransport', { defaultValue: 'Connected directly by USB to this Android device.' })
                                                    : selectedThermalPrinter.transport === 'webbluetooth'
                                                        ? t('settings.printing.thermalWebBluetoothTransport', { defaultValue: 'Connected directly by Bluetooth LE to this Android device.' })
                                                        : selectedThermalPrinter.transport === 'tauri-android-bluetooth'
                                                            ? t('settings.printing.thermalTauriAndroidBluetoothTransport', { defaultValue: 'Connected directly by Bluetooth Classic to this Android device.' })
                                                    : selectedThermalPrinter.transport === 'qz'
                                                    ? t('settings.printing.thermalQzTransport', { defaultValue: 'Connected through QZ Tray on this device.' })
                                                    : t('settings.printing.thermalTauriTransport', { defaultValue: 'Connected through the native desktop print service.' })}
                                            </p>
                                        </>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            {t('settings.printing.noThermalPrinterSelected', {
                                                defaultValue: 'No thermal printer is saved for this workspace on this device yet.'
                                            })}
                                        </p>
                                    )}
                                    <div className="pt-2">
                                        <Label className="text-[11px] uppercase text-muted-foreground">
                                            {t('settings.printing.thermalRollWidthLabel', { defaultValue: 'Receipt roll width' })}
                                        </Label>
                                        <Select
                                            value={String(selectedThermalRollWidth)}
                                            onValueChange={handleThermalRollWidthChange}
                                            disabled={isThermalActionPending}
                                        >
                                            <SelectTrigger className="mt-2 h-9 max-w-[220px]">
                                                <SelectValue placeholder={t('settings.printing.thermalRollWidthPlaceholder', { defaultValue: 'Choose roll width' })} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {THERMAL_ROLL_WIDTHS.map((option) => (
                                                    <SelectItem key={option.value} value={String(option.value)}>
                                                        {option.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {selectedThermalPrinter && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={handleTestThermalPrinter}
                                            disabled={isThermalActionPending}
                                            className="mt-3"
                                        >
                                            <Printer className="mr-2 h-4 w-4" />
                                            {t('settings.printing.testThermalPrinter', { defaultValue: 'Print Test Receipt' })}
                                        </Button>
                                    )}
                                </div>
                                <div className="flex shrink-0 flex-col gap-2 self-start md:items-end">
                                    {!isDesktop() && !isAndroidDirectThermalPwa && !isTauriAndroidApp && (
                                        <a
                                            href="https://qz.io/download/"
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center text-xs text-primary underline-offset-4 hover:underline"
                                        >
                                            {t('settings.printing.installQzTray', { defaultValue: 'Install QZ Tray' })}
                                            <ExternalLink className="ml-1 h-3 w-3" />
                                        </a>
                                    )}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={scanThermalPrinters}
                                        disabled={isScanningThermalPrinters}
                                    >
                                        <RefreshCw className={cn('mr-2 h-4 w-4', isScanningThermalPrinters && 'animate-spin')} />
                                        {isDesktop()
                                            ? t('settings.printing.refreshPrinters', { defaultValue: 'Refresh' })
                                            : isAndroidDirectThermalPwa
                                                ? t('settings.printing.refreshPairedUsbPrinters', { defaultValue: 'Refresh Paired USB Printers' })
                                                : isTauriAndroidApp
                                                    ? t('settings.printing.refreshPairedBluetoothPrinters', { defaultValue: 'Refresh Paired Bluetooth Printers' })
                                                : t('settings.printing.connectAndScanPrinters', { defaultValue: 'Connect & Scan' })}
                                    </Button>
                                </div>
                            </div>

                            {thermalPrinterMessage && (
                                <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                                    {thermalPrinterMessage}
                                </div>
                            )}

                            {hiddenPrinterCount > 0 && (
                                <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-3 text-sm">
                                    <p className="text-muted-foreground">
                                        {showAllDetectedPrinters
                                            ? t('settings.printing.showingAllPrinters', {
                                                defaultValue: `Showing all detected printers on this device. ${hiddenPrinterCount} non-thermal-looking printer(s) are included.`
                                            })
                                            : t('settings.printing.hiddenNonThermalPrinters', {
                                                defaultValue: `${hiddenPrinterCount} detected printer(s) were hidden because they do not look like receipt/thermal printers.`
                                            })}
                                    </p>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="shrink-0"
                                        onClick={() => setShowAllDetectedPrinters(prev => !prev)}
                                    >
                                        {showAllDetectedPrinters
                                            ? t('settings.printing.showLikelyThermalOnly', { defaultValue: 'Show Thermal Only' })
                                            : t('settings.printing.showAllDetectedPrinters', { defaultValue: 'Show All' })}
                                    </Button>
                                </div>
                            )}

                            <div className="space-y-3">
                                {displayedThermalPrinters.map((printer) => {
                                    const isCurrentSelection = selectedThermalPrinter?.name === printer.name

                                    return (
                                        <div
                                            key={`${printer.name}-${printer.identifier}`}
                                            className={cn(
                                                'rounded-xl border p-4 transition-colors',
                                                isCurrentSelection && 'border-emerald-500 bg-emerald-500/5'
                                            )}
                                        >
                                            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                                <div className="space-y-1">
                                                    <p className="font-semibold text-foreground">{printer.name}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {printer.interface_type || 'Unknown interface'} | {printer.status || 'Unknown status'}
                                                    </p>
                                                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                                                        {printer.identifier}
                                                    </p>
                                                </div>
                                                <Button
                                                    type="button"
                                                    className="self-start md:self-auto"
                                                    onClick={() => handleEnableThermalPrinter(printer)}
                                                    disabled={isThermalActionPending || (features.thermal_printing && isCurrentSelection)}
                                                >
                                                    {features.thermal_printing && isCurrentSelection
                                                        ? t('settings.printing.thermalEnabledButton', { defaultValue: 'Enabled' })
                                                        : t('settings.printing.enableThermalPrinter', { defaultValue: 'Enable' })}
                                                </Button>
                                            </div>
                                        </div>
                                    )
                                })}

                                {displayedThermalPrinters.length === 0 && !isScanningThermalPrinters && (
                                    <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                                        {t('settings.printing.noDisplayableThermalPrinters', {
                                            defaultValue: 'No usable thermal printers are currently being shown. Refresh the scan or reveal all detected printers if your device uses an uncommon model name.'
                                        })}
                                    </div>
                                )}
                            </div>
                        </AppDialogBody>

                        <AppDialogFooter className="gap-2 sm:justify-between">
                            {features.thermal_printing ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={handleDisableThermalPrinting}
                                    disabled={isThermalActionPending}
                                    className="w-full sm:w-auto"
                                >
                                    {t('settings.printing.disableThermalPrinting', { defaultValue: 'Disable Thermal Printing' })}
                                </Button>
                            ) : <div />}
                            <Button
                                type="button"
                                variant="default"
                                onClick={() => setIsThermalDialogOpen(false)}
                                disabled={isThermalActionPending || isScanningThermalPrinters}
                                className="w-full sm:w-auto"
                            >
                                {t('common.close', { defaultValue: 'Close' })}
                            </Button>
                        </AppDialogFooter>
                    </AppDialogContent>
                </AppDialog>

                <Dialog
                    open={isPasswordChangeModalOpen}
                    onOpenChange={handlePasswordChangeModalOpenChange}
                >
                    <DialogContent className="max-w-md">
                        <form
                            onSubmit={(event) => {
                                event.preventDefault()
                                void handlePasswordChange()
                            }}
                        >
                            <DialogHeader>
                                <DialogTitle>{t('settings.passwordChange.dialogTitle', { defaultValue: 'Change password' })}</DialogTitle>
                                <DialogDescription>
                                    {t('settings.passwordChange.dialogDescription', { defaultValue: 'Enter your current password, then choose and confirm a new password.' })}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="space-y-4 py-5">
                                <div className="space-y-2">
                                    <Label htmlFor="current-password">
                                        {t('settings.passwordChange.currentPassword', { defaultValue: 'Current password' })}
                                    </Label>
                                    <Input
                                        id="current-password"
                                        type="password"
                                        autoComplete="current-password"
                                        value={currentPasswordInput}
                                        onChange={(event) => setCurrentPasswordInput(event.target.value)}
                                        disabled={isPasswordChangeSaving}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="new-password">
                                        {t('settings.passwordChange.newPassword', { defaultValue: 'New password' })}
                                    </Label>
                                    <Input
                                        id="new-password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={newPasswordInput}
                                        onChange={(event) => setNewPasswordInput(event.target.value)}
                                        disabled={isPasswordChangeSaving}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="repeat-new-password">
                                        {t('settings.passwordChange.repeatNewPassword', { defaultValue: 'Repeat new password' })}
                                    </Label>
                                    <Input
                                        id="repeat-new-password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={repeatNewPasswordInput}
                                        onChange={(event) => setRepeatNewPasswordInput(event.target.value)}
                                        disabled={isPasswordChangeSaving}
                                    />
                                </div>
                            </div>

                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => handlePasswordChangeModalOpenChange(false)}
                                    disabled={isPasswordChangeSaving}
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button type="submit" disabled={isPasswordChangeSaving}>
                                    {isPasswordChangeSaving
                                        ? t('settings.passwordChange.saving', { defaultValue: 'Saving...' })
                                        : t('settings.passwordChange.save', { defaultValue: 'Save password' })}
                                </Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>

                {/* Clear Local Data Confirmation Modal */}
                <Dialog open={isClearDataDialogOpen} onOpenChange={setIsClearDataDialogOpen}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-destructive">
                                <AlertCircle className="w-5 h-5" />
                                {t('settings.confirmClearDataTitle') || 'Clear All Local Data?'}
                            </DialogTitle>
                            <DialogDescription className="space-y-3 pt-2">
                                <p className="font-bold text-foreground">
                                    {t('settings.messages.clearDataConfirm') || 'This will delete ALL local data including products, customers, orders, and invoices. Are you sure?'}
                                </p>
                                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-xs leading-relaxed">
                                    <p className="font-bold text-destructive mb-1 uppercase tracking-tight">Warning: This action is irreversible</p>
                                    <ul className="list-disc pl-4 space-y-1 opacity-80">
                                        <li>All IndexedDB tables will be wiped</li>
                                        <li>Local preferences (hotkeys, theme, etc) will be reset</li>
                                        <li>Browser and application caches will be cleared</li>
                                        <li>You will be signed out and redirected to login</li>
                                    </ul>
                                </div>
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="gap-2 sm:gap-0">
                            <Button variant="ghost" onClick={() => setIsClearDataDialogOpen(false)}>
                                {t('common.cancel') || 'Cancel'}
                            </Button>
                            <Button variant="destructive" onClick={handleConfirmClearAllData} className="gap-2">
                                <Trash2 className="w-4 h-4" />
                                {t('settings.clearData') || 'Clear Everything'}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Currency Confirmation Modal */}
                <Dialog open={isCurrencyModalOpen} onOpenChange={setIsCurrencyModalOpen}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t('settings.currency.confirmTitle') || 'Change Currency'}</DialogTitle>
                            <DialogDescription>
                                {t('settings.currency.confirmDesc') || 'Are you sure you want to change the default currency? This will affect how prices and total amounts are displayed across the application.'}
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setIsCurrencyModalOpen(false)}>
                                {t('common.cancel') || 'Cancel'}
                            </Button>
                            <Button onClick={confirmCurrencyChange} className="bg-primary text-primary-foreground">
                                {t('common.confirm') || 'Confirm'}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </Tabs >
        </div >
    )
}
