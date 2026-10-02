import { setupSupabaseLab, createSupabaseDriver } from './fixtures/supabaseFixture'
import { registerFaultScenarios } from './faults/registerFaultScenarios'
setupSupabaseLab()
registerFaultScenarios(createSupabaseDriver)
