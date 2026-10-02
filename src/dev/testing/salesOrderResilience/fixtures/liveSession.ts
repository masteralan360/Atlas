import { createClient } from '@supabase/supabase-js'
import { readManifest } from './testActor'
import { TransportFaults } from '../faults/transportFaults'

const manifest = readManifest()
export const faults = new TransportFaults()
export const labSupabase = createClient(manifest.url, manifest.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: faults.fetch }
})
