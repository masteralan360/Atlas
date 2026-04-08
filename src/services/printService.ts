import i18n from '@/i18n/config'
import { formatCurrency, formatDocumentDateTime } from '@/lib/utils'
import { isDesktop } from '@/lib/platform'
import { clearAppSetting, getAppSetting, setAppSetting } from '@/local-db/settings'
import type { UniversalInvoice } from '@/types'
import type { WorkspaceFeatures } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    list_thermal_printers,
    print_thermal_printer,
    test_thermal_printer,
    type PaperSize,
    type PrinterInfo,
    type PrintJobRequest,
    type PrintSections
} from 'tauri-plugin-thermal-printer'

export type ThermalRollWidth = 58 | 76 | 80 | 112

export const THERMAL_ROLL_WIDTHS: { value: ThermalRollWidth; label: string }[] = [
    { value: 58, label: '57-58 mm' },
    { value: 80, label: '80 mm (Most Common)' },
    { value: 76, label: '76 mm' },
    { value: 112, label: '112 mm' }
]

export const DEFAULT_THERMAL_ROLL_WIDTH: ThermalRollWidth = 80

export interface StoredThermalPrinter {
    name: string
    interface_type: string
    identifier: string
    status?: string
    paper_size: PaperSize
    roll_width_mm?: ThermalRollWidth
}

interface ThermalReceiptPrintRequest {
    saleData: UniversalInvoice
    features: WorkspaceFeatures
    workspaceName: string
    workspaceId?: string
}

const DEFAULT_PAPER_SIZE: PaperSize = 'Mm80'
const VIRTUAL_PRINTER_PATTERNS = [
    /onenote/i,
    /print to pdf/i,
    /document writer/i,
    /\bxps\b/i,
    /\bfax\b/i,
    /pdfcreator/i,
    /adobe pdf/i,
    /foxit pdf/i,
    /cutepdf/i,
    /dopdf/i,
    /image writer/i,
    /paperport/i,
    /snagit/i,
    /portprompt:/i,
    /^nul:$/i
]
const THERMAL_PRINTER_PATTERNS = [
    /\bthermal\b/i,
    /\breceipt\b/i,
    /\bpos\b/i,
    /\bepson\b/i,
    /\btm[-_ ]/i,
    /\btsp[-_ ]?\d+/i,
    /\bstar\b/i,
    /\bbixolon\b/i,
    /\bx[- ]?printer\b/i,
    /\bg[- ]?printer\b/i,
    /\bgp[-_ ]/i,
    /\bxp[-_ ]/i,
    /\brp[-_ ]/i,
    /\b58\s?mm\b/i,
    /\b80\s?mm\b/i,
    /\bhprt\b/i,
    /\bsunmi\b/i,
    /\brongta\b/i,
    /\bzywell\b/i,
    /\bzjiang\b/i,
    /\bcitizen\b/i,
    /\bsewoo\b/i,
    /\bbematech\b/i,
    /\bsprt\b/i,
    /\bmunbyn\b/i
]
const OFFICE_PRINTER_PATTERNS = [
    /\blaserjet\b/i,
    /\bdeskjet\b/i,
    /\bofficejet\b/i,
    /\bphotosmart\b/i,
    /\bcanon\b/i,
    /\bbrother\b/i,
    /\bxerox\b/i,
    /\bricoh\b/i,
    /\bkyocera\b/i,
    /\blexmark\b/i,
    /\bkonica\b/i,
    /\bminolta\b/i,
    /\bsharp\b/i,
    /\bsamsung\b/i
]

function getThermalPrinterSettingKey(workspaceId: string) {
    return `thermal_printer_selection_${workspaceId}`
}

function getPrinterSearchText(printer: Pick<PrinterInfo, 'name' | 'identifier' | 'interface_type'>) {
    return `${printer.name} ${printer.identifier} ${printer.interface_type}`.toLowerCase()
}

function getPrintLanguage(features: WorkspaceFeatures) {
    return features.print_lang && features.print_lang !== 'auto'
        ? features.print_lang
        : i18n.language
}

function rollWidthToPaperSize(rollWidth?: ThermalRollWidth): PaperSize {
    return rollWidth === 58 ? 'Mm58' : 'Mm80'
}

