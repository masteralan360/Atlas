import { generateTemplatePdf } from '@/services/pdfGenerator'
import type {
    CustomTemplateBackground,
    CustomTemplateLayout,
    CustomTemplatePrintLanguage,
    TemplatePreview,
    TemplatePreviewDataKey
} from '@/lib/printPreviewEditorStore'
import {
    getCustomTemplateLayoutHeightMm,
    getCustomTemplateLayoutOverflowHeightMm,
    getCustomTemplateLayoutPageCount,
    shouldReflowCustomTemplateText
} from '@/lib/printPreviewEditorStore'
import { PdfShapeGraphic } from '@/ui/components/PdfShapeGraphic'
import { getPdfShapeHeight, getPdfShapeZIndex } from '@/types'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { platformService } from '@/services/platformService'
import {
    getRealEstateNativeFieldPlaceholders,
    getRealEstateNativeTemplateFieldLabels,
    getRealEstateTemplateKeyLabels,
    getRealEstateTransactionTypeFromModuleTypeKey
} from '@/lib/realEstateParties'
import {
    RealEstateBuyPrintTemplate,
    type WorkspaceFooterContacts
} from '@/ui/components/real-estate/RealEstateBuyPrintTemplate'
import type {
    BusinessPartner,
    OrderInstallment,
    PurchaseOrder,
    RealEstateTransactionType,
    SalesOrder
} from '@/local-db'
import type { WorkspaceFeatures } from '@/workspace'
import type { Sale, UniversalInvoice } from '@/types'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'
import {
    SaleReceiptBase,
    SALE_RECEIPT_TEMPLATE_FIELD_KEYS,
    RECEIPT_MOVABLE_COMPONENT_KEYS
} from '@/ui/components/SaleReceipt'
import {
    PartnerDetailsPrintTemplate,
    PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS,
    type PartnerDetailsPrintData
} from '@/ui/components/crm/PartnerDetailsPrintTemplate'
import {
    PartnerOrderItemsPrintTemplate,
    PARTNER_ORDER_ITEMS_MOVABLE_COMPONENT_KEYS,
    type PartnerOrderItemsPrintData
} from '@/ui/components/crm/PartnerOrderItemsPrintTemplate'
import {
    PartnerAccountStatementPrintTemplate,
    type PartnerAccountStatementPrintData
} from '@/ui/components/crm/PartnerAccountStatementPrintTemplate'
import { LoanAccountStatementPrintTemplate } from '@/ui/components/loans/LoanAccountStatementPrintTemplate'
import type { LoanAccountStatementPrintData } from '@/lib/loanAccountStatement'
import {
    ORDER_DETAILS_MOVABLE_COMPONENT_KEYS,
    ORDER_PRINT_COMMON_FIELD_KEYS,
    ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS,
    ORDER_RECEIPT_TEMPLATE_FIELD_KEYS,
    OrderReceiptPrintTemplate,
    OrderDetailsPrintTemplate
} from '@/ui/components/orders/OrderPrintTemplates'
import {
    AtlasStandardOrderInvoiceTemplate,
    ATLAS_STANDARD_ORDER_MOVABLE_COMPONENT_KEYS,
    ATLAS_STANDARD_ORDER_TEMPLATE_FIELD_KEYS
} from '@/ui/components/orders/AtlasStandardOrderInvoiceTemplate'
import {
    createAtlasStandardPartnerBalancePrintState,
    resetAtlasStandardPartnerBalancePrintState,
    type AtlasStandardPartnerBalancePrintState
} from '@/lib/atlasStandardPartnerBalancePrintState'
import {
    SalesHistoryAtlasStandardInvoiceTemplate,
    SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS
} from '@/ui/components/sales/SalesHistoryAtlasStandardInvoiceTemplate'
import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'
import {
    createSampleSalesOrderReturnPrintData,
    type SalesOrderReturnPrintData
} from '@/lib/orderReturnPrintData'
import type { OrderPrintVersion } from '@/lib/orderPrintReturnState'
import type { ProductPrintImageUrls } from '@/ui/components/print/ProductPrintImage'
import { ModernA4InvoiceTemplate, MODERN_A4_MOVABLE_COMPONENT_KEYS } from '@/ui/components/ModernA4InvoiceTemplate'
import {
    ProfessionalA4InvoiceTemplate,
    PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS,
    PROFESSIONAL_A4_TABLE_ROW_COUNT
} from '@/ui/components/ProfessionalA4InvoiceTemplate'

export const SALES_HISTORY_RECEIPT_TEMPLATE_KEY = 'salesHistory.Receipt'
export const INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY = 'instantHistory.Receipt'
export const SALES_HISTORY_MODERN_A4_TEMPLATE_KEY = 'salesHistory.ModernA4'
export const SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY = 'salesHistory.ProfessionalA4'
export const SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY = 'salesHistory.AtlasStandard'
export const SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY = 'salesHistory.AtlasStandardReturn'
export const SALES_HISTORY_A4_TEMPLATE_KEYS = [
    SALES_HISTORY_MODERN_A4_TEMPLATE_KEY,
    SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY,
    SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
    SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
] as const
export const PARTNER_DETAILS_TEMPLATE_KEY = 'businessPartners.Details'
export const PARTNER_ORDER_ITEMS_TEMPLATE_KEY = 'businessPartners.OrderItems'
export const PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY = 'businessPartners.AccountStatement'
export const LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY = 'loans.AccountStatement'
export const ORDER_ATLAS_STANDARD_TEMPLATE_KEY = 'orders.AtlasStandard'
export const ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY = 'orders.AtlasStandardReturn'
export const ORDER_DETAILS_TEMPLATE_KEY = 'orders.Details'
export const ORDER_RECEIPT_TEMPLATE_KEY = 'orders.Receipt'
export const PARTNER_DETAILS_TEMPLATE_FIELD_KEYS = {
    showWhoOwesWhom: 'showWhoOwesWhom',
    showOrders: 'showOrders'
} as const
export const ORDER_DETAILS_TEMPLATE_FIELD_KEYS = {
    hideUnit: 'hideUnit',
    hideDiscount: 'hideDiscount',
    showOrderAdjustments: ORDER_PRINT_COMMON_FIELD_KEYS.showOrderAdjustments,
    boldAllText: 'boldAllText',
    labelOpacity: 'labelOpacity'
} as const
export const PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS = {
    showPaidAmount: 'showPaidAmount',
    showRemainingAmount: 'showRemainingAmount',
    showSettlementActivity: 'showSettlementActivity'
} as const

export type CustomTemplateTarget = {
    moduleTypeKey: string
    workspaceModuleKey: 'instant_pos' | 'real_estate' | 'sales_history' | 'crm' | 'loans'
    moduleLabel: string
    typeLabel: string
    description: string
    nativeTemplateKey: string
    nativeTemplateAvailable: boolean
    printFormat: 'a4' | 'receipt'
    page: {
        widthMm: number
        heightMm: number
    }
}

const REAL_ESTATE_CONTRACT_TARGETS: Array<Pick<CustomTemplateTarget, 'moduleTypeKey' | 'typeLabel' | 'description' | 'nativeTemplateKey' | 'nativeTemplateAvailable' | 'printFormat' | 'page'>> = [
    {
        moduleTypeKey: 'realEstate.Sell',
        typeLabel: 'Sell',
        description: 'Real estate sell transaction print layout.',
        nativeTemplateKey: 'realEstate.Sell',
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: 'realEstate.Buy',
        typeLabel: 'Buy',
        description: 'Real estate buy transaction print layout.',
        nativeTemplateKey: 'realEstate.Buy',
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: 'realEstate.Rent',
        typeLabel: 'Rent',
        description: 'Real estate rent transaction print layout.',
        nativeTemplateKey: 'realEstate.Rent',
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: 'realEstate.Lease',
        typeLabel: 'Lease',
        description: 'Real estate lease transaction print layout.',
        nativeTemplateKey: 'realEstate.Lease',
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: 'realEstate.Exchange',
        typeLabel: 'Exchange',
        description: 'Real estate exchange transaction print layout.',
        nativeTemplateKey: 'realEstate.Exchange',
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    }
]

const REAL_ESTATE_CONTRACT_MODULE_TYPE_KEYS = new Set(
    REAL_ESTATE_CONTRACT_TARGETS.map((target) => target.moduleTypeKey)
)

