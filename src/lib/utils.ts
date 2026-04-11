import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { getLoanLinkedPartySummary } from '@/lib/loanParties'
import { getLoanCounterpartyLabel, getLoanDetailsTitle, getLoanDirection, getLoanDirectionLabel, getLoanScheduleTitle, getLoanSummaryTitle, isSimpleLoan } from '@/lib/loanPresentation'
import i18n from '@/i18n/config'
import { getAppSettingSync, setAppSetting } from '@/local-db/settings'

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

export type HourDisplayPreference = '24-hour' | '12-hour'

export const HOUR_DISPLAY_PREFERENCE_KEY = 'hour_display_preference'
export const HOUR_DISPLAY_PREFERENCE_EVENT = 'atlas:hour-display-preference-change'

function pad2(value: number) {
    return String(value).padStart(2, '0')
}

function toDate(value: Date | string): Date {
    if (value instanceof Date) {
        return new Date(value.getTime())
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [year, month, day] = value.split('-').map(Number)
        return new Date(year, month - 1, day)
    }

    return new Date(value)
}

function isValidDate(value: Date) {
    return !Number.isNaN(value.getTime())
}

function formatNumericDate(date: Date, yearDigits: 2 | 4) {
    if (!isValidDate(date)) {
        return yearDigits === 2 ? '--/--/--' : '--/--/----'
    }

    const year = yearDigits === 2
        ? date.getFullYear().toString().slice(-2)
        : String(date.getFullYear())

    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${year}`
}

function formatTimePlaceholder(includeMinutes: boolean, includeSeconds: boolean, preference: HourDisplayPreference) {
    if (!includeMinutes) {
        return preference === '12-hour'
            ? `-- ${i18n.t('common.am', { defaultValue: 'AM' })}`
            : '--'
    }

    const base = includeSeconds ? '--:--:--' : '--:--'
    return preference === '12-hour'
        ? `${base} ${i18n.t('common.am', { defaultValue: 'AM' })}`
        : base
}

export function getHourDisplayPreference(): HourDisplayPreference {
    const storedPreference = getAppSettingSync(HOUR_DISPLAY_PREFERENCE_KEY)
    return storedPreference === '12-hour' ? '12-hour' : '24-hour'
}

export async function setHourDisplayPreference(preference: HourDisplayPreference): Promise<void> {
    await setAppSetting(HOUR_DISPLAY_PREFERENCE_KEY, preference)

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(HOUR_DISPLAY_PREFERENCE_EVENT, {
            detail: preference
        }))
    }
}

export function formatCurrency(
    amount: number,
    currency: string = 'usd',
    iqdPreference: 'IQD' | 'د.ع' = 'IQD'
): string {
    const code = currency.toLowerCase()

    if (code === 'iqd') {
        const formatted = new Intl.NumberFormat('en-US', {
            maximumFractionDigits: 0,
            minimumFractionDigits: 0
        }).format(amount)
        return iqdPreference === 'IQD' ? `${formatted} IQD` : `${formatted} د.ع`
    }

    if (code === 'eur') {
        return new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency: 'EUR',
        }).format(amount)
    }

    if (code === 'try') {
        return new Intl.NumberFormat('tr-TR', {
            style: 'currency',
            currency: 'TRY',
        }).format(amount)
    }

    // Default to USD
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
    }).format(amount)
}

export function formatDate(date: Date | string): string {
    return formatNumericDate(toDate(date), 2)
}

export function parseLocalDateValue(value?: string | null): Date | undefined {
    if (!value) {
        return undefined
    }

    const parsed = toDate(value)
    return isValidDate(parsed) ? parsed : undefined
}

export function parseLocalDateTimeValue(value?: string | null): Date | undefined {
    if (!value) {
        return undefined
    }

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
    if (match) {
        const [, year, month, day, hours, minutes, seconds] = match
        return new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hours),
            Number(minutes),
            Number(seconds || 0)
        )
    }

    const parsed = new Date(value)
    return isValidDate(parsed) ? parsed : undefined
}

export function formatLocalDateValue(value?: Date | string | null): string {
    if (!value) {
        return ''
    }

    const parsed = toDate(value)
    if (!isValidDate(parsed)) {
        return ''
    }

    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`
}

