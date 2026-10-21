import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PartnerCreationTrigger } from './PartnerCreationTrigger'

vi.mock('react-i18next', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-i18next')>()
    return { ...actual }
})

describe('PartnerCreationTrigger', () => {
    it('uses the attached input button styling and forwards its click', () => {
        const onClick = vi.fn()
        const element = PartnerCreationTrigger({
            onClick,
            label: 'Add Business Partner',
        }) as ReactElement<{
            'aria-label': string
            className: string
            onClick: () => void
        }>

        expect(element.props['aria-label']).toBe('Add Business Partner')
        expect(element.props.className).toContain('h-8 w-8')
        expect(element.props.className).toContain('rounded-e-none rounded-s-lg border-e-0')
        element.props.onClick()
        expect(onClick).toHaveBeenCalledOnce()
    })
})
