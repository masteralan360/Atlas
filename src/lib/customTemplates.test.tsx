import { beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/services/pdfGenerator', () => ({
    generateTemplatePdf: vi.fn()
}))
vi.mock('@/services/platformService', () => ({
    platformService: {
        convertFileSrc: (path: string) => path
    }
}))
vi.mock('@/ui/components/real-estate/RealEstateBuyPrintTemplate', () => ({
    RealEstateBuyPrintTemplate: () => null
}))
vi.mock('@/ui/components/SaleReceipt', () => ({
    SALE_RECEIPT_TEMPLATE_FIELD_KEYS: {
        showExchangeRateSnapshots: 'showExchangeRateSnapshots',
        showOriginalCurrencyPrice: 'showOriginalCurrencyPrice',
        showTableNumber: 'showTableNumber',
        showNotes: 'showNotes',
        notesFontSize: 'notesFontSize',
        thankYou: 'thankYou',
        keepRecord: 'keepRecord',
        labelOpacity: 'labelOpacity'
    },
    RECEIPT_MOVABLE_COMPONENT_KEYS: {
        logo: 'receiptLogo',
        workspaceName: 'receiptWorkspaceName',
        qrCode: 'receiptQrCode',
        date: 'receiptDate',
        saleId: 'receiptSaleId',
        tableNumber: 'receiptTableNumber',
        cashier: 'receiptCashier',
        paymentMethod: 'receiptPaymentMethod',
        exchangeRateSnapshots: 'receiptExchangeRateSnapshots',
        itemsTable: 'receiptItemsTable',
        total: 'receiptTotal',
        notes: 'receiptNotes',
        thankYou: 'receiptThankYou',
        keepRecord: 'receiptKeepRecord'
    },
    SaleReceiptBase: () => null
}))
vi.mock('@/ui/components/ModernA4InvoiceTemplate', () => ({
    ModernA4InvoiceTemplate: () => null
}))
vi.mock('@/ui/components/ProfessionalA4InvoiceTemplate', () => ({
    ProfessionalA4InvoiceTemplate: () => null,
    PROFESSIONAL_A4_TABLE_ROW_COUNT: 10,
    PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS: {
        logo: 'logo',
        qrCode: 'qrCode',
        workspaceName: 'workspaceName',
        title: 'title',
        subtitle: 'subtitle',
        customer: 'customer',
        saleSummary: 'saleSummary',
        created: 'created',
        payment: 'payment',
        itemsTable: 'itemsTable',
        totals: 'totals',
        terms: 'terms',
        exchangeRates: 'exchangeRates',
        contacts: 'contacts',
        generatedBy: 'generatedBy',
        notes: 'notes'
    }
}))

let customTemplates: typeof import('@/lib/customTemplates')
let ProfessionalA4InvoiceTemplate: typeof import('@/ui/components/ProfessionalA4InvoiceTemplate')['ProfessionalA4InvoiceTemplate']
let PartnerDetailsPrintTemplate: typeof import('@/ui/components/crm/PartnerDetailsPrintTemplate')['PartnerDetailsPrintTemplate']
let PartnerOrderItemsPrintTemplate: typeof import('@/ui/components/crm/PartnerOrderItemsPrintTemplate')['PartnerOrderItemsPrintTemplate']
let OrderDetailsPrintTemplate: typeof import('@/ui/components/orders/OrderPrintTemplates')['OrderDetailsPrintTemplate']
let OrderReceiptPrintTemplate: typeof import('@/ui/components/orders/OrderPrintTemplates')['OrderReceiptPrintTemplate']

beforeAll(async () => {
    vi.stubGlobal('window', {
        location: { hash: '' },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
    })
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    })
    vi.stubGlobal('document', {
        dir: '',
        documentElement: {
            lang: '',
            dir: ''
        }
    })

    customTemplates = await import('@/lib/customTemplates')
    ;({ ProfessionalA4InvoiceTemplate } = await import('@/ui/components/ProfessionalA4InvoiceTemplate'))
    ;({ PartnerDetailsPrintTemplate } = await import('@/ui/components/crm/PartnerDetailsPrintTemplate'))
    ;({ PartnerOrderItemsPrintTemplate } = await import('@/ui/components/crm/PartnerOrderItemsPrintTemplate'))
    ;({ OrderDetailsPrintTemplate, OrderReceiptPrintTemplate } = await import('@/ui/components/orders/OrderPrintTemplates'))
}, 30_000)

describe('Sales History custom A4 templates', () => {
    it('registers every native A4 sales history target, including Atlas Standard and its return version', () => {
        expect(customTemplates.SALES_HISTORY_A4_TEMPLATE_KEYS).toEqual([
            customTemplates.SALES_HISTORY_MODERN_A4_TEMPLATE_KEY,
            customTemplates.SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY,
            customTemplates.SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
            customTemplates.SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
        ])

        const professionalTarget = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY)

        expect(professionalTarget).toMatchObject({
            moduleTypeKey: customTemplates.SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY,
            workspaceModuleKey: 'sales_history',
            typeLabel: 'Professional A4 Print',
            nativeTemplateAvailable: true,
            printFormat: 'a4',
            page: {
                widthMm: 210,
                heightMm: 297
            }
        })
    })

    it('uses the professional A4 layout with movable components', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const componentPositions = {
            itemsTable: { x: 4, y: 8 },
            totals: { x: -6, y: 3 }
        }
        const hiddenFields = {
            'professional.saleSummary.soldBy': true
        }
        const onComponentPositionChange = vi.fn()
        const onHiddenFieldChange = vi.fn()
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en',
            productImageUrls: { 'sample-product': 'https://example.test/products/sample.png' }
        })
        const element = preview.createElement({
            hideUnit: 'true',
            hideDiscount: 'true',
            productImageSizeMm: '9'
        }, undefined, undefined, {
            editableComponents: true,
            componentPositions,
            hiddenFields,
            onComponentPositionChange,
            onHiddenFieldChange
        })

        expect(preview.fields).toEqual([
            expect.objectContaining({ key: 'hideUnit', value: 'false', type: 'boolean' }),
            expect.objectContaining({ key: 'hideDiscount', value: 'false', type: 'boolean' }),
            expect.objectContaining({ key: 'showProductImages', value: 'true', type: 'boolean' }),
            expect.objectContaining({ key: 'productImageSizeMm', value: '5', type: 'range', min: 5, max: 16, step: 0.5, unit: ' mm' }),
            expect.objectContaining({ key: 'showNotes', value: 'false', type: 'boolean' }),
            expect.objectContaining({ key: 'tableRowCount', value: '10', type: 'number' })
        ])
        expect(preview.movableComponents?.map((component) => component.key)).toEqual([
            'logo',
            'qrCode',
            'workspaceName',
            'title',
            'subtitle',
            'customer',
            'saleSummary',
            'created',
            'payment',
            'itemsTable',
            'totals',
            'terms',
            'exchangeRates',
            'contacts',
            'generatedBy',
            'notes'
        ])
        expect(preview.fixedPrintLang).toBe('en')
        expect(element.type).toBe(ProfessionalA4InvoiceTemplate)
        expect(element.props.workspaceName).toBe('Atlas Test')
        expect(element.props.hideUnit).toBe(true)
        expect(element.props.hideDiscount).toBe(true)
        expect(element.props.showProductImages).toBe(true)
        expect(element.props.productImageSizeMm).toBe(9)
        expect(element.props.productImageUrls).toEqual({ 'sample-product': 'https://example.test/products/sample.png' })
        expect(element.props.componentPositions).toBe(componentPositions)
        expect(element.props.hiddenFields).toBe(hiddenFields)
        expect(element.props.editableComponents).toBe(true)
        expect(element.props.onComponentPositionChange).toBe(onComponentPositionChange)
        expect(element.props.onHiddenFieldChange).toBe(onHiddenFieldChange)
    })
})

