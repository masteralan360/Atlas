import { createClient } from '@supabase/supabase-js'

const url = process.env.ATLAS_LIVE_SUPABASE_URL
const key = process.env.ATLAS_LIVE_SUPABASE_KEY
if (!url || !key) throw new Error('live_config_missing')

// The live Vitest setup installs an exact-origin network guard before this module loads.
export const liveSupabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: globalThis.fetch.bind(globalThis) }
})
