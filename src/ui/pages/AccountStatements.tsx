import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleAlert, FileText, Loader2, Printer, RefreshCw, Settings, TrendingDown, TrendingUp } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import type { i18n as I18n } from 'i18next'

import { isSupabaseConfigured, supabase, useAuth } from '@/auth'
import {
    PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
    buildCustomTemplateLayoutPdf,
    createCustomTemplatePreview,
    getCustomTemplatePrintLanguageWarning,
    getCustomTemplateTarget,
    getStoredCustomTemplateLabel,
    isCustomTemplatePrintLanguageCompatible,
    readCustomTemplateLayout,
    resolveCustomTemplatePrintLanguage,
    type StoredCustomTemplateRow
} from '@/lib/customTemplates'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import {
    createPartnerAccountStatementTemplateConfiguration,
    DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
    getPartnerAccountStatementSummaryLabelColumn,
    getPartnerAccountStatementVisibleColumns,
    PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
    readPartnerAccountStatementTemplate,
    serializePartnerAccountStatementTemplate,
    type PartnerAccountStatementColumnId,
    type PartnerAccountStatementTemplate,
    type PartnerAccountStatementTemplateConfiguration
} from '@/lib/partnerAccountStatementTemplates'
import {
    buildPartnerAccountStatementLedger,
    type PartnerAccountStatementCurrencyLedger,
    type PartnerAccountStatementEntry,
    type PartnerAccountStatementEntryKind,
    type PartnerAccountStatementPeriod
} from '@/lib/partnerAccountStatement'
import { PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES } from '@/lib/partnerAccountStatementLiveData'
import {
    getPartnerAccountStatementEntryDescription,
    getPartnerAccountStatementEntryDetail
} from '@/lib/partnerAccountStatementPresentation'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { getLoanDetailsPath } from '@/lib/loanPresentation'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import type { CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { usePartnerAccountStatement } from '@/hooks/usePartnerAccountStatement'
import {
    deleteLocalCustomTemplate,
    isAgentBusinessPartnerRole,
    saveLocalCustomTemplate,
    useWorkspaceContacts
} from '@/local-db'
import type { DateRangeType } from '@/context/DateRangeContext'
import type { PrintFormat } from '@/services/pdfGenerator'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    DateRangeFilters,
    PrintPreviewModal,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/ui/components'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { PartnerAccountStatementTemplateDialog } from '@/ui/components/crm/PartnerAccountStatementTemplateDialog'
import type { PartnerAccountStatementPrintData } from '@/ui/components/crm/PartnerAccountStatementPrintTemplate'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useWorkspace } from '@/workspace'

const ACCOUNT_STATEMENT_PATH = '/business-partners/account-statement'

function readPartnerSelection(location: string) {
    const searchParams = new URLSearchParams(location.split('?')[1] || '')
    return {
        id: searchParams.get('partnerId'),
        partnerName: searchParams.get('partnerName') || ''
    }
}

function entryLabel(
    kind: PartnerAccountStatementEntryKind,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    const labels: Record<PartnerAccountStatementEntryKind, string> = {
        sales_order: t('orders.tabs.sales', { defaultValue: 'Sales Order' }),
        sales_order_return: t('businessPartners.accountStatement.salesOrderReturn', { defaultValue: 'Sales order return' }),
        purchase_order: t('orders.tabs.purchase', { defaultValue: 'Purchase Order' }),
        incoming_payment: t('businessPartners.accountStatement.paymentReceived', { defaultValue: 'Payment received' }),
        outgoing_payment: t('businessPartners.accountStatement.paymentMade', { defaultValue: 'Payment made' }),
        direct_transaction: t('ledger.type.direct_transaction', { defaultValue: 'Direct Transaction' }),
        loan_disbursal: t('businessPartners.accountStatement.loanMovement', { defaultValue: 'Loan movement' }),
        loan_repayment: t('businessPartners.accountStatement.loanRepayment', { defaultValue: 'Loan repayment' }),
        pos_sale_loan: t('loans.posSaleLoan', { defaultValue: 'POS Sale Loan' }),
        pos_sale_installment_loan: t('loans.posSaleInstallmentLoan', { defaultValue: 'POS Sale Installment Loan' }),
        installment_sale: t('businessPartners.accountStatement.installmentSale', { defaultValue: 'Installment sale' }),
        agent_commission: t('salesAgentCommissions.title', { defaultValue: 'Sales agent commission' }),
        delivery_post: t('postService.title', { defaultValue: 'Post Service' })
    }
    return labels[kind]
}

function balanceLabel(balance: number, t: (key: string, options?: Record<string, unknown>) => string) {
    if (balance > 0.000001) return t('businessPartners.accountStatement.dueFromPartner', { defaultValue: 'Due from partner' })
    if (balance < -0.000001) return t('businessPartners.accountStatement.dueToPartner', { defaultValue: 'Due to partner' })
    return t('businessPartners.accountStatement.settled', { defaultValue: 'Settled' })
}

