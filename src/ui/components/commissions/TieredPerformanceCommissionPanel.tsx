import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Coins,
  History,
  Loader2,
  Pencil,
  Plus,
  TrendingUp,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/query/queryKeys'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { formatCurrency } from '@/lib/utils'
import { AppPagination } from '@/ui/components/AppPagination'
import { useToast } from '@/ui/components/use-toast'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from '@/ui/components/dialog'
import { Badge } from '@/ui/components/ui/badge'
import { Button } from '@/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Checkbox } from '@/ui/components/checkbox'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { Switch } from '@/ui/components/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'
import { Textarea } from '@/ui/components/textarea'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import {
  saveTieredCommissionProgram,
  settleAndActivateTieredCommissionMonth,
  TIERED_COMMISSION_FRESHNESS_TABLES,
  useTieredCommissionDashboard,
  type TieredCommissionProgram,
  type TieredCommissionTier,
} from '@/local-db/tieredPerformanceCommissions'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'

type TierDraft = { id?: string; name: string; minimumSales: string }
type ProgramDraft = {
  id?: string
  name: string
  description: string
  isActive: boolean
  tiers: TierDraft[]
  agentIds: string[]
}

function freshProgramDraft(): ProgramDraft {
  return { name: '', description: '', isActive: true, tiers: [{ name: '', minimumSales: '0' }], agentIds: [] }
}

function readSavedPageSize() {
  try {
    const saved = Number(window.localStorage.getItem('tiered_commission_entries_page_size'))
    return [10, 20, 50, 100].includes(saved) ? saved : 20
  } catch {
    return 20
  }
}

function savePageSize(pageSize: number) {
  try { window.localStorage.setItem('tiered_commission_entries_page_size', String(pageSize)) } catch { /* storage can be unavailable */ }
}

function tierRangeLabel(tier: TieredCommissionTier, nextTier: TieredCommissionTier | undefined, t: (key: string, options?: Record<string, unknown>) => string) {
  const end = nextTier ? nextTier.minimumSales - 1 : null
  if (end === null) return t('salesAgentCommissions.tiered.unlimitedRange', { minimum: tier.minimumSales.toLocaleString() })
  return `${tier.minimumSales.toLocaleString()}–${end.toLocaleString()}`
}

