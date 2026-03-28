import { useEffect, useState } from 'react'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useWorkspace } from '@/workspace'
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
    CreditCard,
    FileText,
    Loader2,
    Check,
    ArrowRight,
    ImagePlus,
    Package,
    MapPin
} from 'lucide-react'
import { isTauri as isTauriCheck } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { assetManager } from '@/lib/assetManager'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import type { WorkspaceDataMode } from '@/local-db/models'

interface FeatureToggle {
    key: 'pos' | 'invoices_history'
    label: string
    description: string
    icon: React.ElementType
}

export function WorkspaceConfiguration() {
    const { user } = useAuth()
    const { refreshFeatures, features: currentFeatures, isLoading: isWorkspaceLoading, updateSettings } = useWorkspace()
    const [, navigate] = useLocation()
    const { t } = useTranslation()
    const { toast } = useToast()

    const [isLoading, setIsLoading] = useState(false)
    const [isLocationSaving, setIsLocationSaving] = useState(false)
    const [logoUrl, setLogoUrl] = useState(currentFeatures.logo_url || '')
    const [coordination, setCoordination] = useState(currentFeatures.coordination || '')
    const [dataMode, setDataMode] = useState<WorkspaceDataMode>(currentFeatures.data_mode)
    const isTauri = isTauriCheck()
    const workspaceId = user?.workspaceId || ''

    useEffect(() => {
        if (!isWorkspaceLoading && currentFeatures.is_configured) {
            navigate('/')
        }
    }, [currentFeatures.is_configured, isWorkspaceLoading, navigate])

    useEffect(() => {
        setCoordination(currentFeatures.coordination || '')
    }, [currentFeatures.coordination])

    const [features, setFeatures] = useState({
        pos: currentFeatures.pos,
        invoices_history: currentFeatures.invoices_history
    })

    const featureToggles: FeatureToggle[] = [
        {
            key: 'pos',
            label: t('workspaceConfig.features.pos') || 'Point of Sale (POS)',
            description: t('workspaceConfig.features.posDesc') || 'Enable quick sales and checkout functionality',
            icon: CreditCard
        },
        {
            key: 'invoices_history',
            label: t('workspaceConfig.features.invoices') || 'Invoicing',
            description: t('workspaceConfig.features.invoicesDesc') || 'Generate and manage invoices',
            icon: FileText
        }
    ]

    const toggleFeature = (key: keyof typeof features) => {
        setFeatures(prev => ({ ...prev, [key]: !prev[key] }))
    }

    const handleImageUpload = async () => {
        if (!isTauri) return;
        const targetPath = await platformService.pickAndSaveImage(workspaceId, 'workspace-logos');
        if (targetPath) {
            setLogoUrl(targetPath);
            // Trigger asset sync via R2
            assetManager.uploadFromPath(targetPath, 'branding').then(success => {
                if (success) {
                    console.log('[WorkspaceConfig] Logo synced via R2');
                }
            }).catch(console.error);
        }
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return platformService.convertFileSrc(url);
    }

    const formatCoordination = (latitude: number, longitude: number) => {
        const lat = Number.isFinite(latitude) ? latitude.toFixed(14) : String(latitude)
        const lon = Number.isFinite(longitude) ? longitude.toFixed(14) : String(longitude)
        return `${lat}, ${lon}`
    }

    const getLocationErrorMessage = (error: GeolocationPositionError) => {
        if (error.code === error.PERMISSION_DENIED) {
            return t('workspaceConfig.location.permissionDenied') || 'Location permission was denied.'
        }
        if (error.code === error.POSITION_UNAVAILABLE) {
            return t('workspaceConfig.location.unavailable') || 'Location information is unavailable.'
        }
        if (error.code === error.TIMEOUT) {
            return t('workspaceConfig.location.timeout') || 'Location request timed out. Please try again.'
        }
        return t('workspaceConfig.location.failed') || 'Failed to capture location.'
    }

    const handleShareLocation = async () => {
        if (coordination || isLocationSaving) return

        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            toast({
                title: t('common.error') || 'Error',
                description: t('workspaceConfig.location.unsupported') || 'Geolocation is not supported on this device.',
                variant: 'destructive'
            })
            return
        }

        setIsLocationSaving(true)
        try {
            const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 15000,
                    maximumAge: 0
                })
            })

            const formatted = formatCoordination(position.coords.latitude, position.coords.longitude)
            setCoordination(formatted)
            await updateSettings({ coordination: formatted })

            toast({
                title: t('common.success') || 'Success',
                description: t('workspaceConfig.location.saved') || 'Location saved to workspace.'
            })
        } catch (err: any) {
            const message = err?.code
                ? getLocationErrorMessage(err)
                : (err?.message || (t('workspaceConfig.location.failed') || 'Failed to capture location.'))
            toast({
                title: t('common.error') || 'Error',
                description: message,
                variant: 'destructive'
            })
        } finally {
            setIsLocationSaving(false)
        }
    }

    const handleSave = async () => {
        setIsLoading(true)
        try {
            const { error } = await runSupabaseAction('workspace.configure', () =>
                supabase
                    .from('workspaces')
                    .update({
                        data_mode: dataMode,
                        pos: features.pos,
                        crm: currentFeatures.crm,
                        invoices_history: features.invoices_history,
                        logo_url: logoUrl || null,
                        is_configured: true
                    })
                    .eq('id', workspaceId),
                { timeoutMs: 12000, platform: 'all' }
            ) as any

            if (error) throw normalizeSupabaseActionError(error)

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
                    title: t('common.error') || 'Error',
                    description: `Failed to save configuration: ${normalized.message || 'Unknown error'}`,
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
                                            alt="Workspace Logo"
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <Package className="w-10 h-10 text-muted-foreground/30" />
                                    )}
                                </div>
                                {isTauri && (
                                    <button
                                        onClick={handleImageUpload}
                                        className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
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
                                <p className="font-bold text-xl text-foreground">{user?.workspaceName || 'My Workspace'}</p>
                                {isTauri && (
                                    <p className="text-[10px] text-muted-foreground mt-2 italic flex items-center justify-center gap-1">
                                        <Check className="w-3 h-3 text-green-500" />
                                        {t('workspaceConfig.logoNote')}
                                    </p>
                                )}
                            </div>
                        </div>


                        {/* Workspace Location */}
                        <div className="bg-muted/30 rounded-lg p-6 space-y-4">
                            <div className="flex items-start gap-3">
                                <div className="mt-1 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                    <MapPin className="w-5 h-5 text-primary" />
                                </div>
                                <div className="flex-1">
                                    <p className="font-medium">{t('workspaceConfig.location.title') || 'Share your location'}</p>
                                    <p className="text-sm text-muted-foreground">
                                        {t('workspaceConfig.location.desc') || 'Save your workspace coordinates for maps and future services.'}
                                    </p>
                                </div>
                            </div>

                            {coordination ? (
                                <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground">
                                    {coordination}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {t('workspaceConfig.location.example') || 'Example: 40.74032035559755, -73.97990562328214'}
                                </p>
                            )}

                            <Button
                                variant="outline"
                                className="w-full h-10 gap-2"
                                onClick={handleShareLocation}
                                disabled={isLocationSaving || Boolean(coordination)}
                            >
                                {isLocationSaving ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <MapPin className="w-4 h-4" />
                                )}
                                {coordination
                                    ? (t('workspaceConfig.location.savedCta') || 'Location saved')
                                    : (t('workspaceConfig.location.cta') || 'Share Location')}
                            </Button>
                        </div>

                        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-6">
                            <div className="space-y-1">
                                <Label>{t('workspaceConfig.mode.title') || 'Workspace Mode'}</Label>
                                <p className="text-sm text-muted-foreground">
                                    {t('workspaceConfig.mode.description') || 'Choose how this workspace stores business data. This choice is permanent after setup.'}
                                </p>
                            </div>
                            <Select value={dataMode} onValueChange={(value) => setDataMode(value as WorkspaceDataMode)}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="cloud">{t('workspaceConfig.mode.cloud') || 'Cloud Mode'}</SelectItem>
                                    <SelectItem value="local">{t('workspaceConfig.mode.local') || 'Local Mode'}</SelectItem>
                                    <SelectItem value="hybrid">{t('workspaceConfig.mode.hybrid') || 'Hybrid Mode'}</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {dataMode === 'local'
                                    ? (t('workspaceConfig.mode.localHint') || 'Local Mode keeps business data on the device and does not use cloud business-data sync.')
                                    : dataMode === 'hybrid'
                                        ? (t('workspaceConfig.mode.hybridHint') || 'Hybrid Mode keeps business data in the cloud (source of truth) and also saves a local backup to the device for offline access.')
                                        : (t('workspaceConfig.mode.cloudHint') || 'Cloud Mode keeps business data in the cloud and uses the existing sync flow.')}
                            </p>
                        </div>

                        {/* Feature Toggles */}
                        <div className="space-y-3">
                            {featureToggles.map((feature) => {
                                const Icon = feature.icon
                                const isEnabled = features[feature.key as keyof typeof features]

                                return (
                                    <button
                                        key={feature.key}
                                        onClick={() => toggleFeature(feature.key as keyof typeof features)}
                                        className={`
                                        w-full p-4 rounded-xl border-2 transition-all duration-200 text-left
                                        flex items-center gap-4 group
                                        ${isEnabled
                                                ? 'border-primary bg-primary/5 hover:bg-primary/10'
                                                : 'border-border bg-card hover:border-muted-foreground/30'
                                            }
                                    `}
                                    >
                                        <div className={`
                                        w-12 h-12 rounded-lg flex items-center justify-center transition-colors
                                        ${isEnabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}
                                    `}>
                                            <Icon className="w-6 h-6" />
                                        </div>
                                        <div className="flex-1">
                                            <div className="font-medium">{feature.label}</div>
                                            <div className="text-sm text-muted-foreground">{feature.description}</div>
                                        </div>
                                        <div className={`
                                        w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all
                                        ${isEnabled
                                                ? 'border-primary bg-primary text-primary-foreground'
                                                : 'border-muted-foreground/30'
                                            }
                                    `}>
                                            {isEnabled && <Check className="w-4 h-4" />}
                                        </div>
                                    </button>
                                )
                            })}
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
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <>
                                    {t('workspaceConfig.continue')}
                                    <ArrowRight className="w-5 h-5" />
                                </>
                            )}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
