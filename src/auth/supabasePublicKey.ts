export function isSupabasePublicKey(value: string) {
    if (!value || value.includes('your_supabase_anon') || value.startsWith('sb_secret_')) return false
    if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(value)) return true
    try {
        const parts = value.split('.')
        if (parts.length !== 3) return false
        const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
        return claims.role === 'anon'
    } catch { return false }
}
