import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd'
import { GripVertical } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
    type CurrencyCode,
    type IQDDisplayPreference,
    type SalesOrder
} from '@/local-db'
import { getOrderLineInventoryQuantity, getOrderLinePaidQuantity } from '@/lib/orderLineItems'
import {
    getA4OrderPrintReturnRowStyle,
    getOrderPrintReturnState,
    type OrderPrintVersion
} from '@/lib/orderPrintReturnState'
import type { SalesOrderReturnPrintData } from '@/lib/orderReturnPrintData'
import { isPostReturnOrderAdjustment } from '@/lib/orderAdjustments'
import {
    ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM,
    ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
    chunkAtlasStandardTableRows,
    clampProductImageColumnWidth,
    DEFAULT_PRODUCT_IMAGE_COLUMN_WIDTH,
    getProductImageSizeMm,
    MAX_PRODUCT_IMAGE_COLUMN_WIDTH,
    MIN_PRODUCT_IMAGE_COLUMN_WIDTH,
    resolveAtlasStandardTableCapacities
} from '@/lib/atlasStandardOrderTablePagination'
import { cn, formatCurrency } from '@/lib/utils'
import { normalizeUnitCode } from '@/local-db/models'
import type { Sale } from '@/types'
import { platformService } from '@/services/platformService'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/ui/components/dialog'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger
} from '@/ui/components/ui/context-menu'
import type { CustomTemplateComponentPosition, CustomTemplateBackground } from '@/lib/printPreviewEditorStore'
import { MovableOrderPrintBlock } from '@/ui/components/MovableComponentPrint'
import { ReorderablePickerGrid } from '@/ui/components/ReorderablePickerGrid'

import { ProductPrintImage, type ProductPrintImageUrls } from '@/ui/components/print/ProductPrintImage'
import { OrderPrintReturnValue } from '@/ui/components/orders/OrderPrintReturnValue'

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

export interface SalesHistoryAtlasStandardInvoiceTemplateProps {
    workspaceName?: string | null
    printLang: string
    sale: Sale
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    workspaceFooterContacts?: WorkspaceFooterContacts
    printedBy?: string | null
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    hiddenFields?: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    fieldOrders?: Record<string, string[]>
    onFieldOrderChange?: (sectionKey: string, fieldKeys: string[]) => void
    fieldLabelOverrides?: Record<string, string>
    onFieldLabelChange?: (fieldKey: string, label: string) => void
    fieldDisplayModes?: Record<string, string>
    onFieldDisplayModeChange?: (fieldKey: string, mode: string) => void
    productImageUrls?: ProductPrintImageUrls
    background?: CustomTemplateBackground | null
    templateFields?: Record<string, string>
    /** Renders a return-only document with the same Atlas Standard editor controls. */
    returnPrintData?: SalesOrderReturnPrintData | null
    /** Whether to show adjusted values, original order values, or return-only values. */
    printVersion?: OrderPrintVersion
}

const INK = '#1f2937'

export const SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS = {
    logo: 'salesHistoryAtlasStandardWorkspaceLogo',
    workspaceName: 'salesHistoryAtlasStandardWorkspaceName'
} as const

export const SALES_HISTORY_ATLAS_STANDARD_HIDDEN_FIELD_KEYS = {
    invoiceDetails: {
        saleType: 'salesHistoryAtlasStandard.invoiceDetails.saleType',
        saleNumber: 'salesHistoryAtlasStandard.invoiceDetails.saleNumber',
        cashier: 'salesHistoryAtlasStandard.invoiceDetails.cashier',
        saleStatus: 'salesHistoryAtlasStandard.invoiceDetails.saleStatus',
        saleDate: 'salesHistoryAtlasStandard.invoiceDetails.saleDate',
        time: 'salesHistoryAtlasStandard.invoiceDetails.time'
    },
    table: {
        productImage: 'salesHistoryAtlasStandard.table.productImage',
        number: 'salesHistoryAtlasStandard.table.number',
        product: 'salesHistoryAtlasStandard.table.product',
        sku: 'salesHistoryAtlasStandard.table.sku',
        batchNumber: 'salesHistoryAtlasStandard.table.batchNumber',
        quantity: 'salesHistoryAtlasStandard.table.quantity',
        price: 'salesHistoryAtlasStandard.table.price',
        total: 'salesHistoryAtlasStandard.table.total',
        note: 'salesHistoryAtlasStandard.table.note'
    },
    financialSummary: {
        paidTotal: 'salesHistoryAtlasStandard.financialSummary.paidTotal',
        refundedAmount: 'salesHistoryAtlasStandard.financialSummary.refundedAmount',
        netTotal: 'salesHistoryAtlasStandard.financialSummary.netTotal',
        paymentMethod: 'salesHistoryAtlasStandard.financialSummary.paymentMethod',
        amountInWords: 'salesHistoryAtlasStandard.financialSummary.amountInWords',
        printedBy: 'salesHistoryAtlasStandard.financialSummary.printedBy',
        notes: 'salesHistoryAtlasStandard.financialSummary.notes'
    }
} as const

export const SALES_HISTORY_ATLAS_STANDARD_FIELD_ORDER_KEYS = {
    invoiceDetails: 'salesHistoryAtlasStandard.invoiceDetails',
    financialSummary: 'salesHistoryAtlasStandard.financialSummary'
} as const

export const SALES_HISTORY_ATLAS_STANDARD_TABLE_SETTING_KEYS = {
    productImageWidth: 'salesHistoryAtlasStandard.table.productImage.width',
    productKgTotal: 'salesHistoryAtlasStandard.table.productKgTotal'
} as const

type TableColumn = {
    key: string
    label: string
    width: string
    contextMenu?: ReactNode
    defaultLabel?: string
}

/**
 * Applies the user's label overrides to the table columns. Shared by the
 * editable first table and every continuation table so all pages of the order
 * items table always render the exact same column definitions.
 */
function resolveTitledTableColumns(
    columns: TableColumn[],
    fieldLabelOverrides: Record<string, string>
): TableColumn[] {
    return columns.map((column) => {
        const defaultLabel = column.defaultLabel || column.label
        const labelOverride = fieldLabelOverrides[column.key]?.trim()
        return {
            ...column,
            defaultLabel,
            label: labelOverride || column.label
        }
    })
}

/**
 * Resolves the columns that are actually printed: label overrides applied and
 * hidden columns removed. Used to render continuation tables with the exact
 * same definitions as the first page's order items table.
 */
function resolveVisibleTableColumns(
    columns: TableColumn[],
    fieldLabelOverrides: Record<string, string>,
    hiddenFields: Record<string, boolean>
): TableColumn[] {
    return resolveTitledTableColumns(columns, fieldLabelOverrides).filter((column) => !hiddenFields[column.key])
}

function getProductNameWeightKg(productName?: string | null) {
    const match = (productName || '').trim().match(/(\d+(?:\.\d+)?)\s*kg/i)
    return match ? Number(match[1]) : 0
}

function ImageColumnWidthControl({
    columnWidth,
    onColumnWidthChange,
    label
}: {
    columnWidth: number
    onColumnWidthChange: (width: number) => void
    label: string
}) {
    const [inputValue, setInputValue] = useState(String(columnWidth))
    const imageSizeMm = getProductImageSizeMm(columnWidth)
    const updateWidth = (value: number) => {
        const nextWidth = clampProductImageColumnWidth(value)
        setInputValue(String(nextWidth))
        onColumnWidthChange(nextWidth)
    }

    return (
        <div
            className="w-64 space-y-3 p-2"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{label}</span>
                <output className="text-sm tabular-nums text-muted-foreground">{columnWidth}%</output>
            </div>
            <input
                aria-label={label}
                type="range"
                min={MIN_PRODUCT_IMAGE_COLUMN_WIDTH}
                max={MAX_PRODUCT_IMAGE_COLUMN_WIDTH}
                step="0.5"
                value={columnWidth}
                className="w-full accent-primary"
                onChange={(event) => updateWidth(Number(event.target.value))}
            />
            <label className="flex items-center justify-between gap-3 text-sm" htmlFor="atlas-standard-product-image-column-width">
                <span>Width (%)</span>
                <input
                    id="atlas-standard-product-image-column-width"
                    type="text"
                    lang="en"
                    min={MIN_PRODUCT_IMAGE_COLUMN_WIDTH}
                    max={MAX_PRODUCT_IMAGE_COLUMN_WIDTH}
                    step="0.5"
                    inputMode="decimal"
                    className="h-8 w-20 rounded-md border border-input bg-background px-2 text-end text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    value={inputValue}
                    onChange={(event) => {
                        const nextValue = event.target.value
                        setInputValue(nextValue)
                        const nextWidth = Number(nextValue)
                        if (Number.isFinite(nextWidth)) onColumnWidthChange(clampProductImageColumnWidth(nextWidth))
                    }}
                    onBlur={() => updateWidth(Number(inputValue))}
                />
            </label>
            <p className="text-xs leading-4 text-muted-foreground">Photo size: {imageSizeMm} mm</p>
        </div>
    )
}

type HideablePrintField = {
    key: string
    label: ReactNode
    defaultLabel?: string
    value?: ReactNode
    render?: ReactNode | ((label: ReactNode) => ReactNode)
    className?: string
    dialogClassName?: string
    layoutRow?: number
    layoutSpan?: number
    suppressLabelOverride?: boolean
    contextMenuMode?: {
        active: boolean
        activateLabel: string
        deactivateLabel: string
        onChange: (active: boolean) => void
    }
}

function getGridSpan(className?: string) {
    if (className?.includes('col-span-4')) return 4
    if (className?.includes('col-span-3')) return 3
    if (className?.includes('col-span-2')) return 2
    return 1
}

