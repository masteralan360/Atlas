type FirebaseServiceAccount = {
    project_id: string
    client_email: string
    private_key: string
}

export type PushNotificationTarget = {
    notification_id: string
    workspace_id: string
    user_id: string
    notification_type: string
    title: string
    body: string | null
    action_url: string | null
    payload: Record<string, unknown> | null
    created_at: string
    token_id: string | null
    device_token: string | null
    platform: 'android' | 'web' | null
}

type FirebaseSendResult = {
    name: string
}

type FirebasePushErrorMeta = {
    httpStatus: number
    fcmStatus: string | null
    fcmErrorCode: string | null
    rawBody: string
}

const encoder = new TextEncoder()
const fcmScope = 'https://www.googleapis.com/auth/firebase.messaging'
const oauthTokenUrl = 'https://oauth2.googleapis.com/token'

let cachedAccessToken: { value: string; expiresAt: number } | null = null
let cachedServiceAccount: FirebaseServiceAccount | null = null

export class FirebasePushError extends Error {
    httpStatus: number
    fcmStatus: string | null
    fcmErrorCode: string | null
    rawBody: string

    constructor(message: string, meta: FirebasePushErrorMeta) {
        super(message)
        this.name = 'FirebasePushError'
        this.httpStatus = meta.httpStatus
        this.fcmStatus = meta.fcmStatus
        this.fcmErrorCode = meta.fcmErrorCode
        this.rawBody = meta.rawBody
    }
}

function encodeBase64Url(value: string | Uint8Array) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function pemToBinary(privateKey: string) {
    const normalized = privateKey.replace(/\\n/g, '\n').trim()
    const body = normalized
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s+/g, '')
    const decoded = atob(body)
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

async function importPrivateKey(privateKey: string) {
    const binary = pemToBinary(privateKey)
    return await crypto.subtle.importKey(
        'pkcs8',
        binary.buffer,
        {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256',
        },
        false,
        ['sign']
    )
}

function readServiceAccount() {
    if (cachedServiceAccount) {
        return cachedServiceAccount
    }

    const rawJson = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')?.trim() ?? ''
    if (rawJson) {
        const parsed = JSON.parse(rawJson) as Partial<FirebaseServiceAccount>
        if (parsed.project_id && parsed.client_email && parsed.private_key) {
            cachedServiceAccount = {
                project_id: parsed.project_id,
                client_email: parsed.client_email,
                private_key: parsed.private_key,
            }
            return cachedServiceAccount
        }
    }

    const projectId = Deno.env.get('FIREBASE_PROJECT_ID')?.trim() ?? ''
    const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')?.trim() ?? ''
    const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')?.trim() ?? ''

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Firebase push is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY in Supabase Edge Function secrets.')
    }

    cachedServiceAccount = {
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
    }
    return cachedServiceAccount
}

async function getAccessToken() {
    if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
        return cachedAccessToken.value
    }

    const serviceAccount = readServiceAccount()
    const now = Math.floor(Date.now() / 1000)
    const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = encodeBase64Url(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: fcmScope,
        aud: oauthTokenUrl,
        iat: now,
        exp: now + 3600,
    }))
    const unsignedJwt = `${header}.${payload}`
    const key = await importPrivateKey(serviceAccount.private_key)
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsignedJwt))
    const assertion = `${unsignedJwt}.${encodeBase64Url(new Uint8Array(signature))}`

    const tokenResponse = await fetch(oauthTokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }).toString(),
    })

    const tokenText = await tokenResponse.text()
    if (!tokenResponse.ok) {
        throw new Error(`Failed to mint Firebase access token: ${tokenResponse.status} ${tokenText}`)
    }

    const tokenPayload = JSON.parse(tokenText) as { access_token?: string; expires_in?: number }
    if (!tokenPayload.access_token) {
        throw new Error(`Firebase access token response did not include access_token: ${tokenText}`)
    }

    cachedAccessToken = {
        value: tokenPayload.access_token,
        expiresAt: Date.now() + Math.max((tokenPayload.expires_in ?? 3600) - 60, 60) * 1000,
    }

    return cachedAccessToken.value
}

function buildDataPayload(target: PushNotificationTarget) {
    const data: Record<string, string> = {
        notificationId: target.notification_id,
        notificationType: target.notification_type,
        title: target.title,
        body: target.body ?? '',
        actionUrl: target.action_url ?? '',
        workspaceId: target.workspace_id,
        userId: target.user_id,
        createdAt: target.created_at,
    }

    if (target.payload) {
        const payloadJson = JSON.stringify(target.payload)
        if (payloadJson.length <= 3000) {
            data.payload = payloadJson
        }
    }

    return data
}

function parseFirebaseError(httpStatus: number, rawBody: string) {
    try {
        const parsed = JSON.parse(rawBody) as {
            error?: {
                message?: string
                status?: string
                details?: Array<{ errorCode?: string }>
            }
        }

        const message = parsed.error?.message ?? `FCM request failed with status ${httpStatus}`
        const fcmStatus = parsed.error?.status ?? null
        const fcmErrorCode = parsed.error?.details?.find((detail) => detail?.errorCode)?.errorCode ?? null

        return new FirebasePushError(message, {
            httpStatus,
            fcmStatus,
            fcmErrorCode,
            rawBody,
        })
    } catch {
        return new FirebasePushError(`FCM request failed with status ${httpStatus}`, {
            httpStatus,
            fcmStatus: null,
            fcmErrorCode: null,
            rawBody,
        })
    }
}

export function isStaleRegistrationToken(error: unknown) {
    if (!(error instanceof FirebasePushError)) {
        return false
    }

    if (error.fcmErrorCode === 'UNREGISTERED') {
        return true
    }

    return error.fcmErrorCode === 'INVALID_ARGUMENT'
        && /registration token/i.test(error.rawBody)
}

export function isFirebaseConfigured() {
    try {
        readServiceAccount()
        return true
    } catch {
        return false
    }
}

export async function sendFirebasePush(target: PushNotificationTarget): Promise<FirebaseSendResult> {
    if (!target.device_token || !target.platform) {
        throw new Error('Push target is missing device token or platform')
    }

    const accessToken = await getAccessToken()
    const projectId = readServiceAccount().project_id
    const data = buildDataPayload(target)
    const body = target.body ?? 'You have a new notification.'

    const message: Record<string, unknown> = {
        token: target.device_token,
        data,
        notification: {
            title: target.title,
            body,
        },
    }

    if (target.platform === 'android') {
        message.android = {
            priority: 'high',
            notification: {
                channelId: 'asaas_default_channel',
                sound: 'default',
            },
        }
    }

    if (target.platform === 'web') {
        message.webpush = {
            headers: {
                Urgency: 'high',
            },
            notification: {
                title: target.title,
                body,
                icon: '/icon-192.png',
                data,
            },
        }
    }

    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message }),
    })

    const rawBody = await response.text()
    if (!response.ok) {
        throw parseFirebaseError(response.status, rawBody)
    }

    return JSON.parse(rawBody) as FirebaseSendResult
}
