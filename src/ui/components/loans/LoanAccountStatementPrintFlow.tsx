import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Loan, LoanPayment } from '@/local-db'
import { usePartnerAccountStatement } from '@/hooks/usePartnerAccountStatement'
import {
    buildLoanAccountStatement,
    type LoanAccountStatementPrintData
} from '@/lib/loanAccountStatement'
import {
    createCustomTemplatePreview,
    getCustomTemplateTarget,
    LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY
} from '@/lib/customTemplates'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import type { PrintFormat } from '@/services/pdfGenerator'
import type { WorkspaceFeatures } from '@/workspace'
import { PrintFlow } from '@/ui/components'
import { LoanAccountStatementPaymentPickerDialog } from './LoanAccountStatementPaymentPickerDialog'

const ALL_TIME_PERIOD: PartnerAccountStatementPeriod = { type: 'allTime' }
const LOAN_ACCOUNT_STATEMENT_TARGET = getCustomTemplateTarget(LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY)

type LoanAccountStatementPrintFlowProps = {
    paymentPickerOpen: boolean
    onPaymentPickerOpenChange: (open: boolean) => void
    loan: Loan | null | undefined
    payments: LoanPayment[]
    workspaceId: string | undefined
    workspaceName?: string | null
    features: WorkspaceFeatures
    createdByName?: string | null
}

export function LoanAccountStatementPrintFlow({
    paymentPickerOpen,
    onPaymentPickerOpenChange,
    loan,
    payments,
    workspaceId,
    workspaceName,
    features,
    createdByName
}: LoanAccountStatementPrintFlowProps) {
    const { t, i18n } = useTranslation()
    const linkedPartnerId = loan?.linkedPartyType === 'business_partner' ? loan.linkedPartyId || undefined : undefined
    const { partner, statementData } = usePartnerAccountStatement(workspaceId, linkedPartnerId, ALL_TIME_PERIOD)
    const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null)
    const [previewOpen, setPreviewOpen] = useState(false)
    const printLang = features.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const activePayments = useMemo(() => payments.filter((payment) => !payment.isDeleted), [payments])
    const selectedPayment = useMemo(() => activePayments.find((payment) => payment.id === selectedPaymentId) || null, [activePayments, selectedPaymentId])

    useLayoutEffect(() => {
        if (!paymentPickerOpen || activePayments.length !== 1) return
        setSelectedPaymentId(activePayments[0].id)
        onPaymentPickerOpenChange(false)
        setPreviewOpen(true)
    }, [activePayments, onPaymentPickerOpenChange, paymentPickerOpen])
    const statement = useMemo<LoanAccountStatementPrintData | null>(() => {
        if (!loan || !partner || !statementData || !selectedPayment) return null
        return buildLoanAccountStatement(loan, partner, statementData, selectedPayment)
    }, [loan, partner, selectedPayment, statementData])
    const templatePreview = useMemo<TemplatePreview | undefined>(() => {
        if (!statement || !LOAN_ACCOUNT_STATEMENT_TARGET) return undefined
        return createCustomTemplatePreview(LOAN_ACCOUNT_STATEMENT_TARGET, {
            workspaceId,
            workspaceName,
            features,
            loanAccountStatementData: statement,
            printLang
        })
    }, [features, printLang, statement, workspaceId, workspaceName])

    const handlePaymentConfirmed = useCallback((paymentId: string) => {
        setSelectedPaymentId(paymentId)
        onPaymentPickerOpenChange(false)
        setPreviewOpen(true)
    }, [onPaymentPickerOpenChange])

    const buildPdf = useCallback(async ({ effectiveId, printLangOverride }: { format: PrintFormat; effectiveId: string; printLangOverride?: string }) => {
        if (!templatePreview) throw new Error(t('loans.accountStatement.notReady'))
        const element = templatePreview.createElement({}, effectiveId, printLangOverride)
        if (!templatePreview.buildPdf) throw new Error(t('loans.accountStatement.notReady'))
        return templatePreview.buildPdf(element, printLangOverride)
    }, [t, templatePreview])

    if (!loan) return null

    return (
        <>
            <LoanAccountStatementPaymentPickerDialog
                open={paymentPickerOpen}
                onOpenChange={onPaymentPickerOpenChange}
                payments={payments}
                currency={loan.settlementCurrency}
                iqdPreference={features.iqd_display_preference}
                onConfirm={handlePaymentConfirmed}
            />
            {statement && templatePreview && LOAN_ACCOUNT_STATEMENT_TARGET ? (
                <PrintFlow
                    module="loans"
                    isOpen={previewOpen}
                    onClose={() => setPreviewOpen(false)}
                    onConfirm={() => setPreviewOpen(false)}
                    title={t('loans.accountStatement.title')}
                    features={features}
                    workspaceName={workspaceName}
                    originId={statement.selectedPayment.id}
                    invoiceData={{
                        invoiceid: statement.selectedPayment.id,
                        totalAmount: statement.selectedPayment.amount,
                        settlementCurrency: statement.currency,
                        origin: 'loans',
                        createdByName: createdByName || '',
                        cashierName: createdByName || '',
                        printFormat: 'a4'
                    }}
                    pdfBuilder={buildPdf}
                    templatePreview={templatePreview}
                    customTemplate={{
                        moduleTypeKey: LOAN_ACCOUNT_STATEMENT_TARGET.moduleTypeKey,
                        nativeTemplateKey: LOAN_ACCOUNT_STATEMENT_TARGET.nativeTemplateKey,
                        label: t('loans.accountStatement.title')
                    }}
                />
            ) : null}
        </>
    )
}
