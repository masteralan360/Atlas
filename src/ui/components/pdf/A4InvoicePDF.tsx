import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import { UniversalInvoice } from '@/types'

// Register a clean sans-serif font (optional - uses default if not available)
// Font.register({ family: 'Inter', src: 'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2' })

const BRAND_COLOR = '#5c6ac4'

const styles = StyleSheet.create({
    page: {
        backgroundColor: '#ffffff',
        padding: 40,
        fontFamily: 'Helvetica',
        fontSize: 10,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    logo: {
        width: 120,
        height: 48,
        objectFit: 'contain',
    },
    logoPlaceholder: {
        width: 120,
        height: 48,
        backgroundColor: '#f3f4f6',
        justifyContent: 'center',
        alignItems: 'center',
    },
    logoPlaceholderText: {
        color: '#9ca3af',
        fontSize: 10,
        fontWeight: 'bold',
    },
    headerRight: {
        alignItems: 'flex-end',
    },
    label: {
        fontSize: 8,
        color: '#94a3b8',
        textTransform: 'uppercase',
        marginBottom: 2,
    },
    valueMain: {
        fontSize: 12,
        fontWeight: 'bold',
        color: BRAND_COLOR,
    },
    invoiceNumber: {
        fontSize: 14,
        fontWeight: 'bold',
        color: BRAND_COLOR,
    },
    infoSection: {
        backgroundColor: '#f8fafc',
        padding: 16,
        marginBottom: 20,
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    infoLabel: {
        fontWeight: 'bold',
        marginBottom: 4,
    },
    infoValue: {
        color: BRAND_COLOR,
        fontWeight: 'bold',
        fontSize: 12,
    },
    table: {
        marginBottom: 20,
    },
    tableHeader: {
        flexDirection: 'row',
        borderBottomWidth: 2,
        borderBottomColor: BRAND_COLOR,
        paddingBottom: 8,
        marginBottom: 8,
    },
    tableHeaderCell: {
        fontWeight: 'bold',
        color: BRAND_COLOR,
        fontSize: 9,
    },
    tableRow: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        paddingVertical: 6,
    },
    colQty: { width: '10%', textAlign: 'center' },
    colName: { width: '30%' },
    colDesc: { width: '20%' },
    colPrice: { width: '15%', textAlign: 'right' },
    colDiscount: { width: '10%', textAlign: 'center' },
    colTotal: { width: '15%', textAlign: 'right' },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 'auto',
    },
    termsSection: {
        width: '55%',
    },
    termsLabel: {
        fontSize: 8,
        color: BRAND_COLOR,
        fontWeight: 'bold',
        textTransform: 'uppercase',
        marginBottom: 4,
    },
    termsBox: {
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: '#d1d5db',
        height: 50,
        backgroundColor: '#fafafa',
        borderRadius: 4,
    },
    totalsSection: {
        width: '40%',
    },
    totalsRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
    },
    totalsLabel: {
        color: '#94a3b8',
    },
    totalsValue: {
        fontWeight: 'bold',
        color: BRAND_COLOR,
    },
    totalsFinal: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: BRAND_COLOR,
        padding: 8,
    },
    totalsFinalLabel: {
        color: '#ffffff',
        fontWeight: 'bold',
        fontSize: 12,
        textTransform: 'uppercase',
    },
    totalsFinalValue: {
        color: '#ffffff',
        fontWeight: 'bold',
        fontSize: 14,
    },
    exchangeRates: {
        marginTop: 8,
    },
    exchangeRateItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: '#ffffff',
        padding: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#f3f4f6',
        marginBottom: 4,
    },
    exchangeRatePair: {
        fontSize: 8,
        color: '#94a3b8',
        fontWeight: 'bold',
    },
    exchangeRateValue: {
        fontSize: 8,
        color: BRAND_COLOR,
        fontWeight: 'bold',
    },
    siteFooter: {
        marginTop: 20,
        borderTopWidth: 1,
        borderTopColor: '#e5e7eb',
        paddingTop: 8,
        textAlign: 'center',
        fontSize: 8,
        color: '#6b7280',
    },
    currencyTotalRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderBottomStyle: 'dashed',
        borderBottomColor: '#f3f4f6',
    },
    currencyTotalLabel: {
        fontSize: 8,
        color: '#cbd5e1',
        fontStyle: 'italic',
    },
    currencyTotalValue: {
        fontSize: 9,
        color: '#94a3b8',
        fontWeight: 'bold',
    },
})

// Simple currency formatter for PDF (no hooks)
function formatCurrencyPdf(amount: number, currency: string, iqdPreference?: string): string {
    if (currency === 'iqd') {
        const formatted = iqdPreference === 'comma'
            ? amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
            : (amount / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
        return `${formatted} IQD`
    }
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount)
}

function formatDateTimePdf(dateString: string): string {
    const date = new Date(dateString)
    return date.toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    })
}

interface A4InvoicePDFProps {
    data: UniversalInvoice
    features: {
        logo_url?: string
        iqd_display_preference?: string
    }
    translations: {
        date: string
        number: string
        soldTo: string
        soldBy: string
        qty: string
        productName: string
        description: string
        price: string
        discount: string
        total: string
        subtotal: string
        terms: string
        exchangeRates: string
        posSystem: string
        generated: string
    }
}

