import { useAuth } from '@/auth'
import { isBackendConfigurationRequired, supabase } from '@/auth/supabase'
import { useSyncStatus, clearQueue } from '@/sync'
import { db } from '@/local-db'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button, Label, LanguageSwitcher, Input, CurrencySelector, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger, TabsContent, Switch, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Textarea, useToast, RegisterWorkspaceContactsModal } from '@/ui/components'
import { useTranslation } from 'react-i18next'
import { useWorkspace } from '@/workspace'
import { Coins } from 'lucide-react'
import type { IQDDisplayPreference, CurrencyCode } from '@/local-db/models'
import { Settings as SettingsIcon, Database, Cloud, Trash2, RefreshCw, User, Copy, Check, CreditCard, Globe, Download, AlertCircle, Printer, Contact, Fingerprint, Store, ExternalLink } from 'lucide-react'
import { formatDate, formatDateTime, formatTime, cn, getHourDisplayPreference, setHourDisplayPreference, type HourDisplayPreference } from '@/lib/utils'
import { useTheme } from '@/ui/components/theme-provider'
import { Moon, Sun, Monitor, Unlock, Server, MessageSquare, Bell, MonitorPlay, Wifi } from 'lucide-react'
import { useState, useEffect } from 'react'
import { isMobile, isDesktop } from '@/lib/platform'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { getAppSettingSync, setAppSetting } from '@/local-db/settings'
import { decrypt } from '@/lib/encryption'
import { check } from '@tauri-apps/plugin-updater';
import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'
import { Image as ImageIcon } from 'lucide-react'
import { assetManager } from '@/lib/assetManager'
import { getMonthDisplayPreference, setMonthDisplayPreference, type MonthDisplayPreference } from '@/lib/monthDisplay'
import { useWorkspaceContacts } from '@/local-db/hooks'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { DEFAULT_THERMAL_ROLL_WIDTH, THERMAL_ROLL_WIDTHS, isLikelyThermalPrinter, isVirtualPrinter, printService, type StoredThermalPrinter, type ThermalRollWidth } from '@/services/printService'
import type { PrinterInfo } from 'tauri-plugin-thermal-printer'
// Notification imports moved to dynamic imports for cross-platform support
import { registerDeviceTokenIfNeeded } from '@/services/notificationDevice'
import { useKdsStream } from '@/hooks/useKdsStream'
import { ReactQRCode } from '@lglab/react-qr-code'
import { BranchManager } from '@/ui/components/workspace/BranchManager'