export const CUSTOM_TEMPLATE_TARGETS: CustomTemplateTarget[] = [
    {
        moduleTypeKey: SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
        workspaceModuleKey: 'sales_history',
        moduleLabel: 'Sales History',
        typeLabel: 'Receipt Print',
        description: 'Sales History thermal receipt print layout.',
        nativeTemplateKey: SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'receipt',
        page: { widthMm: 80, heightMm: 200 }
    },
    {
        moduleTypeKey: INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY,
        workspaceModuleKey: 'instant_pos',
        moduleLabel: 'Instant History',
        typeLabel: 'Receipt Print',
        description: 'Instant History thermal receipt print layout.',
        nativeTemplateKey: INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'receipt',
        page: { widthMm: 80, heightMm: 200 }
    },
    {
        moduleTypeKey: SALES_HISTORY_MODERN_A4_TEMPLATE_KEY,
        workspaceModuleKey: 'sales_history',
        moduleLabel: 'Sales History',
        typeLabel: 'Modern A4 Print',
        description: 'Sales History modern A4 print layout.',
        nativeTemplateKey: SALES_HISTORY_MODERN_A4_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY,
        workspaceModuleKey: 'sales_history',
        moduleLabel: 'Sales History',
        typeLabel: 'Professional A4 Print',
        description: 'Sales History professional A4 print layout.',
        nativeTemplateKey: SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
        workspaceModuleKey: 'sales_history',
        moduleLabel: 'Sales History',
        typeLabel: 'Atlas Standard Print',
        description: 'Sales History Atlas Standard A4 sale print layout.',
        nativeTemplateKey: SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        workspaceModuleKey: 'sales_history',
        moduleLabel: 'Sales History',
        typeLabel: 'Atlas Standard Return Print',
        description: 'Sales History Atlas Standard A4 return-only print layout.',
        nativeTemplateKey: SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: PARTNER_DETAILS_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Business Partners',
        typeLabel: 'Partner Details',
        description: 'Business partner details A4 print layout.',
        nativeTemplateKey: PARTNER_DETAILS_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: PARTNER_ORDER_ITEMS_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Business Partners',
        typeLabel: 'Order Items Statement',
        description: 'Date-filtered business partner sales and purchase order item statement.',
        nativeTemplateKey: PARTNER_ORDER_ITEMS_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Orders',
        typeLabel: 'Orders Atlas Standard',
        description: 'Orders Atlas Standard order invoice A4 print layout.',
        nativeTemplateKey: ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Orders',
        typeLabel: 'Orders Atlas Standard Return',
        description: 'Orders Atlas Standard partial and fully returned sales-order A4 print layout.',
        nativeTemplateKey: ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Business Partners',
        typeLabel: 'Account Statement',
        description: 'Chronological debit, credit, and running-balance partner account statement.',
        nativeTemplateKey: PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY,
        workspaceModuleKey: 'loans',
        moduleLabel: 'Loans',
        typeLabel: 'Loan Account Statement',
        description: 'Partner account summary through one selected loan repayment.',
        nativeTemplateKey: LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: ORDER_DETAILS_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Orders',
        typeLabel: 'old',
        description: 'Legacy sales and purchase order details A4 print layout.',
        nativeTemplateKey: ORDER_DETAILS_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'a4',
        page: { widthMm: 210, heightMm: 297 }
    },
    {
        moduleTypeKey: ORDER_RECEIPT_TEMPLATE_KEY,
        workspaceModuleKey: 'crm',
        moduleLabel: 'Orders',
        typeLabel: 'Receipt Print',
        description: 'Sales and purchase order thermal receipt print layout.',
        nativeTemplateKey: ORDER_RECEIPT_TEMPLATE_KEY,
        nativeTemplateAvailable: true,
        printFormat: 'receipt',
        page: { widthMm: 80, heightMm: 200 }
    },
    ...REAL_ESTATE_CONTRACT_TARGETS.map((target) => ({
        ...target,
        workspaceModuleKey: 'real_estate' as const,
        moduleLabel: 'Real Estate'
    }))
]

export function getCustomTemplateTarget(moduleTypeKey: string) {
    return CUSTOM_TEMPLATE_TARGETS.find((target) => target.moduleTypeKey === moduleTypeKey)
}

export function getCustomTemplateDisplayName(moduleTypeKey: string) {
    const target = getCustomTemplateTarget(moduleTypeKey)
    if (target) {
        if (moduleTypeKey === ORDER_ATLAS_STANDARD_TEMPLATE_KEY
            || moduleTypeKey === ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
            || moduleTypeKey === ORDER_DETAILS_TEMPLATE_KEY) {
            return target.typeLabel
        }
        return `${target.moduleLabel} - ${target.typeLabel}`
    }

    return moduleTypeKey
}

export function resolveCustomTemplatePrintLanguage(
    configuredPrintLanguage?: string | null,
    fallbackLanguage = 'en'
): CustomTemplatePrintLanguage {
    const candidate = configuredPrintLanguage && configuredPrintLanguage !== 'auto'
        ? configuredPrintLanguage
        : fallbackLanguage
    const baseLanguage = candidate.toLowerCase().split('-')[0]

    if (baseLanguage === 'ar' || baseLanguage === 'ku') {
        return baseLanguage
    }

    return 'en'
}

export function stampCustomTemplatePrintLanguage(
    layout: CustomTemplateLayout,
    configuredPrintLanguage?: string | null,
    fallbackLanguage = 'en'
): CustomTemplateLayout {
    return {
        ...layout,
        printLanguage: resolveCustomTemplatePrintLanguage(configuredPrintLanguage, fallbackLanguage)
    }
}

export type StoredCustomTemplateRow = {
    id: string
    module_type_key: string
    label?: string | null
    layout_json: unknown
    active?: boolean
    primary?: boolean
    version?: number
    updated_at?: string | null
}

function sanitizeLayoutBackground(
    value: unknown
): CustomTemplateBackground | undefined {
    if (!value || typeof value !== 'object') return undefined
    const candidate = value as Partial<CustomTemplateBackground>
    const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
    if (!path) return undefined
    const opacity = Number(candidate.opacity)
    const size = Number(candidate.size)
    return {
        path,
        opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(1, Math.round(opacity))) : 15,
        size: Number.isFinite(size) ? Math.min(100, Math.max(10, Math.round(size))) : 100
    }
}

export function readCustomTemplateLayout(row?: StoredCustomTemplateRow | null): CustomTemplateLayout | null {
    if (!row || !row.layout_json || typeof row.layout_json !== 'object') return null

    const layout = row.layout_json as Partial<CustomTemplateLayout>
    const targetPage = getCustomTemplateTarget(row.module_type_key)?.page
    const hiddenFields = layout.hiddenFields && typeof layout.hiddenFields === 'object'
        ? Object.fromEntries(
            Object.entries(layout.hiddenFields).filter(([, value]) => typeof value === 'boolean')
        )
        : {}
    const fieldOrders = layout.fieldOrders && typeof layout.fieldOrders === 'object'
        ? Object.fromEntries(
            Object.entries(layout.fieldOrders)
                .filter(([, value]) => Array.isArray(value))
                .map(([key, value]) => [key, value.filter((fieldKey): fieldKey is string => typeof fieldKey === 'string')])
        )
        : {}
    const fieldLabelOverrides = layout.fieldLabelOverrides && typeof layout.fieldLabelOverrides === 'object'
        ? Object.fromEntries(
            Object.entries(layout.fieldLabelOverrides)
                .filter(([, value]) => typeof value === 'string' && Boolean(value.trim()))
                .map(([key, value]) => [key, (value as string).trim()])
        )
        : {}
    const fieldDisplayModes = layout.fieldDisplayModes && typeof layout.fieldDisplayModes === 'object'
        ? Object.fromEntries(
            Object.entries(layout.fieldDisplayModes)
                .filter(([, value]) => typeof value === 'string' && Boolean(value.trim()))
                .map(([key, value]) => [key, (value as string).trim()])
        )
        : {}
    const background = sanitizeLayoutBackground(layout.background)

    return {
        version: 1,
        label: row.label?.trim() || (typeof layout.label === 'string' ? layout.label : undefined),
        moduleTypeKey: typeof layout.moduleTypeKey === 'string' ? layout.moduleTypeKey : row.module_type_key,
        nativeTemplateKey: typeof layout.nativeTemplateKey === 'string' ? layout.nativeTemplateKey : undefined,
        printLanguage: layout.printLanguage === 'ar' || layout.printLanguage === 'ku' || layout.printLanguage === 'en'
            ? layout.printLanguage
            : undefined,
        page: {
            widthMm: targetPage?.widthMm || layout.page?.widthMm || 210,
            heightMm: targetPage?.heightMm || layout.page?.heightMm || 297
        },
        fields: layout.fields || {},
        hiddenFields,
        fieldOrders,
        fieldLabelOverrides,
        fieldDisplayModes,
        background,
        componentPositions: layout.componentPositions || {},
        annotations: layout.annotations || [],
        texts: layout.texts || [],
        images: layout.images || [],
        shapes: layout.shapes || [],
        updatedAt: typeof layout.updatedAt === 'string' ? layout.updatedAt : row.updated_at || new Date().toISOString()
    }
}

/**
 * Starts a Sales Return template from an Atlas Standard order layout without
 * carrying sale-specific labels or field values into the new document type.
 */
export function cloneAtlasStandardOrderLayoutForReturn(
    source: StoredCustomTemplateRow
): CustomTemplateLayout | null {
    if (source.module_type_key !== ORDER_ATLAS_STANDARD_TEMPLATE_KEY) return null

    const layout = readCustomTemplateLayout(source)
    if (!layout) return null

    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const copiedTableSettings = Object.fromEntries(
        Object.entries(layout.fieldDisplayModes || {}).filter(([key]) =>
            key.startsWith('atlasStandard.table.')
        )
    )

    return {
        version: layout.version,
        label: getCustomTemplateDisplayName(ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY),
        moduleTypeKey: ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        nativeTemplateKey: ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
        printLanguage: layout.printLanguage,
        page: { ...layout.page },
        // Return documents start with native labels and field values.
        fields: {},
        hiddenFields: clone(layout.hiddenFields || {}),
        fieldOrders: clone(layout.fieldOrders || {}),
        fieldLabelOverrides: {},
        fieldDisplayModes: copiedTableSettings,
        background: layout.background ? clone(layout.background) : undefined,
        componentPositions: clone(layout.componentPositions || {}),
        annotations: clone(layout.annotations || []),
        texts: clone(layout.texts || []),
        images: clone(layout.images || []),
        shapes: clone(layout.shapes || []),
        updatedAt: new Date().toISOString()
    }
}

