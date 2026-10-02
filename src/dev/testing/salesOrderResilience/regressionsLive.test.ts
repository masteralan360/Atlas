import { describe, it } from 'vitest'
import { setupSupabaseLab, createSupabaseDriver } from './fixtures/supabaseFixture'
import { runSequence } from './runner/resilienceRunner'
import { regressionScenarios } from './scenarios/regressionScenarios'
describe('Sales Order Resilience Lab · persisted reproductions', () => {
    setupSupabaseLab()
    for (const scenario of regressionScenarios) it(`${scenario.id} ${scenario.description}`, async () => {
        const driver = await createSupabaseDriver({ currency: 'usd', method: 'cash', account: true })
        try { await runSequence(driver, scenario.actions) } finally { await driver.close() }
    })
})