function orderFieldsForLayout(fields: HideablePrintField[], fieldOrder?: string[]) {
    const fieldsByKey = new Map(fields.map((field) => [field.key, field]))
    const usedKeys = new Set<string>()
    const orderedKeys = (fieldOrder || [])
        .filter((key) => fieldsByKey.has(key) && !usedKeys.has(key))
        .filter((key) => {
            usedKeys.add(key)
            return true
        })

    fields.forEach((field) => {
        if (!usedKeys.has(field.key)) orderedKeys.push(field.key)
    })

    let layoutRow = 0
    let usedColumns = 0

    return orderedKeys.map((key, index) => {
        const field = fieldsByKey.get(key)!
        const slot = fields[index] || field
        const layoutSpan = getGridSpan(slot.className)
        if (usedColumns + layoutSpan > 4) {
            layoutRow += 1
            usedColumns = 0
        }
        const fieldLayoutRow = layoutRow
        usedColumns += layoutSpan
        if (usedColumns === 4) {
            layoutRow += 1
            usedColumns = 0
        }
        return {
            ...field,
            className: slot.className,
            dialogClassName: slot.dialogClassName,
            layoutRow: fieldLayoutRow,
            layoutSpan
        }
    })
}

function isRTL(language: string) {
    const baseLanguage = (language || 'en').split('-')[0]
    return baseLanguage === 'ar' || baseLanguage === 'ku'
}

function hasRTLText(value: string) {
    return /[\u0590-\u08FF]/.test(value)
}

type AtlasStandardLocale = 'en' | 'ar' | 'ku'

function resolveAtlasStandardLocale(language: string): AtlasStandardLocale {
    const baseLanguage = (language || 'en').split('-')[0]
    return baseLanguage === 'ar' || baseLanguage === 'ku' ? baseLanguage : 'en'
}

const ATLAS_STANDARD_LABELS = {
    en: {
        customer: 'Customer', supplier: 'Supplier', invoice: 'Invoice', salesOrder: 'Sales Order', purchaseOrder: 'Purchase Order', number: 'No.', phone: 'Phone', salesPerson: 'Cashier', partnerAddress: "Partner's Address", status: 'Status', documentNumber: 'Document No.', invoiceDate: 'Inv. date', time: 'Time',
        productName: 'Product Name', expiry: 'EXP', batchNumber: 'Batch No.', quantity: 'Qty', freeQuantity: 'Free Qty', price: 'Price', total: 'Total', note: 'Note',
        paidAmount: 'Paid Amount', discount: 'Discount', amountInWords: 'Amount in words', paymentMethod: 'Payment Method', outstanding: 'Order Outstanding', currentBalance: "Partner's Current Balance", printedBy: 'Printed by', notes: 'Notes',
        invoiceDetails: 'Invoice details', orderItemsTable: 'Order items table', financialSummary: 'Financial summary', selectValues: 'Select the values to include in this print.', selectColumns: 'Select the table columns to include in this print.', noColumns: 'No item columns selected', dragToSwap: 'Drag to swap position', renameTitle: 'Rename title', renameTitleDescription: 'Use a custom title for this value in the print.', title: 'Title', save: 'Save', cancel: 'Cancel', resetTitle: 'Reset title', invoiceOrganizer: 'Invoice Organizer', switchToInvoiceOrganizer: 'Switch to Invoice Organizer', switchToCashier: 'Switch to Cashier', logo: 'LOGO', workspaceLogo: 'Workspace logo', workspaceName: 'Workspace Name', email: 'Email', madeBy: 'Made By AtlasERP', page: 'Page', pageOf: 'from', printDate: 'Print date', enableKgTotal: 'Show weight total (Kg/Ton)', disableKgTotal: 'Hide weight total',
        statuses: { draft: 'Draft', pending: 'Pending', completed: 'Completed', cancelled: 'Cancelled', ordered: 'Ordered', received: 'Received' },
        paymentMethods: { cash: 'Cash', fib: 'FIB', qicard: 'Qi Card', zaincash: 'Zain Cash', fastpay: 'FastPay', bank_transfer: 'Bank Transfer', loan: 'Loan', installments: 'Installments' }
    },
    ar: {
        customer: 'العميل', supplier: 'المورد', invoice: 'الفاتورة', salesOrder: 'طلب مبيعات', purchaseOrder: 'طلب شراء', number: 'الرقم', phone: 'الهاتف', salesPerson: 'أمين الصندوق', partnerAddress: 'عنوان الشريك', status: 'الحالة', documentNumber: 'رقم المستند', invoiceDate: 'تاريخ الفاتورة', time: 'الوقت',
        productName: 'اسم المنتج', expiry: 'الصلاحية', batchNumber: 'رقم التشغيلة', quantity: 'الكمية', freeQuantity: 'كمية مجانية', price: 'السعر', total: 'الإجمالي', note: 'ملاحظة',
        paidAmount: 'المبلغ المدفوع', discount: 'الخصم', amountInWords: 'المبلغ كتابة', paymentMethod: 'طريقة الدفع', outstanding: 'المبلغ المتبقي للطلب', currentBalance: 'الرصيد الحالي للشريك', printedBy: 'طبع بواسطة', notes: 'ملاحظات',
        invoiceDetails: 'تفاصيل الفاتورة', orderItemsTable: 'جدول أصناف الطلب', financialSummary: 'الملخص المالي', selectValues: 'اختر القيم التي تريد تضمينها في هذه الطباعة.', selectColumns: 'اختر أعمدة الجدول التي تريد تضمينها في هذه الطباعة.', noColumns: 'لم يتم اختيار أي أعمدة للأصناف', dragToSwap: 'اسحب لتبديل الموضع', renameTitle: 'إعادة تسمية العنوان', renameTitleDescription: 'استخدم عنواناً مخصصاً لهذه القيمة في الطباعة.', title: 'العنوان', save: 'حفظ', cancel: 'إلغاء', resetTitle: 'استعادة العنوان', invoiceOrganizer: 'منظم الفاتورة', switchToInvoiceOrganizer: 'التبديل إلى منظم الفاتورة', switchToCashier: 'التبديل إلى أمين الصندوق', logo: 'الشعار', workspaceLogo: 'شعار مساحة العمل', workspaceName: 'اسم مساحة العمل', email: 'البريد الإلكتروني', madeBy: 'تم الإنشاء بواسطة AtlasERP', page: 'الصفحة', pageOf: 'من', printDate: 'تاريخ الطباعة', enableKgTotal: 'إظهار إجمالي الوزن (كجم/طن)', disableKgTotal: 'إخفاء إجمالي الوزن',
        statuses: { draft: 'مسودة', pending: 'قيد الانتظار', completed: 'مكتمل', cancelled: 'ملغى', ordered: 'تم الطلب', received: 'تم الاستلام' },
        paymentMethods: { cash: 'نقدي', fib: 'FIB', qicard: 'كي كارد', zaincash: 'زين كاش', fastpay: 'فاست باي', bank_transfer: 'تحويل بنكي', loan: 'قرض', installments: 'أقساط' }
    },
    ku: {
        customer: 'کڕیار', supplier: 'دابینکەر', invoice: 'پسوڵە', salesOrder: 'داواکاری فرۆشتن', purchaseOrder: 'داواکاری کڕین', number: 'ژمارە', phone: 'تەلەفۆن', salesPerson: 'کاشێر', partnerAddress: 'ناونیشانی هاوبەش', status: 'دۆخ', documentNumber: 'ژمارەی بەڵگە', invoiceDate: 'بەرواری پسوڵە', time: 'کات',
        productName: 'ناوی کاڵا', expiry: 'بەسەرچوون', batchNumber: 'ژمارەی بچ', quantity: 'بڕ', freeQuantity: 'بڕی بەخۆڕایی', price: 'نرخ', total: 'کۆی گشتی', note: 'تێبینی',
        paidAmount: 'بڕی دراو', discount: 'داشکاندن', amountInWords: 'بڕ بە نووسین', paymentMethod: 'شێوازی پارەدان', outstanding: 'بڕی ماوەی داواکاری', currentBalance: 'باڵانسی ئێستای هاوبەش', printedBy: 'چاپکراوە لەلایەن', notes: 'تێبینی',
        invoiceDetails: 'وردەکارییەکانی پسوڵە', orderItemsTable: 'خشتەی کاڵاکانی داواکاری', financialSummary: 'پوختەی دارایی', selectValues: 'ئەو بەهایانە هەڵبژێرە کە دەتهەوێت لەم چاپەدا دەربکەون.', selectColumns: 'ستوونەکانی خشتە هەڵبژێرە کە دەتهەوێت لەم چاپەدا دەربکەون.', noColumns: 'هیچ ستوونی کاڵا هەڵنەبژێردراوە', dragToSwap: 'ڕابکێشە بۆ گۆڕینی شوێن', renameTitle: 'ناونیشان بگۆڕە', renameTitleDescription: 'ناونیشانێکی تایبەت بۆ ئەم بەهایە لە چاپەکەدا بەکاربهێنە.', title: 'ناونیشان', save: 'پاشەکەوتکردن', cancel: 'هەڵوەشاندنەوە', resetTitle: 'ناونیشان بگەڕێنەوە', invoiceOrganizer: 'ڕێکخەری پسوڵە', switchToInvoiceOrganizer: 'بگۆڕە بۆ ڕێکخەری پسوڵە', switchToCashier: 'بگۆڕە بۆ کاشێر', logo: 'لۆگۆ', workspaceLogo: 'لۆگۆی شوێنی کار', workspaceName: 'ناوی شوێنی کار', email: 'ئیمەیڵ', madeBy: 'دروستکراوە لەلایەن AtlasERP', page: 'لاپەڕە', pageOf: 'لە', printDate: 'بەرواری چاپ', enableKgTotal: 'کۆی کێش نیشان بدە (کگ/تۆن)', disableKgTotal: 'کۆی کێش بشارەوە',
        statuses: { draft: 'ڕەشنووس', pending: 'چاوەڕوان', completed: 'تەواوبوو', cancelled: 'هەڵوەشاوە', ordered: 'داواکراو', received: 'وەرگیراو' },
        paymentMethods: { cash: 'کاش', fib: 'FIB', qicard: 'کیو کارد', zaincash: 'زین کاش', fastpay: 'فاست پەی', bank_transfer: 'گواستنەوەی بانکی', loan: 'قەرز', installments: 'قسط' }
    }
} as const

