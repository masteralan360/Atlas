import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import { UniversalInvoice } from '@/types'

const styles = StyleSheet.create({
    page: {
        backgroundColor: '#ffffff',
        padding: 24,
        fontFamily: 'Helvetica',
        fontSize: 9,
        width: 226, // ~80mm
    },
    header: {
        alignItems: 'center',
        marginBottom: 16,
    },
    logo: {
        width: 60,
        height: 40,
        objectFit: 'contain',
        marginBottom: 8,
    },
    storeName: {
        fontSize: 14,
        fontWeight: 'bold',
        textTransform: 'uppercase',
        letterSpacing: 2,
        marginBottom: 12,
    },
    infoRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 12,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
    },
    infoLabel: {
        fontSize: 7,
        color: '#9ca3af',
        textTransform: 'uppercase',
        marginBottom: 2,
    },
    infoValue: {
        fontSize: 9,
    },
    exchangeSection: {
        marginBottom: 12,
    },
    exchangeLabel: {
        fontSize: 7,
        color: '#9ca3af',
        textTransform: 'uppercase',
        marginBottom: 4,
    },
    exchangeGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
    },
    exchangeItem: {
        backgroundColor: '#f9fafb',
        borderWidth: 1,
        borderColor: '#e5e7eb',
        borderRadius: 2,
        padding: 4,
        width: '48%',
    },
    exchangePair: {
        fontSize: 7,
        fontWeight: 'bold',
    },
    exchangeRate: {
        fontSize: 8,
        fontWeight: 'bold',
    },
    table: {
        marginBottom: 12,
    },
    tableHeader: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb',
        paddingBottom: 4,
        marginBottom: 4,
    },
    tableHeaderCell: {
        fontSize: 7,
        color: '#9ca3af',
        textTransform: 'uppercase',
        fontWeight: 'bold',
    },
    tableRow: {
        flexDirection: 'row',
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f4f6',
    },
    colName: { width: '40%' },
    colQty: { width: '15%', textAlign: 'center' },
    colPrice: { width: '22%', textAlign: 'right' },
    colTotal: { width: '23%', textAlign: 'right' },
    productName: {
        fontWeight: 'bold',
        fontSize: 9,
    },
    productSku: {
        fontSize: 6,
        color: '#9ca3af',
        marginTop: 1,
    },
    totalSection: {
        borderTopWidth: 2,
        borderTopColor: '#000000',
        paddingTop: 8,
        marginBottom: 12,
    },
    totalRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
    },
    totalLabel: {
        fontSize: 9,
        fontWeight: 'bold',
        textTransform: 'uppercase',
        color: '#6b7280',
    },
    totalValue: {
        fontSize: 16,
        fontWeight: 'bold',
    },
    footer: {
        textAlign: 'center',
        borderTopWidth: 1,
        borderTopColor: '#f3f4f6',
        paddingTop: 12,
    },
    thankYou: {
        fontSize: 9,
        fontWeight: 'bold',
        marginBottom: 2,
    },
    keepRecord: {
        fontSize: 7,
        color: '#9ca3af',
    },
})

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

interface ReceiptPDFProps {
    data: UniversalInvoice
    features: {
        logo_url?: string
        iqd_display_preference?: string
    }
    workspaceName: string
    translations: {
        date: string
        id: string
        cashier: string
        paymentMethod: string
        name: string
        quantity: string
        price: string
        total: string
        thankYou: string
        keepRecord: string
        exchangeRates: string
        snapshots: string
    }
}