function inferRollWidthFromPaperSize(paperSize?: PaperSize): ThermalRollWidth {
    return paperSize === 'Mm58' ? 58 : DEFAULT_THERMAL_ROLL_WIDTH
}

function getTextAlign(features: WorkspaceFeatures): 'left' | 'right' {
    const lang = getPrintLanguage(features)
    return lang === 'ar' || lang === 'ku' ? 'right' : 'left'
}

function getPaymentMethodLabel(paymentMethod: string | undefined, t: ReturnType<typeof i18n.getFixedT>) {
    if (!paymentMethod) return t('common.notAvailable', { defaultValue: 'N/A' })

    switch (paymentMethod) {
        case 'cash':
            return t('pos.cash', { defaultValue: 'Cash' })
        case 'fib':
            return 'FIB'
        case 'qicard':
            return 'QiCard'
        case 'zaincash':
            return 'ZainCash'
        case 'fastpay':
            return 'FastPay'
        case 'loan':
            return t('pos.loan', { defaultValue: 'Loan' })
        default:
            return paymentMethod.toUpperCase()
    }
}

function buildReceiptSections(
    saleData: UniversalInvoice,
    features: WorkspaceFeatures,
    workspaceName: string,
    workspaceId?: string
): PrintSections[] {
    const printLang = getPrintLanguage(features)
    const t = i18n.getFixedT(printLang)
    const align = getTextAlign(features)
    const sections: PrintSections[] = [
        { Title: { text: workspaceName || 'Atlas' } },
        { Subtitle: { text: saleData.invoiceid || `#${saleData.id.slice(0, 8)}` } },
        { Text: { text: `${t('sales.date', { defaultValue: 'Date' })}: ${formatDocumentDateTime(saleData.created_at)}`, styles: { align } } },
        { Text: { text: `${t('sales.cashier', { defaultValue: 'Cashier' })}: ${saleData.cashier_name || 'System'}`, styles: { align } } },
        { Text: { text: `${t('pos.paymentMethod', { defaultValue: 'Payment Method' })}: ${getPaymentMethodLabel(saleData.payment_method, t)}`, styles: { align } } },
        { Line: { character: '-' } }
    ]

    for (const item of saleData.items || []) {
        const quantity = Number(item.quantity) || 0
        const total = typeof item.total_price === 'number' ? item.total_price : quantity * (item.unit_price || 0)

        sections.push(
            { Text: { text: item.product_name, styles: { bold: true, align } } },
            {
                Text: {
                    text: `${quantity} x ${formatCurrency(item.unit_price || 0, saleData.settlement_currency, features.iqd_display_preference)} = ${formatCurrency(total, saleData.settlement_currency, features.iqd_display_preference)}`,
                    styles: { align }
                }
            }
        )
    }

    sections.push(
        { Line: { character: '-' } },
        {
            Text: {
                text: `${t('common.total', { defaultValue: 'Total' })}: ${formatCurrency(saleData.total_amount, saleData.settlement_currency, features.iqd_display_preference)}`,
                styles: { bold: true, align: 'right', size: 'double' }
            }
        }
    )

    if (features.print_qr && workspaceId && !isLocalWorkspaceMode(workspaceId)) {
        sections.push({
            Qr: {
                data: `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/receipts/${saleData.id}.pdf`,
                size: 5,
                error_correction: 'M',
                model: 2,
                align: 'center'
            }
        })
    }

    sections.push(
        { Feed: { feed_type: 'lines', value: 1 } },
        { Text: { text: t('sales.receipt.thankYou', { defaultValue: 'Thank you for your purchase!' }), styles: { align: 'center', bold: true } } },
        { Text: { text: t('sales.receipt.keepRecord', { defaultValue: 'Please keep this receipt for your records.' }), styles: { align: 'center' } } },
        { Feed: { feed_type: 'lines', value: 2 } }
    )

    return sections
}

