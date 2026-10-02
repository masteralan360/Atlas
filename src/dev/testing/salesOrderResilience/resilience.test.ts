import 'fake-indexeddb/auto'
import { beforeAll, describe, it, vi } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'

vi.mock('@/auth/supabase', () => {
    const forbidden = () => { throw new Error('ModuleDriver must never contact Supabase') }
    return { isSupabaseConfigured: false, supabase: { from: forbidden, schema: () => ({ from: forbidden }), rpc: forbidden } }
})

describe('Sales Order Resilience Lab · generated module sequences', () => {
    beforeAll(() => installTestBrowser())
    it('checks independent business invariants after every valid generated action', async () => {
        const { createModuleDriver } = await import('./fixtures/moduleFixture')
        const { runResilience } = await import('./runner/resilienceRunner')
        await runResilience(createModuleDriver, { path: process.env.SORL_PATH, replayPath: process.env.SORL_REPLAY_PATH })
    }, 600_000)
})
