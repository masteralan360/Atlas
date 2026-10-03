import { useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { ArrowDownLeft, ArrowUpRight, Ban, HandCoins, Printer, RotateCcw, Search, ShieldCheck } from 'lucide-react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { UiAccessGate } from '@/context/UiAccessContext'
import {
    getPaymentTransactionReversalAmounts,
    getFinancialVoidTransactionChain,
    getPaymentSourceKey,
    getPaymentTransactionRoutePath,
    getRemainingPaymentTransactions,
    isReversiblePaymentSourceType,
    isFinancialVoidSourceSupported,
    isPartnerSettlementPartialError,
    recordObligationSettlement,
    reversePaymentTransaction,
    settlePartnerBalance,
    useLockedPaymentSourceKeys,
    useFinancialTransactionVoids,
    usePaymentObligations,
    usePaymentTransactions,
    useWorkspaceContacts,
    voidFinancialTransaction,
    type BusinessPartner,
    type CurrencySettlementAmount,
    type PaymentObligation,
    type PaymentTransaction,
    type PaymentTransactionDirection,
    type PartnerSettlementProgress
} from '@/local-db'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import {
    Button,
    AppPagination,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useToast
} from '@/ui/components'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { SettlementDialog } from '@/ui/components/payments/SettlementDialog'
import { PartnerSettlementDialog } from '@/ui/components/payments/PartnerSettlementDialog'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'
import {
    FinancialTransactionVoidDialog,
    type FinancialTransactionVoidDialogInput
} from '@/ui/components/payments/FinancialTransactionVoidDialog'
import { FinancialVoidAuditDialog } from '@/ui/components/payments/FinancialVoidAuditDialog'
import { PaymentTransactionPrintTemplate, type PaymentTransactionPrintData, type PaymentTransactionPrintStatus } from '@/ui/components/payments/PaymentTransactionPrintTemplate'
import { PrintFlow } from '@/ui/components/PrintFlow'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { getPaymentTransactionReversalState } from '@/lib/paymentReversals'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { useWorkspace } from '@/workspace'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'

type PaymentsTab = 'open-items' | 'payable' | 'collectable' | 'transactions'
type ObligationTab = Exclude<PaymentsTab, 'transactions'>
type DirectionFilter = 'all' | 'incoming' | 'outgoing'
type SourceFilter = 'all' | 'loans' | 'orders' | 'budget' | 'real_estate' | 'activities' | 'clinical_appointments' | 'car_rental' | 'travel_transportation' | 'payments' | 'payment_accounts'
type OpenStatusFilter = 'all' | 'open' | 'overdue'

const PAYMENT_PAGE_SIZE_STORAGE_KEY = 'payments_rows_per_page'
const INITIAL_PAYMENT_PAGES: Record<PaymentsTab, number> = {
    'open-items': 1,
    payable: 1,
    collectable: 1,
    transactions: 1
}

function sourceTypeLabel(
    value: PaymentObligation['sourceType'] | PaymentTransaction['sourceType'],
    t: any,
    metadata?: Record<string, unknown> | null
) {
    switch (value) {
        case 'loan_origination':
            return t('payments.sourceType.loanOrigination', { defaultValue: 'Loan Origination' })
        case 'loan_installment':
            return t('payments.sourceType.loanInstallment', { defaultValue: 'Loan Installment' })
        case 'simple_loan':
            if (metadata?.displaySourceLabel === 'order_loan') {
                return t('payments.sourceType.orderLoan', { defaultValue: 'Order loan' })
            }
            return t('payments.sourceType.simpleLoan', { defaultValue: 'Simple Loan' })
        case 'loan_payment':
            return t('payments.sourceType.loanPayment', { defaultValue: 'Loan Payment' })
        case 'real_estate_payment':
            return t('payments.sourceType.realEstatePayment', { defaultValue: 'Real Estate Payment' })
        case 'real_estate_installment':
            return t('payments.sourceType.realEstateInstallment', { defaultValue: 'Real Estate Installment' })
        case 'real_estate_commission':
            return t('payments.sourceType.realEstateCommission', { defaultValue: 'Real Estate Commission' })
        case 'agent_commission_payout':
            return t('payments.sourceType.agentCommissionPayout', { defaultValue: 'Agent Commission Payout' })
        case 'agent_commission_recovery':
            return t('payments.sourceType.agentCommissionRecovery')
        case 'activity_transaction':
            return t('payments.sourceType.activityTransaction', { defaultValue: 'Activity Transaction' })
        case 'activity_refund':
            return t('payments.sourceType.activityRefund', { defaultValue: 'Activity Refund' })
        case 'clinical_appointment':
            return t('payments.sourceType.clinicalAppointment', { defaultValue: 'Appointment Service' })
        case 'sales_order':
            return t('payments.sourceType.salesOrder', { defaultValue: 'Sales Order' })
        case 'purchase_order':
            return t('payments.sourceType.purchaseOrder', { defaultValue: 'Purchase Order' })
        case 'expense_item':
            return t('payments.sourceType.expense', { defaultValue: 'Expense' })
        case 'payroll_status':
            return t('payments.sourceType.payroll', { defaultValue: 'Payroll' })
        case 'direct_transaction':
            return t('payments.sourceType.directTransaction', { defaultValue: 'Direct Transaction' })
        case 'payment_account_opening_balance':
            return t('paymentAccounts.openingBalance', { defaultValue: 'Opening Balance' })
        case 'payment_account_deposit':
            return t('paymentAccounts.deposit')
        case 'payment_account_withdrawal':
            return t('paymentAccounts.withdraw')
        case 'payment_account_adjustment':
            return t('paymentAccounts.adjustBalance')
        case 'delivery_courier_remittance':
            return t('payments.sourceType.deliveryCourierRemittance', { defaultValue: 'Courier Remittance' })
        case 'delivery_courier_fee_payout':
            return t('payments.sourceType.deliveryCourierFeePayout', { defaultValue: 'Courier Fee Payment' })
        case 'delivery_courier_reimbursement':
            return t('payments.sourceType.deliveryCourierReimbursement', { defaultValue: 'Courier Reimbursement' })
        case 'delivery_merchant_payout':
            return t('payments.sourceType.deliveryMerchantPayout', { defaultValue: 'Merchant Payout' })
        case 'delivery_recipient_payout':
            return t('payments.sourceType.deliveryRecipientPayout', { defaultValue: 'Recipient Payout' })
        case 'delivery_merchant_repayment':
            return t('payments.sourceType.deliveryMerchantRepayment', { defaultValue: 'Merchant Repayment' })
        case 'rental_payment':
            return t('payments.sourceType.rentalPayment')
        case 'rental_deposit':
            return t('payments.sourceType.rentalDeposit')
        case 'rental_deposit_refund':
            return t('payments.sourceType.rentalDepositRefund')
        case 'travel_booking_payment':
            return t('travelTransportation.recordProfitPayment')
        default:
            return value
    }
}

function paymentMethodLabel(value: PaymentTransaction['paymentMethod'], t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('ledger.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'loan_adjustment':
            return t('ledger.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' })
        case 'qicard':
            return t('ledger.paymentMethod.qicard', { defaultValue: 'QiCard' })
        case 'zaincash':
            return t('ledger.paymentMethod.zaincash', { defaultValue: 'ZainCash' })
        case 'fastpay':
            return t('ledger.paymentMethod.fastpay', { defaultValue: 'FastPay' })
        case 'fib':
            return t('ledger.paymentMethod.fib', { defaultValue: 'FIB' })
        case 'cash':
            return t('ledger.paymentMethod.cash', { defaultValue: 'Cash' })
        default:
            return value.charAt(0).toUpperCase() + value.slice(1).replace('_', ' ')
    }
}