export const SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_FIELD_KEYS = {
    showOrderAdjustments: 'showOrderAdjustments',
    showPrintFooter: 'showPrintFooter'
} as const

const ATLAS_STANDARD_RETURN_LABELS = {
    en: {
        invoice: 'Return Document',
        returnInvoice: 'Return Invoice',
        returnStatus: 'Return Status',
        partialReturn: 'Partial Return',
        fullReturn: 'Fully Returned',
        originalOrderNumber: 'Original Order No.',
        returnDate: 'Return date',
        returnTime: 'Return time',
        returnedQuantity: 'Returned Qty',
        returnedFreeQuantity: 'Returned Bonus Qty',
        refundPerUnit: 'Refund / Unit',
        refundedAmount: 'Refund Amount',
        returnedItemsTable: 'Returned items table',
        returnSummary: 'Return summary',
        totalRefunded: 'Total Refunded',
        refundAmountInWords: 'Refund amount in words'
    },
    ar: {
        invoice: 'مستند المرتجع',
        returnInvoice: 'فاتورة مرتجع',
        returnStatus: 'حالة المرتجع',
        partialReturn: 'مرتجع جزئي',
        fullReturn: 'مرتجع كامل',
        originalOrderNumber: 'رقم الطلب الأصلي',
        returnDate: 'تاريخ المرتجع',
        returnTime: 'وقت المرتجع',
        returnedQuantity: 'الكمية المرتجعة',
        returnedFreeQuantity: 'الكمية المجانية المرتجعة',
        refundPerUnit: 'المبلغ المسترد / الوحدة',
        refundedAmount: 'المبلغ المسترد',
        returnedItemsTable: 'جدول الأصناف المرتجعة',
        returnSummary: 'ملخص المرتجع',
        totalRefunded: 'إجمالي المبلغ المسترد',
        refundAmountInWords: 'المبلغ المسترد كتابة'
    },
    ku: {
        invoice: 'بەڵگەی گەڕاندنەوە',
        returnInvoice: 'پسوڵەی گەڕاندنەوە',
        returnStatus: 'دۆخی گەڕاندنەوە',
        partialReturn: 'گەڕاندنەوەی بەشێکی',
        fullReturn: 'گەڕاندنەوەی تەواو',
        originalOrderNumber: 'ژمارەی داواکاری سەرەکی',
        returnDate: 'بەرواری گەڕاندنەوە',
        returnTime: 'کاتی گەڕاندنەوە',
        returnedQuantity: 'بڕی گەڕێندراوە',
        returnedFreeQuantity: 'بڕی بەخۆڕایی گەڕێندراوە',
        refundPerUnit: 'بڕی گەڕاندنەوە / یەکە',
        refundedAmount: 'بڕی گەڕێندراوە',
        returnedItemsTable: 'خشتەی کاڵاکانی گەڕێندراوە',
        returnSummary: 'پوختەی گەڕاندنەوە',
        totalRefunded: 'کۆی بڕی گەڕێندراوە',
        refundAmountInWords: 'بڕی گەڕێندراوە بە نووسین'
    }
} as const

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function formatPrintDateTime(value: string, language: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return { date: '-', time: '-' }

    const locale = resolveAtlasStandardLocale(language) === 'ar'
        ? 'ar-IQ'
        : resolveAtlasStandardLocale(language) === 'ku'
            ? 'ku-Arab-IQ'
            : 'en-CA'
    const datePart = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date).replace(/-/g, '/')
    const timePart = new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: resolveAtlasStandardLocale(language) === 'en'
    }).format(date)

    return { date: datePart, time: timePart }
}

function numberToEnglishWords(value: number) {
    const wholeValue = Math.floor(Math.abs(Number(value) || 0))
    if (wholeValue === 0) return 'Zero'

    const underTwenty = [
        'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
    ]
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
    const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion']

    const toWordsBelowThousand = (amount: number): string => {
        const parts: string[] = []
        if (amount >= 100) {
            parts.push(`${underTwenty[Math.floor(amount / 100)]} Hundred`)
            amount %= 100
        }
        if (amount >= 20) {
            parts.push(tens[Math.floor(amount / 10)])
            amount %= 10
        }
        if (amount > 0) parts.push(underTwenty[amount])
        return parts.join(' ')
    }

    const parts: string[] = []
    let remaining = wholeValue
    let scaleIndex = 0
    while (remaining > 0 && scaleIndex < scales.length) {
        const chunk = remaining % 1000
        if (chunk > 0) {
            parts.unshift([toWordsBelowThousand(chunk), scales[scaleIndex]].filter(Boolean).join(' '))
        }
        remaining = Math.floor(remaining / 1000)
        scaleIndex += 1
    }

    return parts.join(' ')
}

function numberToArabicWords(value: number) {
    const wholeValue = Math.floor(Math.abs(Number(value) || 0))
    if (wholeValue === 0) return 'صفر'

    const underTwenty = [
        '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
        'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'
    ]
    const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون']
    const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة']
    const scales = [
        { singular: '', dual: '', plural: '' },
        { singular: 'ألف', dual: 'ألفان', plural: 'آلاف' },
        { singular: 'مليون', dual: 'مليونان', plural: 'ملايين' },
        { singular: 'مليار', dual: 'ملياران', plural: 'مليارات' },
        { singular: 'تريليون', dual: 'تريليونان', plural: 'تريليونات' }
    ]

    const toWordsBelowHundred = (amount: number): string => {
        if (amount < 20) return underTwenty[amount]
        const ones = amount % 10
        return ones > 0 ? `${underTwenty[ones]} و${tens[Math.floor(amount / 10)]}` : tens[Math.floor(amount / 10)]
    }

    const toWordsBelowThousand = (amount: number): string => {
        const parts: string[] = []
        if (amount >= 100) {
            parts.push(hundreds[Math.floor(amount / 100)])
            amount %= 100
        }
        if (amount > 0) parts.push(toWordsBelowHundred(amount))
        return parts.join(' و')
    }

    const parts: string[] = []
    let remaining = wholeValue
    let scaleIndex = 0
    while (remaining > 0 && scaleIndex < scales.length) {
        const chunk = remaining % 1000
        if (chunk > 0) {
            const scale = scales[scaleIndex]
            if (scaleIndex === 0) {
                parts.unshift(toWordsBelowThousand(chunk))
            } else if (chunk === 1) {
                parts.unshift(scale.singular)
            } else if (chunk === 2) {
                parts.unshift(scale.dual)
            } else if (chunk >= 3 && chunk <= 10) {
                parts.unshift(`${toWordsBelowThousand(chunk)} ${scale.plural}`)
            } else {
                parts.unshift(`${toWordsBelowThousand(chunk)} ${scale.singular}`)
            }
        }
        remaining = Math.floor(remaining / 1000)
        scaleIndex += 1
    }

    return parts.join(' و')
}

function numberToKurdishWords(value: number) {
    const wholeValue = Math.floor(Math.abs(Number(value) || 0))
    if (wholeValue === 0) return 'سفر'

    const underTwenty = [
        '', 'یەک', 'دوو', 'سێ', 'چوار', 'پێنج', 'شەش', 'حەوت', 'هەشت', 'نۆ',
        'دە', 'یازدە', 'دوازدە', 'سێزدە', 'چواردە', 'پانزە', 'شانزە', 'حەڤدە', 'هەژدە', 'نۆزدە'
    ]
    const tens = ['', '', 'بیست', 'سی', 'چل', 'پەنجا', 'شەست', 'حەفتا', 'هەشتا', 'نەوەت']
    const hundreds = ['', 'سەد', 'دووسەد', 'سێسەد', 'چوارسەد', 'پێنجسەد', 'شەشسەد', 'حەوتسەد', 'هەشتسەد', 'نۆسەد']
    const scales = ['', 'هەزار', 'ملیۆن', 'ملیار', 'تریلیۆن']

    const toWordsBelowHundred = (amount: number): string => {
        if (amount < 20) return underTwenty[amount]
        const ones = amount % 10
        return ones > 0 ? `${tens[Math.floor(amount / 10)]} و ${underTwenty[ones]}` : tens[Math.floor(amount / 10)]
    }

    const toWordsBelowThousand = (amount: number): string => {
        const parts: string[] = []
        if (amount >= 100) {
            parts.push(hundreds[Math.floor(amount / 100)])
            amount %= 100
        }
        if (amount > 0) parts.push(toWordsBelowHundred(amount))
        return parts.join(' و ')
    }

    const parts: string[] = []
    let remaining = wholeValue
    let scaleIndex = 0
    while (remaining > 0 && scaleIndex < scales.length) {
        const chunk = remaining % 1000
        if (chunk > 0) {
            const words = toWordsBelowThousand(chunk)
            parts.unshift(scaleIndex === 0 ? words : `${words} ${scales[scaleIndex]}`)
        }
        remaining = Math.floor(remaining / 1000)
        scaleIndex += 1
    }

    return parts.join(' و ')
}

function numberToWords(value: number, language: string) {
    switch ((language || 'en').split('-')[0]) {
        case 'ar': return numberToArabicWords(value)
        case 'ku': return numberToKurdishWords(value)
        default: return numberToEnglishWords(value)
    }
}

function getBatchDetails(item: SalesOrder['items'][number]) {
    const allocations = item.batchAllocations || []
    return {
        batchNumber: allocations.map((allocation) => allocation.batchNumber).filter(Boolean).join(', ')
    }
}

function toCurrencyCode(value?: string | null): CurrencyCode {
    const normalized = value?.toLowerCase()
    return normalized === 'iqd' || normalized === 'eur' || normalized === 'try' ? normalized : 'usd'
}

function saleHasReturnActivity(sale: Sale) {
    return Boolean(
        sale.is_returned
        || sale.return_status === 'partial'
        || sale.return_status === 'full'
        || (sale.returned_amount || 0) > 0
        || sale.items?.some((item) => item.is_returned || (item.returned_quantity || 0) > 0)
    )
}

/**
 * Adapts the immutable Sales History snapshot to the same line shape used by
 * the Atlas Standard pagination and return-state helpers. It deliberately
 * leaves partner data blank: Sales History can contain many source records
 * that do not have a business partner.
 */
