import { beforeEach, describe, expect, it, vi } from 'vitest'

const support = vi.hoisted(() => ({
  local: false,
  online: true,
}))

vi.mock('@/lib/network', () => ({
  isOnline: () => support.online,
}))

vi.mock('@/workspace/workspaceMode', () => ({
  isLocalWorkspaceMode: () => support.local,
}))

import {
  assertLoanDeletionConnectivity,
  LOAN_DELETE_ONLINE_REQUIRED,
} from './loanDeletionSupport'

describe('loan deletion connectivity', () => {
  beforeEach(() => {
    support.local = false
    support.online = true
  })

  it('allows an online Cloud Sync deletion', () => {
    expect(() => assertLoanDeletionConnectivity('workspace-1')).not.toThrow()
  })

  it('allows an offline Local workspace deletion', () => {
    support.local = true
    support.online = false
    expect(() => assertLoanDeletionConnectivity('workspace-1')).not.toThrow()
  })

  it('fails before an offline Cloud Sync deletion can mutate local state', () => {
    support.online = false
    expect(() => assertLoanDeletionConnectivity('workspace-1'))
      .toThrow(LOAN_DELETE_ONLINE_REQUIRED)
  })
})