export function TieredPerformanceCommissionPanel({
  workspaceId,
  userId,
  iqdPreference,
  canManage,
  canSettle,
}: {
  workspaceId: string
  userId?: string
  iqdPreference: 'IQD' | 'د.ع'
  canManage: boolean
  canSettle: boolean
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const pagination = usePaginationState({
    initialPageSize: readSavedPageSize(),
    resetOn: [selectedMonth],
    onPageSizeChange: savePageSize,
  })
  const query = useTieredCommissionDashboard({
    workspaceId,
    monthStart: selectedMonth,
    page: pagination.currentPage,
    pageSize: pagination.pageSize,
    userId,
    enabled: true,
  })
  const { data } = query
  const lastEntryCountRef = useRef(0)
  if (data && !query.isFetching) lastEntryCountRef.current = data.entryCount
  const pageBounds = usePaginationBounds({
    currentPage: pagination.currentPage,
    setCurrentPage: pagination.setCurrentPage,
    totalCount: data?.entryCount,
    pageSize: pagination.pageSize,
    isLoading: query.isFetching,
    error: query.error,
  })
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProgram, setEditingProgram] = useState<TieredCommissionProgram | null>(null)
  const [isSavingProgram, setIsSavingProgram] = useState(false)
  const [isSettling, setIsSettling] = useState(false)

  const activeCycle = useMemo(() => data?.cycles.find((cycle) => cycle.status === 'active') ?? null, [data?.cycles])
  const activeMonth = activeCycle?.monthStart ?? null
  const canSettleThisCycle = Boolean(activeCycle && activeMonth && activeMonth < currentWorkspaceMonth(activeCycle.timeZone))
  const agentNameById = useMemo(() => new Map(data?.agents.map((agent) => [agent.id, agent.name]) ?? []), [data?.agents])
  const entryTotal = data?.entryCount ?? lastEntryCountRef.current
  const isHistoryView = Boolean(selectedMonth && selectedMonth !== activeMonth)

  const invalidateTieredData = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.tieredPerformanceCommissions.all(workspaceId) })
  }

  const openNewProgram = () => {
    setEditingProgram(null)
    setEditorOpen(true)
  }

  const openProgramEditor = (program: TieredCommissionProgram) => {
    setEditingProgram(program)
    setEditorOpen(true)
  }

  const saveProgram = async (draft: ProgramDraft) => {
    setIsSavingProgram(true)
    try {
      await saveTieredCommissionProgram(workspaceId, {
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description,
        isActive: draft.isActive,
        tiers: draft.tiers.map((tier, index) => ({
          ...(tier.id ? { id: tier.id } : {}),
          name: tier.name.trim(),
          position: index + 1,
          minimumSales: Number(tier.minimumSales.replace(/,/g, '')),
        })),
        agentIds: draft.agentIds,
      })
      await invalidateTieredData()
      toast({ title: t('salesAgentCommissions.tiered.programSaved') })
      setEditorOpen(false)
      setEditingProgram(null)
    } catch {
      toast({ title: t('common.error'), description: t('salesAgentCommissions.tiered.saveFailed'), variant: 'destructive' })
    } finally {
      setIsSavingProgram(false)
    }
  }

  const settleMonth = async () => {
    if (!activeCycle || !canSettle || !canSettleThisCycle || isSettling) return
    setIsSettling(true)
    try {
      const result = await settleAndActivateTieredCommissionMonth(workspaceId, activeCycle.id)
      setSelectedMonth(null)
      pagination.resetPage()
      await invalidateTieredData()
      toast({
        title: t('salesAgentCommissions.tiered.settlementComplete'),
        description: t('salesAgentCommissions.tiered.deferredSalesProcessed', { count: result.deferredSalesProcessed }),
      })
    } catch {
      toast({ title: t('common.error'), description: t('salesAgentCommissions.tiered.settlementFailed'), variant: 'destructive' })
    } finally {
      setIsSettling(false)
    }
  }

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><TrendingUp className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold">{t('salesAgentCommissions.tiered.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.description')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModulePageFreshness className="shrink-0" tableNames={TIERED_COMMISSION_FRESHNESS_TABLES} />
          {canManage ? <Button type="button" className="gap-2" onClick={openNewProgram}><Plus className="h-4 w-4" />{t('salesAgentCommissions.tiered.newProgram')}</Button> : null}
        </div>
      </div>

      {query.isFetching && !data ? <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{t('salesAgentCommissions.tiered.loading')}</div> : null}
      {query.error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{t('salesAgentCommissions.tiered.loadFailed')}</div> : null}

      {!data && (query.isFetching || query.error) ? (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" />{t('salesAgentCommissions.tiered.monthlyRecords')}</CardTitle>
            <AppPagination
              currentPage={pageBounds.currentPage}
              totalCount={entryTotal}
              pageCount={pageBounds.pageCount}
              pageSize={pagination.pageSize}
              onPageChange={pagination.setCurrentPage}
              onPageSizeChange={pagination.setPageSize}
              pageSizeOptions={[10, 20, 50, 100]}
            />
          </CardHeader>
          {query.isFetching ? <CardContent><div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('salesAgentCommissions.tiered.loading')}</div></CardContent> : null}
        </Card>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={CalendarDays} title={t('salesAgentCommissions.tiered.activeCycle')} value={activeCycle ? formatMonth(activeCycle.monthStart) : t('salesAgentCommissions.tiered.noCycle')} />
            <Metric icon={UsersRound} title={t('salesAgentCommissions.tiered.assignedAgents')} value={String(data.agents.length)} />
            <Metric icon={Coins} title={t('salesAgentCommissions.tiered.totalQualifyingSales')} value={String(data.agents.reduce((sum, agent) => sum + agent.qualifyingSales, 0).toLocaleString())} />
            <Metric icon={Clock3} title={t('salesAgentCommissions.tiered.pendingSales')} value={String(data.pendingSales.toLocaleString())} />
          </div>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-primary" />{t('salesAgentCommissions.tiered.performance')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.performanceDescription')}</p>
              </div>
              {data.cycles.length ? (
                <div className="w-full sm:w-56">
                  <Select value={selectedMonth ?? 'active'} onValueChange={(value) => setSelectedMonth(value === 'active' ? null : value)}>
                    <SelectTrigger aria-label={t('salesAgentCommissions.tiered.selectMonth')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {activeCycle ? <SelectItem value="active">{t('salesAgentCommissions.tiered.activeLabel', { month: formatMonth(activeCycle.monthStart) })}</SelectItem> : null}
                      {data.cycles.filter((cycle) => cycle.status === 'settled').map((cycle) => (
                        <SelectItem key={cycle.id} value={cycle.monthStart}>{formatMonth(cycle.monthStart)} · {t('salesAgentCommissions.tiered.settled')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {!data.agents.length ? <Empty icon={UsersRound} message={t('salesAgentCommissions.tiered.noAssignedAgents')} /> : (
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>{t('salesAgentCommissions.tiered.agent')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.program')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.currentTier')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.qualifyingSales')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.nextTier')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.salesToNextTier')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.commissionTotal')}</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {data.agents.map((agent) => (
                        <TableRow key={agent.id}>
                          <TableCell className="font-semibold">{agent.name}</TableCell>
                          <TableCell>{agent.programName || '—'}</TableCell>
                          <TableCell><Badge variant="outline" className="gap-1"><TrendingUp className="h-3 w-3" />{agent.currentTierName || '—'}</Badge></TableCell>
                          <TableCell className="text-end font-semibold">{agent.qualifyingSales.toLocaleString()}</TableCell>
                          <TableCell>{agent.nextTierName || t('salesAgentCommissions.tiered.topTier')}</TableCell>
                          <TableCell className="text-end">{agent.salesToNextTier == null ? '—' : agent.salesToNextTier.toLocaleString()}</TableCell>
                          <TableCell className="text-end font-bold">{formatCurrency(agent.commissionTotalIqd, 'iqd', iqdPreference)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><BadgeCheck className="h-5 w-5 text-primary" />{t('salesAgentCommissions.tiered.programs')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.programsDescription')}</p>
            </CardHeader>
            <CardContent>
              {!data.programs.length ? <Empty icon={TrendingUp} message={t('salesAgentCommissions.tiered.noPrograms')} /> : (
                <div className="grid gap-3 xl:grid-cols-2">
                  {data.programs.map((program) => (
                    <div key={program.id} className="rounded-xl border bg-card p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-bold">{program.name}</h3>
                            <Badge variant={program.isActive ? 'default' : 'secondary'}>{t(program.isActive ? 'salesAgentCommissions.tiered.active' : 'salesAgentCommissions.tiered.inactive')}</Badge>
                          </div>
                          {program.description ? <p className="mt-1 text-sm text-muted-foreground">{program.description}</p> : null}
                        </div>
                        {canManage ? <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => openProgramEditor(program)}><Pencil className="h-3.5 w-3.5" />{t('common.edit')}</Button> : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {program.tiers.map((tier, index) => (
                          <Badge key={tier.id} variant="outline" className="gap-1.5 px-2.5 py-1">
                            <span className="font-semibold">{tier.name}</span>
                            <span className="text-muted-foreground">{tierRangeLabel(tier, program.tiers[index + 1], t)}</span>
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><UsersRound className="h-3.5 w-3.5" />{t('salesAgentCommissions.tiered.assignedCount', { count: program.agentIds?.length ?? 0 })}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" />{t('salesAgentCommissions.tiered.monthlyRecords')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t(isHistoryView ? 'salesAgentCommissions.tiered.historicalDescription' : 'salesAgentCommissions.tiered.recordsDescription')}</p>
              </div>
              <AppPagination
                currentPage={pageBounds.currentPage}
                totalCount={entryTotal}
                pageCount={pageBounds.pageCount}
                pageSize={pagination.pageSize}
                onPageChange={pagination.setCurrentPage}
                onPageSizeChange={pagination.setPageSize}
                pageSizeOptions={[10, 20, 50, 100]}
              />
            </CardHeader>
            <CardContent className="space-y-4">
              {data.cycle?.status === 'settled' ? <Badge variant="secondary" className="gap-1"><BadgeCheck className="h-3.5 w-3.5" />{t('salesAgentCommissions.tiered.settled')}</Badge> : null}
              {query.isFetching ? <div role="status" className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('salesAgentCommissions.tiered.loading')}</div> : !data.entries.length ? (
                <Empty icon={History} message={t('salesAgentCommissions.tiered.noRecords')} />
              ) : (
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>{t('salesAgentCommissions.tiered.date')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.agent')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.product')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.tier')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.quantity')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.recordStatus')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.amount')}</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {data.entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="whitespace-nowrap">{formatDate(entry.occurredAt)}</TableCell>
                          <TableCell>{agentNameById.get(entry.agentId) || '—'}</TableCell>
                          <TableCell><div className="font-medium">{entry.productName}</div>{entry.productSku ? <div className="text-xs text-muted-foreground">{entry.productSku}</div> : null}</TableCell>
                          <TableCell><div>{entry.tierName}</div><div className="text-xs text-muted-foreground">{entry.programName}</div></TableCell>
                          <TableCell className="text-end">{Math.abs(entry.quantity).toLocaleString()}</TableCell>
                          <TableCell><Badge variant={entry.status === 'correction_pending' ? 'destructive' : entry.status === 'settled' ? 'secondary' : 'outline'}>{t(`salesAgentCommissions.tiered.status.${entry.status}`)}</Badge>{entry.kind === 'reversal' || entry.kind === 'reinstatement' ? <div className="mt-1 text-xs text-muted-foreground">{t(`salesAgentCommissions.tiered.${entry.kind}`)}</div> : null}</TableCell>
                          <TableCell className={`text-end font-bold ${entry.amountIqd < 0 ? 'text-destructive' : ''}`}>{formatCurrency(entry.amountIqd, 'iqd', iqdPreference)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {data.audit.length ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-amber-600" />{t('salesAgentCommissions.tiered.audit')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {data.audit.map((item, index) => <div key={`${item.eventType}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"><span>{t(`salesAgentCommissions.tiered.auditEvents.${item.eventType}`, { defaultValue: t('salesAgentCommissions.tiered.auditFallback') })}</span><span className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</span></div>)}
              </CardContent>
            </Card>
          ) : null}

          {canSettle && activeCycle && !isHistoryView ? (
            <Card className="border-primary/30 bg-primary/[0.025]">
              <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><CircleDollarSign className="h-5 w-5" /></span>
                  <div><p className="font-semibold">{t('salesAgentCommissions.tiered.settlementTitle', { month: formatMonth(activeCycle.monthStart) })}</p><p className="text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.settlementDescription')}</p></div>
                </div>
                <Button type="button" disabled={!canSettleThisCycle || isSettling} onClick={() => void settleMonth()} className="shrink-0 gap-2">
                  {isSettling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />}
                  {t('salesAgentCommissions.tiered.settleAndActivate')}
                </Button>
                {!canSettleThisCycle ? <p className="text-xs text-muted-foreground sm:max-w-44">{t('salesAgentCommissions.tiered.settlementAvailableAfterMonth')}</p> : null}
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      <ProgramEditorDialog
        open={editorOpen}
        existing={editingProgram}
        eligibleAgents={data?.eligibleAgents ?? []}
        saving={isSavingProgram}
        onOpenChange={(open) => { if (!isSavingProgram) setEditorOpen(open) }}
        onSave={saveProgram}
      />
    </div>
  )
}

function ProgramEditorDialog({
  open,
  existing,
  eligibleAgents,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean
  existing: TieredCommissionProgram | null
  eligibleAgents: Array<{ id: string; name: string; isEligible: boolean }>
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: ProgramDraft) => Promise<void>
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ProgramDraft>(freshProgramDraft)
  const [attempted, setAttempted] = useState(false)
  const [tierIndexToRemove, setTierIndexToRemove] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(existing ? {
      id: existing.id,
      name: existing.name,
      description: existing.description || '',
      isActive: existing.isActive,
      tiers: existing.tiers.map((tier) => ({ id: tier.id, name: tier.name, minimumSales: String(tier.minimumSales) })),
      agentIds: existing.agentIds ?? [],
    } : freshProgramDraft())
    setAttempted(false)
  }, [existing, open])

  const parseMinimum = (value: string) => value.trim() === '' ? Number.NaN : Number(value.replace(/,/g, ''))
  const tiersValid = draft.tiers.length > 0
    && draft.tiers.every((tier, index) => {
      const minimum = parseMinimum(tier.minimumSales)
      const previousMinimum = index > 0 ? parseMinimum(draft.tiers[index - 1].minimumSales) : null
      return Boolean(tier.name.trim()) && Number.isSafeInteger(minimum) && minimum >= 0
        && (index === 0 ? minimum === 0 : minimum > (previousMinimum ?? Number.POSITIVE_INFINITY))
    })
  const valid = Boolean(draft.name.trim() && tiersValid)
  const nextTierMinimum = (index: number) => draft.tiers[index + 1] ? parseMinimum(draft.tiers[index + 1].minimumSales) : null

  const updateTier = (index: number, changes: Partial<TierDraft>) => setDraft((current) => ({
    ...current,
    tiers: current.tiers.map((tier, tierIndex) => tierIndex === index ? { ...tier, ...changes } : tier),
  }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (!valid || saving) return
    void onSave(draft)
  }

  return (
    <AppDialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent className="max-w-3xl">
        <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-primary" />{t(existing ? 'salesAgentCommissions.tiered.editProgram' : 'salesAgentCommissions.tiered.newProgram')}</AppDialogTitle></AppDialogHeader>
        <form onSubmit={submit}>
          <AppDialogBody>
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="tiered-program-name">{t('salesAgentCommissions.tiered.programName')} *</Label><Input id="tiered-program-name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={saving} required />{attempted && !draft.name.trim() ? <p className="text-xs text-destructive">{t('salesAgentCommissions.tiered.nameRequired')}</p> : null}</div>
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3"><div><Label htmlFor="tiered-program-active">{t('salesAgentCommissions.tiered.programActive')}</Label><p className="text-xs text-muted-foreground">{t('salesAgentCommissions.tiered.programStatusHint')}</p></div><Switch id="tiered-program-active" checked={draft.isActive} onCheckedChange={(isActive) => setDraft((current) => ({ ...current, isActive }))} disabled={saving} /></div>
                <div className="space-y-2 sm:col-span-2"><Label htmlFor="tiered-program-description">{t('salesAgentCommissions.tiered.programDescription')}</Label><Textarea id="tiered-program-description" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} disabled={saving} rows={2} /></div>
              </div>

              <section className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="flex items-center gap-2 font-semibold"><TrendingUp className="h-4 w-4 text-primary" />{t('salesAgentCommissions.tiered.tierConfiguration')}</h3><p className="text-xs text-muted-foreground">{t('salesAgentCommissions.tiered.tierConfigurationHint')}</p></div><Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setDraft((current) => ({ ...current, tiers: [...current.tiers, { name: '', minimumSales: String((parseMinimum(current.tiers.at(-1)?.minimumSales ?? '0') || 0) + 1) }] }))} disabled={saving}><Plus className="h-3.5 w-3.5" />{t('salesAgentCommissions.tiered.addTier')}</Button></div>
                {draft.tiers.map((tier, index) => (
                  <div key={tier.id || `new-${index}`} className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(120px,0.7fr)_minmax(120px,0.7fr)_auto] sm:items-end">
                    <div className="space-y-2"><Label htmlFor={`tier-name-${index}`}>{t('salesAgentCommissions.tiered.tierName')} *</Label><Input id={`tier-name-${index}`} value={tier.name} onChange={(event) => updateTier(index, { name: event.target.value })} disabled={saving} required /></div>
                    <div className="space-y-2"><Label htmlFor={`tier-minimum-${index}`}>{t('salesAgentCommissions.tiered.minimumSales')} *</Label><Input id={`tier-minimum-${index}`} type="text" inputMode="numeric" placeholder="0" value={tier.minimumSales} onChange={(event) => updateTier(index, { minimumSales: event.target.value.replace(/[^\d,]/g, '') })} onBlur={() => {
                      const minimum = parseMinimum(tier.minimumSales)
                      if (Number.isSafeInteger(minimum) && minimum >= 0) updateTier(index, { minimumSales: minimum.toLocaleString('en-US') })
                    }} disabled={saving} required /></div>
                    <div className="space-y-2"><Label>{t('salesAgentCommissions.tiered.maximumSales')}</Label><div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">{nextTierMinimum(index) === null ? t('salesAgentCommissions.tiered.unlimited') : Number.isSafeInteger(nextTierMinimum(index)) ? Math.max(0, nextTierMinimum(index)! - 1).toLocaleString() : '—'}</div></div>
                    <Button type="button" size="icon" variant="ghost" aria-label={t('salesAgentCommissions.tiered.removeTier')} disabled={saving || draft.tiers.length === 1} onClick={() => setTierIndexToRemove(index)}><X className="h-4 w-4" /></Button>
                  </div>
                ))}
                {attempted && !tiersValid ? <p className="text-sm text-destructive">{t('salesAgentCommissions.tiered.tiersInvalid')}</p> : null}
              </section>

              <section className="space-y-3">
                <div><h3 className="flex items-center gap-2 font-semibold"><UsersRound className="h-4 w-4 text-primary" />{t('salesAgentCommissions.tiered.assignAgents')}</h3><p className="text-xs text-muted-foreground">{t('salesAgentCommissions.tiered.assignAgentsHint')}</p></div>
                {eligibleAgents.length ? <div className="grid max-h-52 gap-2 overflow-y-auto rounded-xl border p-3 sm:grid-cols-2">{eligibleAgents.map((agent) => {
                  const isAssigned = draft.agentIds.includes(agent.id)
                  return <label key={agent.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted/50"><Checkbox checked={isAssigned} onCheckedChange={(checked) => setDraft((current) => ({ ...current, agentIds: checked ? [...new Set([...current.agentIds, agent.id])] : current.agentIds.filter((id) => id !== agent.id) }))} disabled={saving || (!agent.isEligible && !isAssigned)} /><span className="min-w-0 flex-1 truncate">{agent.name}</span>{!agent.isEligible ? <Badge variant="secondary">{t('salesAgentCommissions.tiered.unavailableAgent')}</Badge> : null}</label>
                })}</div> : <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.noEligibleAgents')}</p>}
              </section>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!valid || saving} className="gap-2">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : existing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{t(saving ? 'salesAgentCommissions.tiered.saving' : 'common.save')}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
      <DeleteConfirmationModal
        isOpen={tierIndexToRemove !== null}
        onClose={() => { if (!saving) setTierIndexToRemove(null) }}
        isLoading={saving}
        onConfirm={() => {
          if (tierIndexToRemove !== null) setDraft((current) => ({ ...current, tiers: current.tiers.filter((_, index) => index !== tierIndexToRemove) }))
          setTierIndexToRemove(null)
        }}
        itemName={tierIndexToRemove === null ? '' : draft.tiers[tierIndexToRemove]?.name}
        simpleConfirmation
        confirmLabel={t('salesAgentCommissions.tiered.removeTier')}
        title={t('salesAgentCommissions.tiered.confirmRemoveTier')}
        description={t('salesAgentCommissions.tiered.confirmRemoveTierDescription')}
      />
    </AppDialog>
  )
}

function Metric({ icon: Icon, title, value }: { icon: LucideIcon; title: string; value: string }) {
  return <Card><CardContent className="flex items-center gap-3 p-4"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span><div className="min-w-0"><p className="text-xs font-semibold text-muted-foreground">{title}</p><p className="truncate text-lg font-bold">{value}</p></div></CardContent></Card>
}

function Empty({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground"><Icon className="h-5 w-5" />{message}</div>
}

function currentWorkspaceMonth(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  return `${year}-${month}-01`
}

function formatMonth(monthStart: string) {
  const [year, month, day = '01'] = monthStart.slice(0, 10).split('-')
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(Number(year), Number(month) - 1, Number(day)))
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
