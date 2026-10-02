import { it } from 'vitest'
import { createSupabaseDriver, setupSupabaseLab } from './supabaseFixture'
setupSupabaseLab()
it('provisions the browser catalog through normal authenticated Atlas module calls', async () => {
    const driver = await createSupabaseDriver({ currency: 'usd', method: 'cash', account: false })
    await driver.close()
})