export function getStoredCustomTemplatePrintLanguage(
    row?: StoredCustomTemplateRow | null
): CustomTemplatePrintLanguage | null {
    return readCustomTemplateLayout(row)?.printLanguage || null
}

export function isCustomTemplatePrintLanguageCompatible(
    row: StoredCustomTemplateRow | null | undefined,
    currentPrintLanguage: string
) {
    const storedPrintLanguage = getStoredCustomTemplatePrintLanguage(row)
    return storedPrintLanguage !== null
        && storedPrintLanguage === resolveCustomTemplatePrintLanguage(currentPrintLanguage)
}

export function getCustomTemplatePrintLanguageWarning(
    row: StoredCustomTemplateRow,
    currentPrintLanguage: string,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    const storedPrintLanguage = getStoredCustomTemplatePrintLanguage(row)
    if (!storedPrintLanguage) {
        return t('customTemplates.languageMissingWarning', {
            defaultValue: 'No print language is saved in this template. Open and save it again before printing.'
        })
    }

    const normalizedCurrentPrintLanguage = resolveCustomTemplatePrintLanguage(currentPrintLanguage)
    if (storedPrintLanguage === normalizedCurrentPrintLanguage) {
        return undefined
    }

    return t('customTemplates.languageMismatchWarning', {
        defaultValue: 'Saved for {{templateLanguage}}, but workspace printing is {{workspaceLanguage}}. Change the print language or save this template again.',
        templateLanguage: storedPrintLanguage.toUpperCase(),
        workspaceLanguage: normalizedCurrentPrintLanguage.toUpperCase()
    })
}

export function countCustomTemplateLayoutItems(row: StoredCustomTemplateRow) {
    const layout = readCustomTemplateLayout(row)
    if (!layout) return 0
    return layout.annotations.length
        + layout.texts.length
        + layout.images.length
        + layout.shapes.length
        + Object.keys(layout.fields).length
        + Object.keys(layout.componentPositions || {}).length
}

export function getStoredCustomTemplateLabel(row: StoredCustomTemplateRow) {
    const layout = readCustomTemplateLayout(row)
    return row.label?.trim() || layout?.label || getCustomTemplateDisplayName(row.module_type_key)
}

export type CustomTemplatePreviewOptions = {
    workspaceId?: string
    workspaceName?: string | null
    features?: WorkspaceFeatures
    workspaceFooterContacts?: WorkspaceFooterContacts
    receiptData?: UniversalInvoice
    sale?: Sale
    salesHistoryPrintVersion?: OrderPrintVersion
    partnerDetailsData?: PartnerDetailsPrintData
    partnerOrderItemsData?: PartnerOrderItemsPrintData
    partnerAccountStatementData?: PartnerAccountStatementPrintData
    loanAccountStatementData?: LoanAccountStatementPrintData
    order?: SalesOrder | PurchaseOrder
    orderKind?: 'sales' | 'purchase'
    orderReturnPrintData?: SalesOrderReturnPrintData | null
    orderPrintVersion?: OrderPrintVersion
    orderInstallments?: OrderInstallment[]
    businessPartner?: BusinessPartner | null
    partnerAccountStatementBalances?: PartnerAccountStatementClosingBalance[]
    partnerBalancePrintState?: AtlasStandardPartnerBalancePrintState
    productUnits?: Record<string, string | null | undefined>
    productImageUrls?: ProductPrintImageUrls
    counterpartyPhone?: string
    counterpartyAddress?: string
    printedBy?: string | null
    printLang?: string
}

const SAMPLE_RECEIPT_DATA: UniversalInvoice = {
    id: 'custom-template-receipt',
    sequenceId: 1,
    invoiceid: '#00636',
    created_at: new Date().toISOString(),
    cashier_name: 'Demo',
    items: [
        {
            product_id: 'sample-product',
            product_name: 'Sample Product',
            product_sku: '42432423423',
            quantity: 1,
            unit_price: 100000,
            total_price: 100000,
            original_unit_price: 64,
            original_currency: 'usd',
            settlement_currency: 'iqd'
        }
    ],
    total_amount: 100000,
    settlement_currency: 'iqd',
    payment_method: 'cash',
    exchange_rates: [
        {
            pair: 'USD/IQD',
            rate: 155700,
            source: 'XEIQD',
            timestamp: new Date().toISOString()
        }
    ],
    status: 'paid',
    notes: 'This is a sample sale note. It will appear when "Show notes" is enabled.'
}

// Keep enough rows here to demonstrate both the first A4 page and a continuation page.
const SAMPLE_SALES_HISTORY_ATLAS_STANDARD_ITEMS = Array.from({ length: 30 }, (_, index) => {
    const productNumber = index + 1
    const unitPrice = productNumber * 1000

    return {
        id: `sales-history-atlas-standard-item-${productNumber}`,
        sale_id: 'sales-history-atlas-standard-sample',
        product_id: `sample-product-${productNumber}`,
        product_name: `Sample Product ${String(productNumber).padStart(2, '0')}`,
        product_sku: `SKU-${String(productNumber).padStart(4, '0')}`,
        quantity: 1,
        unit_price: unitPrice,
        total_price: unitPrice,
        original_currency: 'iqd',
        original_unit_price: unitPrice,
        converted_unit_price: unitPrice,
        settlement_currency: 'iqd',
        batch_allocations: [{
            batch_id: `sample-batch-${productNumber}`,
            batch_number: `B-2026-${String(productNumber).padStart(2, '0')}`,
            quantity: 1,
            expiry_date: '2027-09-05'
        }]
    }
})

const SAMPLE_SALES_HISTORY_ATLAS_STANDARD_SALE: Sale = {
    id: 'sales-history-atlas-standard-sample',
    workspace_id: 'sample-workspace',
    cashier_id: 'sample-cashier',
    cashier_name: 'Demo Cashier',
    sequenceId: 636,
    total_amount: 465000,
    original_total_amount: 465000,
    returned_amount: 0,
    return_status: 'none',
    settlement_currency: 'iqd',
    created_at: '2026-09-05T09:30:00.000Z',
    origin: 'pos',
    payment_method: 'cash',
    notes: 'This is a sample sale note.',
    items: SAMPLE_SALES_HISTORY_ATLAS_STANDARD_ITEMS
}

const SAMPLE_SALES_HISTORY_ATLAS_STANDARD_RETURN_SALE: Sale = {
    ...SAMPLE_SALES_HISTORY_ATLAS_STANDARD_SALE,
    id: 'sales-history-atlas-standard-return-sample',
    sequenceId: 637,
    returned_amount: 465000,
    return_status: 'full',
    is_returned: true,
    returned_at: '2026-09-05T10:30:00.000Z',
    items: SAMPLE_SALES_HISTORY_ATLAS_STANDARD_SALE.items?.map((item) => ({
        ...item,
        id: item.id.replace('sales-history-atlas-standard-item', 'sales-history-atlas-standard-return-item'),
        sale_id: 'sales-history-atlas-standard-return-sample',
        returned_quantity: item.quantity,
        is_returned: true,
        returned_at: '2026-09-05T10:30:00.000Z'
    }))
}

const SAMPLE_PARTNER_DETAILS_DATA: PartnerDetailsPrintData = {
    partner: {
        partnerName: 'Sample Business Partner',
        role: 'both',
        phone: '+964 750 000 0000',
        address: 'Business District',
        city: 'Erbil',
        defaultCurrency: 'usd',
        createdAt: new Date().toISOString(),
        notes: 'Partner notes appear here.'
    },
    period: {
        type: 'allTime'
    },
    generatedAt: new Date().toISOString(),
    loanSummary: {
        remainingReceivable: 2500,
        remainingPayable: 1200,
        paymentsReceived: 8000,
        paymentsMade: 3200
    },
    metrics: {
        moneyIn: 42000,
        moneyOut: 18500
    },
    relationshipSummary: {
        receivable: 2500,
        payable: 1200
    },
    providedByYou: [
        {
            id: 'sample-sales-order',
            source: 'sales_order',
            reference: 'SO-00042',
            displayDate: new Date().toISOString(),
            status: 'completed',
            statusLabel: 'Completed',
            summary: 'Sample product order',
            originalAmount: 12000,
            paidAmount: 12000,
            remainingAmount: 0,
            currency: 'usd'
        }
    ],
    providedByPartner: [
        {
            id: 'sample-loan',
            source: 'loan',
            reference: 'LN-00007',
            displayDate: new Date().toISOString(),
            status: 'active',
            statusLabel: 'Active',
            summary: 'Installment loan',
            originalAmount: 5000,
            paidAmount: 2500,
            remainingAmount: 2500,
            currency: 'usd'
        }
    ],
    salesOrders: [
        {
            id: 'sample-sales-order',
            source: 'sales_order',
            reference: 'SO-00042',
            displayDate: new Date().toISOString(),
            status: 'completed',
            statusLabel: 'Completed',
            summary: 'Sample product order',
            originalAmount: 12000,
            paidAmount: 12000,
            remainingAmount: 0,
            currency: 'usd'
        }
    ],
    purchaseOrders: [
        {
            id: 'sample-purchase-order',
            source: 'purchase_order',
            reference: 'PO-00019',
            displayDate: new Date().toISOString(),
            status: 'received',
            statusLabel: 'Received',
            summary: 'Sample supply order',
            originalAmount: 7200,
            paidAmount: 3000,
            remainingAmount: 4200,
            currency: 'usd'
        }
    ],
    topProducts: [
        {
            id: 'sample-product',
            name: 'Sample Product',
            quantity: 48,
            amount: 24000
        }
    ]
}

