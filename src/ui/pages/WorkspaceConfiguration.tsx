import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useWorkspace } from '@/workspace'
import { cn } from '@/lib/utils'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Button,
    useToast
} from '@/ui/components'
import {
    Loader2,
    Check,
    ArrowRight,
    ImagePlus,
    Package,
    MapPin,
    Phone,
    Zap,
    Star,
    LogOut
} from 'lucide-react'
import { isTauri as isTauriCheck } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { getMediaUploadErrorCode } from '@/services/mediaUploadService'
import {
    formatCoordinates,
    isGeolocationSupported,
    requestCurrentLocation
} from '@/lib/geolocation'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import type { WorkspaceDataMode } from '@/local-db/models'
import { WORKSPACE_PLANS, getPlanCapabilities } from '@/plans/workspacePlans'
import type { WorkspacePlan } from '@/plans/workspacePlans'

export function WorkspaceConfiguration() {
    const { user, signOut } = useAuth()
    const { refreshFeatures, features: currentFeatures, isLoading: isWorkspaceLoading, updateSettings } = useWorkspace()
    const [, navigate] = useLocation()
    const { t, i18n } = useTranslation()
    const { toast } = useToast()

    const [isLoading, setIsLoading] = useState(false)
    const [isLocationSaving, setIsLocationSaving] = useState(false)
    const [isLocationSynced, setIsLocationSynced] = useState(Boolean(currentFeatures.coordination))
    const locationRequestInFlight = useRef(false)
    const [logoUrl, setLogoUrl] = useState(currentFeatures.logo_url || '')
    const [coordination, setCoordination] = useState(currentFeatures.coordination || '')
    const [a2cPhone, setA2cPhone] = useState('')
    const [dataMode, setDataMode] = useState<WorkspaceDataMode>('hybrid')
    const [plan, setPlan] = useState<WorkspacePlan>('enterprise')
    const isTauri = isTauriCheck()
    const workspaceId = user?.workspaceId || ''
    const isRtl = i18n.dir(i18n.resolvedLanguage || i18n.language) === 'rtl'

    useEffect(() => {
        if (!isWorkspaceLoading && currentFeatures.is_configured) {
            navigate('/')
        }
    }, [currentFeatures.is_configured, isWorkspaceLoading, navigate])

    useEffect(() => {
        setCoordination(currentFeatures.coordination || '')
        setIsLocationSynced(Boolean(currentFeatures.coordination))
    }, [currentFeatures.coordination])

    const handleImageUpload = async () => {
        if (!isTauri) return;
        try {
            const targetPath = await platformService.pickAndSaveImage(workspaceId, 'workspace-logos', 'workspace-logo');
            if (targetPath) setLogoUrl(targetPath);
        } catch (error) {
            const code = getMediaUploadErrorCode(error) || 'upload_failed'
            toast({
                title: t('common.error'),
                description: t(`mediaUpload.errors.${code}`),
                variant: 'destructive',
            })
        }
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return platformService.convertFileSrc(url);
    }

    const getLocationErrorMessage = (error: GeolocationPositionError) => {
        if (error.code === error.PERMISSION_DENIED) {
            return t('workspaceConfig.location.permissionDenied')
        }
        if (error.code === error.POSITION_UNAVAILABLE) {
            return t('workspaceConfig.location.deviceLocationDisabled')
        }
        if (error.code === error.TIMEOUT) {
            return t('workspaceConfig.location.timeout')
        }
        return t('workspaceConfig.location.failed')
    }

    const isValidA2cPhone = (value: string) => {
        const normalized = value.trim()
        return normalized.length >= 6
            && normalized.length <= 32
            && /^[0-9+().\-\s]+$/.test(normalized)
            && /\d/.test(normalized)
    }

    const handleShareLocation = async () => {
        if (isLocationSynced || isLocationSaving || locationRequestInFlight.current) return

        if (!isGeolocationSupported()) {
            toast({
                title: t('common.error'),
                description: t('workspaceConfig.location.unsupported'),
                variant: 'destructive'
            })
            return
        }

        locationRequestInFlight.current = true
        let position: GeolocationPosition
        try {
            position = await requestCurrentLocation()
        } catch (err: unknown) {
            const message = typeof err === 'object' && err !== null && 'code' in err
                ? getLocationErrorMessage(err as GeolocationPositionError)
                : err instanceof Error
                    ? err.message
                    : t('workspaceConfig.location.failed')
            toast({
                title: t('common.error'),
                description: message,
                variant: 'destructive'
            })
            locationRequestInFlight.current = false
            return
        }

        setIsLocationSaving(true)
        try {
            const formatted = formatCoordinates(position.coords.latitude, position.coords.longitude)
            setCoordination(formatted)
            await updateSettings({ coordination: formatted }, {
                requireRemoteSync: dataMode !== 'local'
            })
            setIsLocationSynced(true)

            toast({
                title: t('common.success'),
                description: t('workspaceConfig.location.saved')
            })
        } catch (err: any) {
            setIsLocationSynced(false)
            const message = err?.code
                ? getLocationErrorMessage(err)
                : (err?.message || t('workspaceConfig.location.failed'))
            toast({
                title: t('common.error'),
                description: message,
                variant: 'destructive'
            })
        } finally {
            setIsLocationSaving(false)
            locationRequestInFlight.current = false
        }
    }

    const handleSave = async () => {
        const normalizedA2cPhone = a2cPhone.trim()
        if (!isValidA2cPhone(normalizedA2cPhone)) {
            toast({
                title: t('common.error'),
                description: t('workspaceConfig.a2cPhone.invalid'),
                variant: 'destructive'
            })
            return
        }

        setIsLoading(true)
        try {
            // This RPC only records the immutable audit value; the app never reads it.
            const { error: phoneError } = await runSupabaseAction('workspace.recordA2cPhone', () =>
                supabase.rpc('record_workspace_a2c_phone', {
                    p_phone_number: normalizedA2cPhone
                }),
                { timeoutMs: 12000, platform: 'all' }
            ) as any

            if (phoneError) throw normalizeSupabaseActionError(phoneError)

            const updatePayload: any = {
                data_mode: dataMode,
                plan: plan,
                is_configured: true
            }

            // Only sync logo to Supabase if NOT in local mode
            if (dataMode !== 'local') {
                updatePayload.logo_url = logoUrl || null
            }

            const { error } = await runSupabaseAction('workspace.configure', () =>
                supabase
                    .from('workspaces')
                    .update(updatePayload)
                    .eq('id', workspaceId),
                { timeoutMs: 12000, platform: 'all' }
            ) as any

            if (error) throw normalizeSupabaseActionError(error)

            // Ensure settings are also updated locally via context (which handles Dexie/SQLite)
            await updateSettings({
                data_mode: dataMode,
                plan: plan,
                logo_url: logoUrl || null,
                is_configured: true
            })

            // Refresh workspace features in context
            await refreshFeatures()

            // Navigate to dashboard
            navigate('/')
        } catch (err: any) {
            console.error('Error configuring workspace:', err)
            const normalized = normalizeSupabaseActionError(err)
            if (isRetriableWebRequestError(normalized)) {
                const message = getRetriableActionToast(normalized)
                toast({
                    title: message.title,
                    description: message.description,
                    variant: 'destructive'
                })
            } else {
                toast({
                    title: t('common.error'),
                    description: t('workspaceConfig.errors.saveFailed', {
                        message: normalized.message || t('workspaceConfig.errors.unknown')
                    }),
                    variant: 'destructive'
                })
            }
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="h-screen overflow-hidden bg-gradient-to-br from-background via-background to-primary/5 flex flex-col">
            <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center py-12">
                <Card className="w-full max-w-2xl shadow-xl border-border/50 shrink-0 mb-8">
                    <CardHeader className="text-center pb-2">
                        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                            <ImagePlus className="w-8 h-8 text-primary" />
                        </div>
                        <CardTitle className="text-2xl">
                            {t('workspaceConfig.title')}
                        </CardTitle>
                        <CardDescription className="text-base">
                            {t('workspaceConfig.subtitle')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Workspace Info & Logo */}
                        <div className="bg-muted/30 rounded-lg p-6 flex flex-col items-center gap-4">
                            <div className="relative group">
                                <div className="w-24 h-24 rounded-2xl bg-background border-2 border-dashed border-muted-foreground/30 flex items-center justify-center overflow-hidden transition-all group-hover:border-primary/50">
                                    {logoUrl ? (
                                        <img
                                            src={getDisplayImageUrl(logoUrl)}
                                            alt={t('workspaceConfig.logoAlt')}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <Package className="w-10 h-10 text-muted-foreground/30" />
                                    )}
                                </div>
                                {isTauri && (
                                    <button
                                        onClick={handleImageUpload}
                                        className="absolute -bottom-2 -end-2 w-8 h-8 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
                                        title={t('workspaceConfig.uploadLogo')}
                                    >
                                        <ImagePlus className="w-4 h-4" />
                                    </button>
                                )}
                            </div>

                            <div className="text-center">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                    {t('workspaceConfig.workspaceName')}
                                </p>
                                <p className="font-bold text-xl text-foreground">
                                    {user?.workspaceName || t('workspaceConfig.fallbackWorkspaceName')}
                                </p>
                                {isTauri && (
                                    <p className="text-[10px] text-muted-foreground mt-2 italic flex items-center justify-center gap-1">
                                        <Check className="w-3 h-3 text-green-500" />
                                        {t('workspaceConfig.logoNote')}
                                    </p>
                                )}
                            </div>
                        </div>


                        {/* Administrator-to-customer audit phone */}
                        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-6">
                            <div className="flex items-start gap-3">
                                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                                    <Phone className="h-5 w-5 text-primary" />
                                </div>
                                <div className="flex-1 space-y-1">
                                    <Label htmlFor="workspace-a2c-phone">
                                        {t('workspaceConfig.a2cPhone.title')}
                                    </Label>
                                    <p className="text-sm text-muted-foreground">
                                        {t('workspaceConfig.a2cPhone.description')}
                                    </p>
                                </div>
                            </div>
                            <input
                                id="workspace-a2c-phone"
                                type="tel"
                                inputMode="tel"
                                autoComplete="tel"
                                maxLength={32}
                                required
                                value={a2cPhone}
                                onChange={(event) => setA2cPhone(event.target.value)}
                                placeholder={t('workspaceConfig.a2cPhone.placeholder')}
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            />
                            <p className="text-xs text-muted-foreground">
                                {t('workspaceConfig.a2cPhone.auditNote')}
                            </p>
                        </div>

                        {/* Workspace Location */}
                        <div className="bg-muted/30 rounded-lg p-6 space-y-4">
                            <div className="flex items-start gap-3">
                                <div className="mt-1 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                    <MapPin className="w-5 h-5 text-primary" />
                                </div>
                                <div className="flex-1">
                                    <p className="font-medium">{t('workspaceConfig.location.title')}</p>
                                    <p className="text-sm text-muted-foreground">
                                        {t('workspaceConfig.location.desc')}
                                    </p>
                                </div>
                            </div>

                            {coordination ? (
                                <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground">
                                    {coordination}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {t('workspaceConfig.location.example')}
                                </p>
                            )}

                            <Button
                                variant="outline"
                                className="w-full h-10 gap-2"
                                onClick={handleShareLocation}
                                disabled={isLocationSaving || isLocationSynced}
                            >
                                {isLocationSaving ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <MapPin className="w-4 h-4" />
                                )}
                                {isLocationSynced
                                    ? t('workspaceConfig.location.savedCta')
                                    : t('workspaceConfig.location.cta')}
                            </Button>
                        </div>

                        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-6">
                            <div className="space-y-1">
                                <Label>{t('workspaceConfig.mode.title')}</Label>
                                <p className="text-sm text-muted-foreground">
                                    {t('workspaceConfig.mode.description')}
                                </p>
                            </div>
                            <Select value={dataMode} onValueChange={(value) => setDataMode(value as WorkspaceDataMode)}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="hybrid">{t('workspaceConfig.mode.hybrid')}</SelectItem>
                                    <SelectItem value="cloud">{t('workspaceConfig.mode.cloud')}</SelectItem>
                                    <SelectItem value="local">{t('workspaceConfig.mode.local')}</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {dataMode === 'local'
                                    ? t('workspaceConfig.mode.localHint')
                                    : dataMode === 'hybrid'
                                        ? t('workspaceConfig.mode.hybridHint')
                                        : t('workspaceConfig.mode.cloudHint')}
                            </p>
                        </div>

                        {/* Plan Selection */}
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <Label>{t('workspaceConfig.plan.title')}</Label>
                                <p className="text-sm text-muted-foreground">
                                    {t('workspaceConfig.plan.description')}
                                </p>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                {WORKSPACE_PLANS.map((p) => {
                                    const caps = getPlanCapabilities(p)
                                    const isSelected = plan === p
                                    const features = caps.modules.length
                                    const planIcons: Record<string, typeof Zap> = { basic: Package, business: Zap, enterprise: Star }
                                    const PlanIcon = planIcons[p] || Package
                                    return (
                                        <button
                                            key={p}
                                            type="button"
                                            onClick={() => setPlan(p)}
                                            className={cn(
                                                'relative rounded-lg border-2 p-4 text-start transition-all cursor-pointer',
                                                isSelected
                                                    ? 'border-primary bg-primary/5 shadow-sm'
                                                    : 'border-border bg-muted/30 hover:border-primary/50'
                                            )}
                                        >
                                            <div className="flex items-center gap-2 mb-2">
                                                <PlanIcon className={cn(
                                                    'w-5 h-5',
                                                    isSelected ? 'text-primary' : 'text-muted-foreground'
                                                )} />
                                                <span className="font-semibold text-sm">
                                                    {t(`workspaceConfig.plan.names.${p}`)}
                                                </span>
                                            </div>
                                            <div className="text-xs text-muted-foreground space-y-0.5">
                                                <p>{t('workspaceConfig.plan.moduleCount', { value: features })}</p>
                                                <p>{t('workspaceConfig.plan.memberCount', { value: caps.limits.maxMembers })}</p>
                                                <p>{caps.limits.maxBranches > 0
                                                    ? t('workspaceConfig.plan.branchCount', { value: caps.limits.maxBranches })
                                                    : t('workspaceConfig.plan.noBranches')}</p>
                                            </div>
                                            {isSelected && (
                                                <div className="absolute top-2 end-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                                                    <Check className="w-3 h-3 text-primary-foreground" />
                                                </div>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        {/* Info Note */}
                        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-sm text-blue-600 dark:text-blue-400">
                            <p>
                                {t('workspaceConfig.note')}
                            </p>
                        </div>

                        {/* Save Button */}
                        <Button
                            className="w-full h-12 text-lg gap-2"
                            onClick={handleSave}
                            disabled={isLoading || !isValidA2cPhone(a2cPhone)}
                        >
                            {isLoading ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <>
                                    {t('workspaceConfig.continue')}
                                    <ArrowRight className={cn('w-5 h-5', isRtl && 'rotate-180')} />
                                </>
                            )}
                        </Button>

                        <Button
                            variant="ghost"
                            className="w-full h-10 gap-2 text-muted-foreground"
                            onClick={() => void signOut()}
                        >
                            <LogOut className="w-4 h-4" />
                            {t('signOut')}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
