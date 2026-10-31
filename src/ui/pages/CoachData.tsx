import { useTranslation } from 'react-i18next'
import { Redirect } from 'wouter'
import { Loader2, UsersRound } from 'lucide-react'

import { useAuth } from '@/auth/AuthContext'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useWorkspacePermissions } from '@/permissions'

export function CoachData() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { hasFeature, isLoading: isWorkspaceLoading } = useWorkspace()
  const { hasPermission, isLoading: arePermissionsLoading } = useWorkspacePermissions()

  if (isWorkspaceLoading || arePermissionsLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label={t('common.loading')}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const canAccessAsAdmin = user?.role === 'admin'
    && hasFeature('commerce_operations')
    && hasPermission('commerceOperations.access')
  const canAccessAsCoach = user?.role === 'staff' && hasPermission('coach')

  if (!canAccessAsAdmin && !canAccessAsCoach) return <Redirect to="/" />

  return (
    <div className="w-full space-y-6 pb-8">
      <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold sm:text-3xl">
        <UsersRound className="h-7 w-7 text-primary" />
        {t('commerceOperations.coachData.title')}
      </h1>
    </div>
  )
}
