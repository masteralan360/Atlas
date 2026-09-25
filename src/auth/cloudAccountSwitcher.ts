export type CloudWorkspaceAccount = {
  id: string
  email: string
  name: string
  role: string
  profileUrl?: string | null
}

export type CloudAccountSwitchErrorCode =
  | 'offline'
  | 'unavailable'
  | 'connection'
  | 'credentials'
  | 'workspace_changed'
  | 'outgoing_shift_cancelled'
  | 'incoming_shift_cancelled'
  | 'restore_failed'
  | 'failed'

export class CloudAccountSwitchError extends Error {
  readonly code: CloudAccountSwitchErrorCode

  constructor(code: CloudAccountSwitchErrorCode) {
    super(code)
    this.name = 'CloudAccountSwitchError'
    this.code = code
  }
}

type InvokeCloudAccountSwitcher = (body: Record<string, unknown>) => Promise<{
  data: unknown
  error: unknown
}>

const invokeCloudAccountSwitcher: InvokeCloudAccountSwitcher = async (body) => {
  const { supabase } = await import('./supabase')
  return supabase.functions.invoke('workspace-account-switcher', { body })
}

function isNetworkFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /network|fetch|timeout|offline|connection/i.test(message)
}

function parseAccount(value: unknown): CloudWorkspaceAccount | null {
  if (!value || typeof value !== 'object') return null
  const account = value as Record<string, unknown>
  if (
    typeof account.id !== 'string' ||
    typeof account.email !== 'string' ||
    typeof account.name !== 'string' ||
    typeof account.role !== 'string'
  ) {
    return null
  }

  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
    profileUrl: typeof account.profileUrl === 'string' ? account.profileUrl : null
  }
}

export async function requestCloudWorkspaceAccounts(
  workspaceId: string,
  invoke: InvokeCloudAccountSwitcher = invokeCloudAccountSwitcher
): Promise<CloudWorkspaceAccount[]> {
  try {
    const { data, error } = await invoke({ action: 'list-members', workspaceId })
    if (error) {
      throw new CloudAccountSwitchError(isNetworkFailure(error) ? 'connection' : 'unavailable')
    }

    const accounts = (data as { accounts?: unknown } | null)?.accounts
    if (!Array.isArray(accounts)) throw new CloudAccountSwitchError('unavailable')

    return accounts.map(parseAccount).filter((account): account is CloudWorkspaceAccount => Boolean(account))
  } catch (error) {
    if (error instanceof CloudAccountSwitchError) throw error
    throw new CloudAccountSwitchError(isNetworkFailure(error) ? 'connection' : 'unavailable')
  }
}

export async function requestCloudWorkspaceAccount(
  workspaceId: string,
  userId: string,
  invoke: InvokeCloudAccountSwitcher = invokeCloudAccountSwitcher
): Promise<CloudWorkspaceAccount> {
  try {
    const { data, error } = await invoke({ action: 'validate-member', workspaceId, userId })
    if (error) {
      throw new CloudAccountSwitchError(isNetworkFailure(error) ? 'connection' : 'unavailable')
    }

    const account = parseAccount((data as { account?: unknown } | null)?.account)
    if (!account) throw new CloudAccountSwitchError('unavailable')
    return account
  } catch (error) {
    if (error instanceof CloudAccountSwitchError) throw error
    throw new CloudAccountSwitchError(isNetworkFailure(error) ? 'connection' : 'unavailable')
  }
}

export type CloudSwitchIdentity = {
  id: string
  workspaceId: string
  workspaceMode: string
}

export type CloudCredentialSession = {
  user: { id: string }
  session: unknown
}

export type CloudAccountSwitchDependencies<TIdentity extends CloudSwitchIdentity, TSession> = {
  isOnline: () => boolean
  loadMember: (workspaceId: string, userId: string) => Promise<CloudWorkspaceAccount>
  verifyCredentials: (
    email: string,
    password: string
  ) => Promise<{ credential: CloudCredentialSession; error?: never } | { credential?: never; error: 'credentials' | 'connection' }>
  completeOutgoingShift: (identity: TIdentity) => Promise<boolean>
  commitSession: (session: CloudCredentialSession) => Promise<TSession>
  loadIdentity: (userId: string) => Promise<TIdentity>
  publishIdentity: (identity: TIdentity) => void
  confirmIncomingShift: (identity: TIdentity) => Promise<boolean>
  restoreIdentity: (session: TSession, identity: TIdentity) => Promise<void>
}

export async function performCloudAccountSwitch<TIdentity extends CloudSwitchIdentity, TSession>(
  input: {
    currentIdentity: TIdentity
    currentSession: TSession | null
    targetUserId: string
    password: string
  },
  dependencies: CloudAccountSwitchDependencies<TIdentity, TSession>
): Promise<{ error: CloudAccountSwitchErrorCode | null }> {
  const { currentIdentity, currentSession, targetUserId, password } = input
  if (!dependencies.isOnline()) return { error: 'offline' }
  if (!currentSession || !password || targetUserId === currentIdentity.id) {
    return { error: 'unavailable' }
  }

  let member: CloudWorkspaceAccount
  try {
    member = await dependencies.loadMember(currentIdentity.workspaceId, targetUserId)
  } catch (error) {
    return { error: error instanceof CloudAccountSwitchError ? error.code : 'connection' }
  }

  let verification: Awaited<ReturnType<typeof dependencies.verifyCredentials>>
  try {
    verification = await dependencies.verifyCredentials(member.email, password)
  } catch {
    return { error: 'connection' }
  }
  if (verification.error) return { error: verification.error }
  if (verification.credential.user.id !== targetUserId) return { error: 'credentials' }

  try {
    if (!(await dependencies.completeOutgoingShift(currentIdentity))) {
      return { error: 'outgoing_shift_cancelled' }
    }
  } catch {
    return { error: 'failed' }
  }

  let committedSession: TSession | null = null
  let nextIdentity: TIdentity | null = null
  let sessionCommitStarted = false
  const restorePrevious = async () => {
    try {
      await dependencies.restoreIdentity(currentSession, currentIdentity)
      return true
    } catch {
      return false
    }
  }
  try {
    sessionCommitStarted = true
    committedSession = await dependencies.commitSession(verification.credential)
    nextIdentity = await dependencies.loadIdentity(targetUserId)
    if (
      nextIdentity.id !== targetUserId ||
      nextIdentity.workspaceId !== currentIdentity.workspaceId ||
      (nextIdentity.workspaceMode !== 'cloud' && nextIdentity.workspaceMode !== 'hybrid')
    ) {
      return { error: await restorePrevious() ? 'workspace_changed' : 'restore_failed' }
    }

    dependencies.publishIdentity(nextIdentity)
    if (!(await dependencies.confirmIncomingShift(nextIdentity))) {
      return { error: await restorePrevious() ? 'incoming_shift_cancelled' : 'restore_failed' }
    }

    return { error: null }
  } catch {
    if (sessionCommitStarted || committedSession || nextIdentity) {
      if (!(await restorePrevious())) return { error: 'restore_failed' }
    }
    return { error: 'failed' }
  }
}
