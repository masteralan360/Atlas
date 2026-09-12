import type {
  AgentCommissionEntry,
  AgentProductCommissionEntry,
  SalesAgentCommissionMode,
  SalesOrder,
} from './models'

/** Older workspaces, orders, and entries predate the mode flag and remain payable. */
export function normalizeSalesAgentCommissionMode(
  value: unknown,
): SalesAgentCommissionMode {
  return value === 'tracked' ? 'tracked' : 'payable'
}

export function getSalesOrderCommissionMode(
  order: Pick<SalesOrder, 'commissionMode'>,
) {
  return normalizeSalesAgentCommissionMode(order.commissionMode)
}

export function getCommissionEntryMode(
  entry: Pick<AgentCommissionEntry | AgentProductCommissionEntry, 'commissionMode'>,
) {
  return normalizeSalesAgentCommissionMode(entry.commissionMode)
}

export function isTrackedCommissionEntry(
  entry: Pick<AgentCommissionEntry | AgentProductCommissionEntry, 'commissionMode'>,
) {
  return getCommissionEntryMode(entry) === 'tracked'
}

export function isPayableCommissionEntry(
  entry: Pick<AgentCommissionEntry | AgentProductCommissionEntry, 'commissionMode'>,
) {
  return getCommissionEntryMode(entry) === 'payable'
}
