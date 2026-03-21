import { useState, useEffect, ReactNode } from 'react'
import { isMobile } from '@/lib/platform'
import { Fingerprint, AlertCircle } from 'lucide-react'
import { Button } from './button'

// @ts-ignore
const isTauri = !!window.__TAURI_INTERNALS__

interface BiometricLockProps {
    children: ReactNode
}

export function BiometricLock({ children }: BiometricLockProps) {
    const [isLocked, setIsLocked] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const checkLock = async () => {
            if (isTauri && isMobile()) {
                const isEnabled = localStorage.getItem('biometric_enabled') === 'true'
                if (isEnabled) {
                    const frequency = localStorage.getItem('biometric_frequency') || '24h'
                    const lastAuthStr = localStorage.getItem('biometric_last_auth')
                    const lastAuth = lastAuthStr ? parseInt(lastAuthStr, 10) : 0
                    const now = Date.now()

                    if (frequency === '24h' && lastAuth > 0 && (now - lastAuth) < 24 * 60 * 60 * 1000) {
                        return // Skip lock if within 24 hours
                    }

                    setIsLocked(true)
                    // We optionally trigger it immediately on mount
                    handleAuthenticate()
                }
            }
        }
        checkLock()
    }, [])

    const handleAuthenticate = async () => {
        setError(null)
        try {
            const { authenticate } = await import('@tauri-apps/plugin-biometric')
            await authenticate('Unlock Atlas')
            localStorage.setItem('biometric_last_auth', Date.now().toString())
            setIsLocked(false)
        } catch (err: any) {
            console.error('Biometric auth failed:', err)
            setError('Authentication failed. Please try again.')
        }
    }

    if (!isLocked) {
        return <>{children}</>
    }

    return (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background p-6">
            <div className="flex flex-col items-center max-w-sm space-y-6 text-center">
                <div className="flex items-center justify-center w-20 h-20 rounded-full bg-primary/10">
                    <Fingerprint className="w-10 h-10 text-primary" />
                </div>
                
                <div className="space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight text-foreground">App Locked</h2>
                    <p className="text-muted-foreground text-sm">
                        Use your biometric credentials to unlock the application.
                    </p>
                </div>

                {error && (
                    <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg text-sm w-full justify-center">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <Button 
                    onClick={handleAuthenticate} 
                    className="w-full h-12 rounded-xl mt-4 text-base font-semibold"
                >
                    Unlock
                </Button>
            </div>
        </div>
    )
}