function balanceClass(balance: number) {
    if (balance > 0.000001) return 'text-emerald-600'
    if (balance < -0.000001) return 'text-yellow-500'
    return ''
}

function formatStatementQuantity(quantity: number | null | undefined, unit: string | null | undefined, language: string) {
    if (quantity === null || quantity === undefined) return '—'
    const value = new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(quantity)
    return unit ? `${value} ${unit}` : value
}

function entrySourcePath(entry: PartnerAccountStatementEntry) {
    if (entry.source?.recordType === 'order') {
        return `/orders/${entry.source.recordId}`
    }
    if (entry.source?.recordType === 'loan') {
        return getLoanDetailsPath(entry.source.loanCategory, entry.source.recordId)
    }
    if (entry.source?.recordType === 'installment_sale') {
        return '/installments'
    }
    if (entry.source?.recordType === 'delivery_ledger_entry') {
        return '/post-service'
    }
    return null
}

function statementColumnLabel(
    columnId: PartnerAccountStatementColumnId,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    const labels: Record<PartnerAccountStatementColumnId, [string, string]> = {
        date: ['common.date', 'Date'],
        reference: ['common.reference', 'Reference'],
        type: ['common.type', 'Type'],
        description: ['common.description', 'Description'],
        item: ['businessPartners.accountStatement.item', 'Item'],
        quantity: ['businessPartners.accountStatement.quantity', 'Quantity'],
        commissionPerProduct: ['salesAgentCommissions.productCommission.perUnit', 'Product commission / unit'],
        totalProductCommission: ['salesAgentCommissions.productCommission.lineTotal', 'Total product commission'],
        debit: ['businessPartners.accountStatement.debit', 'Debit'],
        credit: ['businessPartners.accountStatement.credit', 'Credit'],
        balance: ['businessPartners.accountStatement.balance', 'Balance']
    }
    const [key, defaultValue] = labels[columnId]
    return t(key, { defaultValue })
}

function statementColumnIsNumeric(columnId: PartnerAccountStatementColumnId) {
    return ['quantity', 'commissionPerProduct', 'totalProductCommission', 'debit', 'credit', 'balance'].includes(columnId)
}

