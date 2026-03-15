import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
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
    return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).format(new Date(date))
}

export function formatDateTime(date: Date | string): string {
    return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(date))
}

export function formatCompactDateTime(date: Date | string): string {
    const d = new Date(date)
    const month = d.toLocaleString('en-US', { month: 'short' })
    const day = d.getDate()
    const hh = d.getHours().toString().padStart(2, '0')
    const mm = d.getMinutes().toString().padStart(2, '0')
    return `${day} ${month}, ${hh}:${mm}`
}

export function formatSnapshotTime(date: Date | string): string {
    const d = new Date(date)
    const yy = d.getFullYear().toString().slice(-2)
    const mm = (d.getMonth() + 1).toString().padStart(2, '0')
    const dd = d.getDate().toString().padStart(2, '0')
    const hh = d.getHours().toString().padStart(2, '0')
    const min = d.getMinutes().toString().padStart(2, '0')
    return `${dd}/${mm}/${yy} ${hh}:${min}`
}

export function generateId(): string {
    return crypto.randomUUID()
}

// Convert camelCase to snake_case
export function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key in obj) {
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


export function formatNumberWithCommas(val: number | string): string {
    const num = typeof val === 'string' ? val.replace(/,/g, '') : val.toString()
    if (isNaN(Number(num))) return num
    return new Intl.NumberFormat('en-US').format(Number(num))
}

export function formatSaleDetailsForWhatsApp(sale: any, t: (key: string) => string): string {
    const date = formatDateTime(sale.created_at)
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

export function formatOriginLabel(origin?: string | null): string {
    if (!origin) return 'POS'
    const normalized = origin.trim().toLowerCase()
    if (normalized === 'pos') return 'POS'
    if (normalized === 'instant_pos' || normalized === 'instant-pos' || normalized === 'instant pos') return 'Instant POS'
    if (normalized === 'manual') return 'Manual'
    if (normalized === 'loans' || normalized === 'loan') return 'Loans'
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
