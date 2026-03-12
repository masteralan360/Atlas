import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { isMobile, isTauri } from '@/lib/platform'

const TOKEN_STORAGE_KEY_PREFIX = 'asaas_fcm_device_token'

async function readAndroidFcmToken(): Promise<string | null> {
    if (!isTauri() || !isMobile()) {
        console.log('[Notifications] readAndroidFcmToken skipped: isTauri=', isTauri(), 'isMobile=', isMobile())
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
        console.warn('[Notifications] Failed to read FCM token:', error)
        return null
    }
}

export async function registerDeviceTokenIfNeeded(userId: string): Promise<void> {
    console.log('[Notifications] registerDeviceTokenIfNeeded called. userId:', userId)

    if (!isSupabaseConfigured) {
        console.log('[Notifications] Skipped: Supabase not configured')
        return
    }
    if (!isTauri() || !isMobile()) {
        console.log('[Notifications] Skipped: not Tauri mobile. isTauri=', isTauri(), 'isMobile=', isMobile())
        return
    }

    const token = (await readAndroidFcmToken())?.trim() || ''
    if (!token) {
        console.warn('[Notifications] No FCM token found — cannot register device.')
        return
    }

    const storageKey = `${TOKEN_STORAGE_KEY_PREFIX}:${userId}`
    const cached = localStorage.getItem(storageKey)
    if (cached === token) {
        console.log('[Notifications] Token already cached, skipping registration.')
        return
    }

    console.log('[Notifications] Registering device token via Tauri native fetch...')

    try {
        // Use Tauri's native HTTP plugin to bypass CORS
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')

        const { data: sessionData } = await supabase.auth.getSession()
        const accessToken = sessionData?.session?.access_token
        if (!accessToken) {
            console.warn('[Notifications] No active session — cannot register device token.')
            return
        }

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
        const functionUrl = `${supabaseUrl}/functions/v1/register-device-token`

        const response = await tauriFetch(functionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'apikey': supabaseAnonKey
            },
            body: JSON.stringify({ token, platform: 'android' })
        })

        if (!response.ok) {
            const errorBody = await response.text()
            console.warn('[Notifications] Edge function returned error:', response.status, errorBody)
            return
        }

        const result = await response.json()
        console.log('[Notifications] Device token registered successfully!', result)
        localStorage.setItem(storageKey, token)
    } catch (error) {
        console.warn('[Notifications] Failed to register device token:', error)
    }
}
