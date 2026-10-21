import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { PartnerCreationModeControl } from './PartnerCreationModeControl'

vi.mock('react-i18next', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-i18next')>()
    return {
        ...actual,
        useTranslation: () => ({ t: (key: string) => key === 'businessPartners.stopPartnerCreation' ? 'Stop partner creation' : key }),
    }
})

describe('PartnerCreationModeControl', () => {
    it('shows a separate stop action only while partner creation is active', () => {
        const onStop = vi.fn()
        const activeElement = PartnerCreationModeControl({ active: true, onStop })
        const inactiveElement = PartnerCreationModeControl({ active: false, onStop })
        const activeMarkup = renderToStaticMarkup(createElement(() => activeElement))
        const inactiveMarkup = renderToStaticMarkup(createElement(() => inactiveElement))

        expect(activeMarkup).toContain('Stop partner creation')
        expect(activeMarkup).toContain('type="button"')
        expect(inactiveMarkup).toBe('')
        activeElement?.props.children.props.onClick()
        expect(onStop).toHaveBeenCalledOnce()
    })
})