export function mapSaleToSalesHistoryAtlasStandardOrder(sale: Sale): SalesOrder {
    const currency = toCurrencyCode(sale.settlement_currency)
    const items = (sale.items || []).map((item) => ({
        id: item.id,
        productId: item.product_id,
        storageId: item.storage_id ?? null,
        productName: item.product_name || item.product?.name || '-',
        productSku: item.product_sku || item.product?.sku || '',
        unit: item.product?.unit || null,
        quantity: Number(item.quantity) || 0,
        freeBonusQuantity: 0,
        lineTotal: Number(item.total_price) || 0,
        originalCurrency: toCurrencyCode(item.original_currency),
        originalUnitPrice: Number(item.original_unit_price) || 0,
        convertedUnitPrice: Number(item.converted_unit_price ?? item.unit_price) || 0,
        settlementCurrency: toCurrencyCode(item.settlement_currency || sale.settlement_currency),
        costPrice: Number(item.cost_price) || 0,
        convertedCostPrice: Number(item.converted_cost_price) || 0,
        returnedQuantity: item.is_returned ? Number(item.quantity) || 0 : Number(item.returned_quantity) || 0,
        batchAllocations: (item.batch_allocations || []).map((allocation) => ({
            batchId: allocation.batch_id,
            batchNumber: allocation.batch_number,
            quantity: allocation.quantity,
            price: allocation.price ?? null,
            costPrice: allocation.cost_price ?? null,
            currency: toCurrencyCode(allocation.currency || sale.settlement_currency),
            expiryDate: allocation.expiry_date ?? null,
            manufacturingDate: allocation.manufacturing_date ?? null
        })),
        note: item.return_reason || null
    }))
    const total = Number(sale.total_amount) || 0
    const returnedAmount = Number(sale.returned_amount) || 0

    return {
        id: sale.id,
        workspaceId: sale.workspace_id,
        createdAt: sale.created_at,
        updatedAt: sale.updated_at || sale.created_at,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: null,
        orderNumber: sale._transactionNo || sale._orderNumber || `#${sale.sequenceId || sale.id.slice(0, 8)}`,
        customerId: '',
        customerName: '',
        items,
        subtotal: total,
        discount: 0,
        tax: 0,
        total,
        currency,
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        status: 'completed',
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount: total,
        balanceAmount: 0,
        paymentMethod: sale.payment_method,
        initialPaymentAmount: total,
        isInstallmentBased: false,
        installmentCount: 0,
        notes: sale.notes,
        originalTotalAmount: Number(sale.original_total_amount) || total,
        returnedAmount,
        returnStatus: sale.return_status || (sale.is_returned ? 'full' : returnedAmount > 0 ? 'partial' : 'none'),
        returnedAt: sale.returned_at || null,
        returnedBy: sale.returned_by || null
    }
}

/** Builds a return-only view from the cumulative immutable Sales History rows. */
export function createSalesHistoryAtlasStandardReturnPrintData(
    sale: Sale,
    order = mapSaleToSalesHistoryAtlasStandardOrder(sale)
): SalesOrderReturnPrintData | null {
    if (!saleHasReturnActivity(sale)) return null

    const returnItemsBySaleItemId = new Map<string, { quantity: number; amount: number }>()
    for (const entry of sale.returns || []) {
        if (entry.status !== 'posted') continue
        for (const item of entry.items || []) {
            const current = returnItemsBySaleItemId.get(item.sale_item_id) || { quantity: 0, amount: 0 }
            current.quantity += Number(item.quantity) || 0
            current.amount += Number(item.refund_amount) || 0
            returnItemsBySaleItemId.set(item.sale_item_id, current)
        }
    }

    const lines = order.items.map((item) => {
        const recorded = returnItemsBySaleItemId.get(item.id)
        const returnedQuantity = Math.min(
            Math.max(0, Number(item.quantity) || 0),
            recorded?.quantity ?? (Number(item.returnedQuantity) || 0)
        )
        if (returnedQuantity <= 0) return null
        const unitRefundAmount = recorded?.quantity
            ? recorded.amount / recorded.quantity
            : Number(item.convertedUnitPrice) || 0
        return {
            orderItemId: item.id,
            returnedQuantity,
            selectedUnitQuantity: returnedQuantity,
            paidSelectedUnitQuantity: returnedQuantity,
            unitRefundAmount,
            refundAmount: recorded?.amount || unitRefundAmount * returnedQuantity
        }
    }).filter((line): line is NonNullable<typeof line> => Boolean(line))

    if (lines.length === 0) return null
    const calculatedRefund = lines.reduce((sum, line) => sum + line.refundAmount, 0)
    const totalRefundAmount = Number(sale.returned_amount) || calculatedRefund
    const returnedAt = sale.returned_at
        || [...(sale.returns || [])]
            .filter((entry) => entry.status === 'posted')
            .sort((a, b) => b.returned_at.localeCompare(a.returned_at))[0]?.returned_at
        || null

    return {
        status: sale.return_status === 'full' || sale.is_returned ? 'full' : 'partial',
        returnedAt,
        baseRefundAmount: calculatedRefund,
        adjustmentAmount: totalRefundAmount - calculatedRefund,
        totalRefundAmount,
        lines,
        adjustments: []
    }
}

function contactValues(pair?: WorkspaceContactPair) {
    return [pair?.primary, pair?.nonPrimary].filter((value): value is string => Boolean(value?.trim()))
}

function HideableSection({
    title,
    dialogDescription,
    fields,
    fieldOrder,
    fieldLabelOverrides = {},
    hiddenFields,
    onHiddenFieldChange,
    onFieldOrderChange,
    onFieldLabelChange,
    className,
    dialogClassName,
    dialogFieldsClassName,
    dialogFieldClassName,
    dragInstruction,
    renameTitleLabel = 'Rename title',
    resetTitleLabel = 'Reset title',
    renameTitleDescription,
    titleFieldLabel = 'Title',
    saveLabel = 'Save',
    cancelLabel = 'Cancel'
}: {
    title: string
    dialogDescription: string
    fields: HideablePrintField[]
    fieldOrder?: string[]
    fieldLabelOverrides?: Record<string, string>
    hiddenFields: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    onFieldOrderChange?: (fieldKeys: string[]) => void
    onFieldLabelChange?: (fieldKey: string, label: string) => void
    className?: string
    dialogClassName?: string
    dialogFieldsClassName?: string
    dialogFieldClassName?: string
    dragInstruction?: string
    renameTitleLabel?: string
    resetTitleLabel?: string
    renameTitleDescription?: string
    titleFieldLabel?: string
    saveLabel?: string
    cancelLabel?: string
}) {
    const [open, setOpen] = useState(false)
    const [renamedField, setRenamedField] = useState<HideablePrintField | null>(null)
    const [titleDraft, setTitleDraft] = useState('')
    const canConfigure = Boolean(onHiddenFieldChange || onFieldOrderChange || onFieldLabelChange)
    const titledFields = fields.map((field) => {
        const defaultLabel = field.defaultLabel || (typeof field.label === 'string' ? field.label : undefined)
        const labelOverride = field.suppressLabelOverride ? '' : fieldLabelOverrides[field.key]?.trim()
        return {
            ...field,
            defaultLabel,
            label: labelOverride || field.label
        }
    })
    const orderedFields = orderFieldsForLayout(titledFields, fieldOrder)
    const visibleFields = orderedFields.filter((field) => !hiddenFields[field.key])
    const visibleFieldRows = visibleFields.reduce<HideablePrintField[][]>((rows, field) => {
        const rowIndex = field.layoutRow || 0
        const row = rows[rowIndex] || []
        row.push(field)
        rows[rowIndex] = row
        return rows
    }, [])
    const openDialog = () => setOpen(true)
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        openDialog()
    }
    const openRenameTitle = (field: HideablePrintField) => {
        setRenamedField(field)
        setTitleDraft(typeof field.label === 'string' ? field.label : field.defaultLabel || '')
    }
    const saveTitle = () => {
        if (!renamedField) return
        onFieldLabelChange?.(renamedField.key, titleDraft.trim())
        setRenamedField(null)
        setTitleDraft('')
    }
    const renderFieldContent = (field: HideablePrintField) => {
        if (typeof field.render === 'function') return field.render(field.label)
        if (field.render) return field.render
        return <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{field.label} : </strong>{field.value}</div>
    }
    const renderPickerField = (field: HideablePrintField, dragHandleProps?: DraggableProvidedDragHandleProps | null, isDragging = false) => {
        const hidden = Boolean(hiddenFields[field.key])
        const card = (
            <button
                type="button"
                aria-pressed={hidden}
                className={cn(
                    'flex w-full items-start justify-between gap-4 rounded-md border border-border px-3 py-2 text-start text-sm transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    dialogFieldClassName,
                    isDragging && 'opacity-50',
                    hidden && 'text-muted-foreground line-through'
                )}
                onClick={() => onHiddenFieldChange?.(field.key, !hidden)}
            >
                <span className="flex w-full items-start justify-between gap-2 font-medium">
                    <span>{field.label}</span>
                    {dragHandleProps ? (
                        <span
                            {...dragHandleProps}
                            className="shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                            title={dragInstruction}
                        >
                            <GripVertical className="h-4 w-4" aria-hidden="true" />
                            {dragInstruction ? <span className="sr-only">{dragInstruction}</span> : null}
                        </span>
                    ) : null}
                </span>
                {field.value !== undefined ? <span className={cn('text-end', dialogFieldClassName && 'w-full text-start text-xs')}>{field.value}</span> : null}
            </button>
        )
        if (!onFieldLabelChange && !field.contextMenuMode) return card

        return (
            <ContextMenu>
                <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
                <ContextMenuContent className="z-[70]">
                    {field.contextMenuMode ? (
                        <ContextMenuItem onSelect={() => field.contextMenuMode?.onChange(!field.contextMenuMode.active)}>
                            {field.contextMenuMode.active
                                ? field.contextMenuMode.deactivateLabel
                                : field.contextMenuMode.activateLabel}
                        </ContextMenuItem>
                    ) : null}
                    {onFieldLabelChange ? (
                        <ContextMenuItem onSelect={() => openRenameTitle(field)}>
                            {renameTitleLabel}
                        </ContextMenuItem>
                    ) : null}
                    {onFieldLabelChange && fieldLabelOverrides[field.key]?.trim() ? (
                        <ContextMenuItem onSelect={() => onFieldLabelChange(field.key, '')}>
                            {resetTitleLabel}
                        </ContextMenuItem>
                    ) : null}
                </ContextMenuContent>
            </ContextMenu>
        )
    }
    const content = visibleFields.length > 0
        ? visibleFieldRows.filter(Boolean).map((row, rowIndex) => {
            const baseSpan = Math.floor(4 / row.length)
            const remainingColumns = 4 % row.length
            return (
                <div key={`row-${rowIndex}`} className="col-span-4 grid grid-cols-4">
                    {row.map((field, index) => {
                        const span = baseSpan + (index < remainingColumns ? 1 : 0)
                        return (
                            <div
                                key={field.key}
                                className={cn('min-w-0', field.className)}
                                style={{ gridColumn: `span ${span} / span ${span}` }}
                            >
                                {renderFieldContent(field)}
                            </div>
                        )
                    })}
                </div>
            )
        })
        : <div className="col-span-4 min-h-[6.5mm] border-l border-t border-[#1f2937]" />

    const section = (
        <div
            role={canConfigure ? 'button' : undefined}
            tabIndex={canConfigure ? 0 : undefined}
            className={cn(
                'grid grid-cols-4 border-b border-r border-[#1f2937] bg-white text-start outline-none',
                canConfigure && 'cursor-pointer transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary/50',
                className
            )}
            onClick={canConfigure ? (event) => {
                event.stopPropagation()
                openDialog()
            } : undefined}
            onKeyDown={canConfigure ? handleKeyDown : undefined}
        >
            {content}
        </div>
    )

    if (!canConfigure) return section

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {section}
            <DialogContent className={cn('max-w-md', dialogClassName)} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{dialogDescription}</DialogDescription>
                    {onFieldOrderChange && dragInstruction ? <p className="text-sm text-muted-foreground">{dragInstruction}</p> : null}
                </DialogHeader>
                {onFieldOrderChange ? (
                    <ReorderablePickerGrid
                        droppableId={fields[0]?.key || title}
                        items={orderedFields}
                        getItemId={(field) => field.key}
                        getSlotClassName={(field) => field.dialogClassName}
                        onItemsSwap={(nextFields) => onFieldOrderChange(nextFields.map((field) => field.key))}
                        renderItem={(field, dragHandleProps, isDragging) => renderPickerField(field, dragHandleProps, isDragging)}
                        className={cn('space-y-1', dialogFieldsClassName)}
                    />
                ) : (
                    <div className={cn('space-y-1', dialogFieldsClassName)}>
                        {orderedFields.map((field) => (
                            <div key={field.key} className={field.dialogClassName}>
                                {renderPickerField(field)}
                            </div>
                        ))}
                    </div>
                )}
            </DialogContent>
            <Dialog open={Boolean(renamedField)} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setRenamedField(null)
                    setTitleDraft('')
                }
            }}>
                <DialogContent className="z-[80] max-w-sm" onPointerDown={(event) => event.stopPropagation()}>
                    <form onSubmit={(event) => {
                        event.preventDefault()
                        saveTitle()
                    }}>
                        <DialogHeader>
                            <DialogTitle>{renameTitleLabel}</DialogTitle>
                            {renameTitleDescription ? <DialogDescription>{renameTitleDescription}</DialogDescription> : null}
                        </DialogHeader>
                        <div className="mt-4 grid gap-2">
                            <label className="text-sm font-medium" htmlFor="atlas-standard-field-title">{titleFieldLabel}</label>
                            <input
                                id="atlas-standard-field-title"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                value={titleDraft}
                                onChange={(event) => setTitleDraft(event.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className="mt-5 flex justify-end gap-2">
                            <button type="button" className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent" onClick={() => {
                                setRenamedField(null)
                                setTitleDraft('')
                            }}>
                                {cancelLabel}
                            </button>
                            <button type="submit" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">{saveLabel}</button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Dialog>
    )
}

