
import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { UniversalInvoice } from '@/types'
import { formatCurrency, formatDateTime, formatSnapshotTime, cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useWorkspace } from '@/workspace'
import { useAuth } from '@/auth'
import { ReactQRCode } from '@lglab/react-qr-code'

interface SaleReceiptProps {
    data: UniversalInvoice
    features: any
}

interface SaleReceiptBaseProps extends SaleReceiptProps {
    workspaceName?: string | null
    workspaceId?: string
}

export const SaleReceiptBase = forwardRef<HTMLDivElement, SaleReceiptBaseProps>(
    ({ data, features, workspaceName, workspaceId: propWorkspaceId }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId

        const formatReceiptPrice = (amount: number, currency: string) => {
            const code = currency.toLowerCase()
            let formattedNum = ''
            let currencyLabel = code.toUpperCase()

            if (code === 'iqd') {
                formattedNum = new Intl.NumberFormat('en-US').format(amount)
                currencyLabel = features.iqd_display_preference === 'IQD' ? 'IQD' : 'د.ع'
            } else if (code === 'eur') {
                formattedNum = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
            } else {
                formattedNum = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
            }

            return (
                <div className="flex flex-col items-end leading-none">
                    <span className="font-bold">{formattedNum}</span>
                    <span className="text-[9px] text-gray-500 font-medium mt-0.5">{currencyLabel}</span>
                </div>
            )
        }


        return (
            <div ref={ref} dir={isRTL ? 'rtl' : 'ltr'} className="p-8 bg-white text-black print:p-0 print:w-[80mm] print:text-sm">

                <div className="text-center mb-8 relative">
                    <div className="flex justify-between items-center mb-4">
                        <div className="w-16"></div> {/* Spacer */}
                        {features.logo_url && (
                            <img
                                src={features.logo_url.startsWith('http') ? features.logo_url : platformService.convertFileSrc(features.logo_url)}
                                alt="Workspace Logo"
                                className="h-16 w-auto object-contain"
                            />
                        )}
                        <div className="flex justify-end w-20">
                            {features.print_qr && effectiveWorkspaceId && (
                                <div className="p-1 bg-white border border-gray-100 rounded-sm" data-qr-sharp="true">
                                    <ReactQRCode
                                        value={`https://asaas-r2-proxy.alanepic360.workers.dev/${effectiveWorkspaceId}/printed-invoices/receipts/${data.id}.pdf`}
                                        size={64}
                                        level="M"
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold mb-4">
                        {workspaceName || 'Atlas'}
                    </h1>
                    <div className="flex justify-between items-start text-xs text-gray-600 mb-4 border-b border-gray-200 pb-4">
                        <div className="text-start space-y-1">
                            <div>
                                <span className={cn("font-semibold text-[10px] text-gray-400 block", !isRTL && "uppercase tracking-wider")}>{t('sales.date')}: </span>
                                <span className="font-mono">{formatDateTime(data.created_at)}</span>
                            </div>
                            <div className="mt-2">
                                <span className={cn("font-semibold text-[10px] text-gray-400 block", !isRTL && "uppercase tracking-wider")}>{t('sales.id')}: </span>
                                <span className="font-mono">{data.invoiceid}</span>
                            </div>
                        </div>
                        <div className="flex flex-col items-end space-y-2">
                            <div className="text-end space-y-2">
                                <div>
                                    <span className={cn("font-semibold text-[10px] text-gray-400 block", !isRTL && "uppercase tracking-wider")}>{t('sales.cashier')}</span>
                                    <span className="font-medium">{data.cashier_name}</span>
                                </div>
                                {data.payment_method && (
                                    <div>
                                        <span className={cn("font-semibold text-[10px] text-gray-400 block", !isRTL && "uppercase tracking-wider")}>{t('pos.paymentMethod') || 'Payment Method'}</span>
                                        <span className="font-medium">
                                            {data.payment_method === 'cash' ? (t('pos.cash') || 'Cash') :
                                                data.payment_method === 'fib' ? 'FIB' :
                                                    data.payment_method === 'qicard' ? 'QiCard' :
                                                        data.payment_method === 'zaincash' ? 'ZainCash' :
                                                            data.payment_method === 'fastpay' ? 'FastPay' :
                                                                data.payment_method === 'loan' ? (t('pos.loan') || 'Loan') :
                                                                    data.payment_method.toUpperCase()}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Exchange Rates Section */}
                    {data.exchange_rates && data.exchange_rates.length > 0 && (
                        <div className="mb-6 text-start">
                            <div className={cn("text-[10px] font-bold text-gray-400 mb-2", !isRTL && "uppercase tracking-wider")}>
                                {t('settings.exchangeRate.title')} {t('common.snapshots')}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {data.exchange_rates.map((rate: any, idx: number) => (
                                    <div key={idx} className="p-2 border border-gray-200 rounded bg-gray-50/50">
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="text-[10px] font-bold">{rate.pair}</span>
                                            <span className="text-[9px] text-gray-400 uppercase">{rate.source}</span>
                                        </div>
                                        <div className="text-xs font-bold font-mono">
                                            100 {rate.pair.split('/')[0]} = {formatCurrency(rate.rate, rate.pair.split('/')[1].toLowerCase() as any, features.iqd_display_preference)}
                                        </div>
                                        <div className="text-[9px] text-gray-400 mt-1 font-mono opacity-80">
                                            {formatSnapshotTime(rate.timestamp)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="mb-8">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className={cn("text-[10px] text-gray-400 border-b border-gray-200", !isRTL && "uppercase")}>
                                <th className={cn("pb-2 text-start font-bold", !isRTL && "tracking-wider")}>{t('products.table.name')}</th>
                                <th className={cn("pb-2 text-center font-bold", !isRTL && "tracking-wider")}>{t('common.quantity')}</th>
                                <th className={cn("pb-2 text-end font-bold", !isRTL && "tracking-wider")}>{t('common.price')}</th>
                                <th className={cn("pb-2 text-end font-bold", !isRTL && "tracking-wider")}>{t('common.total')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {data.items?.map((item, idx) => {
                                const isConverted = item.original_currency && item.settlement_currency && item.original_currency !== item.settlement_currency
                                return (
                                    <tr key={idx}>
                                        <td className="py-3 text-start align-top">
                                            <div className="font-bold text-sm">{item.product_name}</div>
                                            {item.product_sku && (
                                                <div className="text-[10px] text-gray-400 font-mono mt-0.5">{item.product_sku}</div>
                                            )}
                                        </td>
                                        <td className="py-3 text-center align-top font-mono">{item.quantity}</td>
                                        <td className="py-3 text-end align-top">
                                            <div className="flex flex-col items-end">
                                                {formatReceiptPrice(item.unit_price, data.settlement_currency || 'usd')}
                                                {isConverted && (
                                                    <div className="mt-1 opacity-60 scale-90 origin-right">
                                                        {formatReceiptPrice(item.original_unit_price || item.unit_price, item.original_currency || 'usd')}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        <td className="py-3 text-end align-top">
                                            <div className="flex flex-col items-end">
                                                {formatReceiptPrice(item.total_price || (item.unit_price * item.quantity), data.settlement_currency || 'usd')}
                                                {isConverted && (
                                                    <div className="mt-1 opacity-60 scale-90 origin-right line-through decoration-gray-400">
                                                        {formatReceiptPrice((item.original_unit_price || item.unit_price) * item.quantity, item.original_currency || 'usd')}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="border-t-2 border-black pt-4 mb-8">
                    <div className="flex justify-between items-end">
                        <span className={cn("text-sm font-bold text-gray-500", !isRTL && "uppercase tracking-wider")}>{t('common.total')}</span>
                        <span className={cn("text-3xl font-black", !isRTL && "tracking-tight")}>
                            {formatCurrency(data.total_amount, data.settlement_currency || 'usd', features.iqd_display_preference)}
                        </span>
                    </div>
                </div>

                <div className="text-center text-[10px] text-gray-400 border-t border-gray-100 pt-6">
                    <p className="mb-1 font-medium text-gray-900">{t('sales.receipt.thankYou')}</p>
                    <p>{t('sales.receipt.keepRecord')}</p>
                </div>
            </div>
        )
    }
)
SaleReceiptBase.displayName = 'SaleReceiptBase'

export const SaleReceipt = forwardRef<HTMLDivElement, SaleReceiptProps>(
    ({ data, features }, ref) => {
        const { workspaceName } = useWorkspace()
        const { user } = useAuth()
        const workspaceId = user?.workspaceId

        return (
            <SaleReceiptBase
                ref={ref}
                data={data}
                features={features}
                workspaceName={workspaceName}
                workspaceId={workspaceId}
            />
        )
    }
)

SaleReceipt.displayName = 'SaleReceipt'