function partnerSettlementErrorMessage(t: any, error: unknown) {
    if (isPartnerSettlementPartialError(error)) {
        return t('partnerSettlement.partialFailure', {
            defaultValue: 'Some payments were recorded before another item failed. Review the Account Statement before trying again.'
        })
    }
    const message = error instanceof Error ? error.message : ''
    if (message.includes('Commission payout cannot exceed the outstanding balance')) {
        return t('settlementModal.amountExceedsBalance', { defaultValue: 'The amount cannot exceed the remaining balance.' })
    }
    if (
        message.includes('Sales account agent not found')
        || message.includes('Sales account commission assignment not found')
        || message.includes('Sales account business partner not found')
        || message.includes('Completed sales order not found')
        || message.includes('Commission payout currency must match the sales order')
    ) {
        return t('partnerSettlement.agentCommissionPayoutUnavailable', {
            defaultValue: 'This sales-account commission payout is no longer available. Refresh and try again.'
        })
    }
    return message || t('payments.settlementFailed', { defaultValue: 'Failed to record settlement.' })
}

function collapseTransactionsBySource(
    items: PaymentTransaction[],
    latestUnreversedBySource: ReadonlyMap<string, PaymentTransaction>
) {
    const itemIds = new Set(items.map((item) => item.id))
    const seen = new Set<string>()
    const collapsed: PaymentTransaction[] = []

    items.forEach((item) => {
        const key = getPaymentSourceKey(item)
        const preferred = latestUnreversedBySource.get(key)

        // A reversal can have a later recorded payment time than the payment
        // that replaced it. When there is an active payment for this source,
        // always show that payment rather than collapsing the row to its
        // historical reversal.
        if (preferred && itemIds.has(preferred.id)) {
            if (item.id === preferred.id && !seen.has(key)) {
                collapsed.push(preferred)
                seen.add(key)
            }
            return
        }

        if (seen.has(key)) {
            return
        }

        seen.add(key)
        collapsed.push(item)
    })

    return collapsed
}

function formatAmountSummary(
    rows: Array<{ amount: number; currency: string }>,
    iqdPreference: 'IQD' | 'د.ع'
) {
    if (rows.length === 0) {
        return '0'
    }

    const totals = new Map<string, number>()
    rows.forEach((row) => {
        totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount)
    })

    return Array.from(totals.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => formatCurrency(amount, currency, iqdPreference))
        .join(' • ')
}