describe('Sales and Instant History receipt custom print templates', () => {
    it('keeps Instant History notes on by default and makes Sales History notes optional with a size control', () => {
        const salesTarget = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_RECEIPT_TEMPLATE_KEY)
        const instantTarget = customTemplates.getCustomTemplateTarget(customTemplates.INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY)

        expect(instantTarget).toMatchObject({
            moduleTypeKey: customTemplates.INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY,
            workspaceModuleKey: 'instant_pos',
            moduleLabel: 'Instant History',
            typeLabel: 'Receipt Print',
            nativeTemplateAvailable: true,
            printFormat: 'receipt',
            page: { widthMm: 80, heightMm: 200 }
        })

        expect(salesTarget).toBeDefined()
        expect(instantTarget).toBeDefined()

        const salesPreview = customTemplates.createCustomTemplatePreview(salesTarget!, { printLang: 'en' })
        const instantPreview = customTemplates.createCustomTemplatePreview(instantTarget!, { printLang: 'en' })

        expect(salesPreview.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'showNotes', value: 'false', type: 'boolean' }),
            expect.objectContaining({
                key: 'notesFontSize',
                value: '12',
                type: 'range',
                min: 8,
                max: 24,
                step: 1,
                unit: ' px'
            })
        ]))
        expect(instantPreview.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'showTableNumber', value: 'true', type: 'boolean' }),
            expect.objectContaining({ key: 'showNotes', value: 'true', type: 'boolean' })
        ]))
        expect(instantPreview.fields.some((field) => field.key === 'notesFontSize')).toBe(false)
        expect(instantPreview.movableComponents).toEqual([
            ...salesPreview.movableComponents!.slice(0, 5),
            expect.objectContaining({ key: 'receiptTableNumber', label: 'Table Number' }),
            ...salesPreview.movableComponents!.slice(5)
        ])
        const salesPreviewElement = salesPreview.createElement({}, 'sales-receipt-preview') as any
        const previewElement = instantPreview.createElement({}, 'instant-receipt-preview') as any
        expect(salesPreviewElement.props.children.props.defaultShowNotes).toBe(false)
        expect(previewElement.props.children.props.data.table_number).toBe('12')
        expect(previewElement.props.children.props.defaultShowNotes).toBe(true)
        expect(instantPreview.page).toEqual(salesPreview.page)
    })
})

describe('Partner Details custom print template', () => {
    it('stores and validates the resolved workspace print language', () => {
        const layout = customTemplates.stampCustomTemplatePrintLanguage({
            version: 1,
            moduleTypeKey: customTemplates.PARTNER_DETAILS_TEMPLATE_KEY,
            page: { widthMm: 210, heightMm: 297 },
            fields: {},
            annotations: [],
            texts: [],
            images: [],
            shapes: [],
            updatedAt: new Date().toISOString()
        }, 'auto', 'ar-IQ')
        const row = {
            id: 'arabic-partner-template',
            module_type_key: customTemplates.PARTNER_DETAILS_TEMPLATE_KEY,
            layout_json: layout
        }

        expect(layout.printLanguage).toBe('ar')
        expect(customTemplates.getStoredCustomTemplatePrintLanguage(row)).toBe('ar')
        expect(customTemplates.isCustomTemplatePrintLanguageCompatible(row, 'ar')).toBe(true)
        expect(customTemplates.isCustomTemplatePrintLanguageCompatible(row, 'en')).toBe(false)
    })

    it('treats legacy templates without a saved print language as incompatible', () => {
        const row = {
            id: 'legacy-template',
            module_type_key: customTemplates.PARTNER_DETAILS_TEMPLATE_KEY,
            layout_json: {
                version: 1,
                moduleTypeKey: customTemplates.PARTNER_DETAILS_TEMPLATE_KEY,
                page: { widthMm: 210, heightMm: 297 },
                fields: {},
                annotations: [],
                texts: [],
                images: [],
                shapes: [],
                updatedAt: new Date().toISOString()
            }
        }

        expect(customTemplates.getStoredCustomTemplatePrintLanguage(row)).toBeNull()
        expect(customTemplates.isCustomTemplatePrintLanguageCompatible(row, 'en')).toBe(false)
    })

    it('registers an A4 CRM template target', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_DETAILS_TEMPLATE_KEY)

        expect(target).toMatchObject({
            moduleTypeKey: customTemplates.PARTNER_DETAILS_TEMPLATE_KEY,
            workspaceModuleKey: 'crm',
            nativeTemplateAvailable: true,
            printFormat: 'a4',
            page: {
                widthMm: 210,
                heightMm: 297
            }
        })
    })

    it('uses the native Partner Details A4 layout with section toggles', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en'
        })
        const element = preview.createElement({})

        expect(preview.fields).toEqual([
            expect.objectContaining({
                key: customTemplates.PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showWhoOwesWhom,
                value: 'true',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: customTemplates.PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showOrders,
                value: 'false',
                type: 'boolean'
            })
        ])
        expect(preview.page).toEqual({
            widthMm: 210,
            heightMm: 297
        })
        expect(preview.fixedPrintLang).toBe('en')
        expect(preview.movableComponents).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'partnerDetailsLogo', label: 'Workspace Logo' }),
            expect.objectContaining({ key: 'partnerDetailsBusinessPartnerCard', label: 'Business Partner Card' }),
            expect.objectContaining({ key: 'partnerDetailsFinancialSummary', label: 'Financial Summary' }),
            expect.objectContaining({ key: 'partnerDetailsProvidedByYou', label: 'Provided by You Table' }),
            expect.objectContaining({ key: 'partnerDetailsOrdersHeader', label: 'Show the Orders Header' }),
            expect.objectContaining({ key: 'partnerDetailsPurchaseOrders', label: 'Purchases Table' })
        ]))
        expect(element.type).toBe(PartnerDetailsPrintTemplate)
        expect(element.props.workspaceName).toBe('Atlas Test')
        expect(element.props.printLang).toBe('en')
        expect(element.props.showWhoOwesWhom).toBe(true)
        expect(element.props.showOrders).toBe(false)
    })

    it('uses a high-contrast order-items layout with a movable, scalable workspace name', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_ORDER_ITEMS_TEMPLATE_KEY)
        expect(target).toMatchObject({
            workspaceModuleKey: 'crm',
            nativeTemplateAvailable: true,
            printFormat: 'a4'
        })

        const onComponentPositionChange = vi.fn()
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en'
        })
        const element = preview.createElement({}, undefined, undefined, {
            editableComponents: true,
            componentPositions: {
                partnerOrderItemsWorkspaceName: { x: 4, y: 2, scale: 1.25 }
            },
            onComponentPositionChange
        })
        const html = renderToStaticMarkup(element)

        expect(preview.movableComponents).toEqual([
            { key: 'partnerOrderItemsWorkspaceName', label: 'Workspace Name' }
        ])
        expect(preview.fields.map((field) => field.key)).toEqual(['showPaidAmount', 'showRemainingAmount', 'showSettlementActivity'])
        expect(element.type).toBe(PartnerOrderItemsPrintTemplate)
        expect(element.props.componentPositions.partnerOrderItemsWorkspaceName).toEqual({ x: 4, y: 2, scale: 1.25 })
        expect(element.props.onComponentPositionChange).toBe(onComponentPositionChange)
        expect(element.props.showPaidAmount).toBe(true)
        expect(element.props.showRemainingAmount).toBe(true)
        expect(element.props.showSettlementActivity).toBe(true)
        expect(html).toContain('Partner Order Items Statement')
        expect(html).toContain('order-template-scale-handle')
        expect(html).toContain('scale(1.25)')
        expect(html).toContain('text-black')
        expect(html).not.toContain('text-slate-500')
    })

    it('passes the paid/remaining toggles to the order-items template', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_ORDER_ITEMS_TEMPLATE_KEY)
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en'
        })

        const element = preview.createElement({
            showPaidAmount: 'false',
            showRemainingAmount: 'true',
            showSettlementActivity: 'false'
        })

        expect(element.props.showPaidAmount).toBe(false)
        expect(element.props.showRemainingAmount).toBe(true)
        expect(element.props.showSettlementActivity).toBe(false)
    })

    it('renders the focused loan summary, cash flow, and two activity tables', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en'
        })
        const html = renderToStaticMarkup(preview.createElement({}))

        expect(html).toContain('Remaining Receivable Loans')
        expect(html).toContain('Remaining Payable Loans')
        expect(html).toContain('Loan Payment Received By Us')
        expect(html).toContain('Loan Payment Made to the Partner')
        expect(html).toContain('Incoming Cash')
        expect(html).toContain('Outgoing Cash')
        expect(html).toContain('Net Flow')
        expect(html).toContain('Provided by you')
        expect(html).toContain('Provided by partner')
        expect(html).not.toContain('Unified Activity Timeline')
        expect(html).not.toContain('Average Document')
    })

    it('renders the optional orders back page when enabled', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.PARTNER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en'
        })
        const html = renderToStaticMarkup(preview.createElement({
            [customTemplates.PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showWhoOwesWhom]: 'false',
            [customTemplates.PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showOrders]: 'true'
        }))

        expect(html).not.toContain('Who owes whom?')
        expect(html).toContain('Partner Orders')
        expect(html).toContain('Sales from Atlas Test to Sample Business Partner')
        expect(html).toContain('Purchases supplied by Sample Business Partner to Atlas Test')
        expect(html).toContain('SO-00042')
        expect(html).toContain('PO-00019')
        expect(html).toContain('page-break-before:always')
        expect(html).toContain('data-order-print-component="partnerDetailsOrdersHeader"')
        expect(html).toContain('data-order-print-component="partnerDetailsSalesOrders"')
        expect(html).toContain('data-order-print-component="partnerDetailsPurchaseOrders"')
    })
})

