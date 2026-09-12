import { useState } from 'react'
import { BadgeDollarSign, HandCoins } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { recordObligationSettlement, type PaymentObligation, type WorkspacePaymentMethod } from '@/local-db'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'
import { AgentCommissionAdminOverview } from '@/ui/components/commissions/AgentCommissionAdminOverview'
import { SalesAgentCommissionModeDialog } from '@/ui/components/commissions/SalesAgentCommissionModeDialog'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { SettlementDialog } from '@/ui/components/payments/SettlementDialog'
import { Button, useToast } from '@/ui/components'
import { CommissionFeatureBoundary } from '@/ui/components/commissions/useCommissionAgentDirectory'
import { useWorkspace } from '@/workspace'

// Keep this scoped to the commission page's own views. The generic table
// hydrators report their start, progress, completion, cancellation, and
// failure states through workspaceDataFreshness for these table names.
const SALES_AGENT_COMMISSIONS_FRESHNESS_TABLES = [
    'agent_commission_entries',
    'agent_commission_memberships',
    'agent_commission_plans',
    'sales_order_agent_assignments',
    'sales_orders',
    'agents',
    'business_partners'
] as const

/** Dedicated operational surface for paying and recovering field-agent commission. */
export function AgentCommissions() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features, hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isCommissionModeDialogOpen, setIsCommissionModeDialogOpen] = useState(false)

    const enabled = hasFeature('sales_agent_commissions')
    const canView = enabled && (
        hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewAll')
        || hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewOwn')
        || hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.pay')
    )
    const canPay = enabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.pay')

    if (!user?.workspaceId || !canView) return null

    const recordSettlement = async (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        amount?: number
        note?: string
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!settlementTarget) return
        setIsSubmitting(true)
        try {
            await recordObligationSettlement(user.workspaceId, settlementTarget, {
                ...input,
                createdBy: user.id || null
            })
            toast({
                title: settlementTarget.direction === 'incoming'
                    ? t('salesAgentCommissions.recoveryRecorded')
                    : t('salesAgentCommissions.paymentRecorded')
            })
            setSettlementTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error'),
                description: error?.message || t('payments.settlementFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <CommissionFeatureBoundary enabled={enabled} workspaceId={user.workspaceId}>
            <div className="w-full space-y-6 pb-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                            <HandCoins className="h-7 w-7 text-violet-700 dark:text-violet-300" />
                            {t('salesAgentCommissions.title')}
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('salesAgentCommissions.manualSettlementDescription')}{' '}
                            <ModulePageFreshness className="ms-2" tableNames={SALES_AGENT_COMMISSIONS_FRESHNESS_TABLES} />
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {user.role === 'admin' ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="gap-2"
                                onClick={() => setIsCommissionModeDialogOpen(true)}
                            >
                                <BadgeDollarSign className="h-4 w-4" />
                                {t('salesAgentCommissions.trackWithoutPayment')}
                            </Button>
                        ) : null}
                        <Button type="button" variant="outline" onClick={() => navigate('/agents')}>
                            {t('agents.title')}
                        </Button>
                    </div>
                </div>

                <AgentCommissionAdminOverview
                    workspaceId={user.workspaceId}
                    iqdPreference={features.iqd_display_preference}
                    canReview={canView}
                    canPay={canPay}
                    onSettleCommission={setSettlementTarget}
                />
            </div>

            <SettlementDialog
                open={!!settlementTarget}
                onOpenChange={(open) => { if (!open) setSettlementTarget(null) }}
                obligation={settlementTarget}
                isSubmitting={isSubmitting}
                onSubmit={recordSettlement}
            />
            <SalesAgentCommissionModeDialog
                open={isCommissionModeDialogOpen}
                onOpenChange={setIsCommissionModeDialogOpen}
            />
        </CommissionFeatureBoundary>
    )
}