export function Payments() {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const { features, hasFeature, workspaceName } = useWorkspace()
    const { hasPermission, permissionKeys } = useWorkspacePermissions()
    const { dateRange, customDates } = useDateRange()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr || features.real_estate || features.activities || features.clinical_appointments || features.car_rental || features.travel_transportation || hasFeature('payment_accounts')
    const canSettleSalesAgentCommissions = hasFeature('sales_agent_commissions')
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.pay')

    const [activeTab, setActiveTab] = useState<PaymentsTab>('open-items')
    const [currentPages, setCurrentPages] = useState<Record<PaymentsTab, number>>(INITIAL_PAYMENT_PAGES)
    const [pageSize, setPageSize] = useState(() => {
        const savedPageSize = Number(localStorage.getItem(PAYMENT_PAGE_SIZE_STORAGE_KEY))
        return [5, 10, 20, 50, 100].includes(savedPageSize) ? savedPageSize : 20
    })
    const [search, setSearch] = useState('')
    const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
    const [statusFilter, setStatusFilter] = useState<OpenStatusFilter>('all')
    const [selectedObligation, setSelectedObligation] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [reversingTransactionId, setReversingTransactionId] = useState<string | null>(null)
    const [transactionToReverse, setTransactionToReverse] = useState<PaymentTransaction | null>(null)
    const [transactionToVoid, setTransactionToVoid] = useState<PaymentTransaction | null>(null)
    const [paymentTransactionPrintData, setPaymentTransactionPrintData] = useState<PaymentTransactionPrintData | null>(null)
    const [voidingTransactionId, setVoidingTransactionId] = useState<string | null>(null)
    const [isVoidAuditOpen, setIsVoidAuditOpen] = useState(false)
    const [isPartnerSettlementOpen, setIsPartnerSettlementOpen] = useState(false)

    useEffect(() => {
        localStorage.setItem(PAYMENT_PAGE_SIZE_STORAGE_KEY, String(pageSize))
    }, [pageSize])

    useEffect(() => {
        setCurrentPages(INITIAL_PAYMENT_PAGES)
    }, [search, directionFilter, sourceFilter, statusFilter, dateRange, customDates])

    const handlePageSizeChange = (nextPageSize: number) => {
        setPageSize(nextPageSize)
        setCurrentPages(INITIAL_PAYMENT_PAGES)
    }
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const printLang = features.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const printT = useMemo(() => i18n.getFixedT(printLang), [i18n, printLang])
    const printContactLine = useMemo(() => (['phone', 'email', 'address'] as const)
        .map(type => workspaceContacts.find(contact => contact.type === type && contact.isPrimary)
            || workspaceContacts.find(contact => contact.type === type))
        .map(contact => contact?.value.trim())
        .filter(Boolean)
        .join(' · '), [workspaceContacts])
    const paymentTransactionPrintTitle = printT('payments.transactionPrint.title', { defaultValue: 'Payment Transaction' })

    const settlementAction = useMemo(() => {
        if (activeTab === 'payable') {
            return {
                label: t('payments.actions.payPartner', { defaultValue: 'Pay Partner' }),
                direction: 'outgoing' as const
            }
        }
        if (activeTab === 'collectable') {
            return {
                label: t('payments.actions.collectFromPartner', { defaultValue: 'Collect from Partner' }),
                direction: 'incoming' as const
            }
        }
        return {
            label: t('payments.actions.settleBalance', { defaultValue: 'Settle Balance' }),
            direction: null
        }
    }, [activeTab, t])

    const obligations = usePaymentObligations(workspaceId, {
        direction: directionFilter,
        sourceModule: sourceFilter,
        status: statusFilter,
        search,
        applySalesAgentAccountCredits: true
    })
    const obligationsByTab = useMemo<Record<ObligationTab, PaymentObligation[]>>(() => ({
        'open-items': obligations,
        payable: obligations.filter((item) => item.direction === 'outgoing'),
        collectable: obligations.filter((item) => item.direction === 'incoming')
    }), [obligations])
    const lockedSourceKeys = useLockedPaymentSourceKeys(workspaceId)

    const allTransactions = usePaymentTransactions(workspaceId, { includeReversals: true })
    const financialVoidAudits = useFinancialTransactionVoids(user?.role === 'admin' ? workspaceId : undefined)
    const transactions = usePaymentTransactions(workspaceId, {
        direction: directionFilter,
        sourceModule: sourceFilter,
        search,
        includeReversals: true
    })

    const reversalAmountsByTransactionId = useMemo(
        () => getPaymentTransactionReversalAmounts(allTransactions),
        [allTransactions]
    )

    const fullyReversedIds = useMemo(
        () => new Set(
            allTransactions
                .filter((item) => !item.isDeleted && !item.reversalOfTransactionId)
                .filter((item) => {
                    const reversedAmount = reversalAmountsByTransactionId.get(item.id) || 0
                    return reversedAmount > 0.000001 && Math.abs(Number(item.amount || 0)) - reversedAmount <= 0.000001
                })
                .map((item) => item.id)
        ),
        [allTransactions, reversalAmountsByTransactionId]
    )

    const latestUnreversedBySource = useMemo(() => {
        const map = new Map<string, PaymentTransaction>()
        const sourceRows = getRemainingPaymentTransactions(allTransactions)
            .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))

        sourceRows.forEach((item) => {
            const key = getPaymentSourceKey(item)
            if (!map.has(key)) {
                map.set(key, item)
            }
        })

        return map
    }, [allTransactions])

    const visibleTransactions = useMemo(
        () => collapseTransactionsBySource(
            transactions.filter((item) => isDateInDateRange(item.paidAt, dateRange, customDates)),
            latestUnreversedBySource
        ),
        [customDates, dateRange, transactions, latestUnreversedBySource]
    )
    const transactionsPageCount = Math.max(1, Math.ceil(visibleTransactions.length / pageSize))
    const transactionsCurrentPage = Math.min(currentPages.transactions, transactionsPageCount)
    const paginatedTransactions = visibleTransactions.slice(
        (transactionsCurrentPage - 1) * pageSize,
        transactionsCurrentPage * pageSize
    )
    const voidTransactionChain = useMemo(() => {
        if (!transactionToVoid) return []
        try {
            return getFinancialVoidTransactionChain(allTransactions, transactionToVoid.id).transactions
        } catch {
            return [transactionToVoid]
        }
    }, [allTransactions, transactionToVoid])

    const paymentTransactionPrintPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!paymentTransactionPrintData) return undefined
        const { transaction } = paymentTransactionPrintData
        return {
            fields: [],
            page: { widthMm: 210, heightMm: 297 },
            createElement: (_fields, _effectiveId, printLangOverride) => {
                const effectivePrintLang = printLangOverride || printLang
                const tPrint = i18n.getFixedT(effectivePrintLang)
                return <PaymentTransactionPrintTemplate
                    data={paymentTransactionPrintData}
                    workspaceName={workspaceName || workspaceId || 'Atlas'}
                    logoUrl={features.logo_url}
                    contactLine={printContactLine}
                    printLang={effectivePrintLang}
                    iqdPreference={features.iqd_display_preference}
                    sourceLabel={sourceTypeLabel(transaction.sourceType, tPrint, transaction.metadata)}
                    methodLabel={paymentMethodLabel(transaction.paymentMethod, tPrint)}
                />
            },
            buildPdf: (element, printLangOverride) => generateTemplatePdf({
                element, format: 'a4', printLang: printLangOverride || printLang
            })
        }
    }, [features.iqd_display_preference, features.logo_url, i18n, paymentTransactionPrintData, printContactLine, printLang, workspaceId, workspaceName])

    const handlePrintPaymentTransaction = (
        transaction: PaymentTransaction,
        displayAmount: number,
        status: PaymentTransactionPrintStatus
    ) => {
        const originalTransaction = transaction.reversalOfTransactionId
            ? allTransactions.find((item) => item.id === transaction.reversalOfTransactionId)
            : transaction
        const reversalState = originalTransaction
            ? getPaymentTransactionReversalState(originalTransaction, allTransactions)
            : null

        setPaymentTransactionPrintData({
            transaction,
            displayAmount,
            status,
            reversalSummary: reversalState ? {
                reversedAmount: reversalState.reversedAmount,
                remainingAmount: reversalState.remainingAmount
            } : null,
            asOf: new Date().toISOString()
        })
    }

    const kpis = useMemo(() => ({
        totalOpen: formatAmountSummary(obligations, features.iqd_display_preference),
        receivable: formatAmountSummary(obligations.filter((item) => item.direction === 'incoming'), features.iqd_display_preference),
        payable: formatAmountSummary(obligations.filter((item) => item.direction === 'outgoing'), features.iqd_display_preference)
    }), [obligations, features.iqd_display_preference])

    const handleSettle = async (input: {
        paymentMethod: PaymentTransaction['paymentMethod']
        paidAt: string
        amount?: number
        idempotencyKey?: string
        note?: string
        counterpartyName?: string
        businessPartnerId?: string | null
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!workspaceId || !selectedObligation) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(workspaceId, selectedObligation, {
                paymentMethod: input.paymentMethod,
                paidAt: input.paidAt,
                amount: input.amount,
                idempotencyKey: input.idempotencyKey,
                note: input.note,
                counterpartyName: input.counterpartyName,
                businessPartnerId: input.businessPartnerId,
                accountId: input.accountId,
                accountNameSnapshot: input.accountNameSnapshot,
                createdBy: user?.id || null
            })
            toast({ title: t('payments.settlementRecorded', { defaultValue: 'Settlement recorded' }) })
            setSelectedObligation(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('payments.settlementFailed', { defaultValue: 'Failed to record settlement.' }),
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const handlePartnerSettlement = async (input: {
        partner: BusinessPartner
        direction: PaymentTransactionDirection
        paymentMethod: PaymentTransaction['paymentMethod']
        paidAt: string
        note?: string
        amountsByCurrency?: CurrencySettlementAmount[]
        onProgress?: (progress: PartnerSettlementProgress) => void
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!workspaceId) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            const result = await settlePartnerBalance(workspaceId, {
                partnerId: input.partner.id,
                direction: input.direction,
                paymentMethod: input.paymentMethod,
                paidAt: input.paidAt,
                note: input.note,
                createdBy: user?.id || null,
                amountsByCurrency: input.amountsByCurrency,
                accountId: input.accountId,
                accountNameSnapshot: input.accountNameSnapshot,
                onProgress: input.onProgress
            })
            const summaryText = result.groups
                .map((group) => formatCurrency(group.total, group.currency, features.iqd_display_preference))
                .join(' • ')
            const isCollect = result.direction === 'incoming'
            toast({
                title: isCollect
                    ? t('partnerSettlement.collectionCompleted', { defaultValue: 'Collection completed' })
                    : t('partnerSettlement.paymentCompleted', { defaultValue: 'Payment completed' }),
                description: isCollect
                    ? t('partnerSettlement.collectedFromAndApplied', {
                        defaultValue: '{{amount}} collected from {{partner}} and applied to {{count}} open items.',
                        amount: summaryText,
                        partner: result.partnerName,
                        count: result.items
                    })
                    : t('partnerSettlement.paidToAndApplied', {
                        defaultValue: '{{amount}} paid to {{partner}} and applied to {{count}} open items.',
                        amount: summaryText,
                        partner: result.partnerName,
                        count: result.items
                    })
            })
            setIsPartnerSettlementOpen(false)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: partnerSettlementErrorMessage(t, error),
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const handleReverse = async (input: PaymentReversalDialogInput) => {
        if (!workspaceId || !transactionToReverse || reversingTransactionId) {
            return
        }

        setReversingTransactionId(transactionToReverse.id)
        try {
            await reversePaymentTransaction(workspaceId, transactionToReverse.id, {
                ...input,
                createdBy: user?.id || null
            })
            toast({ title: t('payments.reversed', { defaultValue: 'Transaction reversed' }) })
            setTransactionToReverse(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('payments.reverseFailed', { defaultValue: 'Failed to reverse transaction.' }),
                variant: 'destructive'
            })
        } finally {
            setReversingTransactionId(null)
        }
    }

    const handleVoid = async (input: FinancialTransactionVoidDialogInput) => {
        if (!workspaceId || !user || !transactionToVoid || voidingTransactionId) {
            return
        }

        setVoidingTransactionId(transactionToVoid.id)
        try {
            await voidFinancialTransaction(workspaceId, transactionToVoid.id, {
                ...input,
                voidedBy: user.id,
                voidedByName: user.name || user.email,
                actorRole: user.role
            })
            toast({
                title: t('common.success'),
                description: t('financialVoid.success')
            })
            setTransactionToVoid(null)
        } catch {
            toast({
                title: t('common.error'),
                description: t('financialVoid.failed'),
                variant: 'destructive'
            })
        } finally {
            setVoidingTransactionId(null)
        }
    }

    if (!hasPaymentsSurface) {
        return (
            <div className="p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('payments.notAvailable', { defaultValue: 'Payments is not available in this workspace' })}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t('payments.enableModules', { defaultValue: 'Enable Loans, CRM, Accounting, or HR to use the central payments surface.' })}
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                    <h1 className="flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight">
                        {t('payments.title', { defaultValue: 'Payments' })}
                        {activeTab === 'transactions' ? <DateRangeBadge /> : null}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t('payments.subtitle', { defaultValue: 'Unified open obligations and central transaction history across loans, orders, appointments, payroll, expenses, and Real Estate commissions.' })} <ModulePageFreshness className="ms-2" />
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        {hasPermission('directTransaction.access') && (
                            <Button type="button" variant="outline" onClick={() => setLocation('/direct-transactions')} className="w-fit">
                                {t('payments.directTransactions', { defaultValue: 'Direct Transactions' })}
                            </Button>
                        )}
                        <Button type="button" onClick={() => setIsPartnerSettlementOpen(true)} className="w-fit">
                            <HandCoins className="me-1.5 h-4 w-4" />
                            {settlementAction.label}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.open', { defaultValue: 'Open' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.totalOpen}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.receivable', { defaultValue: 'Receivable' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.receivable}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.payable', { defaultValue: 'Payable' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.payable}</CardContent>
                    </Card>
                </div>
            </div>

            <Card>
                <CardContent className="pt-6">
                    <div className="space-y-3">
                        <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_180px_180px_180px]">
                            <div className="relative">
                                <Search className="pointer-events-none absolute start-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={t('payments.searchPlaceholder', { defaultValue: 'Search payments' })}
                                    className="ps-9"
                                />
                            </div>
                            <Select value={directionFilter} onValueChange={(value: DirectionFilter) => setDirectionFilter(value)}>
                                <SelectTrigger>
                                    <SelectValue placeholder={t('payments.filters.allDirections', { defaultValue: 'All Directions' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t('payments.filters.allDirections', { defaultValue: 'All Directions' })}</SelectItem>
                                    <SelectItem value="incoming">{t('payments.filters.incoming', { defaultValue: 'Incoming' })}</SelectItem>
                                    <SelectItem value="outgoing">{t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select value={sourceFilter} onValueChange={(value: SourceFilter) => setSourceFilter(value)}>
                                <SelectTrigger>
                                    <SelectValue placeholder={t('payments.filters.allSources', { defaultValue: 'All Sources' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t('payments.filters.allSources', { defaultValue: 'All Sources' })}</SelectItem>
                                    <SelectItem value="loans">{t('payments.filters.loans', { defaultValue: 'Loans' })}</SelectItem>
                                    <SelectItem value="orders">{t('payments.filters.orders', { defaultValue: 'Orders' })}</SelectItem>
                                    <SelectItem value="budget">{t('payments.filters.accountingHr', { defaultValue: 'Accounting / HR' })}</SelectItem>
                                    <SelectItem value="real_estate">{t('payments.filters.realEstate', { defaultValue: 'Real Estate' })}</SelectItem>
                                    <SelectItem value="activities">{t('payments.filters.activities', { defaultValue: 'Activities' })}</SelectItem>
                                    <SelectItem value="clinical_appointments">{t('payments.filters.appointments', { defaultValue: 'Appointments' })}</SelectItem>
                                    <SelectItem value="car_rental">{t('payments.filters.carRental')}</SelectItem>
                                    <SelectItem value="travel_transportation">{t('travelTransportation.title')}</SelectItem>
                                    <SelectItem value="payments">{t('payments.filters.directManual', { defaultValue: 'Direct / Manual' })}</SelectItem>
                                    <SelectItem value="payment_accounts">{t('paymentAccounts.title')}</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select value={statusFilter} onValueChange={(value: OpenStatusFilter) => setStatusFilter(value)}>
                                <SelectTrigger>
                                    <SelectValue placeholder={t('payments.filters.allStatuses', { defaultValue: 'All Open Statuses' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t('payments.filters.allStatuses', { defaultValue: 'All Open Statuses' })}</SelectItem>
                                    <SelectItem value="open">{t('payments.filters.open', { defaultValue: 'Open' })}</SelectItem>
                                    <SelectItem value="overdue">{t('payments.filters.overdue', { defaultValue: 'Overdue' })}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        {activeTab === 'transactions' ? <DateRangeFilters /> : null}
                    </div>
                </CardContent>
            </Card>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PaymentsTab)}>
                <TabsList>
                    <TabsTrigger value="open-items">{t('payments.tabs.openItems', { defaultValue: 'Open Items' })}</TabsTrigger>
                    <TabsTrigger value="payable">
                        <ArrowUpRight className="ms-1.5 h-3.5 w-3.5" />
                        {t('payments.tabs.payable', { defaultValue: 'Payable' })}
                    </TabsTrigger>
                    <TabsTrigger value="collectable">
                        <ArrowDownLeft className="ms-1.5 h-3.5 w-3.5" />
                        {t('payments.tabs.collectable', { defaultValue: 'Collectable' })}
                    </TabsTrigger>
                    <TabsTrigger value="transactions">{t('payments.tabs.transactions', { defaultValue: 'Transactions' })}</TabsTrigger>
                </TabsList>

                {(() => {
                    const renderOpenItemsTable = (title: string, tab: ObligationTab, rows: PaymentObligation[]) => {
                        const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
                        const currentPage = Math.min(currentPages[tab], pageCount)
                        const paginatedRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)

                        return (
                        <Card>
                            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                                <CardTitle>{title}</CardTitle>
                                <AppPagination
                                    currentPage={currentPage}
                                    totalCount={rows.length}
                                    pageSize={pageSize}
                                    onPageChange={(page) => setCurrentPages((current) => ({ ...current, [tab]: page }))}
                                    onPageSizeChange={handlePageSizeChange}
                                    className="ms-auto w-fit justify-end"
                                />
                            </CardHeader>
                            <CardContent>
                                <div className="overflow-x-auto">
                                    <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('payments.table.source', { defaultValue: 'Source' })}</TableHead>
                                            <TableHead>{t('payments.table.reference', { defaultValue: 'Reference' })}</TableHead>
                                            <TableHead>{t('payments.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                            <TableHead>{t('payments.table.dueDate', { defaultValue: 'Due Date' })}</TableHead>
                                            <TableHead>{t('payments.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                            <TableHead>{t('payments.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                            <TableHead>{t('payments.table.status', { defaultValue: 'Status' })}</TableHead>
                                            <TableHead className="text-end">{t('payments.table.actions', { defaultValue: 'Actions' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rows.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                                    {t('payments.noOpenItems', { defaultValue: 'No open items match the current filters.' })}
                                                </TableCell>
                                            </TableRow>
                                        ) : paginatedRows.map((item) => (
                                        <TableRow key={item.id}>
                                            {(() => {
                                                const isLockedSource = lockedSourceKeys.has(getPaymentSourceKey(item))
                                                return (
                                                    <>
                                            <TableCell>{sourceTypeLabel(item.sourceType, t, item.metadata)}</TableCell>
                                            <TableCell className="font-medium">
                                                <div>{item.referenceLabel || item.title}</div>
                                                {Number(item.metadata?.salesAgentAccountCreditApplied || 0) > 0 ? (
                                                    <div className="mt-1 text-xs font-normal text-muted-foreground">
                                                        {t('payments.salesAgentAccountCreditApplied', {
                                                            amount: formatCurrency(
                                                                Number(item.metadata?.salesAgentAccountCreditApplied || 0),
                                                                item.currency,
                                                                features.iqd_display_preference
                                                            )
                                                        })}
                                                    </div>
                                                ) : null}
                                            </TableCell>
                                            <TableCell>
                                                <div>{item.counterpartyName || item.title}</div>
                                                {item.subtitle ? <div className="text-xs text-muted-foreground">{item.subtitle}</div> : null}
                                            </TableCell>
                                            <TableCell>{item.dueDate ? formatDate(item.dueDate) : '-'}</TableCell>
                                            <TableCell>
                                                <span className={cn(
                                                    'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                    item.direction === 'incoming'
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                        : 'border-amber-200 bg-amber-50 text-amber-700'
                                                )}>
                                                    {item.direction === 'incoming' 
                                                        ? t('payments.filters.incoming', { defaultValue: 'Incoming' }) 
                                                        : t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}
                                                </span>
                                            </TableCell>
                                            <TableCell>{formatCurrency(item.amount, item.currency, features.iqd_display_preference)}</TableCell>
                                            <TableCell>
                                                <span className={cn(
                                                    'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                    isLockedSource
                                                        ? 'border-slate-300 bg-slate-100 text-slate-700'
                                                        : item.status === 'overdue'
                                                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                                                        : 'border-slate-200 bg-slate-50 text-slate-700'
                                                )}>
                                                    {isLockedSource 
                                                        ? t('payments.status.locked', { defaultValue: 'Locked' }) 
                                                        : item.status === 'overdue' 
                                                            ? t('payments.filters.overdue', { defaultValue: 'Overdue' }) 
                                                            : t('payments.filters.open', { defaultValue: 'Open' })}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-end">
                                                <div className="flex justify-end gap-2">
                                                    <Button variant="outline" size="sm" onClick={() => setLocation(item.routePath)}>
                                                        {t('common.view', { defaultValue: 'View' })}
                                                    </Button>
                                                    <Button size="sm" disabled={isLockedSource} onClick={() => setSelectedObligation(item)}>
                                                        {item.direction === 'incoming' 
                                                            ? t('payments.collect', { defaultValue: 'Collect' }) 
                                                            : t('payments.pay', { defaultValue: 'Pay' })}
                                                    </Button>
                                                </div>
                                            </TableCell>
                                                    </>
                                                )
                                            })()}
                                        </TableRow>
                                    ))}
                                </TableBody>
                                    </Table>
                                </div>
                            </CardContent>
                        </Card>
                        )
                    }

                    const openItemsTitle = t('payments.tabs.openItems', { defaultValue: 'Open Items' })
                    const payableTitle = t('payments.tabs.payable', { defaultValue: 'Payable' })
                    const collectableTitle = t('payments.tabs.collectable', { defaultValue: 'Collectable' })

                    return (
                        <>
                            <TabsContent value="open-items">{renderOpenItemsTable(openItemsTitle, 'open-items', obligationsByTab['open-items'])}</TabsContent>
                            <TabsContent value="payable">{renderOpenItemsTable(payableTitle, 'payable', obligationsByTab.payable)}</TabsContent>
                            <TabsContent value="collectable">{renderOpenItemsTable(collectableTitle, 'collectable', obligationsByTab.collectable)}</TabsContent>
                        </>
                    )
                })()}

                <TabsContent value="transactions">
                    <Card>
                        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                            <CardTitle>{t('payments.tabs.transactions', { defaultValue: 'Transactions' })}</CardTitle>
                            <div className="ms-auto flex flex-wrap items-center justify-end gap-3">
                                <AppPagination
                                    currentPage={transactionsCurrentPage}
                                    totalCount={visibleTransactions.length}
                                    pageSize={pageSize}
                                    onPageChange={(page) => setCurrentPages((current) => ({ ...current, transactions: page }))}
                                    onPageSizeChange={handlePageSizeChange}
                                    className="w-fit justify-end"
                                />
                                {user?.role === 'admin' ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setIsVoidAuditOpen(true)}
                                        className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                                    >
                                        <ShieldCheck className="me-1.5 h-4 w-4" />
                                        {t('financialVoid.auditTitle')}
                                        {financialVoidAudits.length ? (
                                            <span className="ms-2 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold">
                                                {financialVoidAudits.length}
                                            </span>
                                        ) : null}
                                    </Button>
                                ) : null}
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('payments.table.time', { defaultValue: 'Time' })}</TableHead>
                                        <TableHead>{t('payments.table.source', { defaultValue: 'Source' })}</TableHead>
                                        <TableHead>{t('payments.table.reference', { defaultValue: 'Reference' })}</TableHead>
                                        <TableHead>{t('payments.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                        <TableHead>{t('payments.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                        <TableHead>{t('payments.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                        <TableHead>{t('payments.table.method', { defaultValue: 'Method' })}</TableHead>
                                        <TableHead>{t('payments.table.note', { defaultValue: 'Note' })}</TableHead>
                                        <TableHead>{t('payments.table.status', { defaultValue: 'Status' })}</TableHead>
                                        <TableHead className="text-end">{t('payments.table.actions', { defaultValue: 'Actions' })}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibleTransactions.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                                {t('payments.noTransactions', { defaultValue: 'No transactions match the current filters.' })}
                                            </TableCell>
                                        </TableRow>
                                    ) : paginatedTransactions.map((item) => {
                                        const isReversal = !!item.reversalOfTransactionId
                                        const reversedAmount = reversalAmountsByTransactionId.get(item.id) || 0
                                        const hasPartialReversal = !isReversal && reversedAmount > 0.000001 && !fullyReversedIds.has(item.id)
                                        const isReversed = fullyReversedIds.has(item.id)
                                        const isLockedSource = lockedSourceKeys.has(getPaymentSourceKey(item))
                                        const isLatestUnreversed = latestUnreversedBySource.get(getPaymentSourceKey(item))?.id === item.id
                                        const canReverse = !isReversal && !isReversed && !isLockedSource && isLatestUnreversed && isReversiblePaymentSourceType(item.sourceType)
                                        const canVoid = user?.role === 'admin'
                                            && !isLockedSource
                                            && isFinancialVoidSourceSupported(item)
                                        const displayAmount = isReversal
                                            ? (item.direction === 'incoming' ? item.amount : -item.amount)
                                            : item.amount
                                        const printStatus: PaymentTransactionPrintStatus = isReversal
                                            ? 'reversal'
                                            : hasPartialReversal
                                                ? 'partialReversal'
                                                : isLockedSource
                                                    ? 'locked'
                                                    : isReversed
                                                        ? 'reversed'
                                                        : 'posted'

                                        return (
                                            <TableRow key={item.id}>
                                                <TableCell>{formatDateTime(item.paidAt)}</TableCell>
                                                <TableCell>{sourceTypeLabel(item.sourceType, t, item.metadata)}</TableCell>
                                                <TableCell className="font-medium">{item.referenceLabel || item.sourceRecordId}</TableCell>
                                                <TableCell>{item.counterpartyName || '—'}</TableCell>
                                                <TableCell>
                                                    <span className={cn(
                                                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                        isReversal
                                                            ? 'border-violet-200 bg-violet-50 text-violet-700'
                                                            : item.direction === 'incoming'
                                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                                : 'border-amber-200 bg-amber-50 text-amber-700'
                                                    )}>
                                                        {isReversal ? <RotateCcw className="h-3 w-3" /> : item.direction === 'incoming' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                                        {isReversal
                                                            ? item.direction === 'incoming'
                                                                ? t('paymentReversal.cashReturned', { defaultValue: 'Cash returned' })
                                                                : t('paymentReversal.cashRestored', { defaultValue: 'Cash restored' })
                                                            : item.direction === 'incoming'
                                                                ? t('payments.filters.incoming', { defaultValue: 'Incoming' })
                                                                : t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    {displayAmount < 0 ? '-' : ''}
                                                    {formatCurrency(Math.abs(displayAmount), item.currency, features.iqd_display_preference)}
                                                </TableCell>
                                                <TableCell>{paymentMethodLabel(item.paymentMethod, t)}</TableCell>
                                                <TableCell className="max-w-[240px] truncate">{item.note || '—'}</TableCell>
                                                <TableCell>
                                                    <span className={cn(
                                                        'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                        isReversal
                                                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                            : hasPartialReversal
                                                                ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                            : isLockedSource
                                                                ? 'border-slate-300 bg-slate-100 text-slate-700'
                                                            : isReversed
                                                                ? 'border-slate-200 bg-slate-50 text-slate-700'
                                                                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                    )}>
                                                        {isReversal 
                                                            ? t('payments.status.reversal', { defaultValue: 'Reversal' }) 
                                                            : hasPartialReversal
                                                                ? t('payments.status.partialReversal', { defaultValue: 'Partially reversed' })
                                                            : isLockedSource 
                                                                ? t('payments.status.locked', { defaultValue: 'Locked' }) 
                                                                : isReversed 
                                                                    ? t('payments.status.reversed', { defaultValue: 'Reversed' }) 
                                                                    : t('payments.status.posted', { defaultValue: 'Posted' })}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-end">
                                                    <div className="flex justify-end gap-2">
                                                        <Button variant="outline" size="sm" onClick={() => handlePrintPaymentTransaction(item, displayAmount, printStatus)}>
                                                            <Printer className="me-1 h-3.5 w-3.5" />
                                                            {t('common.print', { defaultValue: 'Print' })}
                                                        </Button>
                                                        <Button variant="outline" size="sm" onClick={() => setLocation(getPaymentTransactionRoutePath(item))}>
                                                            {t('common.view', { defaultValue: 'View' })}
                                                        </Button>
                                                        {canReverse ? (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                onClick={() => setTransactionToReverse(item)}
                                                                disabled={reversingTransactionId === item.id}
                                                            >
                                                                <RotateCcw className="ms-1 h-3.5 w-3.5" />
                                                                {t('payments.actions.reverse')}
                                                            </Button>
                                                        ) : null}
                                                        {canVoid ? (
                                                            <UiAccessGate>
                                                                <Button
                                                                    variant="outline"
                                                                    size="sm"
                                                                    onClick={() => setTransactionToVoid(item)}
                                                                    disabled={voidingTransactionId === item.id}
                                                                    className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                                                                >
                                                                    <Ban className="me-1.5 h-3.5 w-3.5" />
                                                                    {t('financialVoid.action')}
                                                                </Button>
                                                            </UiAccessGate>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

            </Tabs>

            <SettlementDialog
                open={!!selectedObligation}
                onOpenChange={(open) => {
                    if (!open) {
                        setSelectedObligation(null)
                    }
                }}
                obligation={selectedObligation}
                includeLoanAdjustment={selectedObligation?.sourceModule === 'loans'}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleSettle}
            />

            <PaymentReversalDialog
                open={!!transactionToReverse}
                onOpenChange={(open) => {
                    if (!open) {
                        setTransactionToReverse(null)
                    }
                }}
                onSubmit={handleReverse}
                isProcessing={reversingTransactionId === transactionToReverse?.id}
                transaction={transactionToReverse}
                workspaceId={workspaceId}
                iqdPreference={features.iqd_display_preference}
            />

            <FinancialTransactionVoidDialog
                open={!!transactionToVoid}
                onOpenChange={(open) => {
                    if (!open && !voidingTransactionId) {
                        setTransactionToVoid(null)
                    }
                }}
                onSubmit={handleVoid}
                isProcessing={voidingTransactionId === transactionToVoid?.id}
                transaction={transactionToVoid}
                transactions={voidTransactionChain}
                sourceLabel={transactionToVoid
                    ? sourceTypeLabel(transactionToVoid.sourceType, t, transactionToVoid.metadata)
                    : ''}
                iqdPreference={features.iqd_display_preference}
            />

            <FinancialVoidAuditDialog
                open={isVoidAuditOpen}
                onOpenChange={setIsVoidAuditOpen}
                rows={financialVoidAudits}
                getSourceLabel={(row) => sourceTypeLabel(row.sourceType, t)}
            />

            {paymentTransactionPrintData && paymentTransactionPrintPreview ? <PrintFlow
                module="payment"
                isOpen
                onClose={() => setPaymentTransactionPrintData(null)}
                onConfirm={() => setPaymentTransactionPrintData(null)}
                title={paymentTransactionPrintTitle}
                features={features}
                workspaceName={workspaceName}
                originId={paymentTransactionPrintData.transaction.id}
                showSaveButton={false}
                allowA4Document
                templatePrimaryActionLabel={t('common.print', { defaultValue: 'Print' })}
                templatePreview={paymentTransactionPrintPreview}
                pdfBuilder={async ({ effectiveId, printLangOverride }) => paymentTransactionPrintPreview.buildPdf(
                    paymentTransactionPrintPreview.createElement({}, effectiveId, printLangOverride), printLangOverride
                )}
                onPreviewPrint={blob => printPdfBlob(blob, { title: paymentTransactionPrintTitle })}
            /> : null}

            {workspaceId ? (
                <PartnerSettlementDialog
                    open={isPartnerSettlementOpen}
                    onOpenChange={setIsPartnerSettlementOpen}
                    workspaceId={workspaceId}
                    defaultDirection={settlementAction.direction}
                    includeSalesAgentCommissionPartners={canSettleSalesAgentCommissions}
                    isSubmitting={isSubmittingSettlement}
                    onSubmit={handlePartnerSettlement}
                />
            ) : null}
        </div>
    )
}