function HideableTable({
    title,
    dialogDescription,
    emptyLabel,
    columns,
    fieldLabelOverrides = {},
    hiddenFields,
    onHiddenFieldChange,
    onFieldLabelChange,
    renameTitleLabel = 'Rename title',
    resetTitleLabel = 'Reset title',
    renameTitleDescription,
    titleFieldLabel = 'Title',
    saveLabel = 'Save',
    cancelLabel = 'Cancel',
    children
}: {
    title: string
    dialogDescription: string
    emptyLabel: string
    columns: TableColumn[]
    fieldLabelOverrides?: Record<string, string>
    hiddenFields: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    onFieldLabelChange?: (fieldKey: string, label: string) => void
    renameTitleLabel?: string
    resetTitleLabel?: string
    renameTitleDescription?: string
    titleFieldLabel?: string
    saveLabel?: string
    cancelLabel?: string
    children: (visibleColumns: TableColumn[]) => ReactNode
}) {
    const [open, setOpen] = useState(false)
    const [renamedColumn, setRenamedColumn] = useState<TableColumn | null>(null)
    const [titleDraft, setTitleDraft] = useState('')
    const canConfigure = Boolean(onHiddenFieldChange || onFieldLabelChange)
    const titledColumns = resolveTitledTableColumns(columns, fieldLabelOverrides)
    const visibleColumns = titledColumns.filter((column) => !hiddenFields[column.key])
    const openDialog = () => setOpen(true)
    const openRenameTitle = (column: TableColumn) => {
        setRenamedColumn(column)
        setTitleDraft(column.label)
    }
    const saveTitle = () => {
        if (!renamedColumn) return
        onFieldLabelChange?.(renamedColumn.key, titleDraft.trim())
        setRenamedColumn(null)
        setTitleDraft('')
    }
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        openDialog()
    }

    const table = (
        <div
            role={canConfigure ? 'button' : undefined}
            tabIndex={canConfigure ? 0 : undefined}
            className={cn(
                'min-h-[16mm] outline-none',
                canConfigure && 'cursor-pointer transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary/50'
            )}
            onClick={canConfigure ? (event) => {
                event.stopPropagation()
                openDialog()
            } : undefined}
            onKeyDown={canConfigure ? handleKeyDown : undefined}
        >
            {visibleColumns.length > 0 ? children(visibleColumns) : (
                <div className="flex min-h-[16mm] items-center justify-center border text-xs text-slate-500" style={{ borderColor: INK }}>
                    {emptyLabel}
                </div>
            )}
        </div>
    )

    if (!canConfigure) return table

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {table}
            <DialogContent className="max-w-md" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{dialogDescription}</DialogDescription>
                </DialogHeader>
                <div className="space-y-1">
                    {titledColumns.map((column) => {
                        const hidden = Boolean(hiddenFields[column.key])
                        const columnButton = (
                            <button
                                key={column.key}
                                type="button"
                                aria-pressed={hidden}
                                className={cn(
                                    'flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-start text-sm transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                                    hidden && 'text-muted-foreground line-through'
                                )}
                                onClick={() => onHiddenFieldChange?.(column.key, !hidden)}
                            >
                                <span className="font-medium">{column.label}</span>
                            </button>
                        )
                        if (!column.contextMenu && !onFieldLabelChange) return columnButton

                        return (
                            <ContextMenu key={column.key}>
                                <ContextMenuTrigger asChild>{columnButton}</ContextMenuTrigger>
                                <ContextMenuContent className="z-[80] w-72 p-1" onCloseAutoFocus={(event) => event.preventDefault()}>
                                    {column.contextMenu}
                                    {column.contextMenu && onFieldLabelChange ? <ContextMenuSeparator /> : null}
                                    {onFieldLabelChange ? (
                                        <ContextMenuItem onSelect={() => openRenameTitle(column)}>
                                            {renameTitleLabel}
                                        </ContextMenuItem>
                                    ) : null}
                                    {onFieldLabelChange && fieldLabelOverrides[column.key]?.trim() ? (
                                        <ContextMenuItem onSelect={() => onFieldLabelChange(column.key, '')}>
                                            {resetTitleLabel}
                                        </ContextMenuItem>
                                    ) : null}
                                </ContextMenuContent>
                            </ContextMenu>
                        )
                    })}
                </div>
            </DialogContent>
            <Dialog open={Boolean(renamedColumn)} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setRenamedColumn(null)
                    setTitleDraft('')
                }
            }}>
                <DialogContent className="z-[90] max-w-sm" onPointerDown={(event) => event.stopPropagation()}>
                    <form onSubmit={(event) => {
                        event.preventDefault()
                        saveTitle()
                    }}>
                        <DialogHeader>
                            <DialogTitle>{renameTitleLabel}</DialogTitle>
                            {renameTitleDescription ? <DialogDescription>{renameTitleDescription}</DialogDescription> : null}
                        </DialogHeader>
                        <div className="mt-4 grid gap-2">
                            <label className="text-sm font-medium" htmlFor="atlas-standard-table-column-title">{titleFieldLabel}</label>
                            <input
                                id="atlas-standard-table-column-title"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                value={titleDraft}
                                onChange={(event) => setTitleDraft(event.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className="mt-5 flex justify-end gap-2">
                            <button type="button" className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent" onClick={() => {
                                setRenamedColumn(null)
                                setTitleDraft('')
                            }}>
                                {cancelLabel}
                            </button>
                            <button type="submit" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">{saveLabel}</button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Dialog>
    )
}