const SAMPLE_ORDER_DATA: SalesOrder = {
    id: 'sample-sales-order',
    workspaceId: 'sample-workspace',
    orderNumber: 'SO-00042',
    customerId: 'sample-customer',
    customerName: 'Sample Customer',
    items: [
        {
            id: 'sample-order-item',
            productId: 'sample-product',
            productName: 'Sample Product',
            productSku: 'SKU-0001',
            note: 'Sample line item note.',
            unit: 'pcs',
            quantity: 2,
            lineTotal: 200,
            originalCurrency: 'usd',
            originalUnitPrice: 100,
            convertedUnitPrice: 100,
            settlementCurrency: 'usd',
            costPrice: 70,
            convertedCostPrice: 70
        }
    ],
    subtotal: 200,
    discount: 10,
    tax: 9.5,
    total: 199.5,
    currency: 'usd',
    exchangeRate: null,
    exchangeRateSource: null,
    exchangeRateTimestamp: null,
    status: 'pending',
    expectedDeliveryDate: new Date().toISOString(),
    isPaid: false,
    paymentStatus: 'partial',
    paidAmount: 50,
    balanceAmount: 149.5,
    paymentMethod: 'cash',
    initialPaymentAmount: 0,
    linkedLoanId: null,
    isInstallmentBased: false,
    installmentCount: 0,
    shippingAddress: 'Business District, Erbil',
    notes: 'Order notes appear here.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    lastSyncedAt: null,
    version: 1,
    isDeleted: false
}

const SAMPLE_PURCHASE_ORDER_DATA: PurchaseOrder = {
    id: 'sample-purchase-order',
    workspaceId: 'sample-workspace',
    orderNumber: 'PO-00019',
    supplierId: 'sample-supplier',
    supplierName: 'Sample Supplier',
    items: [
        {
            id: 'sample-purchase-order-item',
            productId: 'sample-purchase-product',
            productName: 'Sample Supply',
            productSku: 'SKU-0002',
            note: 'Sample purchase item note.',
            unit: 'box',
            quantity: 4,
            lineTotal: 320,
            originalCurrency: 'usd',
            originalUnitPrice: 80,
            convertedUnitPrice: 80,
            settlementCurrency: 'usd'
        }
    ],
    subtotal: 320,
    discount: 20,
    total: 308,
    currency: 'usd',
    orderAdjustments: [{
        id: 'sample-purchase-adjustment',
        type: 'addition',
        name: 'Freight',
        currency: 'usd',
        amount: 8,
        orderCurrency: 'usd',
        convertedAmount: 8,
        exchangeRate: 1,
        exchangeRateSource: 'native',
        exchangeRateTimestamp: new Date().toISOString(),
        exchangeRates: []
    }],
    exchangeRate: null,
    exchangeRateSource: null,
    exchangeRateTimestamp: null,
    status: 'received',
    isPaid: false,
    paymentStatus: 'partial',
    paidAmount: 100,
    balanceAmount: 208,
    paymentMethod: 'bank_transfer',
    initialPaymentAmount: 0,
    linkedLoanId: null,
    isInstallmentBased: false,
    installmentCount: 0,
    notes: 'Purchase order notes appear here.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    lastSyncedAt: null,
    version: 1,
    isDeleted: false
}

const SAMPLE_PARTNER_ORDER_ITEMS_DATA: PartnerOrderItemsPrintData = {
    partner: {
        partnerName: 'Sample Business Partner',
        phone: '+964 750 000 0000',
        address: 'Business District',
        city: 'Erbil'
    },
    period: { type: 'allTime' },
    generatedAt: new Date().toISOString(),
    balanceSummary: {
        receivable: [{ currency: 'usd', amount: 450 }],
        payable: [{ currency: 'usd', amount: 120 }]
    },
    salesOrders: [{
        ...SAMPLE_ORDER_DATA,
        orderAdjustments: [{
            id: 'sample-sales-adjustment',
            type: 'addition',
            name: 'Delivery',
            currency: 'usd',
            amount: 5,
            orderCurrency: 'usd',
            convertedAmount: 5,
            exchangeRate: 1,
            exchangeRateSource: 'native',
            exchangeRateTimestamp: new Date().toISOString(),
            exchangeRates: []
        }]
    }],
    purchaseOrders: [SAMPLE_PURCHASE_ORDER_DATA]
}

const PARTNER_DETAILS_FIELDS = [
    {
        key: PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showWhoOwesWhom,
        label: 'Show the "Who owes whom" section',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showOrders,
        label: 'Show the orders',
        value: 'false',
        type: 'boolean' as const
    }
]

const PARTNER_ORDER_ITEMS_FIELDS = [
    {
        key: PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showPaidAmount,
        label: 'Show paid amount in the order total row',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showRemainingAmount,
        label: 'Show remaining amount in the order total row',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showSettlementActivity,
        label: 'Show partner settlement activity',
        value: 'true',
        type: 'boolean' as const
    }
]

const ORDER_DETAILS_FIELDS = [
    {
        key: ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideUnit,
        label: 'Hide item units',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideDiscount,
        label: 'Hide discounts',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: ORDER_DETAILS_TEMPLATE_FIELD_KEYS.showOrderAdjustments,
        label: 'Show order adjustments',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_DETAILS_TEMPLATE_FIELD_KEYS.boldAllText,
        label: 'Bold all text',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: 'tableRowCount',
        label: 'Table row count',
        value: '10',
        type: 'number' as const
    },
    {
        key: ORDER_DETAILS_TEMPLATE_FIELD_KEYS.labelOpacity,
        label: 'Labels opacity',
        value: '50',
        type: 'number' as const
    }
]

const ATLAS_STANDARD_ORDER_FIELDS = [
    {
        key: ATLAS_STANDARD_ORDER_TEMPLATE_FIELD_KEYS.showOrderAdjustments,
        label: 'Show order adjustments',
        value: 'true',
        type: 'boolean' as const
    }
]

const ORDER_RECEIPT_FIELDS = [
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showExchangeRateSnapshots,
        label: 'Exchange rate source snapshot',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOriginalCurrencyPrice,
        label: 'Original currency price',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideUnit,
        label: 'Hide item units',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideDiscount,
        label: 'Hide discounts',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOrderAdjustments,
        label: 'Show order adjustments',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes,
        label: 'Show notes',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showContacts,
        label: 'Show contacts',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou,
        label: 'Thank-you text',
        value: '',
        type: 'text' as const,
        placeholder: 'Thank you for your order!'
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord,
        label: 'Keep-record text',
        value: '',
        type: 'text' as const,
        placeholder: 'Please keep this receipt for your records.'
    },
    {
        key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.labelOpacity,
        label: 'Labels opacity',
        value: '100',
        type: 'number' as const
    }
]

const SALES_HISTORY_MODERN_A4_FIELDS = [
    {
        key: 'hideUnit',
        label: 'Hide item units',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: 'hideDiscount',
        label: 'Hide discounts',
        value: 'false',
        type: 'boolean' as const
    }
]

const SALES_HISTORY_PROFESSIONAL_A4_FIELDS = [
    ...SALES_HISTORY_MODERN_A4_FIELDS,
    {
        key: 'showProductImages',
        label: 'Show product images',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: 'productImageSizeMm',
        label: 'Product image size',
        value: '5',
        type: 'range' as const,
        min: 5,
        max: 16,
        step: 0.5,
        unit: ' mm'
    },
    {
        key: 'showNotes',
        label: 'Show notes',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: 'tableRowCount',
        label: 'Table row count',
        value: String(PROFESSIONAL_A4_TABLE_ROW_COUNT),
        type: 'number' as const
    }
]

const SALES_HISTORY_RECEIPT_FIELDS = [
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showExchangeRateSnapshots,
        label: 'Exchange rate source snapshot',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showOriginalCurrencyPrice,
        label: 'Original currency price',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou,
        label: 'Thank-you text',
        value: '',
        type: 'text' as const,
        placeholder: 'Thank you for shopping with us!'
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord,
        label: 'Keep-record text',
        value: '',
        type: 'text' as const,
        placeholder: 'Please keep this receipt for your records.'
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.labelOpacity,
        label: 'Labels opacity',
        value: '100',
        type: 'number' as const
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes,
        label: 'customTemplates.fields.showNotes',
        value: 'false',
        type: 'boolean' as const
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.notesFontSize,
        label: 'customTemplates.fields.notesFontSize',
        value: '12',
        type: 'range' as const,
        min: 8,
        max: 24,
        step: 1,
        unit: ' px'
    }
]

const INSTANT_HISTORY_RECEIPT_FIELDS = [
    ...SALES_HISTORY_RECEIPT_FIELDS.filter((field) => (
        field.key !== SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes
        && field.key !== SALE_RECEIPT_TEMPLATE_FIELD_KEYS.notesFontSize
    )),
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showTableNumber,
        label: 'Show table number',
        value: 'true',
        type: 'boolean' as const
    },
    {
        key: SALE_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes,
        label: 'customTemplates.fields.showNotes',
        value: 'true',
        type: 'boolean' as const
    }
]

