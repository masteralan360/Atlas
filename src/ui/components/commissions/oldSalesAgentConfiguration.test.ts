import { describe, expect, it } from 'vitest'

import {
    isSalesAccountSelectionVisible,
    OLD_SALES_AGENT_CONFIGURATION
} from './oldSalesAgentConfiguration'

describe('sales account selector visibility', () => {
    it('keeps the selector hidden when Agent Sales Accounts is disabled', () => {
        expect(isSalesAccountSelectionVisible({
            agentSalesAccountsEnabled: false,
            userRole: 'admin'
        })).toBe(false)
    })

    it('shows the selector to administrators when Agent Sales Accounts is enabled', () => {
        expect(isSalesAccountSelectionVisible({
            agentSalesAccountsEnabled: true,
            userRole: 'admin'
        })).toBe(true)
    })

    it('hides the selector from non-administrators by default', () => {
        expect(OLD_SALES_AGENT_CONFIGURATION.showSalesAccountSelectionForNonAdmins).toBe(false)
        expect(isSalesAccountSelectionVisible({
            agentSalesAccountsEnabled: true,
            userRole: 'staff'
        })).toBe(false)
    })
})