describe('Order Details custom print template', () => {
    it('registers an A4 CRM order target', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)

        expect(target).toMatchObject({
            moduleTypeKey: customTemplates.ORDER_DETAILS_TEMPLATE_KEY,
            workspaceModuleKey: 'crm',
            nativeTemplateAvailable: true,
            printFormat: 'a4',
            page: {
                widthMm: 210,
                heightMm: 297
            }
        })
    })

    it('uses the native order A4 layout with print visibility toggles', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'ku',
            counterpartyPhone: '+964 750 123 4567',
            counterpartyAddress: '100 Example Street, Erbil'
        })
        const componentPositions = {
            customer: { x: 12, y: -4 },
            orderItems: { x: 0, y: 20 },
            totals: { x: -8, y: 12 }
        }
        const hiddenFields = {
            'orders.commercials.outstanding': true
        }
        const onComponentPositionChange = vi.fn()
        const onHiddenFieldChange = vi.fn()
        const element = preview.createElement({
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideUnit]: 'true',
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideDiscount]: 'true',
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.boldAllText]: 'true',
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.labelOpacity]: '37'
        }, undefined, undefined, {
            editableComponents: true,
            componentPositions,
            hiddenFields,
            onComponentPositionChange,
            onHiddenFieldChange
        })

        expect(preview.fields).toEqual([
            expect.objectContaining({
                key: customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideUnit,
                value: 'false',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideDiscount,
                value: 'false',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.showOrderAdjustments,
                value: 'true',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.boldAllText,
                value: 'false',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: 'tableRowCount',
                value: '10',
                type: 'number'
            }),
            expect.objectContaining({
                key: customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.labelOpacity,
                value: '50',
                type: 'number'
            })
        ])
        expect(preview.movableComponents?.map((component) => component.key)).toEqual([
            'customer',
            'commercials',
            'created',
            'expectedDelivery',
            'orderItems',
            'totals',
            'logo',
            'qrCode',
            'workspaceName',
            'title',
            'subtitle',
            'contacts',
            'notes'
        ])
        expect(preview.fixedPrintLang).toBe('ku')
        expect(element.type).toBe(OrderDetailsPrintTemplate)
        expect(element.props.workspaceName).toBe('Atlas Test')
        expect(element.props.printLang).toBe('ku')
        expect(element.props.order.orderNumber).toBe('SO-00042')
        expect(element.props.kind).toBe('sales')
        expect(element.props.counterpartyPhone).toBe('+964 750 123 4567')
        expect(element.props.counterpartyAddress).toBe('100 Example Street, Erbil')
        expect(element.props.hideUnit).toBe(true)
        expect(element.props.hideDiscount).toBe(true)
        expect(element.props.templateFields).toEqual(expect.objectContaining({
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.boldAllText]: 'true',
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.labelOpacity]: '37'
        }))
        expect(element.props.componentPositions).toBe(componentPositions)
        expect(element.props.hiddenFields).toBe(hiddenFields)
        expect(element.props.editableComponents).toBe(true)
        expect(element.props.onComponentPositionChange).toBe(onComponentPositionChange)
        expect(element.props.onHiddenFieldChange).toBe(onHiddenFieldChange)

        const html = renderToStaticMarkup(element)
        expect(html.match(/data-order-print-component=/g)).toHaveLength(12)
        expect(html).toContain('data-print-preview-editor-isolate-components="true"')
        expect(html).toContain('data-order-print-component="customer"')
        expect(html).toContain('translate(12mm, -4mm)')
        expect(html).toContain('aria-label="Move ')
        expect(html).toContain('data-order-print-component="orderItems"')
        expect(html).toContain('data-order-print-component="totals"')
        expect(html).toContain('data-print-preview-editor-page-break-mode="transform"')
        expect(html).toContain('+964 750 123 4567')
        expect(html).toContain('100 Example Street, Erbil')
        expect(html).toContain('font-bold [&amp;_*]:!font-bold')
        expect(html.match(/opacity:0\.37/g)).toHaveLength(9)
    })

    it('shows the current product unit for legacy order lines when units are not hidden', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const sampleOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const legacyOrder = {
            ...sampleOrder,
            items: sampleOrder.items.map(({ unit: _unit, ...item }: typeof sampleOrder.items[number]) => item)
        }
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: legacyOrder,
            productUnits: { 'sample-product': 'pcs' }
        })
        const html = renderToStaticMarkup(preview.createElement({
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideUnit]: 'false'
        }))

        expect(html).toContain('2 pcs')
    })

    it('highlights returned lines in the legacy A4 custom layout', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const html = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                items: [{
                    ...baseOrder.items[0],
                    quantity: 3,
                    lineTotal: 75,
                    convertedUnitPrice: 25,
                    returnedQuantity: 1
                }]
            }
        }).createElement({}))

        expect(html).toContain('data-order-print-return-state="partially-returned"')
        expect(html).toContain('background-color:#fef3c7')
        expect(html).toContain('>3 pcs</span><span')
        expect(html).toContain('>2 pcs</span>')
        expect(html).toContain('>$75</span><span')
        expect(html).toContain('>$50</span>')
    })

    it('prints each order adjustment as a labelled product-table row', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                orderAdjustments: [{
                    id: 'delivery-adjustment',
                    type: 'addition',
                    name: 'Delivery',
                    currency: 'usd',
                    amount: 5,
                    orderCurrency: 'usd',
                    convertedAmount: 5,
                    exchangeRate: 1,
                    exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                    exchangeRates: []
                }]
            }
        })
        const html = renderToStaticMarkup(preview.createElement({}))
        const hiddenHtml = renderToStaticMarkup(preview.createElement({
            [customTemplates.ORDER_DETAILS_TEMPLATE_FIELD_KEYS.showOrderAdjustments]: 'false'
        }))

        expect(html).toContain('data-order-print-row-type="adjustment"')
        expect(html).toContain('Delivery')
        expect(html).toContain('+$5')
        expect(hiddenHtml).not.toContain('data-order-print-row-type="adjustment"')
    })

    it('preserves movable component positions, hidden fields, field orders, and field titles when reading a saved layout', () => {
        const componentPositions = {
            customer: { x: 10, y: 5 },
            commercials: { x: -6, y: 8 }
        }
        const hiddenFields = {
            'orders.commercials.paidAmount': true
        }
        const fieldOrders = {
            'orders.commercials': ['orders.commercials.notes', 'orders.commercials.paidAmount']
        }
        const fieldLabelOverrides = {
            'orders.commercials.paidAmount': 'Received'
        }
        const layout = customTemplates.readCustomTemplateLayout({
            id: 'movable-order-template',
            module_type_key: customTemplates.ORDER_DETAILS_TEMPLATE_KEY,
            layout_json: {
                version: 1,
                moduleTypeKey: customTemplates.ORDER_DETAILS_TEMPLATE_KEY,
                page: { widthMm: 210, heightMm: 297 },
                fields: {},
                componentPositions,
                hiddenFields,
                fieldOrders,
                fieldLabelOverrides,
                annotations: [],
                texts: [],
                images: [],
                shapes: [],
                updatedAt: new Date().toISOString()
            }
        })

        expect(layout?.componentPositions).toEqual(componentPositions)
        expect(layout?.hiddenFields).toEqual(hiddenFields)
        expect(layout?.fieldOrders).toEqual(fieldOrders)
        expect(layout?.fieldLabelOverrides).toEqual(fieldLabelOverrides)
    })

    it('applies saved component positions to the printable custom layout without editor controls', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_DETAILS_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const html = renderToStaticMarkup(customTemplates.renderCustomTemplateLayoutElement({
            target: target!,
            layout: {
                version: 1,
                moduleTypeKey: customTemplates.ORDER_DETAILS_TEMPLATE_KEY,
                page: { widthMm: 210, heightMm: 297 },
                fields: {},
                componentPositions: {
                    orderItems: { x: 7, y: 15 },
                    totals: { x: -4, y: 9 }
                },
                annotations: [],
                texts: [{
                    id: 'phone-number',
                    text: '0770 199 0012',
                    x: 20,
                    y: 30,
                    width: 45,
                    rotation: 0
                }],
                images: [],
                shapes: [{
                    id: 'printed-shape',
                    kind: 'star',
                    color: '#7c3aed',
                    x: 80,
                    y: 40,
                    width: 25,
                    rotation: 15,
                    layer: 'behind-template'
                }],
                updatedAt: new Date().toISOString()
            },
            values: {},
            options: {
                workspaceName: 'Atlas Test',
                printLang: 'ku'
            }
        }))

        expect(html).toContain('data-order-print-component="orderItems"')
        expect(html).toContain('translate(7mm, 15mm)')
        expect(html).toContain('translate(-4mm, 9mm)')
        expect(html).toContain('dir="ltr" class="absolute whitespace-pre-wrap')
        expect(html).toContain('0770 199 0012')
        expect(html).toContain('fill="#7c3aed"')
        expect(html).toContain('z-index:5')
        expect(html).not.toContain('order-template-move-handle absolute')
    })
})

