import { describe, expect, it } from 'vitest'

import { isOrderReadOnly } from './orderEditability'

describe('isOrderReadOnly', () => {
    it('keeps new and draft orders editable', () => {
        expect(isOrderReadOnly(undefined)).toBe(false)
        expect(isOrderReadOnly(null)).toBe(false)
        expect(isOrderReadOnly('draft')).toBe(false)
    })

    it.each(['pending', 'ordered', 'received', 'completed', 'cancelled'] as const)(
        'locks a %s order',
        (status) => {
            expect(isOrderReadOnly(status)).toBe(true)
        }
    )
})