const REAL_ESTATE_BUY_FIELD_PLACEHOLDERS = {
    sellerWitnessName: 'ناوی شاهیدی فرۆشیار بنووسە',
    sellerWitnessAddress: 'ناونیشانی شاهیدی فرۆشیار بنووسە',
    sellerWitnessPhone: 'ژمارەی تەلەفۆنی شاهیدی فرۆشیار بنووسە',
    sellerSignatureName: 'ناوی فرۆشیار بنووسە',
    sellerSignatureAddress: 'ناونیشانی فرۆشیار بنووسە',
    sellerSignaturePhone: 'ژمارەی تەلەفۆنی فرۆشیار بنووسە',
    buyerSignatureName: 'ناوی کڕیار بنووسە',
    buyerSignatureAddress: 'ناونیشانی کڕیار بنووسە',
    buyerSignaturePhone: 'ژمارەی تەلەفۆنی کڕیار بنووسە',
    buyerWitnessName: 'ناوی شاهیدی کڕیار بنووسە',
    buyerWitnessAddress: 'ناونیشانی شاهیدی کڕیار بنووسە',
    buyerWitnessPhone: 'ژمارەی تەلەفۆنی شاهیدی کڕیار بنووسە'
}

export const REAL_ESTATE_BUY_TRANSACTION_KEYS: TemplatePreviewDataKey[] = [
    { key: 'transactionNo', label: '', group: 'Deal' },
    { key: 'transactionType', label: '', group: 'Deal' },
    { key: 'status', label: '', group: 'Deal' },
    { key: 'location', label: '', group: 'Property' },
    { key: 'propertyType', label: '', group: 'Property' },
    { key: 'landAreaM2', label: '', group: 'Property' },
    { key: 'currency', label: '', group: 'Amounts' },
    { key: 'totalAmount', label: '', group: 'Amounts' },
    { key: 'paidAmount', label: '', group: 'Amounts' },
    { key: 'balanceAmount', label: '', group: 'Amounts' },
    { key: 'profitAmount', label: '', group: 'Amounts' },
    { key: 'buyerName', label: '', group: 'Buyer' },
    { key: 'buyerPhone', label: '', group: 'Buyer' },
    { key: 'buyerBusinessPartnerId', label: '', group: 'Buyer' },
    { key: 'buyerWitnessName', label: '', group: 'Buyer' },
    { key: 'buyerWitnessAddress', label: '', group: 'Buyer' },
    { key: 'buyerWitnessPhone', label: '', group: 'Buyer' },
    { key: 'sellerName', label: '', group: 'Seller' },
    { key: 'sellerPhone', label: '', group: 'Seller' },
    { key: 'sellerBusinessPartnerId', label: '', group: 'Seller' },
    { key: 'sellerWitnessName', label: '', group: 'Seller' },
    { key: 'sellerWitnessAddress', label: '', group: 'Seller' },
    { key: 'sellerWitnessPhone', label: '', group: 'Seller' },
    { key: 'isInstallmentBased', label: '', group: 'Installments' },
    { key: 'installmentCount', label: '', group: 'Installments' },
    { key: 'installmentFrequency', label: '', group: 'Installments' },
    { key: 'firstDueDate', label: '', group: 'Installments' },
    { key: 'nextDueDate', label: '', group: 'Installments' },
    { key: 'notes', label: '', group: 'Deal' },
    { key: 'createdAt', label: '', group: 'System' },
    { key: 'updatedAt', label: '', group: 'System' }
]

