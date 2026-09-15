type LinkedProductCommissionAgent = {
    id: string
    linkedUserId?: string | null
    agentType: string
    status: string
    isDeleted: boolean
}

type ProductCommissionAssignment = {
    agentId: string
}

/** Resolves the active field agent eligible for creator product attribution. */
export function findLinkedProductCommissionAgent<T extends LinkedProductCommissionAgent>(
    agents: readonly T[],
    userId?: string | null
) {
    if (!userId) return null
    return agents.find((agent) => (
        !agent.isDeleted
        && agent.status === 'active'
        && agent.agentType === 'field_agent'
        && agent.linkedUserId === userId
    )) ?? null
}

/** Resolves the linked field agent automatically attributed to an order creator. */
export function findOrderCreatorProductCommissionAgent<T extends LinkedProductCommissionAgent>(
    agents: readonly T[],
    orderCreatedBy?: string | null
) {
    return findLinkedProductCommissionAgent(agents, orderCreatedBy)
}

/** Resolves an automatic product beneficiary only for an order they created. */
export function findOwnedOrderCreatorProductCommissionAgent<T extends LinkedProductCommissionAgent>(
    agents: readonly T[],
    userId?: string | null,
    orderCreatedBy?: string | null
) {
    if (!userId || orderCreatedBy !== userId) return null
    return findOrderCreatorProductCommissionAgent(agents, orderCreatedBy)
}

/**
 * Applies the same assignment visibility and creator attribution used by the
 * order-detail product commission preview.
 */
export function getProductCommissionPreviewAgentIds<T extends LinkedProductCommissionAgent>({
    activeAssignments,
    agents,
    getAgent,
    userId,
    orderCreatedBy,
    canAssignSalesAgents,
    canViewAllAgentCommissions,
    canViewOwnAgentCommissions
}: {
    activeAssignments: readonly ProductCommissionAssignment[]
    agents: readonly T[]
    getAgent: (agentId: string) => T | undefined
    userId?: string | null
    orderCreatedBy?: string | null
    canAssignSalesAgents: boolean
    canViewAllAgentCommissions: boolean
    canViewOwnAgentCommissions: boolean
}) {
    const agentIds = new Set(activeAssignments
        .filter((assignment) => {
            if (canAssignSalesAgents || canViewAllAgentCommissions) return true
            if (!canViewOwnAgentCommissions || !userId) return false
            return getAgent(assignment.agentId)?.linkedUserId === userId
        })
        .map((assignment) => assignment.agentId))
    const canViewOrderCreatorAttribution = (
        userId === orderCreatedBy
        || canAssignSalesAgents
        || canViewAllAgentCommissions
    )
    const orderCreatorAgent = canViewOrderCreatorAttribution
        ? findOrderCreatorProductCommissionAgent(agents, orderCreatedBy)
        : null
    if (orderCreatorAgent) agentIds.add(orderCreatorAgent.id)
    return [...agentIds]
}
