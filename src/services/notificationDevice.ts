import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { requestFirebaseTokenSync } from '@/lib/firebase'
import { normalizeNotificationLanguage } from '@/lib/notificationLocalization'
import { isMobile, isTauri } from '@/lib/platform'

const TOKEN_STORAGE_KEY_PREFIX = 'atlas_device_token'

type NotificationPlatform = 'android' | 'web'

type CachedDeviceTokenRegistration = {
    token: string
    language: string
}

function readCachedRegistration(rawValue: string | null): CachedDeviceTokenRegistration | null {
    if (!rawValue) return null

    try {
        const parsed = JSON.parse(rawValue) as Partial<CachedDeviceTokenRegistration>
        if (typeof parsed.token === 'string' && typeof parsed.language === 'string') {
            return {
                token: parsed.token,
                language: parsed.language,
            }
        }
    } catch {
        // Support legacy cache values that stored only the token.
    }

    return {
        token: rawValue,
        language: 'en',
    }
}

async function readAndroidFcmToken(): Promise<string | null> {
    if (!isTauri() || !isMobile()) {
        return null
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core')

        try {
            const paths = await invoke<string[]>('debug_fcm_paths')
            console.log('[Notifications] FCM debug paths:', paths)
        } catch (debugError) {
            console.warn('[Notifications] debug_fcm_paths failed:', debugError)
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
        return null
    }

    return await requestFirebaseTokenSync()
}

export async function registerDeviceTokenIfNeeded(userId: string, requestedLanguage?: string | null): Promise<void> {
    console.log('[Notifications] registerDeviceTokenIfNeeded called. userId:', userId)

    if (!isSupabaseConfigured) {
        console.log('[Notifications] Skipped: Supabase not configured')
        return
    }

    const language = normalizeNotificationLanguage(requestedLanguage)
    let token = ''
    let platform: NotificationPlatform = 'web'

    if (isTauri() && isMobile()) {
        token = (await readAndroidFcmToken())?.trim() || ''
        platform = 'android'
    } else {
        token = (await readWebPushToken())?.trim() || ''
        platform = 'web'
    }

    if (!token) {
        console.warn(`[Notifications] No device token found for ${platform}; cannot register device.`)
        return
    }

    const storageKey = `${TOKEN_STORAGE_KEY_PREFIX}:${platform}:${userId}`
    const cached = readCachedRegistration(localStorage.getItem(storageKey))
    if (cached?.token === token && cached.language === language) {
        console.log(`[Notifications] Token already cached for ${platform} in ${language}, skipping registration.`)
        return
    }

    console.log(`[Notifications] Registering ${platform} device token for language ${language}...`)

    try {
        const { data: sessionData } = await supabase.auth.getSession()
        const accessToken = sessionData?.session?.access_token
        if (!accessToken) {
            console.warn('[Notifications] No active session; cannot register device token.')
            return
        }

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
        const functionUrl = `${supabaseUrl}/functions/v1/register-device-token`
        const requestBody = JSON.stringify({ token, platform, language })

        let response: Response

        if (isTauri()) {
            const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
            response = await tauriFetch(functionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                    apikey: supabaseAnonKey,
                },
                body: requestBody,
            })
        } else {
            response = await fetch(functionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                    apikey: supabaseAnonKey,
                },
                body: requestBody,
            })
        }

        if (!response.ok) {
            const errorBody = await response.text()
            console.warn('[Notifications] Edge function returned error:', response.status, errorBody)
            return
        }

        const result = await response.json()
        console.log(`[Notifications] ${platform} token registered successfully!`, result)
        localStorage.setItem(storageKey, JSON.stringify({ token, language }))
    } catch (error) {
        console.warn('[Notifications] Failed to register device token:', error)
    }
}
