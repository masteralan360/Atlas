import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mts'

// Domain fixtures load the real database/domain modules in beforeAll. Keep the
// complete registered file set and allow their existing 120-second setup budget,
// while ordinary individual assertions retain the base 30-second timeout.
export default mergeConfig(base, defineConfig({ test: { hookTimeout: 120_000 } }))