export function Settings() {
    const { user, signOut, isSupabaseConfigured, updateUser } = useAuth()
    const { syncState, pendingCount, lastSyncTime, sync, isSyncing, isOnline } = useSyncStatus()
    const { theme, setTheme, style, setStyle } = useTheme()
    const { features, updateSettings, refreshFeatures, workspaceName, isLocked, isLocalMode } = useWorkspace()
    const { streamUrl, status: kdsStatus, startStream } = useKdsStream(true)

    useEffect(() => {
        if (isDesktop() && features.kds_enabled && kdsStatus === 'idle') {
            startStream(4004).catch(console.error)
        }
    }, [features.kds_enabled, kdsStatus, startStream])

    const { toast } = useToast()
    const { t } = useTranslation()
    const { alerts, forceAlert } = useExchangeRate()
    const [copied, setCopied] = useState(false)
    const [isCurrencyModalOpen, setIsCurrencyModalOpen] = useState(false)
    const [pendingCurrency, setPendingCurrency] = useState<'usd' | 'iqd' | 'eur' | 'try' | null>(null)
    const [posHotkey, setPosHotkey] = useState(localStorage.getItem('pos_hotkey') || '')
    const [barcodeHotkey, setBarcodeHotkey] = useState(localStorage.getItem('barcode_hotkey') || '')
    const [exchangeRateSource, setExchangeRateSource] = useState(localStorage.getItem('primary_exchange_rate_source') || 'xeiqd')
    const [eurExchangeRateSource, setEurExchangeRateSource] = useState(localStorage.getItem('primary_eur_exchange_rate_source') || 'forexfy')
    const [tryExchangeRateSource, setTryExchangeRateSource] = useState(localStorage.getItem('primary_try_exchange_rate_source') || 'forexfy')
    const [exchangeRateThreshold, setExchangeRateThreshold] = useState(localStorage.getItem('exchange_rate_threshold') || '2500')
    const [whatsappAutoLaunch, setWhatsappAutoLaunch] = useState(localStorage.getItem('whatsapp_auto_launch') === 'true')
    const [hourDisplayPreference, setHourDisplayPreferenceState] = useState<HourDisplayPreference>(getHourDisplayPreference())
    const [monthDisplayPreference, setMonthDisplayPreferenceState] = useState<MonthDisplayPreference>(getMonthDisplayPreference())
    const isKdsSaving = false

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
    const [availableThermalPrinters, setAvailableThermalPrinters] = useState<PrinterInfo[]>([])
    const [selectedThermalPrinter, setSelectedThermalPrinter] = useState<StoredThermalPrinter | null>(null)
    const [selectedThermalRollWidth, setSelectedThermalRollWidth] = useState<ThermalRollWidth>(DEFAULT_THERMAL_ROLL_WIDTH)
    const [isScanningThermalPrinters, setIsScanningThermalPrinters] = useState(false)
    const [isThermalActionPending, setIsThermalActionPending] = useState(false)
    const [thermalPrinterMessage, setThermalPrinterMessage] = useState<string | null>(null)
    const [showAllDetectedPrinters, setShowAllDetectedPrinters] = useState(false)
    const [marketplaceVisibility, setMarketplaceVisibility] = useState<'private' | 'public'>(features.visibility || 'private')
    const [marketplaceSlug, setMarketplaceSlug] = useState(features.store_slug || '')
    const [marketplaceDescription, setMarketplaceDescription] = useState(features.store_description || '')
    const [marketplaceSlugStatus, setMarketplaceSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
    const [isSavingMarketplace, setIsSavingMarketplace] = useState(false)

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

    const loadSelectedThermalPrinter = async () => {
        if (!user?.workspaceId) {
            setSelectedThermalPrinter(null)
            setSelectedThermalRollWidth(DEFAULT_THERMAL_ROLL_WIDTH)
            return
        }

        const selection = await printService.getSelectedThermalPrinter(user.workspaceId)
        setSelectedThermalPrinter(selection)
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

        if (!isElectron) {
            setAvailableThermalPrinters([])
            setThermalPrinterMessage(t('settings.printing.thermalDesktopOnly', {
                defaultValue: 'Thermal printer scanning is available in the desktop Tauri app only.'
            }))
            return
        }

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
                normalizeSupabaseActionError(error).message
                || t('settings.printing.thermalScanError', { defaultValue: 'Failed to scan thermal printers.' })
            )
        } finally {
            setIsScanningThermalPrinters(false)
        }
    }

    const openThermalPrinterDialog = () => {
        setIsThermalDialogOpen(true)
    }

    const handleEnableThermalPrinter = async (printer: PrinterInfo) => {
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
                status: selectedThermalPrinter.status
            } as PrinterInfo, nextValue)
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
        void scanThermalPrinters()
    }, [isThermalDialogOpen, user?.workspaceId, isElectron])

    const [updateStatus, setUpdateStatus] = useState<any>(null)
    const [localWorkspaceName, setLocalWorkspaceName] = useState(workspaceName || '')
    const marketplaceSlugPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
    const marketplaceBaseOrigin = (() => {
        const configuredOrigin = (import.meta.env.VITE_MARKETPLACE_SITE_URL || '').trim().replace(/\/+$/, '')
        if (configuredOrigin) return configuredOrigin
        if (typeof window !== 'undefined' && /^https?:$/i.test(window.location.protocol)) {
            if (window.location.hostname === 'marketplace-atlas.vercel.app') {
                return window.location.origin
            }
        }
        return 'https://marketplace-atlas.vercel.app'
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

    // Tauri updater doesn't use event listeners for status in the same way, logic is inside handleCheckForUpdates

    const handleCheckForUpdates = async () => {
        setUpdateStatus({ status: 'checking' })
        try {
            if (isMobile()) {
                console.log('[Settings] Android custom update check...')
                const { getVersion } = await import('@tauri-apps/api/app')
                const { open } = await import('@tauri-apps/plugin-shell')

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
                            console.log('[Settings] Opening Android APK URL automatically:', downloadUrl)
                            await open(downloadUrl)
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

            const update = await check();
            if (update) {
                setUpdateStatus({ status: 'available', version: update.version });

                let downloaded = 0;
                let contentLength = 0;

                await update.downloadAndInstall((event) => {
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
            setExchangeRateSource(localStorage.getItem('primary_exchange_rate_source') || 'xeiqd')
            setEurExchangeRateSource(localStorage.getItem('primary_eur_exchange_rate_source') || 'forexfy')
            setTryExchangeRateSource(localStorage.getItem('primary_try_exchange_rate_source') || 'forexfy')
        }
        window.addEventListener('exchange-rate-refresh', syncSources)
        return () => window.removeEventListener('exchange-rate-refresh', syncSources)
    }, [])

    const handleExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = localStorage.getItem('manual_rate_usd_iqd');
            if (!currentRate || parseInt(currentRate) === 0) {
                openManualEditor('USD');
                return;
            }
        }
        setExchangeRateSource(val)
        localStorage.setItem('primary_exchange_rate_source', val)
        // Notify the indicator to refresh instantly
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleEurExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = localStorage.getItem('manual_rate_eur_iqd');
            if (!currentRate || parseInt(currentRate) === 0) {
                openManualEditor('EUR');
                return;
            }
        }
        setEurExchangeRateSource(val)
        localStorage.setItem('primary_eur_exchange_rate_source', val)
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleTryExchangeRateSourceChange = (val: string) => {
        if (val === 'manual') {
            const currentRate = localStorage.getItem('manual_rate_try_iqd');
            if (!currentRate || parseInt(currentRate) === 0) {
                openManualEditor('TRY');
                return;
            }
        }
        setTryExchangeRateSource(val)
        localStorage.setItem('primary_try_exchange_rate_source', val)
        window.dispatchEvent(new CustomEvent('exchange-rate-refresh'))
    }

    const handleThresholdChange = (val: string) => {
        setExchangeRateThreshold(val)
        localStorage.setItem('exchange_rate_threshold', val)
    }

    const handleCurrencySelect = (val: CurrencyCode) => {
        setPendingCurrency(val)
        setIsCurrencyModalOpen(true)
    }

    const confirmCurrencyChange = async () => {
        if (pendingCurrency) {
            await updateSettings({ default_currency: pendingCurrency })
            setPendingCurrency(null)
            setIsCurrencyModalOpen(false)
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
                    await registerDeviceTokenIfNeeded(user.id)
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
            setLocalMediaCount(count)
        } catch (e) {
            console.error('Failed to count media:', e)
        }
    }

    const handleSyncMedia = async () => {
        setIsSyncMediaModalOpen(false)
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
        const allowedFolders = ['product-images', 'profile-images', 'workspace-logos']

        try {
            const keySet = new Set<string>()

            for (const folder of allowedFolders) {
                const prefix = `${workspaceId}/${folder}/`
                const keys = await r2Service.listObjects(prefix)
                for (const key of keys) {
                    keySet.add(key)
                }
            }

            const keys = Array.from(keySet)
            if (keys.length === 0) {
                alert(t('settings.messages.noCloudMediaFound') || 'No cloud media found for this workspace.')
                return
            }

            let downloadedCount = 0
            setMediaDownloadProgress({ total: keys.length, current: 0, fileName: '' })

            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]
                const parts = key.split('/')
                const wsPart = parts[0]
                const folderPart = parts[1]
                const restPath = parts.slice(2).join('/')

                setMediaDownloadProgress(prev => prev ? { ...prev, current: i + 1, fileName: restPath || key } : null)

                if (wsPart !== workspaceId || !allowedFolders.includes(folderPart) || !restPath) {
                    console.warn('[Settings] Skipping unexpected R2 key:', key)
                    continue
                }

                const data = await r2Service.download(key)
                if (!data) continue

                const localRelativePath = `${folderPart}/${workspaceId}/${restPath}`
                const savedPath = await platformService.saveDownloadedFile(workspaceId, localRelativePath, data, folderPart)
                if (savedPath) {
                    downloadedCount++
                }
            }

            alert(
                t('settings.messages.mediaDownloadComplete', { count: downloadedCount })
                || `Media download complete! ${downloadedCount} files saved locally.`
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

    const handleLogoUpload = async () => {
        if (!user?.workspaceId) return
        const targetPath = await platformService.pickAndSaveImage(user.workspaceId, 'workspace-logos')
        if (targetPath) {
            await updateSettings({ logo_url: targetPath })

            // Trigger asset sync via R2
            assetManager.uploadFromPath(targetPath, 'branding').then(success => {
                if (success) {
                    console.log('[Settings] Logo synced via R2');
                }
            }).catch(console.error);
        }
    }

    const handleProfilePictureUpload = async () => {
        if (!user?.id || !user?.workspaceId) return

        try {
            // 1. Pick and save image
            const targetPath = await platformService.pickAndSaveImage(user.workspaceId, 'profile-images')
            if (!targetPath) return

            // 2. Resize image for optimization (512px max width)
            const resizedPath = await platformService.resizeImage(targetPath, 512)

            try {
                const syncSuccess = await assetManager.uploadFromPath(resizedPath, 'profiles')
                if (syncSuccess) {
                    console.log('[Settings] Profile picture synced to R2')
                }
            } catch (syncError) {
                console.error('[Settings] R2 upload error (non-blocking):', syncError)
            }

            // 4. Update Supabase profile
            if (isSupabaseConfigured) {
                // Update the profiles table
                const { error: profileError } = await runSupabaseAction('settings.updateProfileImage', () =>
                    supabase
                        .from('profiles')
                        .update({ profile_url: resizedPath })
                        .eq('id', user.id)
                )

                if (profileError) {
                    console.error('[Settings] Error updating Supabase profile:', profileError)
                    throw normalizeSupabaseActionError(profileError)
                }

                // Update Auth metadata so it persists across refreshes
                const { error: authError } = await runSupabaseAction('settings.updateProfileMetadata', () =>
                    supabase.auth.updateUser({
                        data: { profile_url: resizedPath }
                    })
                )

                if (authError) {
                    throw normalizeSupabaseActionError(authError)
                }
            }

            // 5. Update local state
            updateUser({ profileUrl: resizedPath })

            // 6. Dispatch global event for immediate UI updates
            window.dispatchEvent(new CustomEvent('profile-updated'))

            console.log('[Settings] Profile picture updated successfully:', resizedPath)
        } catch (error) {
            console.error('[Settings] Profile picture upload failed:', error)
            showActionError(error, 'Upload failed.')
        }
    }

    const handleRemoveProfilePicture = async () => {
        if (!user || !user.profileUrl) return;

        try {
            // Delete from R2 and Local
            await assetManager.deleteAsset(user.profileUrl);

            // Update cloud profile (Supabase)
            if (isSupabaseConfigured) {
                const { error: profileError } = await runSupabaseAction('settings.removeProfileImage', () =>
                    supabase.from('profiles').update({ profile_url: null }).eq('id', user.id)
                )
                if (profileError) throw normalizeSupabaseActionError(profileError)

                const { error: authError } = await runSupabaseAction('settings.removeProfileMetadata', () =>
                    supabase.auth.updateUser({ data: { profile_url: null } })
                )
                if (authError) throw normalizeSupabaseActionError(authError)
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

        if (marketplaceVisibility === 'public' && !normalizedMarketplaceSlug) {
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
                store_description: marketplaceDescription.trim() || null,
                ecommerce: marketplaceVisibility === 'public' ? true : features.ecommerce
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

    return (
        <div className="space-y-6 max-w-3xl">
            {/* Header */}
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-primary" />
                    {t('settings.title')}
                </h1>
                <p className="text-muted-foreground">{t('settings.subtitle')}</p>
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

                    {/* Application Updates (Electron Only) */}
                    {isElectron && (
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
                                            {updateStatus?.status === 'checking' && t('settings.updater.checking')}
                                            {updateStatus?.status === 'available' && t('settings.updater.available')}
                                            {updateStatus?.status === 'not-available' && t('settings.updater.notAvailable')}
                                            {updateStatus?.status === 'downloaded' && t('settings.updater.downloaded')}
                                            {updateStatus?.status === 'error' && (
                                                <span className="flex items-center gap-1 text-red-500">
                                                    <AlertCircle className="w-4 h-4" />
                                                    {updateStatus.message}
                                                </span>
                                            )}
                                            {updateStatus?.status === 'progress' && `Downloading: ${Math.round(updateStatus.progress)}%`}
                                            {!updateStatus && t('settings.updater.clickButton')}
                                        </p>
                                    </div>
                                    <Button
                                        allowViewer={true}
                                        onClick={handleCheckForUpdates}
                                        disabled={updateStatus?.status === 'checking' || updateStatus?.status === 'progress'}
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
                        </CardContent>
                    </Card>

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
                                    {user?.role === 'admin' && (
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
                                                    onValueChange={(value: 'private' | 'public') => setMarketplaceVisibility(value)}
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
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {user?.role === 'admin' && !isLocalMode && (
                        <BranchManager />
                    )}

                    {/* Contact Modal (rendered outside card but inside profile tab) */}
                    {user?.role === 'admin' && (
                        <RegisterWorkspaceContactsModal
                            open={contactsModalOpen}
                            onOpenChange={setContactsModalOpen}
                            contacts={workspaceContacts.map(p => ({ type: p.type, value: p.value, label: p.label || '', isPrimary: p.isPrimary }))}
                            onContactsChange={async (newContacts) => {
                                if (!user?.workspaceId) return
                                try {
                                    const { error: deleteError } = await runSupabaseAction('settings.replaceWorkspaceContacts.delete', () =>
                                        supabase.from('workspace_contacts').delete().eq('workspace_id', user.workspaceId)
                                    )
                                    if (deleteError) throw normalizeSupabaseActionError(deleteError)

                                    if (newContacts.length > 0) {
                                        const payload = newContacts.map(p => ({
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

                                    <div className="flex flex-col gap-2">
                                        <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.printing.a4Template') || 'A4 Invoice Template'}</Label>
                                        <Select
                                            value={features.a4_template || 'primary'}
                                            onValueChange={(val: any) => updateSettings({ a4_template: val })}
                                        >
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select template" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="primary">{t('settings.printing.primary') || 'Primary'}</SelectItem>
                                                <SelectItem value="modern">{t('settings.printing.modern') || 'Modern'}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-[10px] text-muted-foreground italic">
                                            {t('settings.printing.templateDesc') || 'Full page A4 invoice design.'}
                                        </p>
                                    </div>
                                </div>

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

                                <div className="flex flex-col gap-2 max-w-sm">
                                    <Label className="text-xs text-slate-500 uppercase font-semibold">{t('settings.printing.quality') || 'Print Quality'}</Label>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant={features.print_quality === 'low' ? 'default' : 'outline'}
                                            className="flex-1"
                                            onClick={() => updateSettings({ print_quality: 'low' })}
                                        >
                                            {t('settings.printing.low') || 'Low'}
                                        </Button>
                                        <Button
                                            variant={features.print_quality === 'high' ? 'default' : 'outline'}
                                            className="flex-1"
                                            onClick={() => updateSettings({ print_quality: 'high' })}
                                        >
                                            {t('settings.printing.high') || 'High'}
                                        </Button>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground italic">
                                        {t('settings.printing.qualityDesc') || 'HIGH quality increases clarity but results in larger PDF files. QR codes are always high quality.'}
                                    </p>
                                </div>

                                <div className="grid gap-4 md:grid-cols-2 max-w-3xl">
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
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* KDS Streaming */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <MonitorPlay className="w-5 h-5" />
                                {t('settings.kds.title') || 'KDS Settings'}
                            </CardTitle>
                            <CardDescription>
                                {t('settings.kds.desc') || 'Manage your KDS settings'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-col gap-6">
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border">
                                        <div className="space-y-0.5 pr-4">
                                            <Label className="text-sm font-medium">{t('settings.kds.enable') || 'Enable KDS'}</Label>
                                            <p className="text-xs text-muted-foreground max-w-md">
                                                {t('settings.kds.enableDesc') || 'Enable KDS for your workspace'}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={features.kds_enabled}
                                            disabled={isKdsSaving || !isDesktop()}
                                            onCheckedChange={(val) => {
                                                updateSettings({ kds_enabled: val })
                                                if (val && kdsStatus === 'idle') {
                                                    startStream(4004).catch(console.error)
                                                }
                                            }}
                                        />
                                    </div>
                                    {!isDesktop() && (
                                        <p className="text-sm font-medium text-amber-500">
                                            {t('settings.kds.desktopOnly') || 'KDS Hosting is only available on Desktop app.'}
                                        </p>
                                    )}
                                </div>

                                {features.kds_enabled && (
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
                            </div>
                        </CardContent>
                    </Card>

                    {/* Currency Settings (Admin Only) */}
                    {user?.role === 'admin' && (
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
                                    />

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
                    {user?.role === 'admin' && (
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
                                        <div className="flex items-center justify-between">
                                            <div className="space-y-0.5">
                                                <Label className="text-base">{t('settings.exchangeRate.eurEnable') || 'Enable Euro Support'}</Label>
                                                <p className="text-sm text-muted-foreground">
                                                    {t('settings.exchangeRate.eurEnableDesc') || 'Allow POS to handle EUR products and conversions.'}
                                                </p>
                                            </div>
                                            <Switch
                                                checked={features.eur_conversion_enabled}
                                                onCheckedChange={(val: boolean) => updateSettings({ eur_conversion_enabled: val })}
                                                disabled={user?.role !== 'admin'}
                                            />
                                        </div>

                                        {features.eur_conversion_enabled && (
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
                                        )}

                                        <div className="pt-2 space-y-4 border-t border-border/50">
                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label className="text-base">{t('settings.exchangeRate.tryEnable') || 'Enable TRY Support'}</Label>
                                                    <p className="text-sm text-muted-foreground">
                                                        {t('settings.exchangeRate.tryEnableDesc') || 'Allow POS to handle TRY products and conversions.'}
                                                    </p>
                                                </div>
                                                <div className="space-y-2">
                                                    <Switch
                                                        checked={features.try_conversion_enabled}
                                                        onCheckedChange={(val: boolean) => updateSettings({ try_conversion_enabled: val })}
                                                        disabled={user?.role !== 'admin'}
                                                    />
                                                </div>
                                            </div>

                                            {features.try_conversion_enabled && (
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
                                            )}
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
                    {user?.role === 'admin' && (
                        <>
                            {/* WhatsApp Integration Setting */}
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
                                            <Label className="text-base text-primary">Enable WhatsApp Feature</Label>
                                            <p className="text-sm text-muted-foreground max-w-md">
                                                Allow text-only communication with customers. Staff will inherit this setting.
                                            </p>
                                        </div>
                                        <Switch
                                            checked={features.allow_whatsapp}
                                            onCheckedChange={(val: boolean) => updateSettings({ allow_whatsapp: val })}
                                        />
                                    </div>

                                    {features.allow_whatsapp && (
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
                                    )}
                                </CardContent>
                            </Card>

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
                                            <Label className="text-muted-foreground">{t('settings.authMode')}</Label>
                                            <p className="font-medium">{isSupabaseConfigured ? 'Supabase' : t('settings.demo')}</p>
                                        </div>
                                        <div className="md:col-span-2">
                                            <Label className="text-muted-foreground">Workspace Subscription</Label>
                                            <div className="flex items-center gap-3 mt-1.5 p-3 bg-secondary/20 rounded-lg border border-border w-full max-w-sm">
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
                                    <Button variant="destructive" onClick={signOut}>
                                        {t('auth.signOut')}
                                    </Button>
                                </CardContent>
                            </Card>

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

                <Dialog open={isThermalDialogOpen} onOpenChange={setIsThermalDialogOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>
                                {t('settings.printing.thermalDialogTitle', { defaultValue: 'Thermal Printers' })}
                            </DialogTitle>
                            <DialogDescription>
                                {t('settings.printing.thermalDialogDesc', {
                                    defaultValue: 'Scan this device for available thermal printers and choose which one should handle POS receipt printing for this workspace.'
                                })}
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4">
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
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={scanThermalPrinters}
                                    disabled={isScanningThermalPrinters}
                                    className="self-start md:self-auto"
                                >
                                    <RefreshCw className={cn('mr-2 h-4 w-4', isScanningThermalPrinters && 'animate-spin')} />
                                    {t('settings.printing.refreshPrinters', { defaultValue: 'Refresh' })}
                                </Button>
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

                            <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
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
                        </div>

                        <DialogFooter className="gap-2 sm:justify-between">
                            {features.thermal_printing ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={handleDisableThermalPrinting}
                                    disabled={isThermalActionPending}
                                >
                                    {t('settings.printing.disableThermalPrinting', { defaultValue: 'Disable Thermal Printing' })}
                                </Button>
                            ) : <div />}
                            <Button
                                type="button"
                                variant="default"
                                onClick={() => setIsThermalDialogOpen(false)}
                            >
                                {t('common.close', { defaultValue: 'Close' })}
                            </Button>
                        </DialogFooter>
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
