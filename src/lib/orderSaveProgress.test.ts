import { describe, expect, it } from 'vitest'

import {
    createRemoteOrderSaveConfirmationError,
    isRemoteOrderSaveConfirmationError,
    ORDER_SAVE_PROGRESS
} from './orderSaveProgress'

describe('order save progress', () => {
    it('reports ordered, bounded percentage stages through remote confirmation', () => {
        const reports = Object.values(ORDER_SAVE_PROGRESS)

        expect(reports.map((report) => report.fraction)).toEqual([0.1, 0.3, 0.6, 0.85, 1])
        expect(reports.map((report) => report.stageKey)).toEqual([
            'orders.form.saveProgressPreparing',
            'orders.form.saveProgressPayment',
            'orders.form.saveProgressSaving',
            'orders.form.saveProgressConfirming',
            'orders.form.saveProgressComplete'
        ])
    })

    it('marks remote acknowledgement failures without exposing a technical message to the form', () => {
        const error = createRemoteOrderSaveConfirmationError(new Error('network unavailable'))

        expect(isRemoteOrderSaveConfirmationError(error)).toBe(true)
        expect(isRemoteOrderSaveConfirmationError(new Error('network unavailable'))).toBe(false)
    })
})
