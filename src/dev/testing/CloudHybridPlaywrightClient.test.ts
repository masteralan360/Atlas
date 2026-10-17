import { describe, expect, it } from 'vitest'
import { normalizeCloudHybridScenarioMode } from './CloudHybridPlaywrightClient'

describe('Cloud Hybrid Playwright run mode', () => {
    it('treats the Run All button’s omitted mode as all scenarios', () => {
        expect(normalizeCloudHybridScenarioMode()).toBe('all')
    })

    it('preserves explicit selected-run modes', () => {
        expect(normalizeCloudHybridScenarioMode('from')).toBe('from')
        expect(normalizeCloudHybridScenarioMode('only')).toBe('only')
        expect(normalizeCloudHybridScenarioMode('all')).toBe('all')
    })
})