const REAL_ESTATE_BUY_FIELDS = [
    { key: 'receiptNumber', label: 'ژمارەی وصل', value: '3', type: 'text' as const },
    { key: 'sellerName', label: 'ناوی فرۆشیار', value: '', type: 'text' as const },
    { key: 'sellerPhone', label: 'پەیاسی فرۆشیار', value: 'ناسراوه', type: 'text' as const },
    { key: 'buyerName', label: 'ناوی کڕیار', value: '', type: 'text' as const },
    { key: 'buyerPhone', label: 'پەیاسی کڕیار', value: 'ناسراوه', type: 'text' as const },
    { key: 'contractRow1', label: 'Row 1', value: '', type: 'text' as const },
    { key: 'contractRow2', label: 'Row 2', value: '', type: 'text' as const },
    { key: 'contractRow3', label: 'Row 3', value: '', type: 'text' as const },
    { key: 'contractRow4', label: 'Row 4', value: '', type: 'text' as const },
    { key: 'contractRow5', label: 'Row 5', value: '', type: 'text' as const },
    { key: 'contractRow6', label: 'Row 6', value: '', type: 'text' as const },
    { key: 'contractRow7', label: 'Row 7', value: '', type: 'text' as const },
    { key: 'contractRow8', label: 'Row 8', value: '', type: 'text' as const },
    { key: 'contractRow9', label: 'Row 9', value: '', type: 'text' as const },
    { key: 'contractRow10', label: 'Row 10', value: '', type: 'text' as const },
    { key: 'contractRow11', label: 'Row 11', value: '', type: 'text' as const },
    { key: 'sellerWitnessName', label: 'شاهیدی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerWitnessName },
    { key: 'sellerWitnessAddress', label: 'ناونیشانی شاهیدی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerWitnessAddress },
    { key: 'sellerWitnessPhone', label: 'ژمارەی شاهیدی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerWitnessPhone },
    { key: 'sellerSignatureName', label: 'واژۆی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerSignatureName },
    { key: 'sellerSignatureAddress', label: 'ناونیشانی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerSignatureAddress },
    { key: 'sellerSignaturePhone', label: 'ژمارەی فرۆشیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.sellerSignaturePhone },
    { key: 'buyerSignatureName', label: 'واژۆی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerSignatureName },
    { key: 'buyerSignatureAddress', label: 'ناونیشانی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerSignatureAddress },
    { key: 'buyerSignaturePhone', label: 'ژمارەی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerSignaturePhone },
    { key: 'buyerWitnessName', label: 'شاهیدی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerWitnessName },
    { key: 'buyerWitnessAddress', label: 'ناونیشانی شاهیدی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerWitnessAddress },
    { key: 'buyerWitnessPhone', label: 'ژمارەی شاهیدی کڕیار', value: '', type: 'text' as const, placeholder: REAL_ESTATE_BUY_FIELD_PLACEHOLDERS.buyerWitnessPhone },
    { key: 'note', label: 'تێبینی', value: 'Note', type: 'text' as const }
]

const REAL_ESTATE_BUY_FIELD_TYPES = Object.fromEntries(
    REAL_ESTATE_BUY_FIELDS.map((field) => [field.key, field.type])
)

function createRealEstateFieldsForTransactionType(transactionType: RealEstateTransactionType) {
    const labels = getRealEstateNativeTemplateFieldLabels(transactionType)
    const placeholders = getRealEstateNativeFieldPlaceholders(transactionType)

    return REAL_ESTATE_BUY_FIELDS.map((field) => ({
        ...field,
        label: labels[field.key as keyof typeof labels] || field.label,
        placeholder: placeholders[field.key as keyof typeof placeholders] || field.placeholder
    }))
}

function createRealEstateDataKeysForTransactionType(transactionType: RealEstateTransactionType) {
    const labels = getRealEstateTemplateKeyLabels(transactionType)

    return REAL_ESTATE_BUY_TRANSACTION_KEYS.map((key) => ({
        ...key,
        label: labels[key.key as keyof typeof labels] || key.label,
        group: key.group === 'Buyer'
            ? labels.buyerGroup
            : key.group === 'Seller'
                ? labels.sellerGroup
                : key.group
    }))
}

function buildQrValue(
    workspaceId?: string,
    effectiveId?: string,
    features?: WorkspaceFeatures,
    format: 'a4' | 'receipt' = 'a4'
) {
    if (!features?.print_qr || !workspaceId || !effectiveId || isLocalWorkspaceMode(workspaceId)) {
        return null
    }

    const folder = format === 'receipt' ? 'receipts' : 'A4'
    return `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/${folder}/${effectiveId}.pdf`
}

function createRealEstateContractPreview(
    options: CustomTemplatePreviewOptions,
    moduleTypeKey = 'realEstate.Sell'
): TemplatePreview {
    const transactionType = getRealEstateTransactionTypeFromModuleTypeKey(moduleTypeKey)
    const fields = createRealEstateFieldsForTransactionType(transactionType)
    const dataKeys = createRealEstateDataKeysForTransactionType(transactionType)
    const fieldPlaceholders = getRealEstateNativeFieldPlaceholders(transactionType)

    return {
        fields,
        dataKeys,
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang: 'ku',
        createElement: (data, effectiveId, _printLangOverride, renderOptions) => (
            <RealEstateBuyPrintTemplate
                values={data}
                workspaceName={options.workspaceName}
                logoUrl={options.features?.logo_url}
                qrValue={buildQrValue(options.workspaceId, effectiveId, options.features)}
                workspaceFooterContacts={options.workspaceFooterContacts}
                editableFields={renderOptions?.editableFields}
                fieldTypes={REAL_ESTATE_BUY_FIELD_TYPES}
                fieldPlaceholders={fieldPlaceholders}
                transactionKeys={renderOptions?.dataKeys || dataKeys}
                tokenFieldTemplates={renderOptions?.tokenFieldTemplates}
                transactionType={transactionType}
                printLang={options.features?.print_lang}
                onFieldChange={renderOptions?.onFieldChange}
            />
        ),
        buildPdf: (element) => generateTemplatePdf({
            element,
            printLang: 'ku',
        })
    }
}

function createSalesHistoryModernA4Preview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const receiptData = options.receiptData || SAMPLE_RECEIPT_DATA
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: SALES_HISTORY_MODERN_A4_FIELDS,
        movableComponents: [
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.logo, label: 'Logo' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.qrCode, label: 'QR Code' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.date, label: 'Date' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.time, label: 'Time' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.invoiceNumber, label: 'Invoice #' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.soldTo, label: 'Sold To' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.soldBy, label: 'Sold By' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.itemsTable, label: 'Table' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.terms, label: 'Terms & Conditions' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.exchangeRate, label: 'Exchange Rate' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.totalSummary, label: 'Total Summary' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.generatedBy, label: 'Generated By' },
            { key: MODERN_A4_MOVABLE_COMPONENT_KEYS.contacts, label: 'Contacts' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (data, _effectiveId, _printLangOverride, renderOptions) => (
            <ModernA4InvoiceTemplate
                data={receiptData}
                features={options.features || {}}
                workspaceId={options.workspaceId}
                workspaceName={options.workspaceName ?? undefined}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                hideUnit={data.hideUnit === 'true'}
                hideDiscount={data.hideDiscount === 'true'}
                componentPositions={renderOptions?.componentPositions}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createSalesHistoryProfessionalA4Preview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const receiptData = options.receiptData || SAMPLE_RECEIPT_DATA
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: SALES_HISTORY_PROFESSIONAL_A4_FIELDS,
        supportsBackgroundEdit: true,
        movableComponents: [
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.logo, label: 'Logo' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.qrCode, label: 'QR Code' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.title, label: 'Title' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.subtitle, label: 'Subtitle' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.customer, label: 'Customer' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.saleSummary, label: 'Sale Summary' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.created, label: 'Created' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.payment, label: 'Payment' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.itemsTable, label: 'Items Table' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.totals, label: 'Totals' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.terms, label: 'Terms & Conditions' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.exchangeRates, label: 'Exchange Rates' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.contacts, label: 'Contacts' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.generatedBy, label: 'Generated By' },
            { key: PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.notes, label: 'Notes' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (data, _effectiveId, _printLangOverride, renderOptions) => (
            <ProfessionalA4InvoiceTemplate
                data={receiptData}
                features={options.features || {}}
                workspaceId={options.workspaceId}
                workspaceName={options.workspaceName ?? undefined}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                hideUnit={data.hideUnit === 'true'}
                hideDiscount={data.hideDiscount === 'true'}
                showProductImages={data.showProductImages !== 'false'}
                productImageSizeMm={Number(data.productImageSizeMm) || 5}
                productImageUrls={options.productImageUrls}
                showNotes={data.showNotes === 'true'}
                tableRowCount={Number(data.tableRowCount) || PROFESSIONAL_A4_TABLE_ROW_COUNT}
                componentPositions={renderOptions?.componentPositions}
                hiddenFields={renderOptions?.hiddenFields}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                background={renderOptions?.background}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createSalesHistoryAtlasStandardPreview(
    options: CustomTemplatePreviewOptions,
    printMode: 'sale' | 'return' = 'sale'
): TemplatePreview {
    const sale = options.sale || (printMode === 'return'
        ? SAMPLE_SALES_HISTORY_ATLAS_STANDARD_RETURN_SALE
        : SAMPLE_SALES_HISTORY_ATLAS_STANDARD_SALE)
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'
    const printVersion: OrderPrintVersion = printMode === 'return'
        ? 'returned'
        : options.salesHistoryPrintVersion || 'adjusted'

    return {
        fields: [],
        reflowLowerPageText: true,
        supportsBackgroundEdit: true,
        movableComponents: [
            { key: SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.logo, label: 'Workspace Logo' },
            { key: SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (_data, _effectiveId, printLangOverride, renderOptions) => (
            <SalesHistoryAtlasStandardInvoiceTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                sale={sale}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                printedBy={options.printedBy}
                productImageUrls={options.productImageUrls}
                componentPositions={renderOptions?.componentPositions}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                hiddenFields={renderOptions?.hiddenFields}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                fieldOrders={renderOptions?.fieldOrders}
                onFieldOrderChange={renderOptions?.onFieldOrderChange}
                fieldLabelOverrides={renderOptions?.fieldLabelOverrides}
                onFieldLabelChange={renderOptions?.onFieldLabelChange}
                fieldDisplayModes={renderOptions?.fieldDisplayModes}
                onFieldDisplayModeChange={renderOptions?.onFieldDisplayModeChange}
                background={renderOptions?.background}
                printVersion={printVersion}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createSalesHistoryReceiptPreview(options: CustomTemplatePreviewOptions, includeTableNumber = false): TemplatePreview {
    const receiptData = options.receiptData || (includeTableNumber
        ? { ...SAMPLE_RECEIPT_DATA, origin: 'instant_pos', table_number: '12' }
        : SAMPLE_RECEIPT_DATA)

    return {
        fields: includeTableNumber ? INSTANT_HISTORY_RECEIPT_FIELDS : SALES_HISTORY_RECEIPT_FIELDS,
        movableComponents: [
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.logo, label: 'Logo' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.qrCode, label: 'QR Code' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.date, label: 'Date' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.saleId, label: 'Sale ID' },
            ...(includeTableNumber ? [{ key: RECEIPT_MOVABLE_COMPONENT_KEYS.tableNumber, label: 'Table Number' }] : []),
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.cashier, label: 'Cashier' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.paymentMethod, label: 'Payment Method' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.exchangeRateSnapshots, label: 'Exchange Rate Snapshots' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.itemsTable, label: 'Items Table' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.total, label: 'Total' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.notes, label: 'Notes' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.thankYou, label: 'Thank You' },
            { key: RECEIPT_MOVABLE_COMPONENT_KEYS.keepRecord, label: 'Keep Record' },
        ],
        page: { widthMm: 80, heightMm: 200 },
        createElement: (data, _effectiveId, _printLangOverride, renderOptions) => (
            <div className="mx-auto w-[80mm] bg-white text-black">
                <SaleReceiptBase
                    data={receiptData}
                    features={options.features || {}}
                    workspaceName={options.workspaceName || 'Atlas'}
                    workspaceId={options.workspaceId}
                    templateFields={data}
                    defaultShowNotes={includeTableNumber}
                    editableFields={renderOptions?.editableFields}
                    onTemplateFieldChange={renderOptions?.onFieldChange}
                    componentPositions={renderOptions?.componentPositions}
                    editableComponents={renderOptions?.editableComponents}
                    onComponentPositionChange={renderOptions?.onComponentPositionChange}
                />
            </div>
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'receipt',
            printLang: printLangOverride
        })
    }
}

function createPartnerDetailsPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const partnerDetailsData = options.partnerDetailsData || SAMPLE_PARTNER_DETAILS_DATA
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: PARTNER_DETAILS_FIELDS,
        movableComponents: [
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.logo, label: 'Workspace Logo' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printType, label: 'Print Type' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printInfo, label: 'Print Information and Date Range' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.businessPartnerCard, label: 'Business Partner Card' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.financialSummary, label: 'Financial Summary' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.incomingCash, label: 'Incoming Cash' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.outgoingCash, label: 'Outgoing Cash' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.netFlow, label: 'Net Flow' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.whoOwesWhom, label: 'Who Owes Whom?' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByYou, label: 'Provided by You Table' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByPartner, label: 'Provided by Partner Table' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.topProducts, label: 'Top Products Table' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.notes, label: 'Notes' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.ordersHeader, label: 'Show the Orders Header' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.salesOrders, label: 'Sales Orders Table' },
            { key: PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.purchaseOrders, label: 'Purchases Table' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (data, _effectiveId, printLangOverride, renderOptions) => (
            <PartnerDetailsPrintTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                data={partnerDetailsData}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                showWhoOwesWhom={data[PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showWhoOwesWhom] !== 'false'}
                showOrders={data[PARTNER_DETAILS_TEMPLATE_FIELD_KEYS.showOrders] === 'true'}
                componentPositions={renderOptions?.componentPositions}
                hiddenFields={renderOptions?.hiddenFields}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createPartnerOrderItemsPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const partnerOrderItemsData = options.partnerOrderItemsData || SAMPLE_PARTNER_ORDER_ITEMS_DATA
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: PARTNER_ORDER_ITEMS_FIELDS,
        movableComponents: [
            { key: PARTNER_ORDER_ITEMS_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (data, _effectiveId, printLangOverride, renderOptions) => (
            <PartnerOrderItemsPrintTemplate
                workspaceName={options.workspaceName}
                workspaceDescription={options.features?.store_description}
                printLang={printLangOverride || fixedPrintLang}
                data={partnerOrderItemsData}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                showPaidAmount={data[PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showPaidAmount] !== 'false'}
                showRemainingAmount={data[PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showRemainingAmount] !== 'false'}
                showSettlementActivity={data[PARTNER_ORDER_ITEMS_TEMPLATE_FIELD_KEYS.showSettlementActivity] !== 'false'}
                componentPositions={renderOptions?.componentPositions}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createPartnerAccountStatementPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const partnerAccountStatementData = options.partnerAccountStatementData || SAMPLE_PARTNER_ORDER_ITEMS_DATA
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: [],
        movableComponents: [],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (_data, _effectiveId, printLangOverride) => (
            <PartnerAccountStatementPrintTemplate
                workspaceName={options.workspaceName}
                workspaceDescription={options.features?.store_description}
                printLang={printLangOverride || fixedPrintLang}
                data={partnerAccountStatementData}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createLoanAccountStatementPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const loanAccountStatementData = options.loanAccountStatementData || {
        partner: { partnerName: 'Sample Partner', phone: '', address: '' },
        loan: { id: 'sample-loan', loanNo: 'LOAN-001', direction: 'lent' as const, settlementCurrency: 'iqd' as const },
        selectedPayment: { id: 'sample-payment', amount: 200000, paymentMethod: 'cash' as const, paidAt: '2026-08-28T10:00:00.000Z', note: '' },
        currency: 'iqd' as const,
        previous: { debit: 1000000, credit: 300000, balance: 700000, entryCount: 5 },
        repayment: { debit: 0, credit: 200000, balance: 500000, date: '2026-08-28T10:00:00.000Z', reference: 'LOAN-001' },
        totals: { debit: 1000000, credit: 500000, balance: 500000 },
        generatedAt: '2026-08-28T10:00:00.000Z'
    } satisfies LoanAccountStatementPrintData
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: [],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (_data, _effectiveId, printLangOverride) => (
            <LoanAccountStatementPrintTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                data={loanAccountStatementData}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createOrderDetailsPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const order = options.order || SAMPLE_ORDER_DATA
    const kind = options.orderKind || 'sales'
    const counterpartyPhone = options.counterpartyPhone || (order === SAMPLE_ORDER_DATA ? '+964 750 000 0000' : '')
    const counterpartyAddress = options.counterpartyAddress || (order === SAMPLE_ORDER_DATA ? 'Business District, Erbil' : '')
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: ORDER_DETAILS_FIELDS,
        movableComponents: [
            {
                key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.customer,
                label: kind === 'sales' ? 'Customer' : 'Supplier'
            },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.commercials, label: 'Commercials' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.created, label: 'Created' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.expectedDelivery, label: 'Expected Delivery' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.orderItems, label: 'Order Items and Table' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.totals, label: 'Subtotal, Discount, Tax and Total' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.logo, label: 'Logo' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.qrCode, label: 'QR Code' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.title, label: 'Title' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.subtitle, label: 'Subtitle' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.contacts, label: 'Contacts' },
            { key: ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.notes, label: 'Notes' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        createElement: (data, effectiveId, printLangOverride, renderOptions) => (
            <OrderDetailsPrintTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                order={order}
                installments={options.orderInstallments || []}
                kind={kind}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                qrValue={buildQrValue(options.workspaceId, effectiveId, options.features)}
                hideUnit={data[ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideUnit] === 'true'}
                productUnits={options.productUnits}
                hideDiscount={data[ORDER_DETAILS_TEMPLATE_FIELD_KEYS.hideDiscount] === 'true'}
                templateFields={data}
                counterpartyPhone={counterpartyPhone}
                counterpartyAddress={counterpartyAddress}
                tableRowCount={Number(data.tableRowCount) || 10}
                componentPositions={renderOptions?.componentPositions}
                hiddenFields={renderOptions?.hiddenFields}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                printVersion={options.orderPrintVersion}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createAtlasStandardOrderInvoicePreview(
    options: CustomTemplatePreviewOptions,
    printMode: 'order' | 'return' = 'order'
): TemplatePreview {
    const order = printMode === 'return' && options.orderKind !== 'sales'
        ? SAMPLE_ORDER_DATA
        : options.order || SAMPLE_ORDER_DATA
    const kind = printMode === 'return' ? 'sales' : options.orderKind || 'sales'
    const partnerId = order.businessPartnerId
        || (kind === 'sales' ? (order as SalesOrder).customerId : (order as PurchaseOrder).supplierId)
    const requiresFreshPartnerBalance = Boolean(options.workspaceId && partnerId)
    const partnerBalancePrintState = options.partnerBalancePrintState
        || createAtlasStandardPartnerBalancePrintState(requiresFreshPartnerBalance)
    const effectivePrintVersion: OrderPrintVersion = printMode === 'return'
        ? 'returned'
        : options.orderPrintVersion || 'adjusted'
    const returnPrintData = effectivePrintVersion === 'returned'
        ? options.orderReturnPrintData || createSampleSalesOrderReturnPrintData(order as SalesOrder)
        : undefined
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: printMode === 'order' ? ATLAS_STANDARD_ORDER_FIELDS : [],
        reflowLowerPageText: true,
        supportsBackgroundEdit: true,
        movableComponents: [
            { key: ATLAS_STANDARD_ORDER_MOVABLE_COMPONENT_KEYS.logo, label: 'Workspace Logo' },
            { key: ATLAS_STANDARD_ORDER_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' }
        ],
        page: { widthMm: 210, heightMm: 297 },
        fixedPrintLang,
        requiresFreshPartnerBalance,
        resetFreshPartnerBalance: () => resetAtlasStandardPartnerBalancePrintState(
            partnerBalancePrintState,
            requiresFreshPartnerBalance
        ),
        freshPartnerBalanceRequest: options.workspaceId && partnerId
            ? { workspaceId: options.workspaceId, partnerId }
            : undefined,
        onFreshPartnerBalanceStateChange: (status, balances) => {
            partnerBalancePrintState.status = status
            partnerBalancePrintState.balances = balances
        },
        createElement: (data, _effectiveId, printLangOverride, renderOptions) => (
            <AtlasStandardOrderInvoiceTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                order={order}
                installments={options.orderInstallments || []}
                kind={kind}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                businessPartner={options.businessPartner}
                partnerAccountStatementBalances={options.partnerAccountStatementBalances}
                partnerBalancePrintState={partnerBalancePrintState}
                printedBy={options.printedBy}
                productImageUrls={options.productImageUrls}
                componentPositions={renderOptions?.componentPositions}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                hiddenFields={renderOptions?.hiddenFields}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                fieldOrders={renderOptions?.fieldOrders}
                onFieldOrderChange={renderOptions?.onFieldOrderChange}
                fieldLabelOverrides={renderOptions?.fieldLabelOverrides}
                onFieldLabelChange={renderOptions?.onFieldLabelChange}
                fieldDisplayModes={renderOptions?.fieldDisplayModes}
                onFieldDisplayModeChange={renderOptions?.onFieldDisplayModeChange}
                background={renderOptions?.background}
                templateFields={data}
                returnPrintData={returnPrintData}
                printVersion={effectivePrintVersion}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

function createOrderReceiptPreview(options: CustomTemplatePreviewOptions): TemplatePreview {
    const order = options.order || SAMPLE_ORDER_DATA
    const kind = options.orderKind || 'sales'
    const counterpartyPhone = options.counterpartyPhone || (order === SAMPLE_ORDER_DATA ? '+964 750 000 0000' : '')
    const configuredPrintLang = options.features?.print_lang
    const printLang = options.printLang
        || (configuredPrintLang && configuredPrintLang !== 'auto' ? configuredPrintLang : 'en')
    const fixedPrintLang: TemplatePreview['fixedPrintLang'] = printLang.startsWith('ar')
        ? 'ar'
        : printLang.startsWith('ku')
            ? 'ku'
            : 'en'

    return {
        fields: ORDER_RECEIPT_FIELDS,
        movableComponents: [
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.logo, label: 'Logo' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.workspaceName, label: 'Workspace Name' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.qrCode, label: 'QR Code' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.orderMeta, label: 'Order Details' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.counterparty, label: kind === 'sales' ? 'Customer' : 'Supplier' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.payment, label: 'Payment' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.exchangeRateSnapshots, label: 'Exchange Rate Snapshots' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.itemsTable, label: 'Items Table' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.totals, label: 'Totals and Balance' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.notes, label: 'Notes' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.contacts, label: 'Contacts' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.thankYou, label: 'Thank You' },
            { key: ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.keepRecord, label: 'Keep Record' }
        ],
        page: { widthMm: 80, heightMm: 200 },
        fixedPrintLang,
        createElement: (data, effectiveId, printLangOverride, renderOptions) => (
            <OrderReceiptPrintTemplate
                workspaceName={options.workspaceName}
                printLang={printLangOverride || fixedPrintLang}
                order={order}
                installments={options.orderInstallments || []}
                kind={kind}
                iqdPreference={options.features?.iqd_display_preference}
                logoUrl={options.features?.logo_url}
                qrValue={buildQrValue(options.workspaceId, effectiveId, options.features, 'receipt')}
                productUnits={options.productUnits}
                counterpartyPhone={counterpartyPhone}
                workspaceFooterContacts={renderOptions?.workspaceFooterContacts || options.workspaceFooterContacts}
                templateFields={data}
                editableFields={renderOptions?.editableFields}
                onTemplateFieldChange={renderOptions?.onFieldChange}
                componentPositions={renderOptions?.componentPositions}
                editableComponents={renderOptions?.editableComponents}
                onComponentPositionChange={renderOptions?.onComponentPositionChange}
                printVersion={options.orderPrintVersion}
            />
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element,
            format: 'receipt',
            printLang: printLangOverride || fixedPrintLang
        })
    }
}

export function createCustomTemplatePreview(
    target: CustomTemplateTarget,
    options: CustomTemplatePreviewOptions = {}
): TemplatePreview {
    if (target.moduleTypeKey === SALES_HISTORY_RECEIPT_TEMPLATE_KEY) {
        return createSalesHistoryReceiptPreview(options)
    }

    if (target.moduleTypeKey === INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY) {
        return createSalesHistoryReceiptPreview(options, true)
    }

    if (target.moduleTypeKey === SALES_HISTORY_MODERN_A4_TEMPLATE_KEY) {
        return createSalesHistoryModernA4Preview(options)
    }

    if (target.moduleTypeKey === SALES_HISTORY_PROFESSIONAL_A4_TEMPLATE_KEY) {
        return createSalesHistoryProfessionalA4Preview(options)
    }

    if (target.moduleTypeKey === SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY) {
        return createSalesHistoryAtlasStandardPreview(options)
    }

    if (target.moduleTypeKey === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY) {
        return createSalesHistoryAtlasStandardPreview(options, 'return')
    }

    if (target.moduleTypeKey === PARTNER_DETAILS_TEMPLATE_KEY) {
        return createPartnerDetailsPreview(options)
    }

    if (target.moduleTypeKey === PARTNER_ORDER_ITEMS_TEMPLATE_KEY) {
        return createPartnerOrderItemsPreview(options)
    }

    if (target.moduleTypeKey === PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY) {
        return createPartnerAccountStatementPreview(options)
    }

    if (target.moduleTypeKey === LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY) {
        return createLoanAccountStatementPreview(options)
    }

    if (target.moduleTypeKey === ORDER_ATLAS_STANDARD_TEMPLATE_KEY) {
        return createAtlasStandardOrderInvoicePreview(options)
    }

    if (target.moduleTypeKey === ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY) {
        return createAtlasStandardOrderInvoicePreview(options, 'return')
    }

    if (target.moduleTypeKey === ORDER_DETAILS_TEMPLATE_KEY) {
        return createOrderDetailsPreview(options)
    }

    if (target.moduleTypeKey === ORDER_RECEIPT_TEMPLATE_KEY) {
        return createOrderReceiptPreview(options)
    }

    if (REAL_ESTATE_CONTRACT_MODULE_TYPE_KEYS.has(target.moduleTypeKey)) {
        return createRealEstateContractPreview(options, target.moduleTypeKey)
    }

    return {
        fields: [],
        page: target.page,
        createElement: () => (
            <div
                className="mx-auto border border-slate-200 bg-white px-10 py-9 text-slate-950 shadow-sm"
                style={{ width: '210mm', minHeight: '297mm' }}
            >
                <div className="flex items-start justify-between border-b border-slate-200 pb-6">
                    <div>
                        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                            {target.moduleLabel}
                        </div>
                        <h2 className="mt-2 text-2xl font-semibold">{target.typeLabel} Print Template</h2>
                    </div>
                    <div className="rounded border border-slate-200 px-3 py-2 text-xs font-medium text-slate-500">
                        {target.moduleTypeKey}
                    </div>
                </div>

                <div className="mt-16 rounded-md border border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center">
                    <p className="text-sm font-medium text-slate-800">Native template is not configured yet.</p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                        Custom text, images, and annotations can be positioned here and saved as the workspace custom layout.
                    </p>
                </div>
            </div>
        ),
        buildPdf: (element, printLangOverride) => generateTemplatePdf({ element, printLang: printLangOverride })
    }
}

function nonBlankFields(fields: Record<string, string>) {
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value.trim().length > 0)
    )
}

function CustomTemplateLayoutOverlay({
    layout,
    heightMm,
    reflowLowerPageText = false
}: {
    layout: CustomTemplateLayout
    heightMm: number
    reflowLowerPageText?: boolean
}) {
    const pageWidth = layout.page.widthMm || 210
    const pageHeight = layout.page.heightMm || 297

    return (
        <div
            className="pointer-events-none absolute start-0 top-0 overflow-visible"
            style={{ width: '100%', height: `${heightMm}mm` }}
        >
            <svg className="absolute inset-0 z-40 h-full w-full" viewBox={`0 0 ${pageWidth} ${heightMm}`}>
                {layout.annotations.map((annotation, index) => (
                    <path
                        key={`annotation-${index}`}
                        d={`M ${annotation.points.map((point) => `${point.x},${point.y}`).join(' L ')}`}
                        stroke={annotation.color}
                        strokeWidth={annotation.brushSize}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={annotation.type === 'brush' ? 0.5 : 1}
                    />
                ))}
            </svg>

            {layout.images.map((image, index) => (
                <img
                    key={`image-${index}`}
                    src={platformService.convertFileSrc(image.path)}
                    alt=""
                    className="absolute block select-none"
                    style={{
                        left: `${(image.x / pageWidth) * 100}%`,
                        top: `${(image.y / heightMm) * 100}%`,
                        width: `${(image.width / pageWidth) * 100}%`,
                        transform: `rotate(${image.rotation || 0}deg)`,
                        transformOrigin: 'top left',
                        zIndex: 60 + index
                    }}
                />
            ))}

            {(layout.shapes || []).map((shape, index) => (
                <div
                    key={`shape-${shape.id || index}`}
                    className="absolute"
                    style={{
                        left: `${(shape.x / pageWidth) * 100}%`,
                        top: `${(shape.y / heightMm) * 100}%`,
                        width: `${(shape.width / pageWidth) * 100}%`,
                        height: `${(getPdfShapeHeight(shape) / heightMm) * 100}%`,
                        transform: `translate(-50%, -50%) rotate(${shape.rotation || 0}deg)`,
                        transformOrigin: 'center',
                        zIndex: getPdfShapeZIndex(shape)
                    }}
                >
                    <PdfShapeGraphic kind={shape.kind} color={shape.color} />
                </div>
            ))}

            {layout.texts.map((text, index) => {
                const reflowsAfterContent = shouldReflowCustomTemplateText(text, pageHeight, reflowLowerPageText)

                return (
                    <div
                        key={`text-${text.id || index}`}
                        dir={resolveIsolatedTextDirection(text.text)}
                        data-template-text-flow={reflowsAfterContent ? 'after-content' : undefined}
                        data-template-text-y-mm={reflowsAfterContent ? text.y : undefined}
                        className="absolute whitespace-pre-wrap break-words font-bold leading-snug"
                        style={{
                            left: `${(text.x / pageWidth) * 100}%`,
                            top: `${text.y}mm`,
                            width: `${(text.width / pageWidth) * 100}%`,
                            transform: `rotate(${text.rotation || 0}deg)`,
                            transformOrigin: 'top left',
                            zIndex: 100 + index,
                            fontSize: `${text.fontSize || 16}px`,
                            color: text.color || '#000000'
                        }}
                    >
                        {text.text}
                    </div>
                )
            })}
        </div>
    )
}

export function renderCustomTemplateLayoutElement({
    target,
    layout,
    values,
    options,
    effectiveId,
    fieldMode = 'nonBlankLayoutOverrides'
}: {
    target: CustomTemplateTarget
    layout: CustomTemplateLayout
    values: Record<string, string>
    options?: CustomTemplatePreviewOptions
    effectiveId?: string
    fieldMode?: 'nonBlankLayoutOverrides' | 'layoutOverrides'
}) {
    const preview = createCustomTemplatePreview(target, options)
    const fieldValues = {
        ...values,
        ...(fieldMode === 'layoutOverrides' ? layout.fields || {} : nonBlankFields(layout.fields || {}))
    }
    const pageHeight = layout.page.heightMm || 297
    const isReceiptTemplate = target.printFormat === 'receipt'
    const layoutPageCount = isReceiptTemplate ? 1 : getCustomTemplateLayoutPageCount(layout)
    const layoutOverflowHeight = getCustomTemplateLayoutOverflowHeightMm(layout)
    const layoutHeight = isReceiptTemplate
        ? Math.max(1, layoutOverflowHeight)
        : layoutPageCount * pageHeight

    return (
        <div
            data-custom-template-export-root=""
            className="relative mx-auto overflow-visible bg-white text-black"
            style={{
                width: `${layout.page.widthMm || 210}mm`,
                minHeight: `${layoutHeight}mm`
            }}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
[data-custom-template-export-root] [data-order-print-page] {
    min-height: ${layoutHeight}mm !important;
    overflow: visible !important;
}
`
                }}
            />
            {Array.from({ length: layoutPageCount }).map((_, pageIndex) => (
                <div
                    key={`template-page-bg-${pageIndex}`}
                    className="absolute left-0 top-0 z-0 bg-white"
                    style={{
                        width: '100%',
                        height: `${isReceiptTemplate ? layoutHeight : pageHeight}mm`,
                        transform: `translateY(${isReceiptTemplate ? 0 : pageIndex * pageHeight}mm)`
                    }}
                />
            ))}
            <div className="relative">
                {preview.createElement(fieldValues, effectiveId, preview.fixedPrintLang, {
                    tokenFieldTemplates: layout.fieldTokenTemplates,
                    componentPositions: layout.componentPositions,
                    hiddenFields: layout.hiddenFields,
                    fieldOrders: layout.fieldOrders,
                    fieldLabelOverrides: layout.fieldLabelOverrides,
                    fieldDisplayModes: layout.fieldDisplayModes,
                    background: layout.background
                })}
            </div>
            <CustomTemplateLayoutOverlay
                layout={layout}
                heightMm={isReceiptTemplate
                    ? layoutHeight
                    : Math.max(layoutHeight, getCustomTemplateLayoutHeightMm(layout))}
                reflowLowerPageText={preview.reflowLowerPageText}
            />
        </div>
    )
}

export async function buildCustomTemplateLayoutPdf({
    target,
    layout,
    values,
    options,
    effectiveId,
    fieldMode = 'nonBlankLayoutOverrides'
}: {
    target: CustomTemplateTarget
    layout: CustomTemplateLayout
    values: Record<string, string>
    options?: CustomTemplatePreviewOptions
    effectiveId?: string
    fieldMode?: 'nonBlankLayoutOverrides' | 'layoutOverrides'
}) {
    const preview = createCustomTemplatePreview(target, options)
    const printableLayout = fieldMode === 'layoutOverrides'
        ? layout
        : {
            ...layout,
            fields: nonBlankFields(layout.fields || {})
        }
    const element = renderCustomTemplateLayoutElement({
        target,
        layout: printableLayout,
        values,
        options,
        effectiveId,
        fieldMode
    })

    return generateTemplatePdf({
        element,
        format: target.printFormat,
        printLang: preview.fixedPrintLang,
    })
}