export function formatLocalDateTimeValue(value?: Date | string | null): string {
    if (!value) {
        return ''
    }

    const parsed = toDate(value)
    if (!isValidDate(parsed)) {
        return ''
    }

    return `${formatLocalDateValue(parsed)}T${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
}

export function formatTime(
    date: Date | string,
    options?: {
        includeMinutes?: boolean
        includeSeconds?: boolean
        preference?: HourDisplayPreference
    }
): string {
    const parsedDate = toDate(date)
    const includeMinutes = options?.includeMinutes ?? true
    const includeSeconds = options?.includeSeconds ?? false
    const preference = options?.preference ?? getHourDisplayPreference()

    if (!isValidDate(parsedDate)) {
        return formatTimePlaceholder(includeMinutes, includeSeconds, preference)
    }

    if (preference === '24-hour') {
        const base = includeMinutes
            ? `${pad2(parsedDate.getHours())}:${pad2(parsedDate.getMinutes())}`
            : pad2(parsedDate.getHours())

        return includeSeconds ? `${base}:${pad2(parsedDate.getSeconds())}` : base
    }

    const rawHours = parsedDate.getHours()
    const meridiem = rawHours >= 12
        ? i18n.t('common.pm', { defaultValue: 'PM' })
        : i18n.t('common.am', { defaultValue: 'AM' })
    const hour = rawHours % 12 || 12
    const base = includeMinutes
        ? `${pad2(hour)}:${pad2(parsedDate.getMinutes())}`
        : pad2(hour)

    return includeSeconds
        ? `${base}:${pad2(parsedDate.getSeconds())} ${meridiem}`
        : `${base} ${meridiem}`
}

export function formatDateTime(date: Date | string): string {
    return `${formatDate(date)} ${formatTime(date)}`
}

export function formatCompactDateTime(date: Date | string): string {
    return formatDateTime(date)
}

export function formatSnapshotTime(date: Date | string): string {
    return formatDateTime(date)
}

export function formatDocumentDate(date: Date | string): string {
    return formatNumericDate(toDate(date), 4)
}

export function formatDocumentDateTime(date: Date | string): string {
    return `${formatDocumentDate(date)} ${formatTime(date, { preference: '24-hour' })}`
}

export function generateId(): string {
    return crypto.randomUUID()
}

// Convert camelCase to snake_case
export function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key in obj) {
        if (obj[key] === undefined) {
            continue
        }
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
        result[snakeKey] = obj[key]
    }
    return result
}

// Convert snake_case to camelCase
export function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key in obj) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
        result[camelKey] = obj[key]
    }
    return result
}

export function parseFormattedNumber(val: string): number {
    return Number(val.replace(/,/g, ''))
}

export function sanitizeNumericInput(
    value: string,
    options?: {
        allowDecimal?: boolean
        maxFractionDigits?: number
    }
): string {
    const {
        allowDecimal = true,
        maxFractionDigits = 2
    } = options || {}

    const normalized = value
        .replace(/,/g, '')
        .replace(allowDecimal ? /[^\d.]/g : /\D/g, '')

    if (!normalized) {
        return ''
    }

    const [rawWhole = '', ...rawFractionParts] = normalized.split('.')
    const hasDecimal = allowDecimal && normalized.includes('.')
    const whole = rawWhole === '' ? '' : String(Number(rawWhole))

    if (!allowDecimal) {
        return rawWhole === '' ? '' : whole
    }

    const fraction = rawFractionParts.join('').slice(0, maxFractionDigits)
    if (!hasDecimal) {
        return rawWhole === '' ? '' : whole
    }

    return `${whole || '0'}.${fraction}`
}

export function formatNumericInput(value: string): string {
    if (!value) {
        return ''
    }

    const hasDecimal = value.includes('.')
    const [whole = '', fraction = ''] = value.split('.')
    const formattedWhole = whole ? formatNumberWithCommas(whole) : '0'

    if (!hasDecimal) {
        return formattedWhole
    }

    return `${formattedWhole}.${fraction}`
}

export function formatNumberWithCommas(val: number | string): string {
    const num = typeof val === 'string' ? val.replace(/,/g, '') : val.toString()
    if (isNaN(Number(num))) return num
    return new Intl.NumberFormat('en-US').format(Number(num))
}

export function formatSaleDetailsForWhatsApp(sale: any, t: (key: string) => string): string {
    const date = formatDocumentDateTime(sale.created_at)
    const id = sale.sequenceId ? `#${String(sale.sequenceId).padStart(5, '0')}` : `#${sale.id.slice(0, 8)}`

    // Header
    let text = `*${t('sales.details') || 'Sale Details'}*\n`
    text += `*${t('sales.id') || 'ID'}:* ${id}\n`
    text += `*${t('sales.date') || 'Date'}:* ${date}\n`

    // Cashier
    if (sale.cashier_name) {
        text += `*${t('sales.cashier') || 'Cashier'}:* ${sale.cashier_name}\n`
    }

    // Payment Method
    if (sale.payment_method) {
        const methodMap: Record<string, string> = {
            cash: 'Cash',
            fib: 'FIB',
            qicard: 'QiCard',
            zaincash: 'ZainCash',
            fastpay: 'FastPay',
            loan: 'Loan'
        }
        const method = methodMap[sale.payment_method] || sale.payment_method.toUpperCase()
        text += `*${t('pos.paymentMethod') || 'Payment Method'}:* ${method}\n`
    }

    // Exchange Rate
    // If we have specific exchange rate snapshots, use them. Otherwise use the primary one.
    if (sale.exchange_rates && sale.exchange_rates.length > 0) {
        text += `*${t('settings.exchangeRate.title') || 'Exchange Rate'}:*\n`
        sale.exchange_rates.forEach((rate: any) => {
            const formattedRate = formatCurrency(rate.rate, rate.pair.split('/')[1].toLowerCase(), 'IQD')
            text += `- 100 ${rate.pair.split('/')[0]} = ${formattedRate}\n`
        })
    } else if (sale.exchange_rate) {
        const formattedRate = formatCurrency(sale.exchange_rate, 'iqd', 'IQD')
        text += `*${t('settings.exchangeRate.title') || 'Exchange Rate'}:* 100 USD = ${formattedRate}\n`
        if (sale.exchange_source) {
            text += `  (${sale.exchange_source})\n`
        }
    }

    // Totals
    const currency = sale.settlement_currency || 'usd'
    const total = formatCurrency(sale.total_amount, currency, 'IQD')
    text += `\n*${t('sales.total') || 'Total'}:* ${total}\n`

    // Items
    if (sale.items && sale.items.length > 0) {
        text += `\n*${t('common.items') || 'Items'}:*\n`
        sale.items.forEach((item: any) => {
            const name = item.product_name || item.product?.name || t('item') || 'Item'
            const qty = item.quantity
            const price = formatCurrency(item.converted_unit_price || item.unit_price, currency, 'IQD')
            text += `- ${name} x${qty} (${price})\n`
        })
    }

    return text
}

