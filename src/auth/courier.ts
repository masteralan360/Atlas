import { supabase } from '@/auth/supabase'

export function getCourierUserId(supabaseUserId: string | undefined): string {
    return supabaseUserId || ''
}

export async function fetchCourierToken(accessToken: string): Promise<{ jwt: string; userId: string }> {
    const { data, error } = await supabase.functions.invoke('issue-courier-token', {
        body: {},
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    })

    const payload = data as { error?: string; jwt?: string; userId?: string } | null

    if (error || !payload?.jwt || !payload?.userId) {
        const message = error?.message || payload?.error || 'Failed to issue Courier token'
        throw new Error(message)
    }

    return {
        jwt: payload.jwt,
        userId: payload.userId
    }
}
