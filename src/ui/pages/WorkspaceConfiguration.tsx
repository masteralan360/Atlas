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
    Button,
    useToast
} from '@/ui/components'
import {
    CreditCard,
    Users,
    ShoppingCart,
    FileText,
    Loader2,
    Check,
    ArrowRight,
    ImagePlus,
    Package
} from 'lucide-react'
import { isTauri as isTauriCheck } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { assetManager } from '@/lib/assetManager'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'

interface FeatureToggle {
    key: 'allow_pos' | 'allow_customers' | 'allow_orders' | 'allow_invoices'
    label: string
    description: string
    icon: React.ElementType
}

export function WorkspaceConfiguration() {
    const { user } = useAuth()
    const { refreshFeatures, features: currentFeatures, isLoading: isWorkspaceLoading } = useWorkspace()
    const [, navigate] = useLocation()
    const { t } = useTranslation()
    const { toast } = useToast()

    const [isLoading, setIsLoading] = useState(false)
    const [logoUrl, setLogoUrl] = useState(currentFeatures.logo_url || '')
    const isTauri = isTauriCheck()
    const workspaceId = user?.workspaceId || ''

    useEffect(() => {
        if (!isWorkspaceLoading && currentFeatures.is_configured) {
            navigate('/')
        }
    }, [currentFeatures.is_configured, isWorkspaceLoading, navigate])

    const [features, setFeatures] = useState({
        allow_pos: currentFeatures.allow_pos,
        allow_customers: currentFeatures.allow_customers,
        allow_orders: currentFeatures.allow_orders,
        allow_invoices: currentFeatures.allow_invoices
    })

    const featureToggles: FeatureToggle[] = [
        {
            key: 'allow_pos',
            label: t('workspaceConfig.features.pos') || 'Point of Sale (POS)',
            description: t('workspaceConfig.features.posDesc') || 'Enable quick sales and checkout functionality',
            icon: CreditCard
        },
        {
            key: 'allow_customers',
            label: t('workspaceConfig.features.customers') || 'Customer Management',
            description: t('workspaceConfig.features.customersDesc') || 'Track and manage customer information',
            icon: Users
        },
        {
            key: 'allow_orders',
            label: t('workspaceConfig.features.orders') || 'Order Management',
            description: t('workspaceConfig.features.ordersDesc') || 'Create and track customer orders',
            icon: ShoppingCart
        },
        {
            key: 'allow_invoices',
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

    const handleSave = async () => {
        setIsLoading(true)
        try {
            const { error } = await runSupabaseAction('workspace.configure', () =>
                supabase.rpc('configure_workspace', {
                    p_allow_pos: features.allow_pos,
                    p_allow_customers: features.allow_customers,
                    p_allow_orders: features.allow_orders,
                    p_allow_invoices: features.allow_invoices,
                    p_logo_url: logoUrl || null
                })
            )

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
