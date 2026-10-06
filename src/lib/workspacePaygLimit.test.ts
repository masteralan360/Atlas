import { describe, expect, it } from 'vitest'
import type { WorkspacePaygLimitState } from './workspacePayments'
import {
    getWorkspacePaygMetricCurrentValue,
    isWorkspacePaygLimitThresholdValid
} from './workspacePaygLimit'

const lockedState: WorkspacePaygLimitState = {
    workspaceId: 'workspace-1',
    billingWorkspaceId: 'workspace-1',
    enabled: true,
    hasLimit: true,
    locked: true,
    limit: {
        metric: 'accrued_charge',
        threshold: '50',
        currentValue: '53.42',
        locked: true,
        createdAt: null,
        updatedAt: null
    },
    metrics: {
        accrued_charge: '53.42',
        changed_usage: '12.5'
    }
}

describe('workspace PAYG limit threshold validation', () => {
    it('requires a locked limit replacement to exceed the selected current metric', () => {
        expect(isWorkspacePaygLimitThresholdValid({
            value: '53.42',
            metric: 'accrued_charge',
            state: lockedState
        })).toBe(false)
        expect(isWorkspacePaygLimitThresholdValid({
            value: '54',
            metric: 'accrued_charge',
            state: lockedState
        })).toBe(true)
        expect(isWorkspacePaygLimitThresholdValid({
            value: '13',
            metric: 'changed_usage',
            state: lockedState
        })).toBe(true)
    })

    it('rejects empty and non-positive limits while preserving decimal thresholds', () => {
        expect(isWorkspacePaygLimitThresholdValid({ value: '', metric: 'accrued_charge' })).toBe(false)
        expect(isWorkspacePaygLimitThresholdValid({ value: '0', metric: 'changed_usage' })).toBe(false)
        expect(isWorkspacePaygLimitThresholdValid({ value: '53.43', metric: 'accrued_charge' })).toBe(true)
        expect(isWorkspacePaygLimitThresholdValid({ value: '1,000', metric: 'accrued_charge' })).toBe(true)
    })

    it('reads the existing metric source without recomputing usage', () => {
        expect(getWorkspacePaygMetricCurrentValue(lockedState, 'changed_usage')).toBe(12.5)
        expect(getWorkspacePaygMetricCurrentValue(null, 'accrued_charge')).toBe(0)
    })
})
