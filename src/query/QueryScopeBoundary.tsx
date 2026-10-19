import { useEffect, useRef } from 'react'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { queryClient } from './queryClient'

/** Clear in-memory server-state when identity, workspace, or data mode changes. */
export function QueryScopeBoundary() {
  const { user } = useAuth()
  const { activeWorkspace, features } = useWorkspace()
  const scope = [
    user?.id ?? 'anonymous',
    activeWorkspace?.id ?? user?.workspaceId ?? 'no-workspace',
    features.data_mode ?? user?.workspaceMode ?? 'unknown-mode',
  ].join(':')
  const previousScope = useRef(scope)

  useEffect(() => {
    if (previousScope.current === scope) return
    queryClient.clear()
    previousScope.current = scope
  }, [scope])

  return null
}

