import 'fake-indexeddb/auto'
import { beforeAll, vi } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'
import { registerFaultScenarios } from './faults/registerFaultScenarios'
vi.mock('@/auth/supabase', () => {
    const forbidden = () => { throw new Error('Local operations must never contact Supabase') }
    return { isSupabaseConfigured: false, supabase: { from: forbidden, schema: () => ({ from: forbidden }), rpc: forbidden } }
})
beforeAll(() => installTestBrowser())
registerFaultScenarios(async configuration => (await import('./fixtures/moduleFixture')).createModuleDriver(configuration))