describe('Atlas Standard order invoice custom print template', () => {
    it('registers a fixed A4 target with movable workspace branding and fixed section visibility controls', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toMatchObject({
            moduleTypeKey: customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
            workspaceModuleKey: 'crm',
            typeLabel: 'Orders Atlas Standard',
            nativeTemplateAvailable: true,
            printFormat: 'a4',
            page: { widthMm: 210, heightMm: 297 }
        })
        expect(customTemplates.getCustomTemplateDisplayName(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY))
            .toBe('Orders Atlas Standard')
        expect(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY).toBe('orders.AtlasStandard')
        expect(customTemplates.getStoredCustomTemplateLabel({
            id: 'legacy-order-template',
            module_type_key: customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
            label: 'My legacy order layout',
            layout_json: {}
        })).toBe('My legacy order layout')
        expect(customTemplates.getStoredCustomTemplateLabel({
            id: 'unnamed-legacy-order-template',
            module_type_key: customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
            layout_json: {}
        })).toBe('Orders Atlas Standard')

        const hiddenFields = {
            'atlasStandard.table.price': true,
            'atlasStandard.financialSummary.notes': true
        }
        const fieldOrders = {
            'atlasStandard.invoiceDetails': [
                'atlasStandard.invoiceDetails.invoice',
                'atlasStandard.invoiceDetails.partner'
            ],
            'atlasStandard.financialSummary': [
                'atlasStandard.financialSummary.discount',
                'atlasStandard.financialSummary.paidAmount'
            ]
        }
        const fieldLabelOverrides = {
            'atlasStandard.invoiceDetails.salesPerson': 'Sales Man'
        }
        const fieldDisplayModes = {
            'atlasStandard.invoiceDetails.salesPerson': 'invoiceOrganizer',
            'atlasStandard.table.productImage.width': '12'
        }
        const onHiddenFieldChange = vi.fn()
        const onFieldOrderChange = vi.fn()
        const onFieldLabelChange = vi.fn()
        const onFieldDisplayModeChange = vi.fn()
        const onComponentPositionChange = vi.fn()
        const componentPositions = { atlasStandardWorkspaceName: { x: 20, y: 10 } }
        const productImageUrls = { 'sample-product': 'https://example.test/products/sample.png' }
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en',
            printedBy: 'Order Cashier',
            productImageUrls,
            counterpartyPhone: '+964 750 123 4567',
            counterpartyAddress: '100 Example Street, Erbil'
        })
        const element = preview.createElement({}, undefined, undefined, {
            componentPositions,
            editableComponents: true,
            onComponentPositionChange,
            hiddenFields,
            onHiddenFieldChange,
            fieldOrders,
            onFieldOrderChange,
            fieldLabelOverrides,
            onFieldLabelChange,
            fieldDisplayModes,
            onFieldDisplayModeChange
        })

        expect(preview.fields).toEqual([
            expect.objectContaining({
                key: 'showOrderAdjustments',
                value: 'true',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: 'showPrintFooter',
                label: 'printPreviewEditor.showAtlasStandardFooter',
                value: 'true',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: 'enableTextPositionAnchor',
                value: 'true',
                type: 'boolean'
            })
        ])
        expect(preview.reflowLowerPageText).toBe(true)
        expect(preview.textFlowAnchorField).toBe('enableTextPositionAnchor')
        const smartHtml = renderToStaticMarkup(preview.createElement({ showPrintFooter: 'false', enableTextPositionAnchor: 'false' }))
        expect(smartHtml).toContain('data-atlas-standard-smart-rows="true"')
        expect(smartHtml).not.toContain('data-template-text-flow-anchor')
        expect(smartHtml).not.toContain('data-atlas-standard-contacts')
        expect(renderToStaticMarkup(preview.createElement({ enableTextPositionAnchor: 'false' })))
            .not.toContain('data-atlas-standard-smart-rows')
        expect(preview.movableComponents).toEqual([
            { key: 'atlasStandardWorkspaceLogo', label: 'Workspace Logo' },
            { key: 'atlasStandardWorkspaceName', label: 'Workspace Name' }
        ])
        expect(element.props.hiddenFields).toBe(hiddenFields)
        expect(element.props.onHiddenFieldChange).toBe(onHiddenFieldChange)
        expect(element.props.fieldOrders).toBe(fieldOrders)
        expect(element.props.onFieldOrderChange).toBe(onFieldOrderChange)
        expect(element.props.fieldLabelOverrides).toBe(fieldLabelOverrides)
        expect(element.props.onFieldLabelChange).toBe(onFieldLabelChange)
        expect(element.props.fieldDisplayModes).toBe(fieldDisplayModes)
        expect(element.props.onFieldDisplayModeChange).toBe(onFieldDisplayModeChange)
        expect(element.props.componentPositions).toBe(componentPositions)
        expect(element.props.onComponentPositionChange).toBe(onComponentPositionChange)
        expect(element.props.productImageUrls).toBe(productImageUrls)

        const html = renderToStaticMarkup(element)
        expect(html).toContain('Atlas Test')
        expect(html).toContain('min-h-[13mm]')
        expect(html).toContain('Sample Product')
        expect(html).toContain('Sample line item note.')
        expect(html).toContain('>Image</th>')
        expect(html).toContain('https://example.test/products/sample.png')
        expect(html).toContain('width:12%')
        expect(html).toContain('width:13.6mm;height:13.6mm')
        expect(html).toContain('>Note</th>')
        expect(html).toContain('>2 pcs</td>')
        expect(html).toContain('height:130.4mm')
        expect(html).toContain('h-[8mm] bg-[#e5e7eb]')
        expect(html).toContain('text-[9px] leading-[1.2] truncate')
        expect(html).toContain('min-h-[6.5mm] px-2 py-1.5 text-xs truncate')
        expect(html).toContain('Invoice : </strong><span class="text-green-600">Sales Order</span>')
        expect(html).toContain('Phone : </strong>-')
        expect(html).toContain('Invoice Organizer : </strong>')
        expect(html).not.toContain('Invoice Organizer : </strong>Order Cashier')
        expect(html).toContain('Status : </strong>Pending')
        expect(html).toContain('Paid Amount : </strong>')
        expect(html).toContain('Order Outstanding : </strong>')
        expect(html).toContain('Payment Method : </strong>Cash')
        expect(html.indexOf('<strong>Invoice : </strong><span class="text-green-600">Sales Order</span>')).toBeLessThan(html.indexOf('<strong>Customer : </strong>Sample Customer'))
        expect(html.indexOf('<strong>Discount : </strong>')).toBeLessThan(html.indexOf('<strong>Paid Amount : </strong>'))
        expect(html).not.toContain('Previous Balance')
        expect(html).not.toContain('Net Payable')
        expect(html).toContain('border-x px-1')
        expect(html).not.toContain('gap-px')
        expect(html).toContain('data-order-print-component="atlasStandardWorkspaceName"')
        expect(html).toContain('data-order-print-component="atlasStandardWorkspaceLogo"')
        expect(html).toContain('data-template-text-flow-anchor')
        expect((html.match(/data-order-print-component=/g) || [])).toHaveLength(2)
        expect(html).toContain('data-atlas-standard-print-footer')

        const footerHiddenHtml = renderToStaticMarkup(preview.createElement({ showPrintFooter: 'false' }))
        expect(footerHiddenHtml).not.toContain('data-atlas-standard-print-footer')
        expect(footerHiddenHtml).not.toContain('Made By AtlasERP')

        const purchasePreview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceName: 'Atlas Test',
            printLang: 'en',
            orderKind: 'purchase'
        })
        const purchaseHtml = renderToStaticMarkup(purchasePreview.createElement({}))
        expect(purchaseHtml).toContain('Invoice : </strong><span class="text-red-600">Purchase Order</span>')

        const hiddenNoteHtml = renderToStaticMarkup(preview.createElement({}, undefined, undefined, {
            hiddenFields: { 'atlasStandard.table.note': true }
        }))
        expect(hiddenNoteHtml).not.toContain('Sample line item note.')
        expect(hiddenNoteHtml).not.toContain('>Note</th>')

        const renamedColumnHtml = renderToStaticMarkup(preview.createElement({}, undefined, undefined, {
            fieldLabelOverrides: { 'atlasStandard.table.productImage': 'Photo' },
            onFieldLabelChange
        }))
        expect(renamedColumnHtml).toContain('>Photo</th>')
        expect(renamedColumnHtml).not.toContain('>Image</th>')

        const hiddenImageHtml = renderToStaticMarkup(preview.createElement({}, undefined, undefined, {
            hiddenFields: { 'atlasStandard.table.productImage': true }
        }))
        expect(hiddenImageHtml).not.toContain('>Image</th>')
        expect(hiddenImageHtml).not.toContain('https://example.test/products/sample.png')
    })

    it('writes the amount in words using the selected print language', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const english = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en'
        }).createElement({}))
        const arabic = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'ar'
        }).createElement({}))
        const kurdish = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'ku'
        }).createElement({}))

        expect(english).toContain('One Hundred Ninety Nine')
        expect(arabic).toContain('>2 قطعة</td>')
        expect(kurdish).toContain('>2 دانە</td>')
        expect(arabic).toContain('مائة وتسعة وتسعون')
        expect(kurdish).toContain('سەد و نەوەت و نۆ')
        expect(arabic).toContain('الحالة : </strong>قيد الانتظار')
        expect(arabic).toContain('المبلغ المدفوع : </strong>')
        expect(arabic).toContain('طريقة الدفع : </strong>نقدي')
        expect(kurdish).toContain('دۆخ : </strong>چاوەڕوان')
        expect(kurdish).toContain('بڕی دراو : </strong>')
        expect(kurdish).toContain('شێوازی پارەدان : </strong>کاش')
    })

    it('highlights partial and full sales-order returns in every Atlas Standard custom layout', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const partialHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                items: [{
                    ...baseOrder.items[0],
                    quantity: 3,
                    lineTotal: 75,
                    convertedUnitPrice: 25,
                    returnedQuantity: 1
                }]
            }
        }).createElement({}))
        const fullHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                items: [{
                    ...baseOrder.items[0],
                    quantity: 3,
                    lineTotal: 75,
                    convertedUnitPrice: 25,
                    returnedQuantity: 3
                }]
            }
        }).createElement({}))

        expect(partialHtml).toContain('data-order-print-return-state="partially-returned"')
        expect(partialHtml).toContain('background-color:#fef3c7')
        expect(partialHtml).toContain('>3 pcs</span><span')
        expect(partialHtml).toContain('>2 pcs</span>')
        expect(partialHtml).toContain('>$75</span><span')
        expect(partialHtml).toContain('>$50</span>')
        expect(partialHtml).toContain('flex-col gap-0 text-[9px] leading-[1.05] items-center')
        expect(fullHtml).toContain('data-order-print-return-state="fully-returned"')
        expect(fullHtml).toContain('background-color:#fee2e2')
        expect(fullHtml).toContain('>0 pcs</span>')
        expect(fullHtml).toContain('>$0</span>')
    })

    it('prints the original order values without return markings when requested', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const html = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                total: 50,
                originalTotalAmount: 75,
                returnedAmount: 25,
                items: [{
                    ...baseOrder.items[0],
                    quantity: 3,
                    lineTotal: 75,
                    convertedUnitPrice: 25,
                    returnedQuantity: 1
                }]
            },
            orderPrintVersion: 'original'
        }).createElement({}))

        expect(html).not.toContain('data-order-print-return-state="partially-returned"')
        expect(html).not.toContain('background-color:#fef3c7')
        expect(html).not.toContain('data-order-print-return-value=')
        expect(html).toContain('>3 pcs</td>')
        expect(html).toContain('>$75</td>')
    })

    it('prints each order adjustment as a labelled product-table row', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                orderAdjustments: [{
                    id: 'delivery-adjustment',
                    type: 'addition',
                    name: 'Delivery',
                    currency: 'usd',
                    amount: 5,
                    orderCurrency: 'usd',
                    convertedAmount: 5,
                    exchangeRate: 1,
                    exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                    exchangeRates: []
                }]
            }
        })
        const html = renderToStaticMarkup(preview.createElement({}))
        const hiddenHtml = renderToStaticMarkup(preview.createElement({ showOrderAdjustments: 'false' }))

        expect(html).toContain('data-order-print-row-type="adjustment"')
        expect(html).toContain('Delivery')
        expect(html).toContain('+$5')
        expect(hiddenHtml).not.toContain('data-order-print-row-type="adjustment"')
    })

    it('totals kilogram-quantity products multiplied by line quantity when enabled, converting to tons above 1000 kg', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const weightedOrder = {
            ...baseOrder,
            items: [
                { ...baseOrder.items[0], id: 'weighted-1', productName: 'Sugar 50 KG', quantity: 1200, unit: 'pcs' },
                { ...baseOrder.items[0], id: 'weighted-2', productName: 'Rice 300kg', quantity: 10, unit: 'pcs' },
                { ...baseOrder.items[0], id: 'weighted-3', productName: 'Non Weight Item', quantity: 2000, unit: 'pcs' }
            ]
        }

        const offHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: weightedOrder
        }).createElement({}, undefined, undefined, { fieldDisplayModes: {} }))
        expect(offHtml).not.toContain(' kg')
        expect(offHtml).not.toContain(' ton')

        const enabledHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: weightedOrder
        }).createElement({}, undefined, undefined, {
            fieldDisplayModes: { 'atlasStandard.table.productKgTotal': 'enabled' }
        }))

        expect(enabledHtml).toContain('63 ton')
        expect(enabledHtml).not.toContain('350 kg')
        expect(enabledHtml).not.toContain('35000 kg')

        const concatenatedKgHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...weightedOrder,
                items: [
                    { ...baseOrder.items[0], id: 'concat-1', productName: 'ProductIQD 600KG', quantity: 5, unit: 'pcs' },
                    { ...baseOrder.items[0], id: 'concat-2', productName: 'ProductUSD 600KG', quantity: 3, unit: 'pcs' }
                ]
            }
        }).createElement({}, undefined, undefined, {
            fieldDisplayModes: { 'atlasStandard.table.productKgTotal': 'enabled' }
        }))
        expect(concatenatedKgHtml).toContain('4.8 ton')
        expect(concatenatedKgHtml).not.toContain('1200 kg')

        const belowThousandHtml = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...weightedOrder,
                items: [
                    { ...baseOrder.items[0], productName: 'Sugar 400KG', id: 'below-1', quantity: 1 },
                    { ...baseOrder.items[0], productName: 'Rice 500KG', id: 'below-2', quantity: 1 }
                ]
            }
        }).createElement({}, undefined, undefined, {
            fieldDisplayModes: { 'atlasStandard.table.productKgTotal': 'enabled' }
        }))
        expect(belowThousandHtml).toContain('900 kg')
        expect(belowThousandHtml).not.toContain(' ton')
    })

    it('caps the order items table at 18 rows and continues with an identical table for the remaining rows', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const manyItemsOrder = {
            ...baseOrder,
            items: Array.from({ length: 28 }, (_, index) => ({
                ...baseOrder.items[0],
                id: `many-items-${index + 1}`,
                productName: `Sample Product ${index + 1}`
            }))
        }

        const html = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: manyItemsOrder
        }).createElement({}))

        const heads = html.match(/<thead>[\s\S]*?<\/thead>/g) || []
        expect(heads).toHaveLength(2)
        expect(heads[0]).toBe(heads[1])
        expect(html.match(/style="height:8mm"/g) || []).toHaveLength(28)
        expect(html).toContain('>18</td>')
        expect(html).toContain('>19</td>')
        expect(html).toContain('>28</td>')
        expect(html).not.toContain('>29</td>')
        expect(html.indexOf('>18</td>')).toBeLessThan(html.indexOf('>19</td>'))
        expect(html.indexOf('>19</td>')).toBeGreaterThan(html.indexOf('Made By AtlasERP'))
        expect(html).toContain('data-centered-table=""')
        expect(html.match(/data-centered-table/g) || []).toHaveLength(1)
    })
})

