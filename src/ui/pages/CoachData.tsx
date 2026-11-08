import { useEffect, useState } from 'react'
import {
  Award,
  CalendarDays,
  CircleDollarSign,
  Loader2,
  LockKeyhole,
  MapPin,
  Phone,
  TrendingUp,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Redirect } from 'wouter'

import { useAuth } from '@/auth/AuthContext'
import { COACH_DATA_PAGE_FRESHNESS_TABLES, useCoachData, useCoachDirectory } from '@/local-db/coachData'
import type { CoachDataSnapshot } from '@/local-db/coachData'
import { useWorkspacePermissions } from '@/permissions'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Badge } from '@/ui/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Label } from '@/ui/components/label'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { formatCurrency } from '@/lib/utils'
import { CoachRecentIntake } from '@/ui/components/commerce/CoachRecentIntake'

function formatCycleMonth(monthStart: string) {
  const date = new Date(`${monthStart}T12:00:00`)
  if (Number.isNaN(date.getTime())) return monthStart
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)
}

export function CoachData() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { hasFeature, isLocalMode, isLoading: isWorkspaceLoading } = useWorkspace()
  const { hasPermission, isLoading: arePermissionsLoading } = useWorkspacePermissions()
  const [selectedCoachUserId, setSelectedCoachUserId] = useState('')

  const canAccessAsAdmin = user?.role === 'admin'
    && hasFeature('commerce_operations')
    && hasPermission('commerceOperations.access')
  const canAccessAsCoach = user?.role === 'staff' && hasPermission('coach')

  const directoryQuery = useCoachDirectory({
    workspaceId: user?.workspaceId,
    userId: user?.id,
    enabled: canAccessAsAdmin && !isLocalMode,
  })

  useEffect(() => {
    const firstCoachUserId = directoryQuery.data?.coaches[0]?.userId
    if (!firstCoachUserId) return
    setSelectedCoachUserId((current) => current || firstCoachUserId)
  }, [directoryQuery.data])

  const ownQuery = useCoachData({
    workspaceId: user?.workspaceId,
    userId: user?.id,
    enabled: canAccessAsCoach && !isLocalMode,
  })
  const selectedCoachQuery = useCoachData({
    workspaceId: user?.workspaceId,
    userId: user?.id,
    coachUserId: selectedCoachUserId || null,
    enabled: canAccessAsAdmin && !isLocalMode && Boolean(selectedCoachUserId),
  })
  const dataQuery = canAccessAsCoach ? ownQuery : selectedCoachQuery
  const viewedCoachUserId = canAccessAsCoach ? user?.id : selectedCoachUserId

  if (isWorkspaceLoading || arePermissionsLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label={t('common.loading')}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!canAccessAsAdmin && !canAccessAsCoach) return <Redirect to="/" />

  const selectedCoachIsUnavailable = Boolean(
    canAccessAsAdmin
    && selectedCoachUserId
    && directoryQuery.data
    && !directoryQuery.data.coaches.some((coach) => coach.userId === selectedCoachUserId),
  )

  return (
    <div className="w-full space-y-6 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold sm:text-3xl">
          <UsersRound className="h-7 w-7 text-primary" />
          {t('commerceOperations.coachData.title')}
        </h1>
        <Badge variant="secondary" className="gap-1.5 px-3 py-1.5">
          <LockKeyhole className="h-4 w-4" />
          {t('commerceOperations.coachData.readOnly')}
        </Badge>
      </div>

      {canAccessAsAdmin && !isLocalMode ? (
        <Card>
          <CardContent className="space-y-3 p-4 sm:p-5">
            <Label htmlFor="coach-data-select">{t('commerceOperations.coachData.selectCoach')}</Label>
            <Select
              value={selectedCoachUserId || undefined}
              onValueChange={setSelectedCoachUserId}
              disabled={directoryQuery.isFetching && !directoryQuery.data || !directoryQuery.data?.coaches.length}
            >
              <SelectTrigger id="coach-data-select" className="w-full sm:max-w-xl">
                <SelectValue placeholder={t('commerceOperations.coachData.selectCoachPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {selectedCoachIsUnavailable ? (
                  <SelectItem value={selectedCoachUserId}>
                    {t('commerceOperations.coachData.unavailableCoach')}
                  </SelectItem>
                ) : null}
                {directoryQuery.data?.coaches.map((coach) => (
                  <SelectItem key={coach.userId} value={coach.userId}>
                    {coach.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {directoryQuery.isFetching && !directoryQuery.data ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('commerceOperations.coachData.loading')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!isLocalMode ? <ModulePageFreshness tableNames={COACH_DATA_PAGE_FRESHNESS_TABLES} /> : null}

      {isLocalMode ? (
        <InfoCard icon={UsersRound} text={t('commerceOperations.coachData.localUnavailable')} />
      ) : null}

      {canAccessAsAdmin && directoryQuery.error ? (
        <LoadError message={t('commerceOperations.coachData.loadFailed')} />
      ) : null}

      {canAccessAsAdmin && directoryQuery.data && !directoryQuery.data.coaches.length ? (
        <InfoCard icon={UserRound} text={t('commerceOperations.coachData.noCoachesAvailable')} />
      ) : null}

      {!isLocalMode && dataQuery.isFetching && !dataQuery.data ? (
        <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('commerceOperations.coachData.loading')}
        </div>
      ) : null}

      {!isLocalMode && dataQuery.error ? (
        <LoadError message={t('commerceOperations.coachData.loadFailed')} />
      ) : null}

      {dataQuery.data && !dataQuery.data.coach ? (
        <InfoCard icon={UserRound} text={t('commerceOperations.coachData.noLinkedCoach')} />
      ) : null}

      {dataQuery.data?.coach ? (
        <>
          <CoachSnapshotView snapshot={dataQuery.data} />
          {user?.workspaceId && user.id && viewedCoachUserId ? (
            <CoachRecentIntake
              workspaceId={user.workspaceId}
              viewerId={user.id}
              coachUserId={viewedCoachUserId}
              canOpenOrder={canAccessAsCoach || (canAccessAsAdmin && hasFeature('orders'))}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function CoachSnapshotView({ snapshot }: { snapshot: CoachDataSnapshot }) {
  const { t } = useTranslation()
  const tier = snapshot.tier

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <UserRound className="h-5 w-5 text-primary" />
            {t('commerceOperations.coachData.profile')}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('commerceOperations.coaches.coach')}</p>
            <p className="mt-1 break-words font-medium">{snapshot.coach?.name}</p>
          </div>
          {snapshot.coach?.phone ? (
            <div className="flex min-w-0 items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('commerceOperations.coachData.phone')}</p>
                <p className="mt-1 break-words">{snapshot.coach.phone}</p>
              </div>
            </div>
          ) : null}
          {snapshot.coach?.city ? (
            <div className="flex min-w-0 items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('commerceOperations.coachData.city')}</p>
                <p className="mt-1 break-words">{snapshot.coach.city}</p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {tier ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              icon={CalendarDays}
              title={t('commerceOperations.coachData.currentCycle')}
              value={formatCycleMonth(tier.cycleMonthStart)}
            />
            <SummaryCard
              icon={Award}
              title={t('commerceOperations.coachData.currentTier')}
              value={tier.currentTierName ?? t('commerceOperations.coachData.noTier')}
            />
            <SummaryCard
              icon={TrendingUp}
              title={t('commerceOperations.coachData.qualifyingSales')}
              value={tier.qualifyingSales.toLocaleString()}
            />
            <SummaryCard
              icon={CircleDollarSign}
              title={t('commerceOperations.coachData.commissionEarned')}
              value={formatCurrency(tier.commissionTotalIqd, 'iqd')}
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Award className="h-5 w-5 text-primary" />
                {t('commerceOperations.coachData.tierProgress')}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">{t('commerceOperations.coachData.program')}</p>
                <p className="mt-1 font-medium">{tier.programName ?? t('commerceOperations.coachData.noTier')}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('commerceOperations.coachData.currentTier')}</p>
                <p className="mt-1 font-medium">{tier.currentTierName ?? t('commerceOperations.coachData.noTier')}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('commerceOperations.coachData.nextTier')}</p>
                <p className="mt-1 font-medium">
                  {tier.nextTierName
                    ? t('commerceOperations.coachData.nextTierProgress', { name: tier.nextTierName, count: tier.salesToNextTier ?? 0 })
                    : tier.programName
                      ? t('commerceOperations.coachData.noNextTier')
                      : t('commerceOperations.coachData.noTier')}
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <InfoCard icon={Award} text={t('commerceOperations.coachData.noActiveTierCycle')} />
      )}
    </>
  )
}

function InfoCard({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p>{text}</p>
      </CardContent>
    </Card>
  )
}

function LoadError({ message }: { message: string }) {
  return <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{message}</div>
}

function SummaryCard({
  icon: Icon,
  title,
  value,
}: {
  icon: LucideIcon
  title: string
  value: string
}) {
  return (
    <Card>
      <CardContent className="flex min-w-0 items-start gap-3 p-4 sm:p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-1 break-words text-lg font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}
