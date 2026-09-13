import i18n from '@/i18n/config'
import { formatCurrency, formatDocumentDateTime } from '@/lib/utils'
import { invoke } from '@tauri-apps/api/core'
import { isAndroidPwa, isDesktop, isTauriAndroid } from '@/lib/platform'
import { clearAppSetting, getAppSetting, getAppSettingSync, setAppSetting } from '@/local-db/settings'
import {
    getDirectMobileThermalCapabilities,
    listAuthorizedUsbThermalPrinters,
    printToDirectMobileThermalPrinter,
    renderReceiptImageToEscPos,
    requestBluetoothThermalPrinter,
    requestUsbThermalPrinter,
    testDirectMobileThermalPrinter,
    type DirectMobileThermalPrinter,
    type DirectMobileThermalTransport,
    type WebBluetoothThermalProfile,
    type WebUsbThermalProfile
} from '@/services/mobileThermalPrinter'
import type { UniversalInvoice } from '@/types'
import type { WorkspaceFeatures } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    list_thermal_printers,
    print_thermal_printer,
    test_thermal_printer,
    type PaperSize,
    type PrintJobRequest,
    type PrintSections
} from 'tauri-plugin-thermal-printer'

export type ThermalRollWidth = 58 | 76 | 80 | 112
export type ThermalPrintTransport = 'tauri' | 'qz' | 'tauri-android-bluetooth' | DirectMobileThermalTransport

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
    /** The device-local transport that can reach this printer. */
    transport?: ThermalPrintTransport
    usb?: WebUsbThermalProfile
    bluetooth?: WebBluetoothThermalProfile
}

/**
 * A printer exposed by either the native Tauri plugin or QZ Tray in the PWA.
 * Keeping this independent from the Tauri plugin's type lets Settings work in
 * browsers without loading a native-only API.
 */
export interface ThermalPrinterInfo {
    name: string
    interface_type: string
    identifier: string
    status?: string
    transport: ThermalPrintTransport
    /** Directly paired mobile printers are trusted as thermal printers. */
    is_thermal?: boolean
    usb?: WebUsbThermalProfile
    bluetooth?: WebBluetoothThermalProfile
}

interface QzClient {
    websocket: {
        isActive: () => boolean
        connect: (options?: { retries?: number; delay?: number }) => Promise<void>
    }
    printers: {
        find: () => Promise<string[] | string>
    }
    configs: {
        create: (printer: string, options?: Record<string, unknown>) => unknown
    }
    print: (config: unknown, data: Array<string | Record<string, unknown>>) => Promise<void>
}

interface ThermalReceiptPrintRequest {
    saleData: UniversalInvoice
    features: WorkspaceFeatures
    workspaceName: string
    workspaceId?: string
}

interface ThermalImagePrintRequest {
    imageBase64: string
    workspaceId: string
    maxWidth?: number
}

const THERMAL_MAX_WIDTHS = { 58: 384, 80: 576 } as const

async function getThermalPrinterMaxWidth(workspaceId: string): Promise<number> {
    const printer = await getStoredSelectedThermalPrinter(workspaceId)
    if (!printer) return THERMAL_MAX_WIDTHS[80]
    const rollWidth = printer.roll_width_mm ?? inferRollWidthFromPaperSize(printer.paper_size)
    return THERMAL_MAX_WIDTHS[rollWidth as keyof typeof THERMAL_MAX_WIDTHS] ?? THERMAL_MAX_WIDTHS[80]
}

const DEFAULT_PAPER_SIZE: PaperSize = 'Mm80'
const DEFAULT_THERMAL_PRINTER_OPTIONS: PrintJobRequest['options'] = {
    cut_paper: true,
    beep: false,
    open_cash_drawer: false
}
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

function getAutoPrintUponCheckoutSettingKey(workspaceId: string) {
    return `auto_print_upon_checkout_${workspaceId}`
}

interface AndroidBluetoothThermalPrinterInfo {
    name: string
    interface_type: string
    identifier: string
    status: string
}

