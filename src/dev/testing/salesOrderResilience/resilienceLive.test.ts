import { describe, it } from 'vitest'
import { setupSupabaseLab, createSupabaseDriver } from './fixtures/supabaseFixture'
import { runResilience } from './runner/resilienceRunner'
describe('Sales Order Resilience Lab · authenticated generated integration', () => {
    setupSupabaseLab()
    it('executes generated commands through Atlas with an independent JWT observer', async () => {
        await runResilience(createSupabaseDriver, { maxCommands: 25, path: process.env.SORL_PATH, replayPath: process.env.SORL_REPLAY_PATH })
    }, 3_600_000)
})
