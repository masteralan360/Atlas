import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const mockedLocale = vi.hoisted(() => ({ language: 'en' as 'en' | 'ku' | 'ar' }))

vi.mock('@radix-ui/react-dialog', async () => {
    const React = await import('react')
    const Root = ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children)
    const Primitive = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)
    )
    return {
        Root,
        Trigger: Primitive,
        Portal: Root,
        Close: Primitive,
        Overlay: Primitive,
        Content: Primitive,
        Title: Primitive,
        Description: Primitive,
    }
})

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { defaultValue?: string }) => {
            const translated = {
                en: {
                    'common.dialogInsights': 'Dialog insights',
                    'common.hideDialogInsights': 'Hide insights',
                    'common.showDialogInsights': 'Show insights',
                    'common.dialogInsightPreview': 'Preview',
                },
                ku: {
                    'common.dialogInsights': 'تێڕوانینەکان',
                    'common.hideDialogInsights': 'تێڕوانینەکان بشارەوە',
                    'common.showDialogInsights': 'تێڕوانینەکان پیشان بدە',
                    'common.dialogInsightPreview': 'پێشبینین',
                },
                ar: {
                    'common.dialogInsights': 'رؤى الحوار',
                    'common.hideDialogInsights': 'إخفاء الرؤى',
                    'common.showDialogInsights': 'إظهار الرؤى',
                    'common.dialogInsightPreview': 'معاينة',
                },
            }[mockedLocale.language]
            const loanTranslations: Record<string, string> = {
                'loans.simpleLoanInsightTitle': 'Loan Insight',
                'loans.simpleLoanInsightDescription': 'The full principal is recorded as unpaid.',
                'loans.simpleLoanPreviewLoan': 'The simple loan for {{counterparty}} will be recorded as {{direction}} on {{date}}.',
                'loans.simpleLoanPreviewAmounts': '{{amount}} will be outstanding, with {{paid}} paid; {{due}}',
                'loans.simpleLoanPreviewDueDate': 'the full amount is due on {{date}}.',
                'loans.simpleLoanPreviewNoDueDate': 'no due date is set.',
                'loans.directions.lent': 'Lent',
                'loans.directions.borrowed': 'Borrowed',
                'loans.simpleLoanPreviewIncoming': 'incoming',
                'loans.simpleLoanPreviewOutgoing': 'outgoing',
                'loans.simpleLoanPreviewTransaction': 'The {{movement}} origination for {{amount}} will appear in payment history and the ledger{{accountEffect}}',
                'loans.simpleLoanPreviewAccountIncoming': ', increasing {{account}} by {{amount}}.',
                'loans.simpleLoanPreviewAccountOutgoing': ', decreasing {{account}} by {{amount}}.',
                'loans.simpleLoanPreviewNoAccount': ', with no payment-account movement.',
            }
            const template = translated[key as keyof typeof translated] ?? loanTranslations[key] ?? options?.defaultValue ?? key
            return Object.entries(options ?? {}).reduce((value, [name, replacement]) => (
                value.split(`{{${name}}}`).join(String(replacement))
            ), template)
        },
        i18n: { language: mockedLocale.language, resolvedLanguage: mockedLocale.language },
    }),
}))

vi.mock('@/lib/utils', () => ({
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
    formatCurrency: (amount: number, currency: string) => `${amount.toLocaleString('en-US')} ${currency.toUpperCase()}`,
    formatDate: () => '06/11/26',
    formatDateTime: () => '05/11/26 09:30',
}))

import { AppDialog, AppDialogContent } from './dialog'
import { SimpleLoanDialogInsight, SimpleLoanSavePreview } from './loans/SimpleLoanDialogInsight'
import enLocale from '@/i18n/locales/en.json'
import kuLocale from '@/i18n/locales/ku.json'
import arLocale from '@/i18n/locales/ar.json'

