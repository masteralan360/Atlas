import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleAlert, FileText, Loader2, Printer, RefreshCw, Settings, Link2, Unlink2 } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'

import { isSupabaseConfigured, useAuth } from '@/auth'
import {
    PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY,
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
import { loadPartnerProductMovementsTemplates, savePartnerProductMovementsTemplate, setDefaultPartnerProductMovementsTemplate, deletePartnerProductMovementsTemplate } from '@/lib/partnerProductMovementsTemplateStorage'
import {
    createPartnerProductMovementsTemplateConfiguration,
    DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION,
    getPartnerProductMovementsVisibleColumns,
    PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY,
    readPartnerProductMovementsTemplate,
    type PartnerProductMovementsTemplate,
    type PartnerProductMovementsTemplateConfiguration
} from '@/lib/partnerProductMovementsTemplates'
import { buildPartnerProductMovements } from '@/lib/partnerProductMovements'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'
import { PartnerProductMovementsTable } from '@/ui/components/crm/PartnerProductMovementsTable'
import { PARTNER_PRODUCT_MOVEMENTS_FRESHNESS_TABLE_NAMES } from '@/lib/partnerProductMovementsLiveData'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import type { CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import { usePartnerProductMovements } from '@/hooks/usePartnerProductMovements'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import {
    useBusinessPartnersLoading,
    useWorkspaceContacts
} from '@/local-db'
import type { DateRangeType } from '@/context/DateRangeContext'
import type { PrintFormat } from '@/services/pdfGenerator'
import {
    Button,
    Card,
    CardContent,
    DateRangeFilters,
    PrintPreviewModal,
    Progress,
} from '@/ui/components'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { AutocompleteLoadingIndicator } from '@/ui/components/AutocompleteLoadingIndicator'
import { PartnerProductMovementsTemplateDialog } from '@/ui/components/crm/PartnerProductMovementsTemplateDialog'
import type { PartnerProductMovementsPrintData } from '@/ui/components/crm/PartnerProductMovementsPrintTemplate'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useWorkspace } from '@/workspace'

const PRODUCT_MOVEMENTS_PATH = '/business-partners/product-movements-statement'

function readPartnerSelection(location: string) {
    const searchParams = new URLSearchParams(location.split('?')[1] || '')
    return {
        id: searchParams.get('partnerId'),
        partnerName: searchParams.get('partnerName') || ''
    }
}

export function PartnerProductMovementsStatement() {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { features, hasFeature, workspaceName, isLocalMode } = useWorkspace()
    const online = useNetworkStatus()
    const workspaceId = user?.workspaceId
    const arePartnersLoading = useBusinessPartnersLoading(workspaceId, {
        includeAgentRoles: hasFeature('agent_sales_accounts')
    })
    const [location, navigate] = useLocation()
    const urlPartnerSelection = useMemo(() => readPartnerSelection(location), [location])
    const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(urlPartnerSelection.id)
    const [partnerQuery, setPartnerQuery] = useState(urlPartnerSelection.partnerName)
    const [dateRange, setDateRange] = useState<DateRangeType>('month')
    const [customDates, setCustomDates] = useState({ start: '', end: '' })
    const [customTemplates, setCustomTemplates] = useState<StoredCustomTemplateRow[]>([])
    const [templateLoadFailed, setTemplateLoadFailed] = useState(false)
    const [selectedPrintTemplate, setSelectedPrintTemplate] = useState<StoredCustomTemplateRow | null>(null)
    const [isPrintPreviewOpen, setIsPrintPreviewOpen] = useState(false)
    const [isStatementSettingsOpen, setIsStatementSettingsOpen] = useState(false)
    const [selectedStatementTemplateId, setSelectedStatementTemplateId] = useState<string | null>(null)
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const canManageStatementTemplates = user?.role === 'admin' && (isLocalMode || isSupabaseConfigured && online)

    useEffect(() => {
        setSelectedPartnerId(urlPartnerSelection.id)
        if (urlPartnerSelection.id) {
            setPartnerQuery(urlPartnerSelection.partnerName)
        }
    }, [urlPartnerSelection])

    const statementPeriod = useMemo<PartnerAccountStatementPeriod>(() => {
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
    const loadCustomTemplates = useCallback(async (signal?: AbortSignal) => {
        if (!workspaceId || (!isLocalMode && !isSupabaseConfigured)) {
            setCustomTemplates([])
            return
        }
        const templates = await loadPartnerProductMovementsTemplates(workspaceId, signal)
        if (!signal?.aborted) { setCustomTemplates(templates); setTemplateLoadFailed(false) }
    }, [isLocalMode, workspaceId])

    useEffect(() => {
        const controller = new AbortController()
        setCustomTemplates([])
        void loadCustomTemplates(controller.signal).catch(() => {
            if (!controller.signal.aborted) setTemplateLoadFailed(true)
        })
        return () => controller.abort()
    }, [loadCustomTemplates, online])

    const statementTemplates = useMemo(() => customTemplates
        .filter((template) => template.module_type_key === PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY && template.active)
        .flatMap((template) => {
            const statementTemplate = readPartnerProductMovementsTemplate(template)
            return statementTemplate ? [statementTemplate] : []
        })
        .sort((left, right) => Number(right.primary) - Number(left.primary) || left.label.localeCompare(right.label)),
        [customTemplates]
    )
    const builtInStatementTemplate = useMemo<PartnerProductMovementsTemplate>(() => ({
        id: '__partner-product-movements-built-in-default__',
        label: t('businessPartners.productMovements.builtInDefaultTemplate'),
        primary: true,
        active: true,
        version: 1,
        configuration: createPartnerProductMovementsTemplateConfiguration(DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION)
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
        liveRefreshProgress,
        retryLiveRefresh
    } = usePartnerProductMovements(workspaceId, selectedPartnerId, statementPeriod)
    const liveRefreshProgressPercent = liveRefreshProgress && liveRefreshProgress.totalSources > 0
        ? Math.min(100, Math.round((liveRefreshProgress.completedSources / liveRefreshProgress.totalSources) * 100))
        : 0
    const liveRefreshProgressLabel = liveRefreshProgress
        ? t('businessPartners.accountStatement.refreshingLiveDataProgress', {
            completed: liveRefreshProgress.completedSources.toLocaleString(i18n.resolvedLanguage ?? i18n.language),
            total: liveRefreshProgress.totalSources.toLocaleString(i18n.resolvedLanguage ?? i18n.language),
            percentage: liveRefreshProgressPercent.toLocaleString(i18n.resolvedLanguage ?? i18n.language)
        })
        : ''
    const statement = useMemo(() => statementData ? buildPartnerProductMovements(statementData, activeStatementTemplate.configuration.accumulateProducts) : null,
        [statementData, activeStatementTemplate.configuration.accumulateProducts])
    const statementColumns = getPartnerProductMovementsVisibleColumns(activeStatementTemplate.configuration, {
        showProductCommissionColumns: statement?.hasCommission === true
    })
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
    const printData = useMemo<PartnerProductMovementsPrintData | null>(() => {
        if (!partner || !statement) return null
        return {
            statement,
            period: statementPeriod,
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
    }, [partner, statementColumns, statement, statementPeriod, workspacePrintContacts])
    const printTarget = useMemo(
        () => getCustomTemplateTarget(PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY),
        []
    )
    const availablePrintTemplates = useMemo(
        () => customTemplates.filter((template) => template.module_type_key === PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY
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
            label: t('businessPartners.productMovements.accountStatementA4Template'),
            moduleTypeKey: PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY,
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
                partnerProductMovementsData: printData,
                printLang
            })
            : undefined,
        [features, printData, printLang, printTarget, workspaceId, workspaceName]
    )
    const buildPrintPdf = useCallback(async ({ effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        if (!printTarget || !printData || !activePrintLayout) {
            throw new Error('Partner product movements print data is not available.')
        }
        return buildCustomTemplateLayoutPdf({
            target: printTarget,
            layout: activePrintLayout,
            values: {},
            options: {
                workspaceId,
                workspaceName,
                features,
                partnerProductMovementsData: printData,
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
            throw new Error('Partner product movements print data is not available.')
        }
        return buildCustomTemplateLayoutPdf({
            target: printTarget,
            layout,
            values: {},
            options: {
                workspaceId,
                workspaceName,
                features,
                partnerProductMovementsData: printData,
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
            description: t('businessPartners.productMovements.customAccountStatementA4TemplateDescription'),
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
        if (requestedKey !== PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY) return
        if (template && !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage)) return
        setSelectedPrintTemplate(template || null)
    }, [currentTemplatePrintLanguage])
    const selectPartner = useCallback((nextPartner: { id: string; partnerName: string }) => {
        setSelectedPartnerId(nextPartner.id)
        setPartnerQuery(nextPartner.partnerName)
        navigate(`${PRODUCT_MOVEMENTS_PATH}?partnerId=${encodeURIComponent(nextPartner.id)}&partnerName=${encodeURIComponent(nextPartner.partnerName)}`)
    }, [navigate])
    const changePartnerQuery = useCallback((value: string) => {
        setPartnerQuery(value)
        if (selectedPartnerId && value !== partner?.partnerName) {
            setSelectedPartnerId(null)
            navigate(PRODUCT_MOVEMENTS_PATH)
        }
    }, [navigate, partner?.partnerName, selectedPartnerId])

    useEffect(() => {
        if (partner && selectedPartnerId === partner.id) setPartnerQuery(partner.partnerName)
    }, [partner, selectedPartnerId])

    const templateContext = () => {
        if (!workspaceId || !user?.id || !canManageStatementTemplates) throw new Error('Template editing is unavailable.')
        return { workspaceId, userId: user.id, isLocalMode }
    }
    const saveStatementTemplate = async (input: { id?: string; label: string; configuration: PartnerProductMovementsTemplateConfiguration }) => {
        const id = await savePartnerProductMovementsTemplate(templateContext(), statementTemplates, input)
        await loadCustomTemplates()
        return id
    }
    const setDefaultStatementTemplate = async (templateId: string) => {
        const template = statementTemplates.find(candidate => candidate.id === templateId)
        if (!template) throw new Error('Statement template not found.')
        await setDefaultPartnerProductMovementsTemplate(templateContext(), template)
        await loadCustomTemplates()
    }
    const deleteStatementTemplate = async (templateId: string) => {
        await deletePartnerProductMovementsTemplate(templateContext(), statementTemplates, templateId)
        await loadCustomTemplates()
    }

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
                        {t('businessPartners.productMovements.title')}
                        <ModulePageFreshness tableNames={PARTNER_PRODUCT_MOVEMENTS_FRESHNESS_TABLE_NAMES.slice(0, 1)} className="ms-2" />
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

            {templateLoadFailed && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm text-muted-foreground">
                <CircleAlert className="h-4 w-4" />{t('businessPartners.productMovements.templateLoadFailed')}
                <Button size="sm" variant="outline" onClick={() => { void loadCustomTemplates().catch(() => setTemplateLoadFailed(true)) }}><RefreshCw className="me-1 h-3 w-3" />{t('common.retry')}</Button>
            </div>}
            <Card>
                <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <div className="space-y-2">
                        <label className="inline-flex items-center gap-1.5 text-sm font-semibold">
                            {t('businessPartners.title', { defaultValue: 'Business Partner' })} *
                            <AutocompleteLoadingIndicator isLoading={arePartnersLoading} />
                        </label>
                        <PartnerAutocompleteInput
                            value={partnerQuery}
                            onChange={changePartnerQuery}
                            onSelectPartner={selectPartner}
                            workspaceId={workspaceId}
                            includeAgentRoles={hasFeature('agent_sales_accounts')}
                            isLoading={arePartnersLoading}
                            placeholder={t('businessPartners.accountStatement.searchPartner', { defaultValue: 'Search for a business partner' })}
                        />
                        {partner && <div className="flex items-center gap-2 text-xs">
                            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-primary"><Link2 className="h-3 w-3" />{t('businessPartners.linked')}</span>
                            <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => { setPartnerQuery(''); setSelectedPartnerId(null); navigate(PRODUCT_MOVEMENTS_PATH) }}><Unlink2 className="h-3 w-3" />{t('carRental.partnerLink.unlink')}</Button>
                        </div>}
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

            {statement && statement.undatedCount > 0 && <div role="note" className="flex items-start gap-2 rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{t('businessPartners.productMovements.undatedNotice', { count: statement.undatedCount })}
            </div>}
            {!selectedPartnerId ? (
                <Card>
                    <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
                        <FileText className="mb-4 h-10 w-10 text-muted-foreground" />
                        <h2 className="text-lg font-semibold">
                            {t('businessPartners.accountStatement.selectPartner', { defaultValue: 'Select a business partner' })}
                        </h2>
                        <p className="mt-1 max-w-md text-sm text-muted-foreground">
                            {t('businessPartners.productMovements.selectPartnerDescription')}
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
                            {t('businessPartners.productMovements.refreshingDescription')}
                        </p>
                        <div className="mt-5 w-full max-w-lg space-y-2" aria-live="polite">
                            <Progress
                                value={liveRefreshProgressPercent}
                                className="h-2.5 bg-primary/15"
                                indicatorClassName="bg-primary"
                                aria-valuetext={liveRefreshProgressLabel}
                            />
                            <p className="text-xs font-medium text-muted-foreground">
                                {liveRefreshProgressLabel}
                            </p>
                        </div>
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
            ) : !statement || statement.entries.length === 0 ? (
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
                                <h1 className="flex flex-wrap items-center gap-3 text-lg font-bold">
                                    <span className="truncate">{partner.partnerName}</span>
                                    <DateRangeBadge dateRange={dateRange} customDates={customDates} />
                                </h1>
                                <p className="text-sm text-muted-foreground">
                                    {[partner.phone, partner.address].filter(Boolean).join(' · ')
                                        || t('businessPartners.productMovements.title')}
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                    <div className="space-y-5">
                        {statement && <Card className="overflow-hidden"><div className="overflow-x-auto">
                            <PartnerProductMovementsTable statement={statement} language={i18n.language} columns={statementColumns} iqdPreference={features.iqd_display_preference} />
                        </div></Card>}
                    </div>
                </>
            )}

            <PartnerProductMovementsTemplateDialog
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
                    title={t('businessPartners.productMovements.printAccountStatementA4')}
                    documentId={partner.id}
                    originId={partner.id}
                    invoiceData={{
                        // `invoices.invoiceid` is limited to 50 characters in
                        // existing workspaces. A UUID is 36 characters, so
                        // keep this stable snapshot identifier below that limit.
                        invoiceid: `PARTNER-MOVE-${partner.id}`,
                        totalAmount: 0,
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
                        moduleTypeKey: PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY,
                        nativeTemplateKey: printTarget.nativeTemplateKey,
                        templateId: selectedPrintTemplate?.id,
                        label: selectedPrintTemplate
                            ? getStoredCustomTemplateLabel(selectedPrintTemplate)
                            : t('businessPartners.productMovements.accountStatementA4Template')
                    }}
                    initialTemplateLayout={activePrintLayout}
                    enableTemplatePreviewSave
                    generateTemplateLayoutBlob={buildEditablePrintPdf}
                    features={features}
                    workspaceName={workspaceName}
                    module="businessPartners"
                    printSelectionOptions={[{
                        format: 'a4',
                        nativeTemplateKey: PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY,
                        label: t('businessPartners.productMovements.accountStatementA4Template'),
                        description: t('businessPartners.productMovements.accountStatementA4TemplateDescription')
                    }]}
                    printSelectionTemplates={customPrintOptions}
                    onPrintSelection={handlePrintSelection}
                />
            ) : null}
        </div>
    )
}