function getPrinterSearchText(printer: Pick<ThermalPrinterInfo, 'name' | 'identifier' | 'interface_type'>) {
    return `${printer.name} ${printer.identifier} ${printer.interface_type}`.toLowerCase()
}

let qzClientPromise: Promise<QzClient> | null = null

async function getQzClient(): Promise<QzClient> {
    qzClientPromise ??= import('qz-tray').then((module) => (
        (module.default ?? module) as unknown as QzClient
    ))
    return qzClientPromise
}

async function connectQzTray(): Promise<QzClient> {
    const qz = await getQzClient()
    if (qz.websocket.isActive()) return qz

    try {
        // Do not retry for a long time when the bridge is not installed. The
        // Settings UI should return control to the user immediately.
        await qz.websocket.connect({ retries: 0, delay: 0 })
        return qz
    } catch (error) {
        console.warn('[PrintService] QZ Tray connection failed:', error)
        throw new Error('Could not connect to QZ Tray. Install and run QZ Tray on this device, then approve its connection prompt and try again.')
    }
}

function getStoredPrinterTransport(printer: Partial<StoredThermalPrinter>): ThermalPrintTransport {
    if (
        printer.transport === 'qz'
        || printer.transport === 'tauri'
        || printer.transport === 'tauri-android-bluetooth'
        || printer.transport === 'webusb'
        || printer.transport === 'webbluetooth'
    ) {
        return printer.transport
    }

    // Existing saved selections predate transport metadata. Their local
    // storage belongs to the running app, so native selections remain native
    // while browser/PWA selections are treated as QZ Tray profiles.
    return isDesktop() ? 'tauri' : 'qz'
}

async function listAndroidBluetoothThermalPrinters(): Promise<ThermalPrinterInfo[]> {
    const printers = await invoke<AndroidBluetoothThermalPrinterInfo[]>('list_android_bluetooth_thermal_printers')
    return printers.map((printer) => ({
        ...printer,
        transport: 'tauri-android-bluetooth' as const
    }))
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
            roll_width_mm: parsed.roll_width_mm ?? inferRollWidthFromPaperSize(parsed.paper_size),
            transport: getStoredPrinterTransport(parsed)
        }
    } catch (error) {
        console.error('[PrintService] Failed to parse stored thermal printer:', error)
        return null
    }
}

export function isVirtualPrinter(printer: Pick<ThermalPrinterInfo, 'name' | 'identifier' | 'interface_type' | 'is_thermal'>): boolean {
    if (printer.is_thermal) return false
    const haystack = getPrinterSearchText(printer)
    return VIRTUAL_PRINTER_PATTERNS.some((pattern) => pattern.test(haystack))
}