async function getStoredSelectedThermalPrinter(workspaceId: string): Promise<StoredThermalPrinter | null> {
    if (!workspaceId) return null

    const raw = await getAppSetting(getThermalPrinterSettingKey(workspaceId))
    if (!raw) return null

    try {
        const parsed = JSON.parse(raw) as StoredThermalPrinter
        if (!parsed?.name) return null
        return {
            ...parsed,
            paper_size: parsed.paper_size || DEFAULT_PAPER_SIZE,
            roll_width_mm: parsed.roll_width_mm ?? inferRollWidthFromPaperSize(parsed.paper_size)
        }
    } catch (error) {
        console.error('[PrintService] Failed to parse stored thermal printer:', error)
        return null
    }
}

export function isVirtualPrinter(printer: Pick<PrinterInfo, 'name' | 'identifier' | 'interface_type'>): boolean {
    const haystack = getPrinterSearchText(printer)
    return VIRTUAL_PRINTER_PATTERNS.some((pattern) => pattern.test(haystack))
}

export function isLikelyThermalPrinter(printer: Pick<PrinterInfo, 'name' | 'identifier' | 'interface_type'>): boolean {
    const haystack = getPrinterSearchText(printer)

    if (isVirtualPrinter(printer)) {
        return false
    }

    if (OFFICE_PRINTER_PATTERNS.some((pattern) => pattern.test(haystack))) {
        return false
    }

    return THERMAL_PRINTER_PATTERNS.some((pattern) => pattern.test(haystack))
}

export const printService = {
    async listThermalPrinters(): Promise<PrinterInfo[]> {
        if (!isDesktop()) return []
        return list_thermal_printers()
    },

    async getSelectedThermalPrinter(workspaceId: string): Promise<StoredThermalPrinter | null> {
        return getStoredSelectedThermalPrinter(workspaceId)
    },

    async setSelectedThermalPrinter(
        workspaceId: string,
        printer: PrinterInfo,
        rollWidth: ThermalRollWidth = DEFAULT_THERMAL_ROLL_WIDTH
    ): Promise<StoredThermalPrinter> {
        const paperSize = rollWidthToPaperSize(rollWidth)
        const selection: StoredThermalPrinter = {
            name: printer.name,
            interface_type: printer.interface_type,
            identifier: printer.identifier,
            status: printer.status,
            paper_size: paperSize,
            roll_width_mm: rollWidth
        }

        await setAppSetting(getThermalPrinterSettingKey(workspaceId), JSON.stringify(selection))
        return selection
    },

    async clearSelectedThermalPrinter(workspaceId: string): Promise<void> {
        await clearAppSetting(getThermalPrinterSettingKey(workspaceId))
    },

    async testThermalPrinter(workspaceId: string, printer?: PrinterInfo | StoredThermalPrinter): Promise<boolean> {
        if (!isDesktop()) return false

        const selectedPrinter = printer
            ? {
                name: printer.name,
                paper_size: 'paper_size' in printer ? printer.paper_size : DEFAULT_PAPER_SIZE
            }
            : await getStoredSelectedThermalPrinter(workspaceId)

        if (!selectedPrinter?.name) {
            throw new Error('No thermal printer selected for this workspace on this device.')
        }

        return test_thermal_printer({
            printer_info: {
                printer: selectedPrinter.name,
                paper_size: selectedPrinter.paper_size,
                options: {
                    cut_paper: true,
                    beep: false,
                    open_cash_drawer: false
                },
                sections: []
            },
            include_text: true,
            include_text_styles: true,
            include_alignment: true,
            include_columns: true,
            include_separators: true,
            include_barcode: true,
            include_qr: true,
            include_beep: false,
            cut_paper: true,
            test_feed: true
        })
    },

    async silentPrintReceipt({ saleData, features, workspaceName, workspaceId }: ThermalReceiptPrintRequest): Promise<boolean> {
        if (!isDesktop()) return false
        if (!workspaceId) return false

        const printer = await getStoredSelectedThermalPrinter(workspaceId)
        if (!printer?.name) {
            throw new Error('No thermal printer selected for this workspace on this device.')
        }

        const printJob: PrintJobRequest = {
            printer: printer.name,
            paper_size: printer.paper_size || DEFAULT_PAPER_SIZE,
            options: {
                cut_paper: true,
                beep: false,
                open_cash_drawer: false
            },
            sections: buildReceiptSections(saleData, features, workspaceName, workspaceId)
        }

        return print_thermal_printer(printJob)
    }
}
