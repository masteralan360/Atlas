import 'fake-indexeddb/auto'
import { beforeAll, describe, it, vi } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'
import { regressionScenarios } from './scenarios/regressionScenarios'

vi.mock('@/auth/supabase', () => {
    const forbidden = () => { throw new Error('ModuleDriver must never contact Supabase') }
    return { isSupabaseConfigured: false, supabase: { from: forbidden, schema: () => ({ from: forbidden }), rpc: forbidden } }
})
describe('Sales Order Resilience Lab · permanent reproductions', () => {
    beforeAll(() => installTestBrowser())
    for (const scenario of regressionScenarios) it(`${scenario.id} ${scenario.description}`, async () => {
        const { createModuleDriver } = await import('./fixtures/moduleFixture')
        const { runSequence } = await import('./runner/resilienceRunner')
        const driver = await createModuleDriver({ currency: 'usd', method: 'cash', account: true })
        try { await runSequence(driver, scenario.actions) } finally { await driver.close() }
    }, 120_000)
})