function LedgerCard({
    ledger,
    iqdPreference,
    t,
    i18n,
    language,
    columns,
    onNavigate
}: {
    ledger: PartnerAccountStatementCurrencyLedger
    iqdPreference: Parameters<typeof formatCurrency>[2]
    t: (key: string, options?: Record<string, unknown>) => string
    i18n: I18n
    language: string
    columns: PartnerAccountStatementColumnId[]
    onNavigate: (path: string) => void
}) {
    const display = (amount: number) => formatCurrency(Math.abs(amount), ledger.currency, iqdPreference)
    const summaryLabelColumn = getPartnerAccountStatementSummaryLabelColumn(columns)
    const summaryValue = (columnId: PartnerAccountStatementColumnId, kind: 'opening' | 'total') => {
        if (columnId === 'debit') return kind === 'opening'
            ? ledger.openingBalance > 0 ? display(ledger.openingBalance) : '—'
            : display(ledger.debitTotal)
        if (columnId === 'credit') return kind === 'opening'
            ? ledger.openingBalance < 0 ? display(ledger.openingBalance) : '—'
            : display(ledger.creditTotal)
        if (columnId === 'balance') return display(kind === 'opening' ? ledger.openingBalance : ledger.closingBalance)
        if (columnId === 'totalProductCommission' && kind === 'total') return display(ledger.productCommissionTotal)
        return null
    }
    return (
        <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/20 py-4">
                <div>
                    <CardTitle className="text-base">
                        {t('businessPartners.accountStatement.accountActivity', { defaultValue: 'Account Activity' })}
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {balanceLabel(ledger.closingBalance, t)}
                    </p>
                </div>
                <span className="rounded-md border bg-background px-2 py-1 text-xs font-bold uppercase tracking-wide">
                    {ledger.currency}
                </span>
            </CardHeader>
            <CardContent className="p-0">
                <div className="grid grid-cols-2 divide-x border-b sm:grid-cols-4">
                    {[
                        ['businessPartners.accountStatement.openingBalance', 'Opening balance', ledger.openingBalance],
                        ['businessPartners.accountStatement.debit', 'Debit', ledger.debitTotal],
                        ['businessPartners.accountStatement.credit', 'Credit', ledger.creditTotal],
                        ['businessPartners.accountStatement.balance', 'Balance', ledger.closingBalance]
                    ].map(([key, fallback, amount], index) => (
                        <div key={String(key)} className={cn('min-w-0 p-3 sm:p-4', index > 1 && 'border-t sm:border-t-0')}>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                {t(String(key), { defaultValue: String(fallback) })}
                            </div>
                            <div className={cn(
                                'mt-1 truncate text-sm font-black tabular-nums',
                                index === 3 && balanceClass(ledger.closingBalance)
                            )}>
                                {display(Number(amount))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                                {columns.map((columnId) => (
                                    <TableHead
                                        key={columnId}
                                        className={cn(
                                            statementColumnIsNumeric(columnId) && 'text-right',
                                            columnId === 'description' && 'min-w-48',
                                            columnId === 'item' && 'min-w-40',
                                            columnId === 'totalProductCommission' && 'min-w-36',
                                            columnId === 'commissionPerProduct' && 'min-w-32'
                                        )}
                                    >
                                        {statementColumnLabel(columnId, t)}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Math.abs(ledger.openingBalance) > 0.000001 ? (
                                <TableRow className="bg-muted/20 font-medium">
                                    {columns.map((columnId) => {
                                        const value = summaryValue(columnId, 'opening')
                                        const isLabel = columnId === summaryLabelColumn
                                        return (
                                            <TableCell
                                                key={columnId}
                                                className={cn(
                                                    statementColumnIsNumeric(columnId) && 'text-right tabular-nums',
                                                    columnId === 'balance' && balanceClass(ledger.openingBalance),
                                                    isLabel && value && 'font-semibold'
                                                )}
                                            >
                                                {isLabel && value ? (
                                                    <span className="flex items-center justify-between gap-3">
                                                        <span>{t('businessPartners.accountStatement.openingBalance', { defaultValue: 'Opening balance' })}</span>
                                                        <span className="tabular-nums">{value}</span>
                                                    </span>
                                                ) : isLabel ? t('businessPartners.accountStatement.openingBalance', { defaultValue: 'Opening balance' }) : value || null}
                                            </TableCell>
                                        )
                                    })}
                                </TableRow>
                            ) : null}
                            {ledger.entries.map((entry) => {
                                const sourcePath = entrySourcePath(entry)
                                const description = getPartnerAccountStatementEntryDescription(entry, t)
                                const detail = getPartnerAccountStatementEntryDetail(entry, { t, i18n, language })
                                const row = (
                                    <TableRow className="cursor-context-menu">
                                        {columns.map((columnId) => {
                                            switch (columnId) {
                                                case 'date':
                                                    return <TableCell key={columnId} className="whitespace-nowrap">{formatDate(entry.date)}</TableCell>
                                                case 'reference':
                                                    return <TableCell key={columnId} className="max-w-40 font-medium break-words">{entry.reference}</TableCell>
                                                case 'type':
                                                    return <TableCell key={columnId} className="whitespace-nowrap text-muted-foreground">{entryLabel(entry.kind, t)}</TableCell>
                                                case 'description':
                                                    return <TableCell key={columnId} className="min-w-48 whitespace-pre-wrap"><div>{description}</div>{detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}</TableCell>
                                                case 'item':
                                                    return <TableCell key={columnId} className="min-w-40 whitespace-pre-wrap">{entry.itemName || '—'}</TableCell>
                                                case 'quantity':
                                                    return <TableCell key={columnId} className="text-right tabular-nums whitespace-nowrap">{formatStatementQuantity(entry.quantity, entry.unit, language)}</TableCell>
                                                case 'commissionPerProduct':
                                                    return <TableCell key={columnId} className="text-right font-medium tabular-nums whitespace-nowrap">{entry.commissionPerProduct == null ? '—' : display(entry.commissionPerProduct)}</TableCell>
                                                case 'totalProductCommission':
                                                    return <TableCell key={columnId} className="text-right font-medium tabular-nums whitespace-nowrap">{entry.totalProductCommission == null ? '—' : display(entry.totalProductCommission)}</TableCell>
                                                case 'debit':
                                                    return <TableCell key={columnId} className="text-right font-medium tabular-nums">{entry.delta > 0 ? display(entry.delta) : '—'}</TableCell>
                                                case 'credit':
                                                    return <TableCell key={columnId} className="text-right font-medium tabular-nums">{entry.delta < 0 ? display(entry.delta) : '—'}</TableCell>
                                                case 'balance':
                                                    return <TableCell key={columnId} className={cn('text-right font-bold tabular-nums', balanceClass(entry.runningBalance))}>{display(entry.runningBalance)}</TableCell>
                                            }
                                        })}
                                    </TableRow>
                                )

                                return (
                                    <ContextMenu key={entry.id}>
                                        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                                        <ContextMenuContent className="w-52">
                                            <ContextMenuItem className="gap-2" disabled={!sourcePath} onSelect={() => { if (sourcePath) onNavigate(sourcePath) }}>
                                                <FileText className="h-4 w-4" />
                                                {sourcePath
                                                    ? t('common.view', { defaultValue: 'View' })
                                                    : t('businessPartners.accountStatement.sourceViewUnavailable', { defaultValue: 'No source view is available' })}
                                            </ContextMenuItem>
                                        </ContextMenuContent>
                                    </ContextMenu>
                                )
                            })}
                            <TableRow className="bg-muted/30 font-bold hover:bg-muted/30">
                                {columns.map((columnId) => {
                                    const value = summaryValue(columnId, 'total')
                                    const isLabel = columnId === summaryLabelColumn
                                    return (
                                        <TableCell key={columnId} className={cn(
                                            statementColumnIsNumeric(columnId) && 'text-right tabular-nums',
                                            columnId === 'balance' && balanceClass(ledger.closingBalance),
                                            isLabel && value && 'font-semibold'
                                        )}>
                                            {isLabel && value ? (
                                                <span className="flex items-center justify-between gap-3">
                                                    <span>{t('common.total', { defaultValue: 'Total' })}</span>
                                                    <span className="tabular-nums">{value}</span>
                                                </span>
                                            ) : isLabel ? t('common.total', { defaultValue: 'Total' }) : value || null}
                                        </TableCell>
                                    )
                                })}
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
            </CardContent>
        </Card>
    )
}

export function AccountStatements() {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { features, hasFeature, workspaceName, isLocalMode } = useWorkspace()
    const workspaceId = user?.workspaceId
    const [location, navigate] = useLocation()
    const urlPartnerSelection = useMemo(() => readPartnerSelection(location), [location])
    const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(urlPartnerSelection.id)
    const [partnerQuery, setPartnerQuery] = useState(urlPartnerSelection.partnerName)
    const [dateRange, setDateRange] = useState<DateRangeType>('month')
    const [customDates, setCustomDates] = useState({ start: '', end: '' })
    const [customTemplates, setCustomTemplates] = useState<StoredCustomTemplateRow[]>([])
    const [selectedPrintTemplate, setSelectedPrintTemplate] = useState<StoredCustomTemplateRow | null>(null)
    const [isPrintPreviewOpen, setIsPrintPreviewOpen] = useState(false)
    const [isStatementSettingsOpen, setIsStatementSettingsOpen] = useState(false)
    const [selectedStatementTemplateId, setSelectedStatementTemplateId] = useState<string | null>(null)
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const canManageStatementTemplates = user?.role === 'admin' && (isLocalMode || isSupabaseConfigured)

    useEffect(() => {
        setSelectedPartnerId(urlPartnerSelection.id)
        if (urlPartnerSelection.id) {
            setPartnerQuery(urlPartnerSelection.partnerName)
        }
    }, [urlPartnerSelection])

    const statementPeriod = useMemo<PartnerAccountStatementPeriod>(() => {
        if (dateRange === 'custom') {
            return {
                type: 'custom',
                start: customDates.start || undefined,
                end: customDates.end || undefined
            }
        }
        if (dateRange === 'allTime') return { type: 'allTime' }

        const { start, end } = getDateRangeBounds(dateRange, customDates)
        if (dateRange === 'yesterday') {
            return {
                type: 'custom',
                start: start?.toISOString(),
                end: end ? new Date(end.getTime() - 1).toISOString() : undefined
            }
        }
        return {
            type: dateRange,
            start: start?.toISOString(),
            end: end ? new Date(end.getTime() - 1).toISOString() : undefined
        }
    }, [customDates, dateRange])
    const loadCustomTemplates = useCallback(async () => {
        if (!workspaceId || (!isLocalMode && !isSupabaseConfigured)) {
            setCustomTemplates([])
            return
        }
        const templates = await fetchCachedCustomTemplates(workspaceId, {
            moduleTypePrefix: 'businessPartners.',
            activeOnly: true
        })
        setCustomTemplates(templates as StoredCustomTemplateRow[])
    }, [isLocalMode, workspaceId])

    useEffect(() => {
        let cancelled = false
        void loadCustomTemplates().catch((error) => {
            console.error('[AccountStatements] Failed to load statement templates:', error)
            if (!cancelled) setCustomTemplates([])
        })
        return () => { cancelled = true }
    }, [loadCustomTemplates])

    const statementTemplates = useMemo(() => customTemplates
        .filter((template) => template.module_type_key === PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY && template.active)
        .flatMap((template) => {
            const statementTemplate = readPartnerAccountStatementTemplate(template)
            return statementTemplate ? [statementTemplate] : []
        })
        .sort((left, right) => Number(right.primary) - Number(left.primary) || left.label.localeCompare(right.label)),
        [customTemplates]
    )
    const builtInStatementTemplate = useMemo<PartnerAccountStatementTemplate>(() => ({
        id: '__partner-account-statement-built-in-default__',
        label: t('businessPartners.accountStatement.builtInDefaultTemplate', { defaultValue: 'Default Account Statement' }),
        primary: true,
        active: true,
        version: 1,
        configuration: createPartnerAccountStatementTemplateConfiguration(DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION)
    }), [t])
    const defaultStatementTemplate = statementTemplates.find((template) => template.primary)
        || statementTemplates[0]
        || builtInStatementTemplate
    const activeStatementTemplate = statementTemplates.find((template) => template.id === selectedStatementTemplateId)
        || defaultStatementTemplate

    useEffect(() => {
        if (selectedStatementTemplateId && !statementTemplates.some((template) => template.id === selectedStatementTemplateId)) {
            setSelectedStatementTemplateId(null)
        }
    }, [selectedStatementTemplateId, statementTemplates])

    const {
        partner,
        statementData,
        isRefreshing,
        refreshError,
        retryLiveRefresh
    } = usePartnerAccountStatement(workspaceId, selectedPartnerId, statementPeriod)
    const isAgentStatement = isAgentBusinessPartnerRole(partner?.role)
    const itemizeSalesOrders = activeStatementTemplate.configuration.showOrderItems
    const itemizePosSaleLoans = activeStatementTemplate.configuration.showPosSaleItems
    const statementColumns = getPartnerAccountStatementVisibleColumns(activeStatementTemplate.configuration, {
        showItemColumns: itemizeSalesOrders || itemizePosSaleLoans,
        showProductCommissionColumns: isAgentStatement
    })
    const statementDataForDisplay = useMemo(
        () => statementData ? { ...statementData, itemizeSalesOrders, itemizePosSaleLoans } : null,
        [itemizePosSaleLoans, itemizeSalesOrders, statementData]
    )
    const ledgers = useMemo(
        () => statementDataForDisplay ? buildPartnerAccountStatementLedger(statementDataForDisplay) : [],
        [statementDataForDisplay]
    )
    const printLang = features.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const currentTemplatePrintLanguage = resolveCustomTemplatePrintLanguage(printLang)

    const workspacePrintContacts = useMemo(() => {
        const primaryContact = (type: 'phone' | 'address' | 'email') => {
            const contacts = workspaceContacts.filter((contact) => contact.type === type && contact.value?.trim())
            return (contacts.find((contact) => contact.isPrimary) || contacts[0])?.value.trim()
        }
        return {
            phone: primaryContact('phone'),
            address: primaryContact('address'),
            email: primaryContact('email')
        }
    }, [workspaceContacts])
    const printData = useMemo<PartnerAccountStatementPrintData | null>(() => {
        if (!partner || !statementDataForDisplay) return null
        return {
            ...statementDataForDisplay,
            tableColumns: statementColumns,
            workspace: workspacePrintContacts,
            partner: {
                partnerName: partner.partnerName,
                phone: partner.phone,
                address: partner.address,
                city: partner.city
            },
            generatedAt: new Date().toISOString()
        }
    }, [partner, statementColumns, statementDataForDisplay, workspacePrintContacts])
    const printTarget = useMemo(
        () => getCustomTemplateTarget(PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY),
        []
    )
    const availablePrintTemplates = useMemo(
        () => customTemplates.filter((template) => template.module_type_key === PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY
            && template.active
            && Boolean(readCustomTemplateLayout(template))),
        [customTemplates]
    )
    const selectedPrintLayout = useMemo(
        () => selectedPrintTemplate
            && isCustomTemplatePrintLanguageCompatible(selectedPrintTemplate, currentTemplatePrintLanguage)
            ? readCustomTemplateLayout(selectedPrintTemplate)
            : null,
        [currentTemplatePrintLanguage, selectedPrintTemplate]
    )
    const activePrintLayout = useMemo<CustomTemplateLayout | null>(() => {
        if (selectedPrintLayout) return selectedPrintLayout
        if (!printTarget) return null
        return {
            version: 1,
            label: t('businessPartners.accountStatementA4Template', { defaultValue: 'Partner Account Statement A4' }),
            moduleTypeKey: PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
            nativeTemplateKey: printTarget.nativeTemplateKey,
            page: printTarget.page,
            fields: {},
            fieldOrders: {},
            fieldLabelOverrides: {},
            annotations: [],
            texts: [],
            images: [],
            shapes: [],
            updatedAt: new Date().toISOString()
        }
    }, [printTarget, selectedPrintLayout, t])
    const printPreview = useMemo(
        () => printTarget && printData
            ? createCustomTemplatePreview(printTarget, {
                workspaceId,
                workspaceName,
                features,
                partnerAccountStatementData: printData,
                printLang
            })
            : undefined,
        [features, printData, printLang, printTarget, workspaceId, workspaceName]
    )
    const buildPrintPdf = useCallback(async ({ effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        if (!printTarget || !printData || !activePrintLayout) {
            throw new Error('Partner account statement print data is not available.')
        }
        return buildCustomTemplateLayoutPdf({
            target: printTarget,
            layout: activePrintLayout,
            values: {},
            options: {
                workspaceId,
                workspaceName,
                features,
                partnerAccountStatementData: printData,
                printLang
            },
            effectiveId,
            fieldMode: 'layoutOverrides'
        })
    }, [activePrintLayout, features, printData, printLang, printTarget, workspaceId, workspaceName])
    const buildEditablePrintPdf = useCallback(async (
        layout: CustomTemplateLayout,
        printLangOverride?: string,
        effectiveId?: string
    ) => {
        if (!printTarget || !printData) {
            throw new Error('Partner account statement print data is not available.')
        }
        return buildCustomTemplateLayoutPdf({
            target: printTarget,
            layout,
            values: {},
            options: {
                workspaceId,
                workspaceName,
                features,
                partnerAccountStatementData: printData,
                printLang: printLangOverride || printLang
            },
            effectiveId,
            fieldMode: 'layoutOverrides'
        })
    }, [features, printData, printLang, printTarget, workspaceId, workspaceName])
    const customPrintOptions = useMemo(
        () => availablePrintTemplates.map((template) => ({
            format: 'a4' as const,
            template,
            label: getStoredCustomTemplateLabel(template),
            description: t('businessPartners.customAccountStatementA4TemplateDescription', {
                defaultValue: 'Use this saved Partner Account Statement layout.'
            }),
            primary: template.primary,
            disabled: !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage),
            warning: getCustomTemplatePrintLanguageWarning(template, currentTemplatePrintLanguage, t)
        })),
        [availablePrintTemplates, currentTemplatePrintLanguage, t]
    )
    const handlePrintSelection = useCallback((
        _format: PrintFormat,
        template?: StoredCustomTemplateRow,
        nativeTemplateKey?: string
    ) => {
        const requestedKey = template?.module_type_key || nativeTemplateKey
        if (requestedKey !== PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY) return
        if (template && !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage)) return
        setSelectedPrintTemplate(template || null)
    }, [currentTemplatePrintLanguage])
    const selectPartner = useCallback((nextPartner: { id: string; partnerName: string }) => {
        setSelectedPartnerId(nextPartner.id)
        setPartnerQuery(nextPartner.partnerName)
        navigate(`${ACCOUNT_STATEMENT_PATH}?partnerId=${encodeURIComponent(nextPartner.id)}&partnerName=${encodeURIComponent(nextPartner.partnerName)}`)
    }, [navigate])
    const changePartnerQuery = useCallback((value: string) => {
        setPartnerQuery(value)
        if (selectedPartnerId && value !== partner?.partnerName) {
            setSelectedPartnerId(null)
            navigate(ACCOUNT_STATEMENT_PATH)
        }
    }, [navigate, partner?.partnerName, selectedPartnerId])

    useEffect(() => {
        if (partner && selectedPartnerId === partner.id) setPartnerQuery(partner.partnerName)
    }, [partner, selectedPartnerId])

    const saveStatementTemplate = useCallback(async (input: {
        id?: string
        label: string
        configuration: PartnerAccountStatementTemplateConfiguration
    }) => {
        if (!workspaceId || !user?.id) throw new Error('Missing workspace context.')
        const existingTemplate = input.id
            ? statementTemplates.find((template) => template.id === input.id)
            : undefined
        const layoutJson = serializePartnerAccountStatementTemplate(input.configuration)

        if (isLocalMode) {
            const saved = await saveLocalCustomTemplate({
                id: existingTemplate?.id,
                workspaceId,
                moduleTypeKey: PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
                label: input.label,
                layoutJson,
                active: true,
                primary: existingTemplate?.primary ?? statementTemplates.length === 0,
                userId: user.id
            })
            await loadCustomTemplates()
            return saved.id
        }

        if (!isSupabaseConfigured) throw new Error('Template storage is unavailable.')
        const payload = {
            workspace_id: workspaceId,
            module_type_key: PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
            label: input.label,
            layout_json: layoutJson,
            updated_by: user.id
        }
        const { data, error } = existingTemplate
            ? await runSupabaseAction('partnerAccountStatementTemplates.update', () =>
                supabase
                    .from('custom_templates')
                    .update(payload)
                    .eq('id', existingTemplate.id)
                    .eq('workspace_id', workspaceId)
                    .select('id')
                    .single()
            )
            : await runSupabaseAction('partnerAccountStatementTemplates.create', () =>
                supabase
                    .from('custom_templates')
                    .insert({
                        ...payload,
                        created_by: user.id,
                        active: true,
                        primary: statementTemplates.length === 0
                    })
                    .select('id')
                    .single()
            )
        if (error) throw normalizeSupabaseActionError(error)
        await loadCustomTemplates()
        if (!data?.id) throw new Error('Template was saved without an identifier.')
        return data.id
    }, [isLocalMode, loadCustomTemplates, statementTemplates, user?.id, workspaceId])

    const setDefaultStatementTemplate = useCallback(async (templateId: string) => {
        if (!workspaceId || !user?.id) throw new Error('Missing workspace context.')
        const template = statementTemplates.find((candidate) => candidate.id === templateId)
        if (!template) throw new Error('Statement template not found.')

        if (isLocalMode) {
            await saveLocalCustomTemplate({
                id: template.id,
                workspaceId,
                moduleTypeKey: PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
                label: template.label,
                layoutJson: serializePartnerAccountStatementTemplate(template.configuration),
                active: true,
                primary: true,
                userId: user.id
            })
        } else {
            const { error } = await runSupabaseAction('partnerAccountStatementTemplates.setDefault', () =>
                supabase
                    .from('custom_templates')
                    .update({ primary: true, updated_by: user.id })
                    .eq('id', template.id)
                    .eq('workspace_id', workspaceId)
            )
            if (error) throw normalizeSupabaseActionError(error)
        }
        await loadCustomTemplates()
    }, [isLocalMode, loadCustomTemplates, statementTemplates, user?.id, workspaceId])

    const deleteStatementTemplate = useCallback(async (templateId: string) => {
        if (!workspaceId || !user?.id) throw new Error('Missing workspace context.')
        const template = statementTemplates.find((candidate) => candidate.id === templateId)
        if (!template) throw new Error('Statement template not found.')
        if (template.primary || statementTemplates.length <= 1) {
            throw new Error('Set another template as default before deleting this template.')
        }

        if (isLocalMode) {
            await deleteLocalCustomTemplate(workspaceId, template.id, user.id)
        } else {
            const { data, error } = await runSupabaseAction('partnerAccountStatementTemplates.delete', () =>
                supabase
                    .from('custom_templates')
                    .delete()
                    .eq('id', template.id)
                    .eq('workspace_id', workspaceId)
                    .select('id')
            )
            if (error) throw normalizeSupabaseActionError(error)
            if (!data?.some((row) => row.id === template.id)) {
                throw new Error('The statement template was not found or you do not have permission to delete it.')
            }
        }
        await loadCustomTemplates()
    }, [isLocalMode, loadCustomTemplates, statementTemplates, user?.id, workspaceId])

    if (!workspaceId) return null

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                    <Link href="/business-partners" className="inline-flex items-center gap-1 hover:text-foreground">
                        <ArrowLeft className="h-4 w-4" />
                        {t('businessPartners.title', { defaultValue: 'Business Partners' })}
                    </Link>
                    <span>/</span>
                    <span className="truncate font-semibold text-foreground">
                        {t('businessPartners.accountStatement.title', { defaultValue: 'Account Statement' })}
                        <ModulePageFreshness tableNames={PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES} className="ms-2" />
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        className="h-10 gap-2 rounded-xl px-4"
                        onClick={() => setIsStatementSettingsOpen(true)}
                    >
                        <Settings className="h-4 w-4" />
                        {t('common.settings')}
                    </Button>
                    <Button
                        variant="outline"
                        className="h-10 gap-2 rounded-xl px-4"
                        disabled={isRefreshing || Boolean(refreshError) || !printPreview || !activePrintLayout}
                        onClick={() => {
                            setSelectedPrintTemplate(null)
                            setIsPrintPreviewOpen(true)
                        }}
                    >
                        <Printer className="h-4 w-4" />
                        {t('common.print', { defaultValue: 'Print' })}
                    </Button>
                </div>
            </div>

            <Card>
                <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold">
                            {t('businessPartners.title', { defaultValue: 'Business Partner' })}
                        </label>
                        <PartnerAutocompleteInput
                            value={partnerQuery}
                            onChange={changePartnerQuery}
                            onSelectPartner={selectPartner}
                            workspaceId={workspaceId}
                            includeAgentRoles={hasFeature('agent_sales_accounts')}
                            placeholder={t('businessPartners.accountStatement.searchPartner', { defaultValue: 'Search for a business partner' })}
                        />
                    </div>
                    <DateRangeFilters
                        dateRange={dateRange}
                        customDates={customDates}
                        onDateRangeChange={setDateRange}
                        onCustomDatesChange={setCustomDates}
                        className="justify-start lg:justify-end"
                    />
                </CardContent>
            </Card>

            {!selectedPartnerId ? (
                <Card>
                    <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                        <FileText className="mb-4 h-10 w-10 text-muted-foreground" />
                        <h2 className="text-lg font-semibold">
                            {t('businessPartners.accountStatement.selectPartner', { defaultValue: 'Select a business partner' })}
                        </h2>
                        <p className="mt-1 max-w-md text-sm text-muted-foreground">
                            {t('businessPartners.accountStatement.selectPartnerDescription', {
                                defaultValue: 'Choose a partner to view opening balances, account activity, and closing balances.'
                            })}
                        </p>
                    </CardContent>
                </Card>
            ) : isRefreshing ? (
                <Card>
                    <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                        <Loader2 className="mb-4 h-10 w-10 animate-spin text-primary" />
                        <h2 className="text-lg font-semibold">
                            {t('businessPartners.accountStatement.refreshingLiveData')}
                        </h2>
                        <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                            {t('businessPartners.accountStatement.refreshingLiveDataDescription')}
                        </p>
                    </CardContent>
                </Card>
            ) : refreshError ? (
                <Card>
                    <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                        <CircleAlert className="mb-4 h-10 w-10 text-amber-600 dark:text-amber-400" />
                        <h2 className="text-lg font-semibold">
                            {t('businessPartners.accountStatement.liveDataUnavailable')}
                        </h2>
                        <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                            {t('businessPartners.accountStatement.liveDataUnavailableDescription')}
                        </p>
                        <Button type="button" variant="outline" className="mt-4 gap-2" onClick={retryLiveRefresh}>
                            <RefreshCw className="h-4 w-4" />
                            {t('common.retry')}
                        </Button>
                    </CardContent>
                </Card>
            ) : !partner ? (
                <Card>
                    <CardContent className="p-8 text-center text-sm text-muted-foreground">
                        {t('businessPartners.notFoundDescription', { defaultValue: 'The requested record may have been deleted or moved out of this workspace.' })}
                    </CardContent>
                </Card>
            ) : ledgers.length === 0 ? (
                <Card>
                    <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                        <FileText className="mb-4 h-10 w-10 text-muted-foreground" />
                        <h2 className="text-lg font-semibold">{partner.partnerName}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('businessPartners.noActivity', { defaultValue: 'No related activity yet.' })}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    <Card className="overflow-hidden">
                        <CardContent className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                <FileText className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h1 className="truncate text-lg font-bold">{partner.partnerName}</h1>
                                <p className="text-sm text-muted-foreground">
                                    {[partner.phone, partner.address].filter(Boolean).join(' · ')
                                        || t('businessPartners.accountStatement.accountActivity', { defaultValue: 'Account Activity' })}
                                </p>
                            </div>
                            <div className="flex gap-2 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5 text-emerald-600" /> {t('businessPartners.accountStatement.dueFromPartner', { defaultValue: 'Due from partner' })}</span>
                                <span className="inline-flex items-center gap-1"><TrendingDown className="h-3.5 w-3.5 text-amber-600" /> {t('businessPartners.accountStatement.dueToPartner', { defaultValue: 'Due to partner' })}</span>
                            </div>
                        </CardContent>
                    </Card>
                    <div className="space-y-5">
                        {ledgers.map((ledger) => (
                            <LedgerCard
                                key={ledger.currency}
                                ledger={ledger}
                                iqdPreference={features.iqd_display_preference}
                                t={t}
                                i18n={i18n}
                                language={i18n.language}
                                columns={statementColumns}
                                onNavigate={navigate}
                            />
                        ))}
                    </div>
                </>
            )}

            <PartnerAccountStatementTemplateDialog
                open={isStatementSettingsOpen}
                onOpenChange={setIsStatementSettingsOpen}
                templates={statementTemplates}
                activeTemplate={activeStatementTemplate}
                hasStoredTemplates={statementTemplates.length > 0}
                canManageTemplates={canManageStatementTemplates}
                onSelectTemplate={setSelectedStatementTemplateId}
                onSaveTemplate={saveStatementTemplate}
                onSetDefault={setDefaultStatementTemplate}
                onDeleteTemplate={deleteStatementTemplate}
            />

            {printPreview && printTarget && activePrintLayout && partner && printData ? (
                <PrintPreviewModal
                    isOpen={isPrintPreviewOpen}
                    onClose={() => {
                        setIsPrintPreviewOpen(false)
                        setSelectedPrintTemplate(null)
                    }}
                    onConfirm={() => {
                        setIsPrintPreviewOpen(false)
                        setSelectedPrintTemplate(null)
                    }}
                    title={t('businessPartners.printAccountStatementA4', { defaultValue: 'Print Partner Account Statement A4' })}
                    documentId={partner.id}
                    originId={partner.id}
                    invoiceData={{
                        // `invoices.invoiceid` is limited to 50 characters in
                        // existing workspaces. A UUID is 36 characters, so
                        // keep this stable snapshot identifier below that limit.
                        invoiceid: `PARTNER-STMT-${partner.id}`,
                        totalAmount: partner.netExposure || 0,
                        settlementCurrency: partner.defaultCurrency,
                        origin: 'business_partner',
                        createdBy: user?.id,
                        createdByName: user?.name || 'Unknown',
                        cashierName: user?.name || 'Unknown',
                        printFormat: 'a4'
                    }}
                    pdfBuilder={buildPrintPdf}
                    templatePreview={printPreview}
                    customTemplate={{
                        moduleTypeKey: PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
                        nativeTemplateKey: printTarget.nativeTemplateKey,
                        templateId: selectedPrintTemplate?.id,
                        label: selectedPrintTemplate
                            ? getStoredCustomTemplateLabel(selectedPrintTemplate)
                            : t('businessPartners.accountStatementA4Template', { defaultValue: 'Partner Account Statement A4' })
                    }}
                    initialTemplateLayout={activePrintLayout}
                    enableTemplatePreviewSave
                    generateTemplateLayoutBlob={buildEditablePrintPdf}
                    features={features}
                    workspaceName={workspaceName}
                    module="businessPartners"
                    printSelectionOptions={[{
                        format: 'a4',
                        nativeTemplateKey: PARTNER_ACCOUNT_STATEMENT_TEMPLATE_KEY,
                        label: t('businessPartners.accountStatementA4Template', { defaultValue: 'Partner Account Statement A4' }),
                        description: t('businessPartners.accountStatementA4TemplateDescription', {
                            defaultValue: 'Chronological debit, credit, and running balance for each currency.'
                        })
                    }]}
                    printSelectionTemplates={customPrintOptions}
                    onPrintSelection={handlePrintSelection}
                />
            ) : null}
        </div>
    )
}


