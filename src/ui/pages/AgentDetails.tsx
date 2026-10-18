import { useEffect } from 'react'
import { useRoute } from 'wouter'

import { useAuth } from '@/auth/AuthContext'
import { synchronizeWorkspaceSalesAccountCommissionAssignments } from '@/local-db'
import { PartnerDetailsView } from '@/ui/components/crm/PartnerDetailsView'
import { CommissionFeatureBoundary } from '@/ui/components/commissions/useCommissionAgentDirectory'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'

export function AgentDetails() {
    const { user } = useAuth()
    const { hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const [match, params] = useRoute('/agents/:agentId')
    const agentSalesAccountsEnabled = hasFeature('agent_sales_accounts')
    const salesAgentCommissionsEnabled = hasFeature('sales_agent_commissions')
    const canAssignCommissionOrders = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.assignOrders')

    useEffect(() => {
        if (!user?.workspaceId || !agentSalesAccountsEnabled || !canAssignCommissionOrders) return
        void synchronizeWorkspaceSalesAccountCommissionAssignments(user.workspaceId, user.id)
            .catch((error) => console.error('[Agent details] Failed to backfill sales-account commission beneficiaries:', error))
    }, [agentSalesAccountsEnabled, canAssignCommissionOrders, user?.id, user?.workspaceId])

    if (!match || !params?.agentId || !user?.workspaceId) {
        return null
    }

    const hasCommissionAccess = salesAgentCommissionsEnabled && (
        hasEffectiveSalesAgentCommissionPermission(user.role, permissionKeys, 'salesAgentCommissions.viewAll')
        || hasEffectiveSalesAgentCommissionPermission(user.role, permissionKeys, 'salesAgentCommissions.viewOwn')
    )

    return (
        <CommissionFeatureBoundary enabled={hasCommissionAccess} workspaceId={user.workspaceId}>
        <PartnerDetailsView
            workspaceId={user.workspaceId}
            partnerId={params.agentId}
            kind="agent"
        />
        </CommissionFeatureBoundary>
    )
}
