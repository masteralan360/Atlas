import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { initMessaging, onForegroundMessage } from '@/lib/firebase'
import { isDesktop, isMobile, isTauri } from '@/lib/platform'
import { registerDeviceTokenIfNeeded } from '@/services/notificationDevice'

function openNotificationTarget(data: Record<string, string> | undefined) {
    const route = data?.actionUrl || data?.route
    if (!route) return

    const targetUrl = new URL(route, window.location.origin).toString()
    window.focus()
    window.location.assign(targetUrl)
}

export function DeviceTokenBootstrap() {
    const { user, isAuthenticated } = useAuth()
    const { i18n } = useTranslation()
    const language = i18n.resolvedLanguage ?? i18n.language
    const userId = user?.id
    const workspaceMode = user?.workspaceMode
    const usesLocalBusinessData = workspaceMode === 'local' || workspaceMode === 'demo'

    useEffect(() => {
        if (!isAuthenticated || !userId || usesLocalBusinessData || isDesktop()) return
        void registerDeviceTokenIfNeeded(userId, language)
    }, [isAuthenticated, language, userId, usesLocalBusinessData])

    useEffect(() => {
        if (!isAuthenticated || !userId || usesLocalBusinessData || isDesktop()) return
        if (isTauri() && isMobile()) return

        let unsubscribe: (() => void) | undefined

        void (async () => {
            const messaging = await initMessaging()
            if (!messaging || Notification.permission !== 'granted') {
                return
            }

            unsubscribe = onForegroundMessage((payload) => {
                const title = payload?.notification?.title || payload?.data?.title || 'Asaas'
                const body = payload?.notification?.body || payload?.data?.body || 'You have a new notification.'
                const data = payload?.data as Record<string, string> | undefined
                const notification = new Notification(title, {
                    body,
                    data,
                    icon: '/pwa-icon.png',
                })

                notification.onclick = () => {
                    notification.close()
                    openNotificationTarget(data)
                }
            })
        })()

        return () => {
            unsubscribe?.()
        }
    }, [isAuthenticated, userId, usesLocalBusinessData])

    return null
}