export function formatLoanDetailsForWhatsApp(loan: any, t: (key: string) => string): string {
    const date = formatDocumentDateTime(loan.createdAt)
    const id = loan.loanNo
    const linkedPartySummary = getLoanLinkedPartySummary(loan, t)
    const belongsToLabel = t('loans.belongsTo') === 'loans.belongsTo' ? 'Belongs to' : t('loans.belongsTo')
    const counterpartyLabel = getLoanCounterpartyLabel(loan, t)
    const loanDetailsTitle = getLoanDetailsTitle(loan, t)
    const loanSummaryTitle = getLoanSummaryTitle(loan, t)

    // Header
    let text = `*${loanDetailsTitle}*\n`
    text += `*${t('loans.loanNo') || 'Loan No'}:* ${id}\n`
    text += `*${counterpartyLabel}:* ${loan.borrowerName}\n`
    if (isSimpleLoan(loan)) {
        text += `*${t('loans.direction') || 'Direction'}:* ${getLoanDirectionLabel(getLoanDirection(loan), t)}\n`
    }
    if (linkedPartySummary) {
        text += `*${belongsToLabel}:* ${linkedPartySummary.replace(`${belongsToLabel}: `, '')}\n`
    }
    text += `*${t('loans.date') || 'Disbursed Date'}:* ${date}\n`

    // Summary
    const currency = loan.settlementCurrency || 'usd'
    const principal = formatCurrency(loan.principalAmount, currency, 'IQD')
    const paid = formatCurrency(loan.totalPaidAmount, currency, 'IQD')
    const balance = formatCurrency(loan.balanceAmount, currency, 'IQD')

    text += `\n*${loanSummaryTitle}:*\n`
    text += `*${t('loans.totalPrincipal') || 'Total Principal'}:* ${principal}\n`
    text += `*${t('loans.totalRepaid') || 'Total Repaid'}:* ${paid}\n`
    text += `*${t('loans.balanceDue') || 'Balance Due'}:* ${balance}\n`
    if (isSimpleLoan(loan)) {
        text += `*${getLoanScheduleTitle(loan, t)}:* ${loan.installmentCount || 0}\n`
    }

    // Next Due
    if (loan.nextDueDate) {
        text += `\n*${t('loans.nextDue') || 'Next Due'}:* ${formatDocumentDate(loan.nextDueDate)}\n`
    }

    return text
}

