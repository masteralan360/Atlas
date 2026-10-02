import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { printPosPreprintReceipt } from '@/lib/posPreprintReceipt'

const harness = vi.hoisted(() => ({
    buttons: [] as Array<{ tourId?: string; onClick?: () => unknown }>,
    printReceipt: vi.fn(),
    buildReceiptPdf: vi.fn(),
    triggerInvoiceSync: vi.fn(),
    isAutoPrintUponCheckoutEnabled: vi.fn(),
    printFlow: vi.fn()
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@/ui/components', async () => {
    const React = await import('react')
    const Container = ({ children }: { children?: React.ReactNode }) =>
        React.createElement('div', null, children)

    return {
        Dialog: Container,
        DialogContent: Container,
        DialogTitle: Container,
        Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
            'data-tour-id'?: string
        }) => {
            harness.buttons.push({
                tourId: props['data-tour-id'],
                onClick: props.onClick as (() => unknown) | undefined
            })
            return React.createElement('button', null, children)
        },
        PrintFlow: () => {
            harness.printFlow()
            return null
        }
    }
})

vi.mock('@/auth', () => ({
    useAuth: () => ({ user: { id: 'cashier-1', name: 'Cashier' } })
}))

vi.mock('@/workspace', () => ({
    useWorkspace: () => ({ isLocalMode: true })
}))

vi.mock('@/services/invoiceSyncService', () => ({
    triggerInvoiceSync: harness.triggerInvoiceSync
}))

vi.mock('@/services/printService', () => ({
    printService: { isAutoPrintUponCheckoutEnabled: harness.isAutoPrintUponCheckoutEnabled }
}))

vi.mock('@/ui/components/textarea', async () => {
    const React = await import('react')
    return {
        Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
            React.createElement('textarea', props)
    }
})

vi.mock('@/lib/utils', () => ({
    formatCurrency: () => '12.00',
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')
}))

vi.mock('@/lib/hooks', () => ({ useDebounce: (value: unknown) => value }))
vi.mock('@/auth/supabase', () => ({ supabase: {} }))
vi.mock('@/local-db', () => ({ db: { sales: { update: vi.fn() } } }))
vi.mock('@/lib/supabaseRequest', () => ({
    normalizeSupabaseActionError: (error: unknown) => error,
    runSupabaseAction: vi.fn()
}))
vi.mock('@/lib/customTemplates', () => ({
    SALES_HISTORY_RECEIPT_TEMPLATE_KEY: 'salesHistory.Receipt'
}))
vi.mock('@/ui/components/pos/usePosReceiptPrinter', () => ({
    usePosReceiptPrinter: () => ({
        buildReceiptPdf: harness.buildReceiptPdf,
        isLoadingPrimaryReceiptTemplate: false,
        printFeatures: { print_lang: 'en' },
        printReceipt: harness.printReceipt,
        resolvedWorkspaceName: 'Atlas Test',
        workspaceId: 'workspace-1'
    })
}))

let CheckoutSuccessModal: typeof import('@/ui/components/pos/CheckoutSuccessModal')['CheckoutSuccessModal']

beforeAll(async () => {
    ;({ CheckoutSuccessModal } = await import('@/ui/components/pos/CheckoutSuccessModal'))
})

beforeEach(() => {
    harness.buttons.length = 0
    harness.printReceipt.mockReset().mockResolvedValue(undefined)
    harness.buildReceiptPdf.mockReset().mockResolvedValue(new Blob(['receipt']))
    harness.triggerInvoiceSync.mockReset()
    harness.isAutoPrintUponCheckoutEnabled.mockReset().mockReturnValue(false)
    harness.printFlow.mockReset()
})

describe('POS receipt printing', () => {
    it('prints completed sales and pre-prints directly without opening PrintFlow', async () => {
        renderToStaticMarkup(
            <CheckoutSuccessModal
                isOpen
                onClose={() => undefined}
                saleData={{
                    id: 'sale-1',
                    invoiceid: 'INV-1',
                    total_amount: 12,
                    settlement_currency: 'usd',
                    notes: ''
                }}
                features={{ iqd_display_preference: 'full' } as never}
            />
        )

        const printButton = harness.buttons.find((button) => button.tourId === 'tutorial-pos-print-receipt')
        expect(printButton?.onClick).toBeTypeOf('function')
        await printButton?.onClick?.()

        expect(harness.printFlow).not.toHaveBeenCalled()
        expect(harness.triggerInvoiceSync).toHaveBeenCalledWith(expect.objectContaining({
            saleData: expect.objectContaining({ id: 'sale-1' }),
            format: 'receipt',
            pdfBuilder: expect.any(Function)
        }))
        expect(harness.printReceipt).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Receipt_INV-1',
            pdfBuilder: expect.any(Function)
        }))

        const syncPdfBuilder = harness.triggerInvoiceSync.mock.calls[0][0].pdfBuilder
        const printPdfBuilder = harness.printReceipt.mock.calls[0][0].pdfBuilder
        expect(syncPdfBuilder).toBe(printPdfBuilder)
        await printPdfBuilder()
        expect(harness.buildReceiptPdf).toHaveBeenCalledOnce()

        const preprintPdfBuilder = vi.fn().mockResolvedValue(new Blob(['pre-print']))
        const printPreprint = vi.fn().mockResolvedValue(undefined)
        await printPosPreprintReceipt({
            saleData: { id: 'preview-1', invoiceid: 'PRE-123' },
            pdfBuilder: preprintPdfBuilder,
            printReceipt: printPreprint,
        })
        expect(printPreprint).toHaveBeenCalledOnce()
        expect(printPreprint).toHaveBeenCalledWith({
            title: 'Receipt_PRE-123',
            pdfBuilder: preprintPdfBuilder,
        })
    })
})