export function A4InvoicePDF({ data, features, translations: t }: A4InvoicePDFProps) {
    const items = data.items || []
    const settlementCurrency = data.settlement_currency || 'usd'

    // Calculate currency totals for footer
    const uniqueOriginalCurrencies = Array.from(new Set(items.map(i => i.original_currency || 'usd')))
        .filter(c => c !== settlementCurrency)

    const currencyTotals: Record<string, number> = {}
    uniqueOriginalCurrencies.forEach(curr => {
        currencyTotals[curr] = items
            .filter(i => (i.original_currency || 'usd') === curr)
            .reduce((sum, i) => sum + ((i.original_unit_price || 0) * (i.quantity || 0)), 0)
    })

    return (
        <Document>
            <Page size="A4" style={styles.page}>
                {/* Header */}
                <View style={styles.header}>
                    <View>
                        {features.logo_url ? (
                            <Image src={features.logo_url} style={styles.logo} />
                        ) : (
                            <View style={styles.logoPlaceholder}>
                                <Text style={styles.logoPlaceholderText}>LOGO</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.headerRight}>
                        <Text style={styles.label}>{t.date}</Text>
                        <Text style={styles.valueMain}>{formatDateTimePdf(data.created_at)}</Text>
                        <Text style={[styles.label, { marginTop: 8 }]}>{t.number}</Text>
                        <Text style={styles.invoiceNumber}>{data.invoiceid}</Text>
                    </View>
                </View>

                {/* Info Section */}
                <View style={styles.infoSection}>
                    <View>
                        <Text style={styles.infoLabel}>{t.soldTo}</Text>
                        <Text>{data.customer_name || '_______________'}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.infoLabel}>{t.soldBy}</Text>
                        <Text style={styles.infoValue}>{data.cashier_name?.slice(0, 8) || 'STAFF'}</Text>
                    </View>
                </View>

                {/* Table */}
                <View style={styles.table}>
                    <View style={styles.tableHeader}>
                        <Text style={[styles.tableHeaderCell, styles.colQty]}>{t.qty}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colName]}>{t.productName}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colDesc]}>{t.description}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colPrice]}>{t.price}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colDiscount]}>{t.discount}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colTotal]}>{t.total}</Text>
                    </View>
                    {items.map((item, idx) => {
                        const finalUnitPrice = item.unit_price || 0
                        const total = item.total_price || (finalUnitPrice * item.quantity)
                        const discountAmount = item.discount_amount || 0
                        const priceToShow = finalUnitPrice + (discountAmount / item.quantity)

                        return (
                            <View key={idx} style={styles.tableRow}>
                                <Text style={[styles.colQty, { fontWeight: 'bold' }]}>{item.quantity}</Text>
                                <Text style={[styles.colName, { fontWeight: 'bold' }]}>{item.product_name}</Text>
                                <Text style={[styles.colDesc, { color: '#6b7280', fontSize: 8 }]}>{item.product_sku || '-'}</Text>
                                <Text style={styles.colPrice}>
                                    {formatCurrencyPdf(priceToShow, settlementCurrency, features.iqd_display_preference)}
                                </Text>
                                <Text style={[styles.colDiscount, { color: '#9ca3af' }]}>
                                    {discountAmount > 0 ? formatCurrencyPdf(discountAmount, settlementCurrency, features.iqd_display_preference) : '-'}
                                </Text>
                                <Text style={[styles.colTotal, { fontWeight: 'bold' }]}>
                                    {formatCurrencyPdf(total, settlementCurrency, features.iqd_display_preference)}
                                </Text>
                            </View>
                        )
                    })}
                </View>

                {/* Footer */}
                <View style={styles.footer}>
                    {/* Left: Terms & Exchange Rates */}
                    <View style={styles.termsSection}>
                        <Text style={styles.termsLabel}>{t.terms}</Text>
                        <View style={styles.termsBox} />

                        {data.exchange_rates && data.exchange_rates.length > 0 && (
                            <View style={styles.exchangeRates}>
                                <Text style={styles.termsLabel}>{t.exchangeRates}</Text>
                                {data.exchange_rates.slice(0, 4).map((rate: any, i: number) => (
                                    <View key={i} style={styles.exchangeRateItem}>
                                        <Text style={styles.exchangeRatePair}>{rate.pair}</Text>
                                        <Text style={styles.exchangeRateValue}>{rate.rate}</Text>
                                    </View>
                                ))}
                            </View>
                        )}
                    </View>

                    {/* Right: Totals */}
                    <View style={styles.totalsSection}>
                        <View style={styles.totalsRow}>
                            <Text style={styles.totalsLabel}>{t.subtotal}:</Text>
                            <Text style={styles.totalsValue}>
                                {formatCurrencyPdf(data.subtotal_amount || data.total_amount, settlementCurrency, features.iqd_display_preference)}
                            </Text>
                        </View>

                        {Object.entries(currencyTotals).map(([code, amount], idx) => (
                            <View key={idx} style={styles.currencyTotalRow}>
                                <Text style={styles.currencyTotalLabel}>{t.total} ({code}):</Text>
                                <Text style={styles.currencyTotalValue}>
                                    {formatCurrencyPdf(amount, code, features.iqd_display_preference)}
                                </Text>
                            </View>
                        ))}

                        <View style={styles.totalsFinal}>
                            <Text style={styles.totalsFinalLabel}>{t.total}:</Text>
                            <Text style={styles.totalsFinalValue}>
                                {formatCurrencyPdf(data.total_amount, settlementCurrency, features.iqd_display_preference)}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* Site Footer */}
                <Text style={styles.siteFooter}>
                    {data.origin === 'pos' ? t.posSystem : 'Atlas'} | {t.generated}
                </Text>
            </Page>
        </Document>
    )
}