describe('Atlas Standard return custom print template', () => {
    it('uses a separate return target, native labels, and returned lines only', () => {
        const standardTarget = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
        const returnTarget = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY)
        expect(standardTarget).toBeDefined()
        expect(returnTarget).toMatchObject({
            moduleTypeKey: customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
            typeLabel: 'Orders Atlas Standard Return',
            printFormat: 'a4',
            nativeTemplateAvailable: true
        })
        expect(customTemplates.createCustomTemplatePreview(returnTarget!, { printLang: 'en' }).fields)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'showPrintFooter', value: 'true', type: 'boolean' })
            ]))
        expect(customTemplates.getCustomTemplateDisplayName(customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY))
            .toBe('Orders Atlas Standard Return')
        expect(customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY).toBe('orders.AtlasStandardReturn')

        const baseOrder = customTemplates
            .createCustomTemplatePreview(standardTarget!, { printLang: 'en' })
            .createElement({})
            .props.order
        const order = {
            ...baseOrder,
            orderAdjustments: [{
                id: 'delivery-adjustment',
                type: 'addition' as const,
                name: 'Delivery',
                currency: 'usd' as const,
                amount: 5,
                orderCurrency: 'usd' as const,
                convertedAmount: 5,
                exchangeRate: 1,
                exchangeRateSource: 'native',
                exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                exchangeRates: []
            }, {
                id: 'return-packaging-adjustment',
                type: 'deduction' as const,
                name: 'Damaged packaging',
                currency: 'usd' as const,
                amount: 5,
                orderCurrency: 'usd' as const,
                convertedAmount: 5,
                exchangeRate: 1,
                exchangeRateSource: 'native',
                exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                exchangeRates: [],
                scope: 'post_return' as const,
                returnId: 'return-1'
            }],
            items: [
                { ...baseOrder.items[0], id: 'returned-line', productName: 'Returned Product', quantity: 3, lineTotal: 75, convertedUnitPrice: 25 },
                { ...baseOrder.items[0], id: 'unreturned-line', productName: 'Unreturned Product', quantity: 2, lineTotal: 80, convertedUnitPrice: 40 }
            ]
        }
        const html = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(returnTarget!, {
            printLang: 'en',
            order,
            orderKind: 'sales',
            orderReturnPrintData: {
                status: 'partial',
                returnedAt: '2026-08-15T10:00:00.000Z',
                baseRefundAmount: 20,
                adjustmentAmount: 5,
                totalRefundAmount: 25,
                lines: [{ orderItemId: 'returned-line', returnedQuantity: 1, refundAmount: 20, unitRefundAmount: 20 }],
                adjustments: [{
                    id: 'return-packaging-adjustment',
                    type: 'deduction',
                    name: 'Damaged packaging',
                    currency: 'usd',
                    amount: 5,
                    orderCurrency: 'usd',
                    convertedAmount: 5,
                    exchangeRate: 1,
                    exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                    exchangeRates: [],
                    scope: 'post_return',
                    returnId: 'return-1'
                }]
            }
        }).createElement({}))

        expect(html).toContain('Return Invoice')
        expect(html).toContain('Returned Qty')
        expect(html).toContain('Refund Amount')
        expect(html).toContain('Returned Product')
        expect(html).not.toContain('Unreturned Product')
        expect(html).toContain('$25')
        expect(html).not.toContain('data-order-print-return-value=')
        expect(html).toContain('data-order-print-row-type="adjustment"')
        expect(html).toContain('Post-return adjustment')
        expect(html).toContain('Damaged packaging')
        expect(html).not.toContain('Delivery')
    })

    it('copies Atlas Standard layout elements but resets sale field labels and values', () => {
        const cloned = customTemplates.cloneAtlasStandardOrderLayoutForReturn({
            id: 'order-template',
            module_type_key: customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
            layout_json: {
                version: 1,
                moduleTypeKey: customTemplates.ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
                page: { widthMm: 210, heightMm: 297 },
                fields: { customTitle: 'Sales invoice' },
                hiddenFields: { 'atlasStandard.table.note': true },
                fieldOrders: { 'atlasStandard.invoiceDetails': ['atlasStandard.invoiceDetails.partner'] },
                fieldLabelOverrides: { 'atlasStandard.table.quantity': 'Sold Qty' },
                fieldDisplayModes: {
                    'atlasStandard.table.productImage.width': '12',
                    'atlasStandard.invoiceDetails.salesPerson': 'invoiceOrganizer'
                },
                annotations: [],
                texts: [{ id: 'text-1', text: 'Thank you', x: 1, y: 2, width: 20, rotation: 0 }],
                images: [],
                shapes: [],
                updatedAt: '2026-08-15T10:00:00.000Z'
            }
        })

        expect(cloned).toMatchObject({
            moduleTypeKey: customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
            nativeTemplateKey: customTemplates.ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
            fields: {},
            fieldLabelOverrides: {},
            fieldDisplayModes: { 'atlasStandard.table.productImage.width': '12' },
            hiddenFields: { 'atlasStandard.table.note': true },
            texts: [{ text: 'Thank you' }]
        })
    })

    it('registers independent Atlas Standard sale and return A4 targets', () => {
        const standardTarget = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY)
        const returnTarget = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY)

        expect(standardTarget).toMatchObject({
            workspaceModuleKey: 'sales_history',
            typeLabel: 'Atlas Standard Print',
            printFormat: 'a4'
        })
        expect(returnTarget).toMatchObject({
            workspaceModuleKey: 'sales_history',
            typeLabel: 'Atlas Standard Return Print',
            printFormat: 'a4'
        })

        const standardPreview = customTemplates.createCustomTemplatePreview(standardTarget!, { printLang: 'en' })
        const returnPreview = customTemplates.createCustomTemplatePreview(returnTarget!, { printLang: 'en' })
        expect(standardPreview.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'showPrintFooter', value: 'true', type: 'boolean' })
        ]))
        expect(returnPreview.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'showPrintFooter', value: 'true', type: 'boolean' })
        ]))
        expect(renderToStaticMarkup(standardPreview.createElement({ showPrintFooter: 'false' })))
            .not.toContain('data-atlas-standard-print-footer')
        expect(renderToStaticMarkup(returnPreview.createElement({ showPrintFooter: 'false' })))
            .not.toContain('data-atlas-standard-print-footer')
    })
})

