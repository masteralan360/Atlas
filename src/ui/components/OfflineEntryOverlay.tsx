import { useEffect, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { connectionManager } from '@/lib/connectionManager'
import { Button } from '@/ui/components/button'

function canEnterOfflineMode(workspaceMode: string | undefined) {
    return workspaceMode === 'hybrid'
}

/**
 * Blocks Cloud Sync workspaces after an OS-level network-loss event until
 * the user confirms that the app should switch into its existing offline mode.
 */
export function OfflineEntryOverlay() {
    const { t } = useTranslation()
    const { user, isAuthenticated } = useAuth()
    const [isVisible, setIsVisible] = useState(false)
    const canPrompt = isAuthenticated && canEnterOfflineMode(user?.workspaceMode)

    useEffect(() => {
        if (!canPrompt) {
            setIsVisible(false)
            return
        }

        const showIfConfirmationIsRequired = () => {
            const state = connectionManager.getState()
            setIsVisible(state.offlineConfirmationRequired && state.isOnline)
        }

        showIfConfirmationIsRequired()

        return connectionManager.subscribe((event) => {
            if (event === 'network-lost') {
                showIfConfirmationIsRequired()
            } else if (event === 'online') {
                // Restoration is automatic and never requires confirmation.
                setIsVisible(false)
            }
        })
    }, [canPrompt])

    const handleContinueOffline = () => {
        connectionManager.continueOffline()
        setIsVisible(false)
    }

    if (!isVisible || !canPrompt) {
        return null
    }

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/90 p-6 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="offline-entry-title"
            aria-describedby="offline-entry-description"
        >
            <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-7 text-center shadow-2xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                    <CloudOff className="h-8 w-8" />
                </div>

                <h2 id="offline-entry-title" className="mt-5 text-2xl font-bold tracking-tight text-foreground">
                    {t('offlineEntry.title', { defaultValue: 'No internet connection available' })}
                </h2>
                <p id="offline-entry-description" className="mt-3 text-sm leading-6 text-muted-foreground">
                    {t('offlineEntry.description', {
                        defaultValue: 'Your connection was lost. Continue offline to keep working with data stored on this device.'
                    })}
                </p>

                <Button type="button" className="mt-7 w-full" allowViewer onClick={handleContinueOffline}>
                    <CloudOff className="h-4 w-4" />
                    {t('offlineEntry.continue', { defaultValue: 'Continue Offline' })}
                </Button>
            </div>
        </div>
    )
}
