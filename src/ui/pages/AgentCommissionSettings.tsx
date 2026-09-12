import { ArrowLeft, BadgePercent } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'
import { Button } from '@/ui/components'
import { AgentCommissionSettingsForm } from '@/ui/components/commissions/AgentCommissionSettingsDialog'
import { CommissionFeatureBoundary } from '@/ui/components/commissions/useCommissionAgentDirectory'
import { useWorkspace } from '@/workspace'

export function AgentCommissionSettings() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const [, navigate] = useLocation()
    const canManageCommissionPlans = hasFeature('sales_agent_commissions') && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.managePlans')

    if (!user?.workspaceId || !canManageCommissionPlans) return null

    return (
        <CommissionFeatureBoundary enabled={true} workspaceId={user.workspaceId}>
            <div className="w-full space-y-8 pb-8">
                <div className="space-y-1">
                    <Button type="button" variant="ghost" className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => navigate('/agents')}>
                        <ArrowLeft className="h-4 w-4" />
                        {t('agents.title', { defaultValue: 'Agents' })}
                    </Button>
                    <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                        <BadgePercent className="h-7 w-7 text-violet-700 dark:text-violet-300" />
                        {t('salesAgentCommissions.settingsTitle')}
                    </h1>
                    <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.settingsDescription')}</p>
                </div>

                <AgentCommissionSettingsForm
                    workspaceId={user.workspaceId}
                    userId={user.id}
                    onCancel={() => navigate('/agents')}
                />
            </div>
        </CommissionFeatureBoundary>
    )
}