export function formatOriginLabel(origin?: string | null, sourceChannel?: string | null): string {
    if ((sourceChannel || '').trim().toLowerCase() === 'marketplace') {
        return 'E-Commerce'
    }
    if (!origin) return 'POS'
    const normalized = origin.trim().toLowerCase()
    if (normalized === 'pos') return 'POS'
    if (normalized === 'instant_pos' || normalized === 'instant-pos' || normalized === 'instant pos') return 'Instant POS'
    if (normalized === 'sales_order' || normalized === 'sales-order' || normalized === 'sales order') return 'Sales Order'
    if (normalized === 'ecommerce' || normalized === 'e-commerce' || normalized === 'e commerce') return 'E-Commerce'
    if (normalized === 'travel_agency' || normalized === 'travel-agency' || normalized === 'travel agency') return 'Travel Agency'
    if (normalized === 'manual') return 'Manual'
    if (normalized === 'loans' || normalized === 'loan') return 'Loans'
    if (normalized === 'upload' || normalized === 'uploads') return 'Upload'
    return origin
}

/**
 * Transforms text into Mathematical Sans-Serif Bold Italic characters
 * for a stylized visual effect without special CSS.
 */
export function stylizeText(text: string): string {
    if (!text) return ''
    return text.split('').map(char => {
        const code = char.charCodeAt(0)
        // Lowercase a-z (U+0061 to U+007A) -> Sans-Serif Bold Italic (U+1D5BA to U+1D5D3)
        // Offset: 0x1D559
        if (code >= 0x61 && code <= 0x7A) {
            return String.fromCodePoint(code + 0x1D559)
        }
        // Uppercase A-Z (U+0041 to U+005A) -> Sans-Serif Bold Italic (U+1D5A0 to U+1D5B9)
        // Offset: 0x1D55F
        if (code >= 0x41 && code <= 0x5A) {
            return String.fromCodePoint(code + 0x1D55F)
        }
        return char
    }).join('')
}