export function isLikelyThermalPrinter(printer: Pick<ThermalPrinterInfo, 'name' | 'identifier' | 'interface_type' | 'is_thermal'>): boolean {
    if (printer.is_thermal) return true
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
    getDirectMobileThermalCapabilities,

    /**
     * This preference lives alongside the selected thermal printer, keeping
     * checkout auto-printing specific to the current workspace and device.
     */
    isAutoPrintUponCheckoutEnabled(workspaceId: string): boolean {
        if (!workspaceId) return false
        return getAppSettingSync(getAutoPrintUponCheckoutSettingKey(workspaceId)) === 'true'
    },

    async setAutoPrintUponCheckoutEnabled(workspaceId: string, enabled: boolean): Promise<void> {
        if (!workspaceId) return
        await setAppSetting(getAutoPrintUponCheckoutSettingKey(workspaceId), String(enabled))
    },

    async listThermalPrinters(): Promise<ThermalPrinterInfo[]> {
        if (isDesktop()) {
            const printers = await list_thermal_printers()
            return printers.map((printer) => ({ ...printer, transport: 'tauri' }))
        }

        if (isTauriAndroid()) {
            return listAndroidBluetoothThermalPrinters()
        }

        if (isAndroidPwa()) {
            return listAuthorizedUsbThermalPrinters()
        }

        const qz = await connectQzTray()
        const result = await qz.printers.find()
        const printers = Array.isArray(result) ? result : [result]

        return printers
            .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
            .map((name) => ({
                name,
                identifier: name,
                interface_type: 'QZ Tray (local bridge)',
                status: 'Available',
                transport: 'qz'
            }))
    },

    async pairUsbThermalPrinter(): Promise<ThermalPrinterInfo> {
        if (!isAndroidPwa()) {
            throw new Error('Direct USB thermal printing is available in the Android PWA only.')
        }
        return requestUsbThermalPrinter()
    },

    async pairBluetoothThermalPrinter(input: {
        serviceUuid: string
        characteristicUuid: string
    }): Promise<ThermalPrinterInfo> {
        if (!isAndroidPwa()) {
            throw new Error('Direct Bluetooth thermal printing is available in the Android PWA only.')
        }
        return requestBluetoothThermalPrinter(input)
    },

    async getSelectedThermalPrinter(workspaceId: string): Promise<StoredThermalPrinter | null> {
        return getStoredSelectedThermalPrinter(workspaceId)
    },

    async setSelectedThermalPrinter(
        workspaceId: string,
        printer: ThermalPrinterInfo,
        rollWidth: ThermalRollWidth = DEFAULT_THERMAL_ROLL_WIDTH
    ): Promise<StoredThermalPrinter> {
        const paperSize = rollWidthToPaperSize(rollWidth)
        const selection: StoredThermalPrinter = {
            name: printer.name,
            interface_type: printer.interface_type,
            identifier: printer.identifier,
            status: printer.status,
            paper_size: paperSize,
            roll_width_mm: rollWidth,
            transport: printer.transport,
            usb: printer.usb,
            bluetooth: printer.bluetooth
        }

        await setAppSetting(getThermalPrinterSettingKey(workspaceId), JSON.stringify(selection))
        return selection
    },

    async clearSelectedThermalPrinter(workspaceId: string): Promise<void> {
        await clearAppSetting(getThermalPrinterSettingKey(workspaceId))
    },

    async testThermalPrinter(workspaceId: string, printer?: ThermalPrinterInfo | StoredThermalPrinter): Promise<boolean> {
        const selectedPrinter = printer
            ? {
                name: printer.name,
                paper_size: 'paper_size' in printer ? printer.paper_size : DEFAULT_PAPER_SIZE,
                transport: getStoredPrinterTransport(printer),
                interface_type: printer.interface_type,
                identifier: printer.identifier,
                status: printer.status,
                usb: printer.usb,
                bluetooth: printer.bluetooth
            }
            : await getStoredSelectedThermalPrinter(workspaceId)

        if (!selectedPrinter?.name) {
            throw new Error('No thermal printer selected for this workspace on this device.')
        }

        if (selectedPrinter.transport === 'qz') {
            const qz = await connectQzTray()
            const config = qz.configs.create(selectedPrinter.name, { jobName: 'Atlas Thermal Printer Test' })
            await qz.print(config, [
                '\x1B@',
                '\x1Ba\x01',
                'ATLAS\n',
                'Thermal printer connected\n',
                '\x1Ba\x00',
                'Test receipt printed successfully.\n\n\n',
                '\x1DV\x00'
            ])
            return true
        }

        if (selectedPrinter.transport === 'webusb' || selectedPrinter.transport === 'webbluetooth') {
            await testDirectMobileThermalPrinter({
                name: selectedPrinter.name,
                interface_type: selectedPrinter.interface_type,
                identifier: selectedPrinter.identifier,
                status: selectedPrinter.status || 'Paired',
                transport: selectedPrinter.transport,
                is_thermal: true,
                usb: selectedPrinter.usb,
                bluetooth: selectedPrinter.bluetooth
            } as DirectMobileThermalPrinter)
            return true
        }

        if (selectedPrinter.transport === 'tauri-android-bluetooth') {
            await invoke('test_android_bluetooth_thermal_printer', { address: selectedPrinter.identifier })
            return true
        }

        if (!isDesktop()) return false

        await test_thermal_printer({
            printer_info: {
                printer: selectedPrinter.name,
                paper_size: selectedPrinter.paper_size,
                options: DEFAULT_THERMAL_PRINTER_OPTIONS,
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
        return true
    },

    async getThermalPrinterMaxWidth(workspaceId: string): Promise<number> {
        return getThermalPrinterMaxWidth(workspaceId)
    },

    async silentPrintImage({ imageBase64, workspaceId, maxWidth: maxWidthParam }: ThermalImagePrintRequest): Promise<boolean> {
        if (!workspaceId) return false

        const printer = await getStoredSelectedThermalPrinter(workspaceId)
        if (!printer?.name) {
            throw new Error('No thermal printer selected for this workspace on this device.')
        }

        const maxWidth = maxWidthParam ?? await getThermalPrinterMaxWidth(workspaceId)

        if (getStoredPrinterTransport(printer) === 'qz') {
            const qz = await connectQzTray()
            const config = qz.configs.create(printer.name, { jobName: 'Atlas Receipt' })
            const rawImageBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')

            await qz.print(config, [
                {
                    type: 'raw',
                    format: 'image',
                    flavor: 'base64',
                    data: rawImageBase64,
                    options: {
                        language: 'ESCPOS',
                        dotDensity: maxWidth <= THERMAL_MAX_WIDTHS[58] ? 'single' : 'double',
                        imageEncoding: 'gs_v_0',
                        quantization: 'dither'
                    }
                },
                '\n\n\n',
                '\x1DV\x00'
            ])
            return true
        }

        const transport = getStoredPrinterTransport(printer)
        if (transport === 'tauri-android-bluetooth') {
            const payload = await renderReceiptImageToEscPos(imageBase64, maxWidth)
            await invoke('print_android_bluetooth_thermal_printer', {
                address: printer.identifier,
                payload: Array.from(payload)
            })
            return true
        }

        if (transport === 'webusb' || transport === 'webbluetooth') {
            const payload = await renderReceiptImageToEscPos(imageBase64, maxWidth)
            await printToDirectMobileThermalPrinter({
                name: printer.name,
                interface_type: printer.interface_type,
                identifier: printer.identifier,
                status: printer.status || 'Paired',
                transport,
                is_thermal: true,
                usb: printer.usb,
                bluetooth: printer.bluetooth
            } as DirectMobileThermalPrinter, payload)
            return true
        }

        if (!isDesktop()) return false

        const printJob: PrintJobRequest = {
            printer: printer.name,
            paper_size: printer.paper_size || DEFAULT_PAPER_SIZE,
            options: DEFAULT_THERMAL_PRINTER_OPTIONS,
            sections: [
                {
                    Image: {
                        data: imageBase64,
                        max_width: maxWidth,
                        align: 'center',
                        dithering: true,
                        size: 'normal'
                    }
                },
                { Feed: { feed_type: 'lines', value: 3 } }
            ]
        }

        await print_thermal_printer(printJob)
        return true
    },

    async silentPrintReceipt({ saleData, features, workspaceName, workspaceId }: ThermalReceiptPrintRequest): Promise<boolean> {
        if (!workspaceId) return false

        const printer = await getStoredSelectedThermalPrinter(workspaceId)
        if (!printer?.name) {
            throw new Error('No thermal printer selected for this workspace on this device.')
        }

        // Checkout uses silentPrintImage so PWA receipts are rasterized before
        // reaching ESC/POS. Keep the text-section path exclusive to Tauri,
        // where the plugin already handles Unicode and structured sections.
        if (getStoredPrinterTransport(printer) !== 'tauri') return false
        if (!isDesktop()) return false

        const printJob: PrintJobRequest = {
            printer: printer.name,
            paper_size: printer.paper_size || DEFAULT_PAPER_SIZE,
            options: DEFAULT_THERMAL_PRINTER_OPTIONS,
            sections: buildReceiptSections(saleData, features, workspaceName, workspaceId)
        }

        await print_thermal_printer(printJob)
        return true
    }
}
