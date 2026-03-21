import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { isMobile, isTauri } from '@/lib/platform'
import { requestFirebaseTokenSync } from '@/lib/firebase'

const TOKEN_STORAGE_KEY_PREFIX = 'atlas_device_token'

async function readAndroidFcmToken(): Promise<string | null> {
    if (!isTauri() || !isMobile()) {
        return null
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core')

        // Diagnostic: show which paths Rust is checking
        try {
            const paths = await invoke<string[]>('debug_fcm_paths')
            console.log('[Notifications] FCM debug paths:', paths)
        } catch (dbgErr) {
            console.warn('[Notifications] debug_fcm_paths failed:', dbgErr)
        }

        const token = await invoke<string | null>('read_fcm_token')
        console.log('[Notifications] read_fcm_token result:', token ? `${token.substring(0, 12)}...` : 'null')
        return token ?? null
    } catch (error) {
        console.warn('[Notifications] Failed to read Android FCM token:', error)
        return null
    }
}

async function readWebPushToken(): Promise<string | null> {
    if (isTauri() && isMobile()) {
        return null // Handled by Android natively
    }
    return await requestFirebaseTokenSync()
}

export async function registerDeviceTokenIfNeeded(userId: string): Promise<void> {
    console.log('[Notifications] registerDeviceTokenIfNeeded called. userId:', userId)

    if (!isSupabaseConfigured) {
        console.log('[Notifications] Skipped: Supabase not configured')
        return
    }

    let token = ''
    let platform = 'web'

    if (isTauri() && isMobile()) {
        token = (await readAndroidFcmToken())?.trim() || ''
        platform = 'android'
    } else {
        token = (await readWebPushToken())?.trim() || ''
        platform = 'web'
    }

    if (!token) {
        console.warn(`[Notifications] No device token found for ${platform} — cannot register device.`)
        return
    }

    const storageKey = `${TOKEN_STORAGE_KEY_PREFIX}:${platform}:${userId}`
    const cached = localStorage.getItem(storageKey)
    if (cached === token) {
        console.log(`[Notifications] Token already cached for ${platform}, skipping registration.`)
        return
    }

    console.log(`[Notifications] Registering ${platform} device token...`)

    try {
        const { data: sessionData } = await supabase.auth.getSession()
        const accessToken = sessionData?.session?.access_token
        if (!accessToken) {
            console.warn('[Notifications] No active session — cannot register device token.')
            return
        }

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
        const functionUrl = `${supabaseUrl}/functions/v1/register-device-token`

        let response: Response

        if (isTauri()) {
            // Use Tauri native fetch to avoid CORS if running inside desktop/mobile Tauri app
            const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
            response = await tauriFetch(functionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'apikey': supabaseAnonKey
                },
                body: JSON.stringify({ token, platform })
            })
        } else {
            // Standard browser fetch
            response = await fetch(functionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'apikey': supabaseAnonKey
                },
                body: JSON.stringify({ token, platform })
            })
        }

        if (!response.ok) {
            const errorBody = await response.text()
            console.warn('[Notifications] Edge function returned error:', response.status, errorBody)
            return
        }

        const result = await response.json()
        console.log(`[Notifications] ${platform} token registered successfully!`, result)
        localStorage.setItem(storageKey, token)
    } catch (error) {
        console.warn('[Notifications] Failed to register device token:', error)
    }
}