export function SalesHistoryAtlasStandardInvoiceTemplate({
    workspaceName,
    printLang,
    sale,
    iqdPreference = 'IQD',
    logoUrl,
    workspaceFooterContacts,
    printedBy,
    componentPositions,
    editableComponents,
    onComponentPositionChange,
    hiddenFields = {},
    onHiddenFieldChange,
    fieldOrders = {},
    onFieldOrderChange,
    fieldLabelOverrides = {},
    onFieldLabelChange,
    fieldDisplayModes = {},
    onFieldDisplayModeChange,
    productImageUrls,
    background,
    templateFields,
    returnPrintData,
    printVersion
}: SalesHistoryAtlasStandardInvoiceTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const locale = resolveAtlasStandardLocale(printLang)
    const labels = ATLAS_STANDARD_LABELS[locale]
    const returnLabels = ATLAS_STANDARD_RETURN_LABELS[locale]
    const order = mapSaleToSalesHistoryAtlasStandardOrder(sale)
    const effectiveReturnPrintData = returnPrintData || createSalesHistoryAtlasStandardReturnPrintData(sale, order)
    // The normal Sales History template keeps the adjusted sale view even
    // when returns exist. The independent return template explicitly passes
    // `returned`, so selecting a normal print never changes its document type.
    const effectivePrintVersion: OrderPrintVersion = printVersion || 'adjusted'
    const isReturnPrint = effectivePrintVersion === 'returned' && Boolean(effectiveReturnPrintData)
    const isOriginalPrint = effectivePrintVersion === 'original'
    const issuedAt = formatPrintDateTime(isReturnPrint && effectiveReturnPrintData?.returnedAt
        ? effectiveReturnPrintData.returnedAt
        : order.createdAt, printLang)
    const logoSrc = resolveLogoSrc(logoUrl)
    const backgroundSrc = resolveLogoSrc(background?.path)
    const workspaceNameValue = workspaceName?.trim() || 'Atlas'
    const workspaceNameDirection = hasRTLText(workspaceNameValue) ? 'rtl' : 'ltr'
    const financialKeys = SALES_HISTORY_ATLAS_STANDARD_HIDDEN_FIELD_KEYS.financialSummary
    const detailsKeys = SALES_HISTORY_ATLAS_STANDARD_HIDDEN_FIELD_KEYS.invoiceDetails
    const tableKeys = SALES_HISTORY_ATLAS_STANDARD_HIDDEN_FIELD_KEYS.table
    const fieldOrderKeys = SALES_HISTORY_ATLAS_STANDARD_FIELD_ORDER_KEYS
    const tableSettingKeys = SALES_HISTORY_ATLAS_STANDARD_TABLE_SETTING_KEYS
    const salesLabels = {
        saleType: t('sales.atlasStandard.saleType', { defaultValue: 'Sale type' }),
        saleNumber: t('sales.atlasStandard.saleNumber', { defaultValue: 'Sale No.' }),
        cashier: t('sales.atlasStandard.cashier', { defaultValue: 'Cashier' }),
        saleStatus: t('sales.atlasStandard.saleStatus', { defaultValue: 'Sale status' }),
        saleDate: t('sales.atlasStandard.saleDate', { defaultValue: 'Sale date' }),
        salesItemsTable: t('sales.atlasStandard.salesItemsTable', { defaultValue: 'Sale items table' }),
        salesSummary: t('sales.atlasStandard.salesSummary', { defaultValue: 'Sales summary' }),
        sku: t('sales.atlasStandard.sku', { defaultValue: 'SKU' }),
        paidTotal: t('sales.atlasStandard.paidTotal', { defaultValue: 'Paid total' }),
        netTotal: t('sales.atlasStandard.netTotal', { defaultValue: 'Net total' }),
        paid: t('sales.atlasStandard.paid', { defaultValue: 'Paid' }),
        noRefund: t('sales.atlasStandard.noRefund', { defaultValue: 'No refund' }),
        origin: t(`sales.atlasStandard.origins.${sale.origin}`, { defaultValue: sale.origin || '-' })
    }
    const {
        productImageColumnWidth,
        productImageSizeMm,
        tableItemRowMm,
        firstPageRows: maxFirstPageRows,
        continuationRows: maxContinuationRows
    } = resolveAtlasStandardTableCapacities(fieldDisplayModes[tableSettingKeys.productImageWidth])
    const returnLineByOrderItemId = new Map(effectiveReturnPrintData?.lines.map((line) => [line.orderItemId, line]) || [])
    const currency = order.currency
    const noteValue = order.notes?.trim() || '-'
    const cashier = sale.cashier_name?.trim() || '-'
    const printedByValue = printedBy?.trim() || cashier
    const statusLabel = isReturnPrint
        ? effectiveReturnPrintData?.status === 'full' ? returnLabels.fullReturn : returnLabels.partialReturn
        : sale.return_status === 'full' || sale.is_returned
            ? returnLabels.fullReturn
            : sale.return_status === 'partial' || (sale.returned_amount || 0) > 0
                ? returnLabels.partialReturn
                : salesLabels.noRefund
    const paymentMethod = order.paymentMethod
        ? labels.paymentMethods[order.paymentMethod as keyof typeof labels.paymentMethods] || order.paymentMethod
        : '-'
    const showPrintFooter = templateFields?.[SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_FIELD_KEYS.showPrintFooter] !== 'false'
    const originalPaidTotal = Number(sale.original_total_amount) || Number(sale.total_amount) || 0
    const refundedAmount = Number(sale.returned_amount) || effectiveReturnPrintData?.totalRefundAmount || 0
    const netTotal = Math.max(0, originalPaidTotal - refundedAmount)
    // Sales History has no order-adjustment rows. Keeping the table's row
    // model otherwise identical preserves Atlas Standard page capacities.
    const orderAdjustments: NonNullable<SalesOrder['orderAdjustments']> = []
    const printTotal = isReturnPrint
        ? effectiveReturnPrintData?.totalRefundAmount || 0
        : isOriginalPrint
            ? originalPaidTotal
            : netTotal
    const amountInWords = numberToWords(printTotal, printLang)
    const items = isReturnPrint
        ? order.items.filter((item) => returnLineByOrderItemId.has(item.id))
        : order.items || []
    const printableTableRows = [
        ...items.map((item) => ({ kind: 'item' as const, item })),
        ...orderAdjustments.map((adjustment) => ({ kind: 'adjustment' as const, adjustment }))
    ]
    const itemChunks = chunkAtlasStandardTableRows(
        printableTableRows,
        maxFirstPageRows,
        maxContinuationRows
    )
    const paidQuantityTotal = items.reduce((sum, item) => sum + (isReturnPrint
        ? returnLineByOrderItemId.get(item.id)?.returnedQuantity || 0
        : !isOriginalPrint
        ? getOrderPrintReturnState(item).remainingQuantity
        : getOrderLinePaidQuantity(item)), 0)
    const paidQuantityUnits = Array.from(new Set(
        items
            .filter((item) => isReturnPrint
                ? (returnLineByOrderItemId.get(item.id)?.returnedQuantity || 0) > 0
                : getOrderLinePaidQuantity(item) > 0)
            .map((item) => normalizeUnitCode(item.unit))
            .filter((unit): unit is string => Boolean(unit))
    ))
    const paidQuantityUnit = paidQuantityUnits.length === 1 ? paidQuantityUnits[0] : ''
    const productImageWidthDifference = productImageColumnWidth - DEFAULT_PRODUCT_IMAGE_COLUMN_WIDTH
    const productKgTotalEnabled = fieldDisplayModes[tableSettingKeys.productKgTotal] === 'enabled'
    const weightGroupedKgTotal = items.reduce(
        (sum, item) => sum + getProductNameWeightKg(item.productName) * getOrderLineInventoryQuantity(item),
        0
    )
    const productKgTotalLabel = productKgTotalEnabled && weightGroupedKgTotal > 0
        ? weightGroupedKgTotal > 1000
            ? `${Number((weightGroupedKgTotal / 1000).toFixed(2))} ${t('products.units.ton', { defaultValue: 'ton' })}`
            : `${weightGroupedKgTotal} ${t('products.units.kg', { defaultValue: 'kg' })}`
        : ''
    const tableColumns: TableColumn[] = [
        {
            key: tableKeys.productImage,
            label: t('products.table.image', { defaultValue: 'Image' }),
            width: `${productImageColumnWidth}%`,
            contextMenu: onFieldDisplayModeChange ? (
                <ImageColumnWidthControl
                    label={t('orders.print.imageColumnWidth', { defaultValue: 'Image column width' })}
                    columnWidth={productImageColumnWidth}
                    onColumnWidthChange={(width) => onFieldDisplayModeChange(tableSettingKeys.productImageWidth, String(width))}
                />
            ) : undefined
        },
        { key: tableKeys.number, label: labels.number, width: '5%' },
        {
            key: tableKeys.product,
            label: labels.productName,
            width: `${23 - productImageWidthDifference * 0.7}%`,
            contextMenu: onFieldDisplayModeChange ? (
                <ContextMenuItem
                    onSelect={() => onFieldDisplayModeChange(
                        tableSettingKeys.productKgTotal,
                        productKgTotalEnabled ? '' : 'enabled'
                    )}
                >
                    {productKgTotalEnabled ? labels.disableKgTotal : labels.enableKgTotal}
                </ContextMenuItem>
            ) : undefined
        },
        { key: tableKeys.sku, label: salesLabels.sku, width: '10%' },
        { key: tableKeys.batchNumber, label: labels.batchNumber, width: '10%' },
        { key: tableKeys.quantity, label: isReturnPrint ? returnLabels.returnedQuantity : labels.quantity, width: '9%' },
        { key: tableKeys.price, label: isReturnPrint ? returnLabels.refundPerUnit : labels.price, width: '11%' },
        { key: tableKeys.total, label: isReturnPrint ? returnLabels.refundedAmount : labels.total, width: '11%' },
        { key: tableKeys.note, label: labels.note, width: `${15 - productImageWidthDifference * 0.3}%` }
    ]
    const visibleTableColumns = resolveVisibleTableColumns(tableColumns, fieldLabelOverrides, hiddenFields)
    const renderItemsTable = (
        tableItems: typeof printableTableRows,
        rowStartIndex: number,
        tableKey: string,
        tableDataAreaMm: number,
        centered = false
    ) => {
        const tableEmptyAreaMm = Math.max(0, tableDataAreaMm - (tableItems.length * tableItemRowMm))
        return (
            <table
                key={tableKey}
                data-centered-table={centered ? '' : undefined}
                className="mb-2 w-full table-fixed border-collapse border text-[10px] leading-none"
                style={{ borderColor: INK }}
            >
                <colgroup>
                    {visibleTableColumns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
                </colgroup>
                <thead>
                    <tr className="h-[8mm] bg-[#e5e7eb] text-center font-bold" style={{ color: '#111827' }}>
                        {visibleTableColumns.map((column) => (
                            <th
                                key={column.key}
                                className="border px-[0.5mm] py-[0.75mm] text-center align-middle text-[9px] leading-[1.2] truncate"
                                style={{ borderColor: INK }}
                            >
                                {column.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {tableItems.map((tableRow, index) => {
                        if (tableRow.kind === 'adjustment') {
                            const { adjustment } = tableRow
                            const isPostReturnAdjustment = isPostReturnOrderAdjustment(adjustment)
                            const typeLabel = isReturnPrint && isPostReturnAdjustment
                                ? adjustment.type === 'addition'
                                    ? t('orders.adjustments.postReturn.reducesRefund', { defaultValue: 'Reduces refund' })
                                    : t('orders.adjustments.postReturn.increasesRefund', { defaultValue: 'Increases refund' })
                                : adjustment.type === 'addition'
                                    ? t('orders.adjustments.addition', { defaultValue: 'Addition (+)' })
                                    : t('orders.adjustments.deduction', { defaultValue: 'Deduction (−)' })
                            const sign = isReturnPrint && isPostReturnAdjustment
                                ? adjustment.type === 'addition' ? '−' : '+'
                                : adjustment.type === 'addition' ? '+' : '−'
                            const values: Record<string, ReactNode> = {
                                [tableKeys.productImage]: '\u00a0',
                                [tableKeys.number]: '\u00a0',
                                [tableKeys.product]: `${isPostReturnAdjustment
                                    ? t('orders.adjustments.postReturn.printRow', { defaultValue: 'Post-return adjustment' })
                                    : t('orders.adjustments.printRow', { defaultValue: 'Order adjustment' })} — ${adjustment.name}`,
                                [tableKeys.sku]: '\u00a0',
                                [tableKeys.batchNumber]: '\u00a0',
                                [tableKeys.quantity]: '\u00a0',
                                [tableKeys.price]: '\u00a0',
                                [tableKeys.total]: `${sign}${formatCurrency(adjustment.convertedAmount, currency, iqdPreference)}`,
                                [tableKeys.note]: typeLabel
                            }

                            return (
                                <tr
                                    key={`order-adjustment-${adjustment.id}`}
                                    style={{ height: `${tableItemRowMm}mm` }}
                                    data-order-print-row-type="adjustment"
                                >
                                    {visibleTableColumns.map((column) => (
                                        <td
                                            key={column.key}
                                            className={cn(
                                                'border text-center align-middle leading-[1.15]',
                                                column.key === tableKeys.productImage
                                                    ? 'px-[0.5mm] py-[0.5mm] whitespace-nowrap'
                                                    : 'px-[1.2mm] py-[1mm] truncate'
                                            )}
                                            style={{ borderColor: INK }}
                                        >
                                            {values[column.key]}
                                        </td>
                                    ))}
                                </tr>
                            )
                        }

                        const { item } = tableRow
                        const batch = getBatchDetails(item)
                        const paidQuantity = getOrderLinePaidQuantity(item)
                        const returnLine = returnLineByOrderItemId.get(item.id)
                        const unit = normalizeUnitCode(item.unit)
                        const returnState = !isOriginalPrint ? getOrderPrintReturnState(item) : null
                        const originalQuantity = unit
                            ? `${paidQuantity} ${t(`products.units.${unit}`, { defaultValue: unit })}`
                            : paidQuantity
                        const remainingQuantity = unit
                            ? `${returnState?.remainingQuantity} ${t(`products.units.${unit}`, { defaultValue: unit })}`
                            : returnState?.remainingQuantity
                        const values: Record<string, ReactNode> = {
                            [tableKeys.productImage]: (
                                <ProductPrintImage
                                    imageUrl={productImageUrls?.[item.productId]}
                                    productName={item.productName}
                                    sizeMm={productImageSizeMm}
                                />
                            ),
                            [tableKeys.number]: rowStartIndex + index + 1,
                            [tableKeys.product]: item.productName || '\u00a0',
                            [tableKeys.sku]: item.productSku || '\u00a0',
                            [tableKeys.batchNumber]: batch.batchNumber || '\u00a0',
                            [tableKeys.quantity]: isReturnPrint
                                ? `${returnLine?.returnedQuantity || 0}${unit ? ` ${t(`products.units.${unit}`, { defaultValue: unit })}` : ''}`
                                : returnState
                                ? <OrderPrintReturnValue
                                    state={returnState}
                                    original={originalQuantity}
                                    remaining={remainingQuantity}
                                    stacked
                                    className="items-center"
                                />
                                : originalQuantity,
                            [tableKeys.price]: formatCurrency(isReturnPrint
                                ? returnLine?.unitRefundAmount || 0
                                : item.convertedUnitPrice, currency, iqdPreference),
                            [tableKeys.total]: isReturnPrint
                                ? formatCurrency(returnLine?.refundAmount || 0, currency, iqdPreference)
                                : returnState
                                ? <OrderPrintReturnValue
                                    state={returnState}
                                    original={formatCurrency(returnState.originalLineTotal, currency, iqdPreference)}
                                    remaining={formatCurrency(returnState.remainingLineTotal, currency, iqdPreference)}
                                    stacked
                                    className="items-center"
                                />
                                : formatCurrency(item.lineTotal, currency, iqdPreference),
                            [tableKeys.note]: item.note?.trim() || '\u00a0'
                        }
                        return (
                            <tr
                                key={item.id}
                                style={{
                                    height: `${tableItemRowMm}mm`,
                                    ...(!isReturnPrint ? getA4OrderPrintReturnRowStyle(returnState?.status || 'active') : {})
                                }}
                                data-order-print-return-state={isReturnPrint ? 'returned' : returnState?.status}
                            >
                                {visibleTableColumns.map((column) => (
                                    <td
                                        key={column.key}
                                        className={cn(
                                            'border text-center align-middle leading-[1.15]',
                                            column.key === tableKeys.productImage
                                                ? 'px-[0.5mm] py-[0.5mm] whitespace-nowrap'
                                                : 'px-[1.2mm] py-[1mm] truncate'
                                        )}
                                        style={{ borderColor: INK }}
                                    >
                                        {values[column.key]}
                                    </td>
                                ))}
                            </tr>
                        )
                    })}
                    {tableEmptyAreaMm > 0 ? (
                        <tr>
                            {visibleTableColumns.map((column) => (
                                    <td
                                        key={column.key}
                                        className="border-x px-1 text-center align-middle"
                                    style={{ borderColor: INK, height: `${tableEmptyAreaMm}mm` }}
                                >
                                    {'\u00a0'}
                                </td>
                            ))}
                        </tr>
                    ) : null}
                    <tr className="h-[8mm] bg-[#f3f4f6] font-bold">
                        {visibleTableColumns.map((column) => {
                            const value = column.key === tableKeys.product
                                ? productKgTotalLabel || '\u00a0'
                                : column.key === tableKeys.quantity
                                    ? paidQuantityTotal + (paidQuantityUnit ? ` ${t(`products.units.${paidQuantityUnit}`, { defaultValue: paidQuantityUnit })}` : '')
                                : column.key === tableKeys.total
                                            ? formatCurrency(printTotal, currency, iqdPreference)
                                            : '\u00a0'
                            return (
                                <td key={column.key} className="border px-[1.2mm] py-[1mm] text-center align-middle leading-[1.15] whitespace-nowrap" style={{ borderColor: INK }}>
                                    {value}
                                </td>
                            )
                        })}
                    </tr>
                </tbody>
            </table>
        )
    }

    const saleNumber = `#${String(sale.sequenceId || sale.id.slice(0, 8)).padStart(5, '0')}`
    const invoiceDetailFields: HideablePrintField[] = [
        {
            key: detailsKeys.saleType,
            label: isReturnPrint ? returnLabels.invoice : salesLabels.saleType,
            value: isReturnPrint ? returnLabels.returnInvoice : salesLabels.origin,
            className: 'border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{isReturnPrint ? returnLabels.returnInvoice : <span className="text-green-600">{salesLabels.origin}</span>}</div>
        },
        {
            key: detailsKeys.saleNumber,
            label: salesLabels.saleNumber,
            value: saleNumber,
            className: 'border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{saleNumber}</div>
        },
        {
            key: detailsKeys.cashier,
            label: salesLabels.cashier,
            value: cashier,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{cashier}</div>
        },
        {
            key: detailsKeys.saleDate,
            label: isReturnPrint ? returnLabels.returnDate : salesLabels.saleDate,
            value: issuedAt.date,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{issuedAt.date}</div>
        },
        {
            key: detailsKeys.time,
            label: isReturnPrint ? returnLabels.returnTime : labels.time,
            value: issuedAt.time,
            className: 'border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{issuedAt.time}</div>
        },
        {
            key: detailsKeys.saleStatus,
            label: isReturnPrint ? returnLabels.returnStatus : salesLabels.saleStatus,
            value: isReturnPrint ? statusLabel : salesLabels.paid,
            className: 'border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{isReturnPrint ? statusLabel : salesLabels.paid}</div>
        }
    ]

    const financialFields: HideablePrintField[] = isReturnPrint ? [
        {
            key: financialKeys.refundedAmount,
            label: returnLabels.totalRefunded,
            value: formatCurrency(printTotal, currency, iqdPreference),
            className: 'col-span-4 border-l border-t border-[#1f2937]',
            dialogClassName: 'col-span-2',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{formatCurrency(printTotal, currency, iqdPreference)}</div>
        },
        {
            key: financialKeys.amountInWords,
            label: returnLabels.refundAmountInWords,
            value: amountInWords,
            className: 'col-span-4 border-l border-t border-[#1f2937]',
            dialogClassName: 'col-span-2',
            render: () => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate">{amountInWords}</div>
        },
        {
            key: financialKeys.paymentMethod,
            label: labels.paymentMethod,
            value: paymentMethod,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{paymentMethod}</div>
        },
        {
            key: financialKeys.printedBy,
            label: labels.printedBy,
            value: printedByValue,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{printedByValue}</div>
        },
        {
            key: financialKeys.notes,
            label: labels.notes,
            value: noteValue,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{noteValue}</div>
        }
    ] : [
        {
            key: financialKeys.paidTotal,
            label: salesLabels.paidTotal,
            value: formatCurrency(originalPaidTotal, currency, iqdPreference),
            className: 'col-span-4 border-l border-t border-[#1f2937]',
            dialogClassName: 'col-span-2',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{formatCurrency(originalPaidTotal, currency, iqdPreference)}</div>
        },
        {
            key: financialKeys.netTotal,
            label: salesLabels.netTotal,
            value: formatCurrency(netTotal, currency, iqdPreference),
            className: 'col-span-4 border-l border-t border-[#1f2937]',
            dialogClassName: 'col-span-2',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{formatCurrency(netTotal, currency, iqdPreference)}</div>
        },
        {
            key: financialKeys.paymentMethod,
            label: labels.paymentMethod,
            value: paymentMethod,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{paymentMethod}</div>
        },
        {
            key: financialKeys.amountInWords,
            label: labels.amountInWords,
            value: amountInWords,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: () => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate">{amountInWords}</div>
        },
        {
            key: financialKeys.printedBy,
            label: labels.printedBy,
            value: printedByValue,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{printedByValue}</div>
        },
        {
            key: financialKeys.notes,
            label: labels.notes,
            value: noteValue,
            className: 'col-span-2 border-l border-t border-[#1f2937]',
            render: (label) => <div className="min-h-[6.5mm] px-2 py-1.5 text-xs truncate"><strong>{label} : </strong>{noteValue}</div>
        }
    ]

    const footerAddress = contactValues(workspaceFooterContacts?.address)
    const footerPhone = contactValues(workspaceFooterContacts?.phone)
    const footerEmail = contactValues(workspaceFooterContacts?.email)

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="sales-history-atlas-standard-invoice bg-white text-slate-800"
            style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', padding: '8mm', position: 'relative', isolation: 'isolate' }}
            data-order-print-page=""
            data-page-width-mm="210"
        >
            <style dangerouslySetInnerHTML={{
                __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
.sales-history-atlas-standard-invoice { color-scheme: light !important; font-family: Arial, Helvetica, sans-serif; }
.sales-history-atlas-standard-invoice table { page-break-inside: auto; }
.sales-history-atlas-standard-invoice tr { page-break-inside: avoid; page-break-after: auto; }
#pdf-render-container .atlas-standard-workspace-name[data-rtl-workspace-name] {
    direction: rtl !important;
    unicode-bidi: plaintext;
    font-kerning: normal;
}
`
            }} />

            {backgroundSrc && background ? (
                <img
                    src={backgroundSrc}
                    alt=""
                    aria-hidden="true"
                    className="pointer-events-none absolute -z-10 object-contain"
                    data-atlas-standard-background=""
                    style={{
                        left: '50%',
                        top: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: `${Math.min(100, Math.max(10, background.size || 100))}%`,
                        height: 'auto',
                        opacity: Math.min(1, Math.max(0.01, (background.opacity ?? 15) / 100))
                    }}
                />
            ) : null}

            <header className="mb-1 flex min-h-[13mm] items-center justify-between border-b-2 px-1 pb-1" style={{ borderColor: INK }}>
                <MovableOrderPrintBlock
                    componentKey={SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.workspaceName}
                    label={labels.workspaceName}
                    position={componentPositions?.[SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.workspaceName]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                    wrapperClassName="shrink-0"
                    fontSizeEditable
                    defaultFontSize={18}
                >
                    <h1
                        data-rtl-workspace-name={workspaceNameDirection === 'rtl' ? 'true' : undefined}
                        className="atlas-standard-workspace-name max-w-[150mm] truncate text-[18px] font-bold tracking-wide"
                        style={workspaceNameDirection === 'rtl'
                            ? { color: INK, fontFamily: 'Tahoma, Arial, sans-serif', letterSpacing: 0 }
                            : { color: INK }}
                    >
                        {workspaceNameValue}
                    </h1>
                </MovableOrderPrintBlock>
                <MovableOrderPrintBlock
                    componentKey={SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.logo}
                    label={labels.workspaceLogo}
                    position={componentPositions?.[SALES_HISTORY_ATLAS_STANDARD_MOVABLE_COMPONENT_KEYS.logo]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                    wrapperClassName="shrink-0"
                    handleSide="left"
                    resizable
                    maxScale={4}
                >
                    {logoSrc ? (
                        <img src={logoSrc} alt={labels.workspaceLogo} className="max-h-[11mm] max-w-[24mm] object-contain" />
                    ) : (
                        <div className="flex h-[11mm] w-[11mm] items-center justify-center border-[2px] text-[9px] font-bold tracking-[0.1em]" style={{ borderColor: INK, color: INK }}>{labels.logo}</div>
                    )}
                </MovableOrderPrintBlock>
            </header>

            <HideableSection
                title={labels.invoiceDetails}
                dialogDescription={labels.selectValues}
                fields={invoiceDetailFields}
                fieldOrder={fieldOrders[fieldOrderKeys.invoiceDetails]}
                fieldLabelOverrides={fieldLabelOverrides}
                hiddenFields={hiddenFields}
                onHiddenFieldChange={onHiddenFieldChange}
                onFieldOrderChange={onFieldOrderChange
                    ? (fieldKeys) => onFieldOrderChange(fieldOrderKeys.invoiceDetails, fieldKeys)
                    : undefined}
                onFieldLabelChange={onFieldLabelChange}
                className="mb-2"
                dialogClassName="max-w-3xl"
                dialogFieldsClassName="grid grid-cols-3 gap-2"
                dialogFieldClassName="min-h-[68px] flex-col justify-start gap-1"
                dragInstruction={labels.dragToSwap}
                renameTitleLabel={labels.renameTitle}
                resetTitleLabel={labels.resetTitle}
                renameTitleDescription={labels.renameTitleDescription}
                titleFieldLabel={labels.title}
                saveLabel={labels.save}
                cancelLabel={labels.cancel}
            />

            <HideableTable
                title={isReturnPrint ? returnLabels.returnedItemsTable : salesLabels.salesItemsTable}
                dialogDescription={labels.selectColumns}
                emptyLabel={labels.noColumns}
                columns={tableColumns}
                fieldLabelOverrides={fieldLabelOverrides}
                hiddenFields={hiddenFields}
                onHiddenFieldChange={onHiddenFieldChange}
                onFieldLabelChange={onFieldLabelChange}
                renameTitleLabel={labels.renameTitle}
                resetTitleLabel={labels.resetTitle}
                renameTitleDescription={labels.renameTitleDescription}
                titleFieldLabel={labels.title}
                saveLabel={labels.save}
                cancelLabel={labels.cancel}
            >
                {() => (
                    renderItemsTable(
                        itemChunks[0],
                        0,
                        'sales-history-atlas-standard-items-page-1',
                        ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM
                    )
                )}
            </HideableTable>

            <HideableSection
                title={isReturnPrint ? returnLabels.returnSummary : salesLabels.salesSummary}
                dialogDescription={labels.selectValues}
                fields={financialFields}
                fieldOrder={fieldOrders[fieldOrderKeys.financialSummary]}
                fieldLabelOverrides={fieldLabelOverrides}
                hiddenFields={hiddenFields}
                onHiddenFieldChange={onHiddenFieldChange}
                onFieldOrderChange={onFieldOrderChange
                    ? (fieldKeys) => onFieldOrderChange(fieldOrderKeys.financialSummary, fieldKeys)
                    : undefined}
                onFieldLabelChange={onFieldLabelChange}
                className="mb-2"
                dialogClassName="max-w-2xl"
                dialogFieldsClassName="grid grid-cols-2 gap-2"
                dialogFieldClassName="min-h-[68px] flex-col justify-start gap-1"
                dragInstruction={labels.dragToSwap}
                renameTitleLabel={labels.renameTitle}
                resetTitleLabel={labels.resetTitle}
                renameTitleDescription={labels.renameTitleDescription}
                titleFieldLabel={labels.title}
                saveLabel={labels.save}
                cancelLabel={labels.cancel}
            />
            <div data-template-text-flow-anchor="" aria-hidden="true" />

            <div className="flex min-h-[13mm] items-start justify-between gap-4 text-[10px]" style={{ color: '#374151' }}>
                <div className="truncate pt-1 font-bold">{footerEmail.length ? `${labels.email}: ${footerEmail.join(' - ')}` : ''}</div>
                <div className="max-w-[125mm] truncate text-end leading-4">
                    {footerAddress.length ? <div className="truncate">{footerAddress.join(' - ')}</div> : null}
                    {footerPhone.length ? <div className="truncate">{footerPhone.join(' - ')}</div> : null}
                </div>
            </div>

            {showPrintFooter ? (
                <footer
                    data-atlas-standard-print-footer=""
                    className="grid grid-cols-3 border-t pt-1 text-center text-[10px] font-bold"
                    style={{ borderColor: INK, color: '#374151' }}
                >
                    <span>{labels.madeBy}</span>
                    <span>{labels.page} 1 {labels.pageOf} 1</span>
                    <span>{labels.printDate}: {issuedAt.date}</span>
                </footer>
            ) : null}

            {visibleTableColumns.length > 0
                ? itemChunks.slice(1).map((chunk, chunkIndex) => (
                    renderItemsTable(
                        chunk,
                        maxFirstPageRows + (chunkIndex * maxContinuationRows),
                        `sales-history-atlas-standard-items-page-${chunkIndex + 2}`,
                        ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM,
                        true
                    )
                ))
                : null}
        </div>
    )
}