const renderDialog = (
    props: React.ComponentProps<typeof AppDialog> = {},
    desktopViewport = true,
    mainContent: React.ReactNode = <div>Main dialog content</div>
) => {
    vi.stubGlobal('window', {
        matchMedia: () => ({
            matches: desktopViewport,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })

    try {
        return renderToStaticMarkup(
            <AppDialog {...props}>
                <AppDialogContent>{mainContent}</AppDialogContent>
            </AppDialog>
        )
    } finally {
        vi.unstubAllGlobals()
    }
}

describe('dialog insight panel', () => {
    it('keeps the existing dialog layout when insight is not enabled', () => {
        const html = renderDialog()

        expect(html).toContain('Main dialog content')
        expect(html).not.toContain('data-dialog-insight-main')
        expect(html).not.toContain('<aside')
        expect(html).not.toContain('Hide insights')
    })

    it('renders an empty green gradient panel when insight is enabled without customization', () => {
        const html = renderDialog({ showInsight: true })

        expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_20rem]')
        expect(html).toContain('atlas-insight-surface')
        expect(html).toContain('text-white')
        expect(html).not.toContain('lg:border-s')
        expect(html).toContain('aria-hidden="true"')
        expect(html).not.toMatch(/<aside[^>]*aria-label=/)
        expect(html).not.toMatch(/<aside[^>]*bg-muted/)
        expect(html).not.toContain('dialogInsightPreview')
        expect(html).toContain('aria-label="Hide insights"')
        expect(html).toContain('aria-pressed="true"')
    })

    it('treats showInsight as off below the desktop breakpoint', () => {
        const html = renderDialog({ showInsight: true }, false)

        expect(html).toContain('Main dialog content')
        expect(html).not.toContain('data-dialog-insight-main')
        expect(html).not.toContain('<aside')
        expect(html).not.toContain('max-w-5xl')
        expect(html).not.toContain('aria-label="Show insights"')
    })

    it('renders customized color, classes, and supplied dynamic content', () => {
        const Insight = ({ value }: { value: string }) => (
            <div>
                <h3 className="text-lg font-medium">{value}</h3>
                <p className="text-white/85">Insight description</p>
            </div>
        )
        const html = renderDialog(
            {
                showInsight: true,
                insightColor: '#374151',
                insightPanelClassName: 'custom-panel-class',
                insightContent: <Insight value="Current product insight" />,
                insightPreview: <p>After saving, the product price will be 9,000 IQD.</p>,
            },
            true,
            'Main dialog content'
        )

        expect(html).toContain('background-color:#374151')
        expect(html).toContain('bg-none')
        expect(html).toContain('custom-panel-class')
        expect(html).toContain('Current product insight')
        expect(html).toContain('data-dialog-insight-content="true"')
        expect(html).toContain('[&amp;_h3]:text-2xl')
        expect(html).toContain('[&amp;_p]:text-emerald-100/85')
        expect(html).toContain('text-lg font-semibold text-white')
        expect(html).toContain('After saving, the product price will be 9,000 IQD.')
        expect(html).toContain('<h3')
        expect(html).toContain('>Preview</h3>')
        expect(html).toContain('aria-label="Dialog insights"')
        expect(html).toContain('<aside aria-hidden="false"')
    })

    it('renders the simple loan insight and current save outcome on desktop and disables the panel on mobile', () => {
        const insightContent = <SimpleLoanDialogInsight />
        const insightPreview = (
            <SimpleLoanSavePreview
                canSubmit
                counterpartyName="Sam"
                direction="lent"
                principalAmount={1250}
                currency="iqd"
                iqdDisplayPreference="IQD"
                createdAt={new Date(2026, 10, 5, 9, 30)}
                dueDate={new Date(2026, 10, 6)}
                paymentAccountName="Cash Drawer"
            />
        )
        const desktopHtml = renderDialog({ showInsight: true, insightContent, insightPreview }, true, 'Loan form')

        expect(desktopHtml).toContain('Loan Insight')
        expect(desktopHtml).toContain('The full principal is recorded as unpaid.')
        expect(desktopHtml).toContain('text-2xl font-semibold')
        expect(desktopHtml).toContain('text-emerald-100/85')
        expect(desktopHtml).toContain('leading-relaxed text-white/95')
        expect(desktopHtml).toContain('text-lg font-semibold text-white')
        expect(desktopHtml).toContain('The simple loan for Sam will be recorded as Lent on 05/11/26 09:30.')
        expect(desktopHtml).toContain('1,250 IQD will be outstanding, with 0 IQD paid; the full amount is due on 06/11/26.')
        expect(desktopHtml).toContain('The outgoing origination for 1,250 IQD will appear in payment history and the ledger, decreasing Cash Drawer by 1,250 IQD.')
        expect(desktopHtml).not.toContain('Partner Co')
        expect(desktopHtml).not.toContain('Personal loan')
        expect(desktopHtml).toContain('>Preview</h3>')

        const mobileHtml = renderDialog({ showInsight: true, insightContent, insightPreview }, false, 'Loan form')
        expect(mobileHtml).toContain('Loan form')
        expect(mobileHtml).not.toContain('Loan Insight')
        expect(mobileHtml).not.toContain('decreasing Cash Drawer by 1,250 IQD.')
        expect(mobileHtml).not.toContain('<aside')
    })

    it.each([
        ['en', 'Preview', enLocale.common.dialogInsightPreview],
        ['ku', 'پێشبینی', kuLocale.common.dialogInsightPreview],
        ['ar', 'معاينة', arLocale.common.dialogInsightPreview],
    ] as const)('localizes the preview heading in %s', (locale, expectedLabel, localeLabel) => {
        mockedLocale.language = locale
        try {
            const html = renderDialog({
                showInsight: true,
                insightPreview: <p>Changes that will be saved.</p>,
            })

            expect(localeLabel).toBe(expectedLabel)
            expect(html).toContain(expectedLabel)
        } finally {
            mockedLocale.language = 'en'
        }
    })
})