export function ReceiptPDF({ data, features, workspaceName, translations: t }: ReceiptPDFProps) {
    const items = data.items || []
    const settlementCurrency = data.settlement_currency || 'usd'

    const getPaymentMethodLabel = (method?: string) => {
        if (!method) return ''
        const labels: Record<string, string> = {
            cash: 'Cash',
            fib: 'FIB',
            qicard: 'QiCard',
            zaincash: 'ZainCash',
            fastpay: 'FastPay',
            loan: 'Loan'
        }
        return labels[method] || method.toUpperCase()
    }

    return (
        <Document>
            <Page size={{ width: 226, height: 2000 }} style={styles.page}>
                {/* Header */}
                <View style={styles.header}>
                    {features.logo_url && (
                        <Image src={features.logo_url} style={styles.logo} />
                    )}
                    <Text style={styles.storeName}>{workspaceName || 'Atlas'}</Text>
                </View>

                {/* Info Row */}
                <View style={styles.infoRow}>
                    <View>
                        <Text style={styles.infoLabel}>{t.date}</Text>
                        <Text style={styles.infoValue}>{formatDateTimePdf(data.created_at)}</Text>
                        <Text style={[styles.infoLabel, { marginTop: 4 }]}>{t.id}</Text>
                        <Text style={styles.infoValue}>{data.invoiceid}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.infoLabel}>{t.cashier}</Text>
                        <Text style={styles.infoValue}>{data.cashier_name}</Text>
                        {data.payment_method && (
                            <>
                                <Text style={[styles.infoLabel, { marginTop: 4 }]}>{t.paymentMethod}</Text>
                                <Text style={styles.infoValue}>{getPaymentMethodLabel(data.payment_method)}</Text>
                            </>
                        )}
                    </View>
                </View>

                {/* Exchange Rates */}
                {data.exchange_rates && data.exchange_rates.length > 0 && (
                    <View style={styles.exchangeSection}>
                        <Text style={styles.exchangeLabel}>{t.exchangeRates} {t.snapshots}</Text>
                        <View style={styles.exchangeGrid}>
                            {data.exchange_rates.map((rate: any, idx: number) => (
                                <View key={idx} style={styles.exchangeItem}>
                                    <Text style={styles.exchangePair}>{rate.pair}</Text>
                                    <Text style={styles.exchangeRate}>
                                        100 {rate.pair.split('/')[0]} = {formatCurrencyPdf(rate.rate, rate.pair.split('/')[1].toLowerCase(), features.iqd_display_preference)}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                {/* Items Table */}
                <View style={styles.table}>
                    <View style={styles.tableHeader}>
                        <Text style={[styles.tableHeaderCell, styles.colName]}>{t.name}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colQty]}>{t.quantity}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colPrice]}>{t.price}</Text>
                        <Text style={[styles.tableHeaderCell, styles.colTotal]}>{t.total}</Text>
                    </View>
                    {items.map((item, idx) => (
                        <View key={idx} style={styles.tableRow}>
                            <View style={styles.colName}>
                                <Text style={styles.productName}>{item.product_name}</Text>
                                {item.product_sku && <Text style={styles.productSku}>{item.product_sku}</Text>}
                            </View>
                            <Text style={[styles.colQty, { fontWeight: 'bold' }]}>{item.quantity}</Text>
                            <Text style={styles.colPrice}>
                                {formatCurrencyPdf(item.unit_price, settlementCurrency, features.iqd_display_preference)}
                            </Text>
                            <Text style={[styles.colTotal, { fontWeight: 'bold' }]}>
                                {formatCurrencyPdf(item.total_price || (item.unit_price * item.quantity), settlementCurrency, features.iqd_display_preference)}
                            </Text>
                        </View>
                    ))}
                </View>

                {/* Total */}
                <View style={styles.totalSection}>
                    <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>{t.total}</Text>
                        <Text style={styles.totalValue}>
                            {formatCurrencyPdf(data.total_amount, settlementCurrency, features.iqd_display_preference)}
                        </Text>
                    </View>
                </View>

                {/* Footer */}
                <View style={styles.footer}>
                    <Text style={styles.thankYou}>{t.thankYou}</Text>
                    <Text style={styles.keepRecord}>{t.keepRecord}</Text>
                </View>
            </Page>
        </Document>
    )
}
