import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

export const LOAN_DELETE_ONLINE_REQUIRED = 'loan_delete_online_required'

/**
 * Loan deletion has no protocol-v1 command adapter yet. In particular,
 * `command.loan_commands` is rejected by the phased server dispatcher and
 * there is no atomic delete-loan RPC to replay. Never mutate a Cloud Sync
 * replica offline when the corresponding command would be silently dropped.
 */
export function assertLoanDeletionConnectivity(workspaceId: string): void {
  if (!isLocalWorkspaceMode(workspaceId) && !isOnline(workspaceId)) {
    throw new Error(LOAN_DELETE_ONLINE_REQUIRED)
  }
}

export function loanDeletionOnlineRequiredError(): Error {
  return new Error(LOAN_DELETE_ONLINE_REQUIRED)
}