describe('Order Receipt custom print template', () => {
    it('registers the thermal Orders - Receipt Print target', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_RECEIPT_TEMPLATE_KEY)

        expect(target).toMatchObject({
            moduleTypeKey: customTemplates.ORDER_RECEIPT_TEMPLATE_KEY,
            workspaceModuleKey: 'crm',
            moduleLabel: 'Orders',
            typeLabel: 'Receipt Print',
            nativeTemplateAvailable: true,
            printFormat: 'receipt',
            page: {
                widthMm: 80,
                heightMm: 200
            }
        })
        expect(customTemplates.getCustomTemplateDisplayName(customTemplates.ORDER_RECEIPT_TEMPLATE_KEY))
            .toBe('Orders - Receipt Print')
    })

    it('uses the order receipt layout with receipt-specific fields and movable components', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_RECEIPT_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const componentPositions = {
            orderReceiptItemsTable: { x: 3, y: 8 },
            orderReceiptTotals: { x: -2, y: 4 }
        }
        const onComponentPositionChange = vi.fn()
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            workspaceId: 'receipt-workspace',
            workspaceName: 'Atlas Test',
            printLang: 'en',
            features: { print_qr: true } as unknown as import('@/workspace').WorkspaceFeatures
        })
        const element = preview.createElement({
            'orderReceipt.hideDiscount': 'true',
            'orderReceipt.showContacts': 'false'
        }, 'order-receipt-id', undefined, {
            editableComponents: true,
            componentPositions,
            onComponentPositionChange
        })

        expect(preview.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({
                key: 'orderReceipt.showExchangeRateSnapshots',
                value: 'true',
                type: 'boolean'
            }),
            expect.objectContaining({
                key: 'orderReceipt.hideUnit', value: 'false', type: 'boolean' }),
            expect.objectContaining({
                key: 'orderReceipt.hideDiscount', value: 'false', type: 'boolean' }),
            expect.objectContaining({
                key: 'showOrderAdjustments', value: 'true', type: 'boolean' }),
            expect.objectContaining({
                key: 'orderReceipt.showContacts', value: 'true', type: 'boolean' }),
            expect.objectContaining({
                key: 'orderReceipt.thankYou', value: '', type: 'text' })
        ]))
        expect(preview.movableComponents?.map((component) => component.key)).toEqual([
            'orderReceiptLogo',
            'orderReceiptWorkspaceName',
            'orderReceiptQrCode',
            'orderReceiptOrderMeta',
            'orderReceiptCounterparty',
            'orderReceiptPayment',
            'orderReceiptExchangeRateSnapshots',
            'orderReceiptItemsTable',
            'orderReceiptTotals',
            'orderReceiptNotes',
            'orderReceiptContacts',
            'orderReceiptThankYou',
            'orderReceiptKeepRecord'
        ])
        expect(preview.page).toEqual({ widthMm: 80, heightMm: 200 })
        expect(preview.fixedPrintLang).toBe('en')
        expect(element.type).toBe(OrderReceiptPrintTemplate)
        expect(element.props.workspaceName).toBe('Atlas Test')
        expect(element.props.qrValue).toContain('/printed-invoices/receipts/order-receipt-id.pdf')
        expect(element.props.componentPositions).toBe(componentPositions)
        expect(element.props.editableComponents).toBe(true)
        expect(element.props.onComponentPositionChange).toBe(onComponentPositionChange)

        const html = renderToStaticMarkup(element)
        expect(html).toContain('SO-00042')
        expect(html).toContain('Sample Customer')
        expect(html).toContain('table-fixed')
        expect(html).toContain('overflow-wrap:anywhere')
        expect(html).toContain('data-order-print-component="orderReceiptItemsTable"')
        expect(html).toContain('translate(3mm, 0)')
        expect(html).toContain('margin-top:8mm')
        expect(html).toContain('data-order-print-component="orderReceiptTotals"')
        expect(html).not.toContain('data-order-print-component="orderReceiptContacts"')
        expect(html).toContain('Paid')
        expect(html).toContain('Outstanding')
    })

    it('keeps returned receipt lines monochrome while preserving the original and remaining values', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_RECEIPT_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const html = renderToStaticMarkup(customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                items: [{
                    ...baseOrder.items[0],
                    quantity: 3,
                    lineTotal: 75,
                    convertedUnitPrice: 25,
                    returnedQuantity: 1
                }]
            }
        }).createElement({}))

        expect(html).toContain('data-order-print-return-state="partially-returned"')
        expect(html).toContain('Partial Return')
        expect(html).toContain('data-order-print-return-value="partially-returned"')
        expect(html).toContain('flex-col gap-0 text-[9px] leading-[1.05] items-end')
        expect(html).not.toContain('#fef3c7')
        expect(html).not.toContain('#fee2e2')
    })

    it('prints each order adjustment as a monochrome receipt table row', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.ORDER_RECEIPT_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const baseOrder = customTemplates
            .createCustomTemplatePreview(target!, { printLang: 'en' })
            .createElement({})
            .props.order
        const preview = customTemplates.createCustomTemplatePreview(target!, {
            printLang: 'en',
            order: {
                ...baseOrder,
                orderAdjustments: [{
                    id: 'handling-adjustment',
                    type: 'deduction',
                    name: 'Handling credit',
                    currency: 'usd',
                    amount: 3,
                    orderCurrency: 'usd',
                    convertedAmount: 3,
                    exchangeRate: 1,
                    exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-22T00:00:00.000Z',
                    exchangeRates: []
                }]
            }
        })
        const html = renderToStaticMarkup(preview.createElement({}))
        const hiddenHtml = renderToStaticMarkup(preview.createElement({ showOrderAdjustments: 'false' }))

        expect(html).toContain('data-order-print-row-type="adjustment"')
        expect(html).toContain('Handling credit')
        expect(html).toContain('−3.00')
        expect(html).not.toContain('#fef3c7')
        expect(html).not.toContain('#fee2e2')
        expect(hiddenHtml).not.toContain('data-order-print-row-type="adjustment"')
    })
})

describe('Receipt custom template pagination', () => {
    it('keeps receipt layouts continuous instead of tiling fixed-height pages', () => {
        const target = customTemplates.getCustomTemplateTarget(customTemplates.SALES_HISTORY_RECEIPT_TEMPLATE_KEY)
        expect(target).toBeDefined()

        const html = renderToStaticMarkup(customTemplates.renderCustomTemplateLayoutElement({
            target: target!,
            layout: {
                version: 1,
                moduleTypeKey: customTemplates.SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
                page: { widthMm: 80, heightMm: 200 },
                fields: {},
                annotations: [],
                texts: [{
                    id: 'below-default-receipt-height',
                    text: 'Receipt footer',
                    x: 10,
                    y: 250,
                    width: 30,
                    rotation: 0
                }],
                images: [],
                shapes: [],
                updatedAt: new Date().toISOString()
            },
            values: {}
        }))

        expect(html).toContain('Receipt footer')
        expect(html).not.toContain('translateY(200mm)')
        expect(html).not.toContain('min-height:400mm')
    })
})
