import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BadgeDollarSign, BadgePercent, CircleDollarSign, ClipboardList, Link2, Loader2, ShoppingCart, UserRound, X } from 'lucide-react'

import type { CartItem } from '@/types'
import {
    createBusinessPartner,
    useAgents,
    useBusinessPartners,
    useProductCommissionRuleAgents,
    useProductCommissionRules,
    type BusinessPartner,
    type CurrencyCode,
    type ExchangeRateSnapshot,
    type InstallmentFrequency,
    type PaymentAccount,
    type SalesAgentCommissionMode,
    type SalesOrder
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import {
    ORDER_FINANCING_PAYMENT_METHODS,
    STANDARD_PAYMENT_METHODS,
    type PaymentMethodOption
} from '@/lib/paymentMethods'
import {
    AppDialogBody,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    DateTimePicker,
    Label,
    MultipleModalLayout,
    Progress,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast
} from '@/ui/components'
import { AddPartnerButton } from '@/ui/components/crm/AddPartnerButton'
import {
    CompactBusinessPartnerFormDialog,
    type CompactBusinessPartnerFormPayload
} from '@/ui/components/crm/CompactBusinessPartnerFormDialog'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import {
    SalesOrderCommissionAssignmentSection,
    type SalesOrderCommissionAssignmentHandle,
    type SalesOrderCommissionAssignmentSummary
} from '@/ui/components/commissions/SalesOrderCommissionAssignmentSection'
import {
    hasEligibleProductCommission,
    ProductCommissionPreview
} from '@/ui/components/commissions/ProductCommissionPreview'
import { findLinkedProductCommissionAgent } from '@/ui/components/commissions/productCommissionAgent'

export type QuickOrderCheckoutData = {
    customer: BusinessPartner
    salesAccountAgentId?: string | null
    commissionEnabled: boolean
    orderStatus: Extract<SalesOrder['status'], 'draft' | 'pending' | 'completed'>
    paymentStatus: Extract<SalesOrder['paymentStatus'], 'paid' | 'unpaid'>
    paymentMethod: PaymentMethodOption
    installmentCount: number
    installmentFrequency: InstallmentFrequency
    firstDueDate: string | null
    paymentAccountId?: string | null
    paymentAccountNameSnapshot?: string | null
}

export type QuickOrderSubmissionOptions = {
    onOrderCreated?: (order: SalesOrder) => Promise<void>
}

export type QuickOrderProgressStage = 'preparing' | 'creating' | 'reserving' | 'completing' | null

function hasSameCommissionSummaries(
    current: SalesOrderCommissionAssignmentSummary[],
    next: SalesOrderCommissionAssignmentSummary[]
) {
    return current.length === next.length && current.every((summary, index) => {
        const candidate = next[index]
        return summary.agentId === candidate.agentId
            && summary.agentName === candidate.agentName
            && summary.planName === candidate.planName
            && summary.amount === candidate.amount
            && summary.ratePercent === candidate.ratePercent
            && summary.status === candidate.status
    })
}

function QuickOrderCommissionSummary({
    summaries,
    currency,
    iqdPreference
}: {
    summaries: SalesOrderCommissionAssignmentSummary[]
    currency: CurrencyCode
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const { t } = useTranslation()
    const hasCompleteAmounts = summaries.every((summary) => summary.status === 'ready' && summary.amount !== null)
    const totalCommission = summaries.reduce((total, summary) => total + (summary.amount ?? 0), 0)

    return (
        <div className="rounded-2xl border border-violet-500/30 bg-violet-500/[0.06] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-violet-950 dark:text-violet-100">
                    <BadgePercent className="h-4 w-4 text-violet-600 dark:text-violet-300" />
                    <div>
                        <div className="text-sm font-semibold">{t('salesAgentCommissions.quickOrderSummary.title')}</div>
                        <p className="mt-0.5 text-xs text-violet-900/75 dark:text-violet-100/75">
                            {t('salesAgentCommissions.quickOrderSummary.notIncludedInOrderTotal')}
                        </p>
                    </div>
                </div>
                <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
                    {t('salesAgentCommissions.quickOrderSummary.agentCount', { count: summaries.length })}
                </span>
            </div>

            <div className="mt-3 space-y-2">
                {summaries.map((summary) => (
                    <div key={summary.agentId} className="flex items-center justify-between gap-3 rounded-xl border border-violet-500/20 bg-background/70 px-3 py-2.5">
                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-sm font-semibold">
                                <UserRound className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
                                <span className="truncate">{summary.agentName}</span>
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                                {summary.planName || t('salesAgentCommissions.noCommissionPlan')}
                            </p>
                        </div>
                        <div className="shrink-0 text-right">
                            <div className="text-sm font-bold tabular-nums text-violet-800 dark:text-violet-200">
                                {summary.amount !== null
                                    ? formatCurrency(summary.amount, currency, iqdPreference)
                                    : summary.ratePercent !== null
                                        ? `${summary.ratePercent}%`
                                        : '—'}
                            </div>
                            <p className="mt-0.5 text-[11px] text-violet-900/70 dark:text-violet-100/70">
                                {summary.status === 'ready'
                                    ? t('salesAgentCommissions.commissionAmount')
                                    : summary.status === 'calculated_on_completion'
                                        ? t('salesAgentCommissions.quickOrderSummary.calculatedOnCompletion')
                                        : summary.status === 'exchange_rate_unavailable'
                                            ? t('salesAgentCommissions.exchangeRateUnavailable')
                                            : summary.status === 'needs_amount'
                                                ? t('salesAgentCommissions.quickOrderSummary.commissionNeedsAttention')
                                                : t('salesAgentCommissions.noCommissionPlan')}
                            </p>
                        </div>
                    </div>
                ))}
            </div>

            {hasCompleteAmounts ? (
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-violet-500/25 pt-3 text-sm font-semibold text-violet-950 dark:text-violet-100">
                    <span>{t('salesAgentCommissions.quickOrderSummary.configuredCommissionTotal')}</span>
                    <span className="tabular-nums">{formatCurrency(totalCommission, currency, iqdPreference)}</span>
                </div>
            ) : null}
        </div>
    )
}

interface QuickOrderModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    cart: CartItem[]
    totalAmount: number
    settlementCurrency: CurrencyCode
    defaultCurrency: CurrencyCode
    availableCurrencies: CurrencyCode[]
    iqdPreference: 'IQD' | 'د.ع'
    loansEnabled: boolean
    installmentsEnabled: boolean
    agentSalesAccountsEnabled: boolean
    productCommissionsEnabled: boolean
    commissionAssignmentsEnabled: boolean
    commissionMode: SalesAgentCommissionMode
    commissionExchangeRates: ExchangeRateSnapshot[]
    commissionCurrencies: CurrencyCode[]
    commissionAssignedBy?: string | null
    isSubmitting: boolean
    progressStage: QuickOrderProgressStage
    onSubmit: (data: QuickOrderCheckoutData, options?: QuickOrderSubmissionOptions) => Promise<void>
}

export function QuickOrderModal({
    isOpen,
    onOpenChange,
    workspaceId,
    cart,
    totalAmount,
    settlementCurrency,
    defaultCurrency,
    availableCurrencies,
    iqdPreference,
    loansEnabled,
    installmentsEnabled,
    agentSalesAccountsEnabled,
    productCommissionsEnabled,
    commissionAssignmentsEnabled,
    commissionMode,
    commissionExchangeRates,
    commissionCurrencies,
    commissionAssignedBy,
    isSubmitting,
    progressStage,
    onSubmit
}: QuickOrderModalProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const commissionTriggerRef = useRef<HTMLButtonElement>(null)
    const commissionAssignmentRef = useRef<SalesOrderCommissionAssignmentHandle>(null)
    const [customerSearch, setCustomerSearch] = useState('')
    const [customer, setCustomer] = useState<BusinessPartner | null>(null)
    const [isCreateCustomerOpen, setIsCreateCustomerOpen] = useState(false)
    const [isCreatingCustomer, setIsCreatingCustomer] = useState(false)
    const [isCreateAdvancedCustomerOpen, setIsCreateAdvancedCustomerOpen] = useState(false)
    const [isCreatingAdvancedCustomer, setIsCreatingAdvancedCustomer] = useState(false)
    const [salesAccountAgentId, setSalesAccountAgentId] = useState('')
    const [orderStatus, setOrderStatus] = useState<QuickOrderCheckoutData['orderStatus']>('completed')
    const [paymentStatus, setPaymentStatus] = useState<QuickOrderCheckoutData['paymentStatus']>('unpaid')
    const [paymentMethod, setPaymentMethod] = useState<PaymentMethodOption>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [firstDueDate, setFirstDueDate] = useState('')
    const [isCommissionPanelOpen, setIsCommissionPanelOpen] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [commissionSummaries, setCommissionSummaries] = useState<SalesOrderCommissionAssignmentSummary[]>([])
    const handleCommissionSummaryChange = useCallback((next: SalesOrderCommissionAssignmentSummary[]) => {
        setCommissionSummaries((current) => hasSameCommissionSummaries(current, next) ? current : next)
    }, [])
    const canLoadAgents = agentSalesAccountsEnabled
        || productCommissionsEnabled
        || commissionAssignmentsEnabled
    const agentPartners = useBusinessPartners(
        canLoadAgents ? workspaceId : undefined,
        { roles: ['agent'], includeAgentRoles: true }
    )
    const agents = useAgents(canLoadAgents ? workspaceId : undefined)
    const productCommissionRules = useProductCommissionRules(productCommissionsEnabled ? workspaceId : undefined)
    const productCommissionRuleAgents = useProductCommissionRuleAgents(productCommissionsEnabled ? workspaceId : undefined)
    const selectedSalesAccount = useMemo(() => {
        if (!agentSalesAccountsEnabled) return null
        const agent = agents.find((candidate) => (
            candidate.id === salesAccountAgentId
            && !candidate.isDeleted
            && candidate.status === 'active'
            && candidate.salesAccountEnabled
        ))
        if (!agent) return null
        const partner = agentPartners.find((candidate) => candidate.id === agent.businessPartnerId)
        return partner ? { agent, partner } : null
    }, [agentPartners, agentSalesAccountsEnabled, agents, salesAccountAgentId])
    const commissionPreviewItems = useMemo(() => {
        const sourceLines = cart.map((item) => {
            const quantity = Math.max(0, Number(item.quantity) || 0)
            const unitPrice = Math.max(0, Number(item.negotiated_price ?? item.discounted_price ?? item.price) || 0)
            return { item, quantity, sourceTotal: quantity * unitPrice }
        })
        const sourceTotal = sourceLines.reduce((sum, line) => sum + line.sourceTotal, 0)
        return sourceLines.map(({ item, quantity, sourceTotal: lineSourceTotal }) => ({
            // Cart items do not have their final SalesOrder item id yet. The
            // preview key only needs to be stable while the checkout is open.
            id: `${item.product_id}:${item.storageId || ''}`,
            productId: item.product_id,
            productName: item.name,
            quantity,
            // The checkout total is already in settlement currency. Allocate
            // it proportionally so the preview uses the same basis as the
            // pending quick order, including a cart-level discount.
            convertedUnitPrice: quantity > 0 && sourceTotal > 0
                ? totalAmount * lineSourceTotal / sourceTotal / quantity
                : 0
        }))
    }, [cart, totalAmount])
    // A customer quick order follows the same beneficiary workflow as a sales
    // order. Sales-account quick orders retain their focused attribution flow,
    // because the selected sales account already identifies the counterparty.
    const showCustomerCommissionAssignments = commissionAssignmentsEnabled
        && Boolean(customer)
        && !selectedSalesAccount
    const commissionRecipient = commissionAssignmentsEnabled
        && selectedSalesAccount?.agent.agentType === 'field_agent'
        ? selectedSalesAccount.agent
        : null
    const creatorCommissionAgent = useMemo(
        () => findLinkedProductCommissionAgent(agents, commissionAssignedBy),
        [agents, commissionAssignedBy]
    )
    const productCommissionAgentIds = useMemo(() => [...new Set([
        selectedSalesAccount?.agent.id,
        creatorCommissionAgent?.id
    ].filter((id): id is string => Boolean(id)))], [creatorCommissionAgent?.id, selectedSalesAccount?.agent.id])
    const productCommissionPreviewAgents = useMemo(() => {
        const partnerNameById = new Map(agentPartners.map((partner) => [partner.id, partner.partnerName]))
        return productCommissionAgentIds.map((agentId) => {
            const agent = agents.find((candidate) => candidate.id === agentId)
            return {
                id: agentId,
                name: agent
                    ? partnerNameById.get(agent.businessPartnerId) ?? t('salesAgentCommissions.salesAgent')
                    : t('salesAgentCommissions.salesAgent')
            }
        })
    }, [agentPartners, agents, productCommissionAgentIds, t])
    const hasAutomaticProductCommission = productCommissionAgentIds.length > 0
        ? hasEligibleProductCommission({
            items: commissionPreviewItems,
            agentIds: productCommissionAgentIds,
            rules: productCommissionRules,
            recipients: productCommissionRuleAgents,
            at: new Date().toISOString()
        })
        : false

    const paymentMethods = useMemo<PaymentMethodOption[]>(() => [
        ...STANDARD_PAYMENT_METHODS,
        ...(loansEnabled ? [ORDER_FINANCING_PAYMENT_METHODS[0]] : []),
        ...(installmentsEnabled ? [ORDER_FINANCING_PAYMENT_METHODS[1]] : [])
    ], [installmentsEnabled, loansEnabled])
    const isInstallmentBased = paymentMethod === 'installments'
    const isFinanced = paymentMethod === 'loan' || paymentMethod === 'installments'
    const isPaidOnSave = paymentStatus === 'paid'
    const orderCounterparty = selectedSalesAccount?.partner ?? customer
    const isQuickOrderValid = Boolean(
        orderCounterparty
        && orderStatus
        && paymentStatus
        && paymentMethod
        && (!isInstallmentBased || firstDueDate)
        && !(isPaidOnSave && isFinanced)
    )
    const canCreditCommission = Boolean(commissionRecipient && isQuickOrderValid)
    const progress = progressStage === 'preparing'
        ? { value: 15, label: t('pos.quickOrder.progress.preparing') }
        : progressStage === 'creating'
            ? { value: 40, label: t('pos.quickOrder.progress.creating') }
            : progressStage === 'reserving'
                ? { value: 65, label: t('pos.quickOrder.progress.reserving') }
                : progressStage === 'completing'
                    ? { value: 90, label: t('pos.quickOrder.progress.completing') }
                    : null

    useEffect(() => {
        if (!isOpen) return
        setCustomerSearch('')
        setCustomer(null)
        setSalesAccountAgentId('')
        setOrderStatus('completed')
        setPaymentStatus('unpaid')
        setPaymentMethod('cash')
        setPaymentAccount(null)
        setFirstDueDate('')
        setIsCommissionPanelOpen(false)
        setSubmitError(null)
        setCommissionSummaries([])
    }, [isOpen])

    const validateQuickOrder = () => {
        if (!orderCounterparty) {
            setSubmitError(t('orders.form.selectCustomer'))
            return false
        }
        if (!paymentMethod) {
            setSubmitError(t('orders.form.errors.paymentMethodRequired'))
            return false
        }
        if (isPaidOnSave && isFinanced) {
            setSubmitError(t('pos.quickOrder.paidFinanceMethodsUnavailable'))
            return false
        }
        if (isInstallmentBased && !firstDueDate) {
            setSubmitError(t('orders.form.errors.firstInstallmentDueDateRequired'))
            return false
        }
        setSubmitError(null)
        return true
    }

    const closeCommissionPanel = () => {
        if (isSubmitting) return
        setIsCommissionPanelOpen(false)
    }

    const handleCreateCustomer = async (payload: CompactBusinessPartnerFormPayload) => {
        setIsCreatingCustomer(true)
        try {
            const partner = await createBusinessPartner(workspaceId, payload)
            setCustomer(partner)
            setCustomerSearch(partner.partnerName)
            setIsCommissionPanelOpen(false)
            setCommissionSummaries([])
            setIsCreateCustomerOpen(false)
            toast({ title: t('customers.messages.addSuccess') })
        } catch (error: any) {
            toast({
                title: t('common.error'),
                description: error?.message || t('customers.messages.addError'),
                variant: 'destructive'
            })
        } finally {
            setIsCreatingCustomer(false)
        }
    }

    const handleCreateAdvancedCustomer = async (payload: BusinessPartnerFormPayload) => {
        setIsCreatingAdvancedCustomer(true)
        try {
            const partner = await createBusinessPartner(workspaceId, payload)
            setCustomer(partner)
            setCustomerSearch(partner.partnerName)
            setIsCommissionPanelOpen(false)
            setCommissionSummaries([])
            setIsCreateAdvancedCustomerOpen(false)
            toast({ title: t('customers.messages.addSuccess') })
        } catch (error: any) {
            toast({
                title: t('common.error'),
                description: error?.message || t('customers.messages.addError'),
                variant: 'destructive'
            })
        } finally {
            setIsCreatingAdvancedCustomer(false)
        }
    }

    const openCommissionPanel = () => {
        if (!validateQuickOrder() || !commissionRecipient) return
        setIsCommissionPanelOpen(true)
    }

    const handleSubmit = async (includeCommission = false) => {
        if (!validateQuickOrder()) return
        const shouldSaveCommissionAssignments = includeCommission || showCustomerCommissionAssignments
        if (shouldSaveCommissionAssignments) {
            if (!commissionAssignmentRef.current) return
            try {
                commissionAssignmentRef.current.validate()
            } catch (error) {
                setSubmitError(error instanceof Error ? error.message : t('salesAgentCommissions.assignmentNeedsAttentionDescription'))
                return
            }
        }

        const shouldCreditCommission = includeCommission || hasAutomaticProductCommission
        try {
            await onSubmit({
                customer: orderCounterparty!,
                salesAccountAgentId: selectedSalesAccount?.agent.id ?? null,
                // A qualifying product commission is automatic. The optional
                // credit-commission step remains only for per-order manual
                // commission terms.
                commissionEnabled: shouldCreditCommission,
                orderStatus,
                paymentStatus,
                paymentMethod,
                installmentCount: 3,
                installmentFrequency: 'monthly',
                firstDueDate: isInstallmentBased ? firstDueDate : null,
                paymentAccountId: paymentAccount?.id ?? null,
                paymentAccountNameSnapshot: paymentAccount?.name ?? null,
            }, shouldSaveCommissionAssignments ? {
                onOrderCreated: async (order) => {
                    await commissionAssignmentRef.current?.save(order)
                }
            } : undefined)
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            setSubmitError(message === 'agent_sales_accounts_not_enabled'
                ? t('agentSalesAccounts.notEnabled')
                : message === 'agent_sales_account_unavailable'
                    ? t('agentSalesAccounts.unavailable')
                    : message || t('orders.form.errors.saveSalesFailed'))
        }
    }

    const primaryPanel = (
        <div className="flex min-h-0 flex-1 flex-col">
            <AppDialogHeader className="relative border-b bg-muted/30 px-6 py-5 text-start">
                <AppDialogTitle className="flex items-center gap-2 text-xl">
                    <ShoppingCart className="h-5 w-5 text-primary" />
                    {t('pos.quickOrder.title')}
                </AppDialogTitle>
                <AppDialogDescription>{t('pos.quickOrder.description')}</AppDialogDescription>
                {!isCommissionPanelOpen ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute end-4 top-4 h-8 w-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onOpenChange(false)}
                        disabled={isSubmitting}
                        aria-label={t('common.close')}
                    >
                        <X className="h-4 w-4" />
                    </Button>
                ) : null}
            </AppDialogHeader>

            <AppDialogBody className="space-y-5 px-6 py-5">
                {isSubmitting && progress ? (
                    <div role="status" aria-live="polite" className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                        <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium text-primary">{progress.label}</span>
                            <span className="tabular-nums text-xs font-semibold text-primary/80">{progress.value}%</span>
                        </div>
                        <Progress value={progress.value} className="h-2 bg-primary/15" indicatorClassName="bg-primary" />
                    </div>
                ) : null}

                {agentSalesAccountsEnabled ? (
                    <div className="grid gap-2">
                        <Label htmlFor="quick-order-sales-account" className="flex items-center gap-2">
                            <UserRound className="h-4 w-4 text-muted-foreground" />
                            {t('agentSalesAccounts.salesAccount')}
                        </Label>
                        <Select
                            value={salesAccountAgentId || 'workspace'}
                            onValueChange={(value) => {
                                setSalesAccountAgentId(value === 'workspace' ? '' : value)
                                setCustomer(null)
                                setCustomerSearch('')
                                setIsCommissionPanelOpen(false)
                                setCommissionSummaries([])
                            }}
                            disabled={isSubmitting || isCommissionPanelOpen}
                        >
                            <SelectTrigger id="quick-order-sales-account"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="workspace">{t('agentSalesAccounts.workspaceAccount')}</SelectItem>
                                {agents
                                    .filter((agent) => !agent.isDeleted && agent.status === 'active' && agent.salesAccountEnabled)
                                    .map((agent) => {
                                        const partner = agentPartners.find((candidate) => candidate.id === agent.businessPartnerId)
                                        return partner ? <SelectItem key={agent.id} value={agent.id}>{partner.partnerName}</SelectItem> : null
                                    })}
                            </SelectContent>
                        </Select>
                        <p className="text-xs leading-5 text-muted-foreground">{t('agentSalesAccounts.salesAccountPosHint')}</p>
                    </div>
                ) : null}

                <div className="grid gap-2">
                    <Label className="flex items-center gap-2">
                        <UserRound className="h-4 w-4 text-muted-foreground" />
                        {selectedSalesAccount ? t('agentSalesAccounts.sellingAgent') : t('orders.form.customer')}
                        <span className="text-destructive">*</span>
                    </Label>
                    {!selectedSalesAccount ? (
                        <div className="flex gap-2">
                            <PartnerAutocompleteInput
                                workspaceId={workspaceId}
                                roles={['customer']}
                                value={customerSearch}
                                onChange={(value) => {
                                    setCustomerSearch(value)
                                    setCustomer(null)
                                    setIsCommissionPanelOpen(false)
                                    setCommissionSummaries([])
                                }}
                                onSelectPartner={(partner) => {
                                    setCustomer(partner)
                                    setCustomerSearch(partner.partnerName)
                                    setIsCommissionPanelOpen(false)
                                    setCommissionSummaries([])
                                }}
                                disabled={isSubmitting || isCommissionPanelOpen}
                                placeholder={t('orders.form.selectCustomer')}
                                className="min-w-0 flex-1"
                            />
                            <AddPartnerButton
                                onClick={() => setIsCreateCustomerOpen(true)}
                                label={t('customers.addCustomer')}
                                disabled={isSubmitting || isCommissionPanelOpen}
                            />
                            <AddPartnerButton
                                onClick={() => setIsCreateAdvancedCustomerOpen(true)}
                                label={t('customers.addCustomerAdvanced')}
                                disabled={isSubmitting || isCommissionPanelOpen}
                                advanced
                            />
                        </div>
                    ) : null}
                    {orderCounterparty ? (
                        <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                            <Link2 className="h-4 w-4 shrink-0 text-primary" />
                            <div className="min-w-0">
                                <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                    {t('businessPartners.linked')} {t('businessPartners.title')}
                                </div>
                                <div className="truncate text-sm font-semibold">{orderCounterparty.partnerName}</div>
                            </div>
                            {!selectedSalesAccount ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-8 shrink-0 px-2 text-muted-foreground"
                                    onClick={() => {
                                        setCustomer(null)
                                        setCustomerSearch('')
                                        setIsCommissionPanelOpen(false)
                                        setCommissionSummaries([])
                                    }}
                                    disabled={isSubmitting || isCommissionPanelOpen}
                                >
                                    {t('common.remove')}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                        <Label htmlFor="quick-order-status" className="flex items-center gap-2">
                            <ClipboardList className="h-4 w-4 text-muted-foreground" />
                            {t('pos.quickOrder.orderStatusOnSave')} <span className="text-destructive">*</span>
                        </Label>
                        <Select
                            value={orderStatus}
                            onValueChange={(value) => {
                                setOrderStatus(value as QuickOrderCheckoutData['orderStatus'])
                                setIsCommissionPanelOpen(false)
                            }}
                            disabled={isSubmitting || isCommissionPanelOpen}
                        >
                            <SelectTrigger id="quick-order-status"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="completed">{t('orders.status.completed')}</SelectItem>
                                <SelectItem value="pending">{t('orders.status.pending')}</SelectItem>
                                <SelectItem value="draft">{t('orders.status.draft')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="quick-order-payment-status" className="flex items-center gap-2">
                            <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
                            {t('pos.quickOrder.paymentStatusOnSave')} <span className="text-destructive">*</span>
                        </Label>
                        <Select
                            value={paymentStatus}
                            onValueChange={(value) => {
                                const nextPaymentStatus = value as QuickOrderCheckoutData['paymentStatus']
                                setPaymentStatus(nextPaymentStatus)
                                if (nextPaymentStatus === 'paid' && isFinanced) {
                                    setPaymentMethod('cash')
                                    setFirstDueDate('')
                                }
                                setIsCommissionPanelOpen(false)
                            }}
                            disabled={isSubmitting || isCommissionPanelOpen}
                        >
                            <SelectTrigger id="quick-order-payment-status"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="unpaid">{t('orders.status.unpaid')}</SelectItem>
                                <SelectItem value="paid">{t('orders.status.paid')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="grid gap-2">
                    <Label htmlFor="quick-order-payment">
                        {t('pos.paymentMethod')} <span className="text-destructive">*</span>
                    </Label>
                    <PaymentMethodSelect
                        id="quick-order-payment"
                        value={paymentMethod}
                        onValueChange={(value) => {
                            setPaymentMethod(value)
                            setIsCommissionPanelOpen(false)
                        }}
                        onLinkedPaymentAccountSelect={setPaymentAccount}
                        workspaceId={workspaceId}
                        methods={paymentMethods}
                        disabledMethods={isPaidOnSave ? ORDER_FINANCING_PAYMENT_METHODS : []}
                        disabled={isSubmitting || isCommissionPanelOpen}
                    />
                </div>

                {isPaidOnSave ? (
                    <PaymentAccountSelector
                        workspaceId={workspaceId}
                        value={paymentAccount?.id ?? null}
                        onValueChange={setPaymentAccount}
                        disabled={isSubmitting || isCommissionPanelOpen}
                        cashDrawerOnly={paymentMethod === 'cash'}
                    />
                ) : null}

                {isPaidOnSave ? (
                    <p className="text-xs text-muted-foreground">{t('pos.quickOrder.paidFinanceMethodsUnavailable')}</p>
                ) : null}

                {showCustomerCommissionAssignments ? (
                    <div className="space-y-3">
                        {commissionMode === 'tracked' ? (
                            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-sky-500/20 bg-sky-500/[0.05] px-4 py-3 text-sm text-sky-800 dark:text-sky-200">
                                <BadgeDollarSign className="h-4 w-4" />
                                <span className="font-semibold">{t('salesAgentCommissions.trackedCommission')}</span>
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                                    {t('salesAgentCommissions.nonpayable')}
                                </span>
                                <span className="basis-full text-xs text-muted-foreground sm:basis-auto">
                                    {t('salesAgentCommissions.trackedOrderDescription')}
                                </span>
                            </div>
                        ) : null}
                        <SalesOrderCommissionAssignmentSection
                            ref={commissionAssignmentRef}
                            workspaceId={workspaceId}
                            customerCity={customer?.city || ''}
                            assignedBy={commissionAssignedBy}
                            orderCurrency={settlementCurrency}
                            orderTotal={totalAmount}
                            exchangeRates={commissionExchangeRates}
                            availableCurrencies={commissionCurrencies}
                            iqdDisplayPreference={iqdPreference}
                            allowPlanCommissionAmountOverride
                            onCommissionSummaryChange={handleCommissionSummaryChange}
                            disabled={isSubmitting}
                        />
                    </div>
                ) : null}

                {isInstallmentBased ? (
                    <div className="grid gap-2 rounded-2xl border bg-muted/20 p-4">
                        <Label htmlFor="quick-order-first-due-date">
                            {t('orders.form.firstInstallmentDueDate')} <span className="text-destructive">*</span>
                        </Label>
                        <DateTimePicker
                            id="quick-order-first-due-date"
                            mode="date"
                            date={firstDueDate ? new Date(`${firstDueDate}T00:00:00`) : undefined}
                            setDate={(date) => {
                                setFirstDueDate(date ? date.toISOString().slice(0, 10) : '')
                                setIsCommissionPanelOpen(false)
                            }}
                            disabled={isSubmitting || isCommissionPanelOpen}
                            placeholder={t('orders.form.firstInstallmentDueDate')}
                        />
                        <p className="text-xs text-muted-foreground">{t('pos.quickOrder.installmentHint')}</p>
                    </div>
                ) : null}

                {productCommissionAgentIds.length > 0 ? (
                    <ProductCommissionPreview
                        workspaceId={workspaceId}
                        items={commissionPreviewItems}
                        agentIds={productCommissionAgentIds}
                        agents={productCommissionPreviewAgents}
                        currency={settlementCurrency}
                        exchangeRates={commissionExchangeRates}
                        iqdPreference={iqdPreference}
                        commissionMode={commissionMode}
                        showTotal
                    />
                ) : null}

                {canCreditCommission ? (
                    <div className="flex flex-col items-center gap-2 py-1 text-center">
                        <Button
                            ref={commissionTriggerRef}
                            type="button"
                            variant="outline"
                            className="min-h-11 gap-2 border-violet-500/30 bg-violet-500/[0.04] px-5 text-violet-700 hover:bg-violet-500/[0.1] hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
                            onClick={openCommissionPanel}
                            disabled={isSubmitting || isCommissionPanelOpen}
                        >
                            <BadgePercent className="h-4 w-4" />
                            {t('pos.quickOrder.creditCommission')}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t('pos.quickOrder.creditCommissionFor', { agent: selectedSalesAccount?.partner.partnerName ?? customer?.partnerName })}
                        </p>
                    </div>
                ) : null}

                {showCustomerCommissionAssignments && commissionSummaries.length > 0 ? (
                    <QuickOrderCommissionSummary
                        summaries={commissionSummaries}
                        currency={settlementCurrency}
                        iqdPreference={iqdPreference}
                    />
                ) : null}

                <div className="rounded-2xl border bg-muted/20 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-semibold">{t('pos.quickOrder.summary')}</div>
                            <div className="text-xs text-muted-foreground">{t('pos.quickOrder.itemCount', { count: cart.length })}</div>
                        </div>
                        <div className="text-right text-base font-bold text-primary">
                            {formatCurrency(totalAmount, settlementCurrency, iqdPreference)}
                        </div>
                    </div>
                    <div className="max-h-32 space-y-2 overflow-y-auto pe-1">
                        {cart.map((item) => (
                            <div key={`${item.product_id}:${item.storageId || ''}`} className="flex justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate">{item.name}</span>
                                <span className="shrink-0 text-muted-foreground">× {item.quantity}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {submitError ? (
                    <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{submitError}</p>
                ) : null}
            </AppDialogBody>

            <AppDialogFooter className="border-t bg-muted/10 px-6 py-4 sm:justify-between">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                    {t('common.cancel')}
                </Button>
                {!isCommissionPanelOpen ? (
                    <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !isQuickOrderValid}>
                        {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {t('pos.quickOrder.save')}
                    </Button>
                ) : null}
            </AppDialogFooter>
            <CompactBusinessPartnerFormDialog
                isOpen={isCreateCustomerOpen}
                onOpenChange={setIsCreateCustomerOpen}
                workspaceId={workspaceId}
                defaultCurrency={defaultCurrency}
                role="customer"
                title={t('customers.addCustomer')}
                submitLabel={t('common.create')}
                isSaving={isCreatingCustomer}
                onSubmit={handleCreateCustomer}
            />
            <BusinessPartnerFormDialog
                isOpen={isCreateAdvancedCustomerOpen}
                onOpenChange={(open) => {
                    if (!isCreatingAdvancedCustomer) setIsCreateAdvancedCustomerOpen(open)
                }}
                defaultCurrency={defaultCurrency}
                availableCurrencies={availableCurrencies}
                initialRole="customer"
                lockedRole="customer"
                title={t('customers.addCustomerAdvanced')}
                submitLabel={t('common.create')}
                isSaving={isCreatingAdvancedCustomer}
                onSubmit={handleCreateAdvancedCustomer}
            />
        </div>
    )

    return (
        <MultipleModalLayout
            open={isOpen}
            onOpenChange={(open) => {
                if (!open && !isSubmitting) onOpenChange(false)
            }}
            closeDisabled={isSubmitting}
            onCloseLastPanel={isCommissionPanelOpen ? closeCommissionPanel : undefined}
            lastPanelTriggerRef={commissionTriggerRef}
            breakpoint="xl"
            align="center"
            gapClassName="gap-5"
            panels={[
                {
                    id: 'quick-order',
                    label: t('pos.quickOrder.title'),
                    className: 'w-full xl:w-[40rem] xl:flex-none',
                    content: primaryPanel
                },
                ...(isCommissionPanelOpen && commissionRecipient ? [{
                    id: 'quick-order-commission',
                    label: t('pos.quickOrder.commissionTitle'),
                    className: 'w-full xl:w-[28rem] xl:flex-none',
                    content: (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <AppDialogHeader className="relative border-b bg-violet-500/[0.03] px-6 py-5 text-start">
                                <AppDialogTitle className="flex items-center gap-2 text-xl">
                                    <BadgePercent className="h-5 w-5 text-violet-600" />
                                    {t('pos.quickOrder.commissionTitle')}
                                </AppDialogTitle>
                                <AppDialogDescription>{t('pos.quickOrder.commissionDescription')}</AppDialogDescription>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute end-4 top-4 h-8 w-8 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    onClick={closeCommissionPanel}
                                    disabled={isSubmitting}
                                    aria-label={t('common.close')}
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </AppDialogHeader>
                            <AppDialogBody className="px-6 py-5">
                                <SalesOrderCommissionAssignmentSection
                                    ref={commissionAssignmentRef}
                                    workspaceId={workspaceId}
                                    salesAccountAgentId={selectedSalesAccount?.agent.id ?? null}
                                    fixedRecipientAgentId={commissionRecipient.id}
                                    fixedRecipientAssignmentSource={selectedSalesAccount ? 'sales_account' : 'manual'}
                                    customerCity={orderCounterparty?.city || ''}
                                    assignedBy={commissionAssignedBy}
                                    orderCurrency={settlementCurrency}
                                    orderTotal={totalAmount}
                                    exchangeRates={commissionExchangeRates}
                                    availableCurrencies={commissionCurrencies}
                                    iqdDisplayPreference={iqdPreference}
                                    showOperationalFields={false}
                                    requireManualCommissionWhenNoPlan
                                    compact
                                    disabled={isSubmitting}
                                />
                            </AppDialogBody>
                            <AppDialogFooter className="border-t bg-muted/10 px-6 py-4 sm:justify-between">
                                <Button type="button" variant="outline" onClick={closeCommissionPanel} disabled={isSubmitting}>
                                    {t('pos.quickOrder.backToQuickOrder')}
                                </Button>
                                <Button type="button" onClick={() => void handleSubmit(true)} disabled={isSubmitting}>
                                    {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                    {t('pos.quickOrder.save')}
                                </Button>
                            </AppDialogFooter>
                        </div>
                    )
                }] : [])
            ]}
        />
    )
}
