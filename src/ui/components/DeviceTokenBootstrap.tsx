import { useEffect } from 'react'
import { useAuth } from '@/auth'
import { initMessaging, onForegroundMessage } from '@/lib/firebase'
import { isMobile, isTauri } from '@/lib/platform'
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

    useEffect(() => {
        if (!isAuthenticated || !user) return
        void registerDeviceTokenIfNeeded(user.id)
    }, [isAuthenticated, user?.id])

    useEffect(() => {
        if (!isAuthenticated || !user) return
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
                    icon: '/icon-192.png',
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
    }, [isAuthenticated, user?.id])

    return null
}
