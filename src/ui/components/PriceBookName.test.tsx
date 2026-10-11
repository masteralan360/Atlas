import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { PriceBookName } from './PriceBookName'

describe('PriceBookName', () => {
    it('renders the configured color beside the Price Book name', () => {
        const markup = renderToStaticMarkup(<PriceBookName name="Wholesale" color="#12abef" />)

        expect(markup).toContain('Wholesale')
        expect(markup).toContain('style="background-color:#12abef"')
    })

    it('keeps an uncolored Price Book free of a placeholder indicator', () => {
        const markup = renderToStaticMarkup(<PriceBookName name="Standard" color={null} />)

        expect(markup).toContain('Standard')
        expect(markup).not.toContain('background-color')
        expect(markup).not.toContain('No color')
    })
})
