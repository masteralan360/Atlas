import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'

import {
    useAgentCommissionMemberships,
    useAgentCommissionPlans,
    useAgents,
    useBusinessPartners,
    useSalesOrderAgentAssignments,
    type Agent,
    type AgentCommissionMembership,
    type AgentCommissionPlan,
    type BusinessPartner
} from '@/local-db'
import { supportsSalesAgentWorkflows } from '@/local-db/models'
import { getActiveAgentCommissionMembership } from './agentCommissionPresentation'

export interface CommissionAgentDirectoryEntry {
    agent: Agent
    partner?: BusinessPartner
    name: string
    membership?: AgentCommissionMembership
    plan?: AgentCommissionPlan
    isEligible: boolean
}

export function useCommissionAgentDirectory(workspaceId?: string) {
    const agents = useAgents(workspaceId)
    const partners = useBusinessPartners(workspaceId, {
        roles: ['agent'],
        includeAgentRoles: true
    })
    const memberships = useAgentCommissionMemberships(workspaceId)
    const plans = useAgentCommissionPlans(workspaceId)

    return useMemo(() => {
        const partnerById = new Map(partners.map((partner) => [partner.id, partner]))
        const planById = new Map(plans.map((plan) => [plan.id, plan]))
        const entries = agents
            .filter((agent) => !agent.isDeleted)
            .map<CommissionAgentDirectoryEntry>((agent) => {
                const membership = getActiveAgentCommissionMembership(memberships, agent.id)
                const partner = partnerById.get(agent.businessPartnerId)
                return {
                    agent,
                    partner,
                    name: partner?.partnerName || 'Unnamed agent',
                    membership,
                    plan: membership ? planById.get(membership.planId) : undefined,
                    isEligible: supportsSalesAgentWorkflows(agent.agentType) && agent.status === 'active'
                }
            })
            .sort((left, right) => left.name.localeCompare(right.name))

        return {
            agents: entries,
            eligibleAgents: entries.filter((entry) => entry.isEligible),
            memberships,
            plans,
            agentById: new Map(entries.map((entry) => [entry.agent.id, entry]))
        }
    }, [agents, memberships, partners, plans])
}

type CommissionFeatureData = ReturnType<typeof useCommissionAgentDirectory> & {
    assignments: ReturnType<typeof useSalesOrderAgentAssignments>
}

const CommissionFeatureDataContext = createContext<CommissionFeatureData | null>(null)

function CommissionFeatureDataProvider({
    workspaceId,
    children,
    includeAssignments = true
}: { workspaceId: string; children: ReactNode; includeAssignments?: boolean }) {
    const directory = useCommissionAgentDirectory(workspaceId)
    const assignments = useSalesOrderAgentAssignments(includeAssignments ? workspaceId : undefined)
    const value = useMemo(() => ({ ...directory, assignments }), [assignments, directory])
    return createElement(CommissionFeatureDataContext.Provider, { value }, children)
}

export function CommissionFeatureBoundary({
    enabled,
    workspaceId,
    children,
    includeAssignments = true
}: {
    enabled: boolean
    workspaceId?: string
    children: ReactNode
    includeAssignments?: boolean
}) {
    if (!enabled || !workspaceId) return children
    return createElement(CommissionFeatureDataProvider, { workspaceId, children, includeAssignments })
}

export function useOptionalCommissionFeatureData() {
    return useContext(CommissionFeatureDataContext)
}
