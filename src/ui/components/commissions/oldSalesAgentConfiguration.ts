/**
 * Controls the legacy Sales-agent user interface while the standalone product
 * commission preview remains available in order forms and details.
 */
export const OLD_SALES_AGENT_CONFIGURATION = {
    showSalesAgentBeneficiaries: false,
    /**
     * Controls whether staff and viewer roles can choose a sales account while
     * creating an order. Administrators can always see the selector when the
     * Agent Sales Accounts feature is enabled.
     */
    showSalesAccountSelectionForNonAdmins: false
} as const

export function isSalesAccountSelectionVisible({
    agentSalesAccountsEnabled,
    userRole
}: {
    agentSalesAccountsEnabled: boolean
    userRole?: string | null
}) {
    return agentSalesAccountsEnabled
        && (userRole === 'admin' || OLD_SALES_AGENT_CONFIGURATION.showSalesAccountSelectionForNonAdmins)
}
