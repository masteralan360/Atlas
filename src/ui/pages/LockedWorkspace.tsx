import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Mail, LogOut, Clock, AlertCircle } from 'lucide-react'
import { Button } from '@/ui/components/button'
import { useAuth } from '@/auth'
import { useLocation } from 'wouter'
import { useWorkspace } from '@/workspace'
import { formatDate } from '@/lib/utils'

export function LockedWorkspace() {
    const { t } = useTranslation()
    const { signOut } = useAuth()
    const { features, isLocked, isLoading } = useWorkspace()
    const [, setLocation] = useLocation()

    const isExpired = features.subscription_expires_at && new Date(features.subscription_expires_at) < new Date()

    useEffect(() => {
        if (!isLoading && !isLocked) {
            setLocation('/')
        }
    }, [isLoading, isLocked, setLocation])

    const handleContactAdmin = () => {
        // Open email client with admin contact
        window.location.href = 'mailto:admin@example.com?subject=Workspace Access Request'
    }

    const handleSignOut = async () => {
        await signOut()
        setLocation('/login')
    }

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30 p-4">
            <div className="max-w-md w-full text-center space-y-8">
                {/* Lock Icon */}
                <div className="mx-auto w-24 h-24 rounded-full bg-destructive/10 flex items-center justify-center relative">
                    {isExpired ? (
                        <Clock className="w-12 h-12 text-destructive animate-pulse" />
                    ) : (
                        <Lock className="w-12 h-12 text-destructive" />
                    )}
                    {isExpired && (
                        <div className="absolute -top-1 -right-1">
                            <AlertCircle className="w-6 h-6 text-destructive fill-background" />
                        </div>
                    )}
                </div>

                {/* Title */}
                <div className="space-y-2">
                    <h1 className="text-3xl font-bold text-foreground">
                        {isExpired
                            ? (t('lockedWorkspace.subscriptionExpired') || 'Subscription Expired')
                            : (t('lockedWorkspace.title') || 'Workspace Locked')
                        }
                    </h1>
                    <p className="text-muted-foreground text-lg">
                        {isExpired
                            ? (t('lockedWorkspace.expiryMessage') || `Your subscription expired on ${formatDate(features.subscription_expires_at!)}. Please contact an administrator to extend it.`)
                            : (t('lockedWorkspace.message') || 'Your workspace has been temporarily locked. Please contact an administrator to regain access.')
                        }
                    </p>
                </div>

                {/* Buttons Container */}
                <div className="flex flex-col gap-3 items-center">
                    <Button
                        size="lg"
                        onClick={handleContactAdmin}
                        className="gap-2 w-full max-w-[240px]"
                    >
                        <Mail className="w-5 h-5" />
                        {t('lockedWorkspace.contactAdmin') || 'Contact an Admin'}
                    </Button>

                    <Button
                        variant="outline"
                        size="lg"
                        onClick={handleSignOut}
                        className="gap-2 w-full max-w-[240px]"
                    >
                        <LogOut className="w-5 h-5" />
                        {t('common.signOut') || 'Sign Out'}
                    </Button>
                </div>

                {/* Additional Info */}
                <p className="text-xs text-muted-foreground opacity-70">
                    {t('lockedWorkspace.additionalInfo') || 'If you believe this is an error, please reach out to your workspace administrator.'}
                </p>
            </div>
        </div>
    )
}
