import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/auth', () => ({
    useOptionalAuth: () => null
}))

import { Input } from './input'
import { NumericInput } from './ui/numeric-input'

describe('numeric input digit rendering', () => {
    it('renders native number props as a Latin-digit text input with a numeric keyboard', () => {
        const markup = renderToStaticMarkup(<Input type="number" value="123" onChange={() => undefined} />)

        expect(markup).toContain('type="text"')
        expect(markup).toContain('inputMode="numeric"')
        expect(markup).toContain('lang="en"')
        expect(markup).not.toContain('dir="ltr"')
    })

    it('locks text inputs with a numeric keyboard to Latin-digit rendering', () => {
        const markup = renderToStaticMarkup(<Input type="text" inputMode="decimal" value="123.45" onChange={() => undefined} />)

        expect(markup).toContain('inputMode="decimal"')
        expect(markup).toContain('lang="en"')
        expect(markup).not.toContain('dir="ltr"')
    })

    it('keeps decimal entry available when a numeric field accepts a fractional step', () => {
        const markup = renderToStaticMarkup(<Input type="number" step="0.01" value="123.45" onChange={() => undefined} />)

        expect(markup).toContain('type="text"')
        expect(markup).toContain('inputMode="decimal"')
    })

    it('gives reusable numeric inputs a numeric keyboard, Latin-digit locale, and LTR direction', () => {
        const markup = renderToStaticMarkup(<NumericInput value="1234.45" onValueChange={() => undefined} />)

        expect(markup).toContain('inputMode="decimal"')
        expect(markup).toContain('lang="en"')
        expect(markup).toContain('dir="ltr"')
        expect(markup).toContain('value="1,234.45"')
    })

    it('preserves an explicitly provided writing direction', () => {
        const markup = renderToStaticMarkup(<Input type="number" dir="rtl" value="123" onChange={() => undefined} />)

        expect(markup).toContain('lang="en"')
        expect(markup).toContain('dir="rtl"')
    })

    it('does not impose an English locale on ordinary text fields', () => {
        const markup = renderToStaticMarkup(<Input value="العربية" onChange={() => undefined} />)

        expect(markup).not.toContain('lang="en"')
        expect(markup).not.toContain('dir="ltr"')
    })
})
