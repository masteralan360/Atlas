import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  X,
  XCircle
} from 'lucide-react'

import {
  getPartnerSettlementBalanceSummaries,
  isAgentBusinessPartnerRole,
  useBusinessPartners,
  type BusinessPartner,
  type PartnerSettlementBalanceSummary
} from '@/local-db'
import { usePartnerAccountStatement } from '@/hooks/usePartnerAccountStatement'
import {
  getPartnerAccountStatementClosingBalances,
  type PartnerAccountStatementData,
  type PartnerAccountStatementClosingBalance
} from '@/lib/partnerAccountStatement'
import { cn, formatCurrency } from '@/lib/utils'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { useWorkspace } from '@/workspace'

const ALL_TIME_PERIOD = { type: 'allTime' } as const
const AMOUNT_EPSILON = 0.000001
const STATEMENT_STABILITY_DELAY_MS = 100

type CurrencyAudit = {
  currency: string
  collect: number
  pay: number
  netOpen: number
  statement: number
  difference: number
}

type PartnerAuditRow = {
  partnerId: string
  partnerName: string
  status: 'PASS' | 'WARNING'
  currencies: CurrencyAudit[]
}

function currencyTotal(
  balances: readonly PartnerAccountStatementClosingBalance[] | undefined,
  currency: string
) {
  return balances?.find((balance) => balance.currency.toLowerCase() === currency)?.closingBalance ?? 0
}

function buildPartnerAuditRow(
  partner: BusinessPartner,
  settlement: PartnerSettlementBalanceSummary | undefined,
  statementBalances: readonly PartnerAccountStatementClosingBalance[]
): PartnerAuditRow {
  const collectByCurrency = new Map(
    (settlement?.incoming.groups ?? []).map((group) => [group.currency.toLowerCase(), group.total])
  )
  const payByCurrency = new Map(
    (settlement?.outgoing.groups ?? []).map((group) => [group.currency.toLowerCase(), group.total])
  )
  const statementByCurrency = new Map(
    statementBalances.map((balance) => [balance.currency.toLowerCase(), balance.closingBalance])
  )
  const currencies = Array.from(new Set([
    ...collectByCurrency.keys(),
    ...payByCurrency.keys(),
    ...statementByCurrency.keys()
  ])).sort()

  const currencyRows = currencies.map((currency): CurrencyAudit => {
    const collect = collectByCurrency.get(currency) ?? 0
    const pay = payByCurrency.get(currency) ?? 0
    const netOpen = collect - pay
    const statement = currencyTotal(statementBalances, currency)
    return {
      currency,
      collect,
      pay,
      netOpen,
      statement,
      difference: statement - netOpen
    }
  })

  return {
    partnerId: partner.id,
    partnerName: partner.partnerName,
    status: currencyRows.some((row) => Math.abs(row.difference) > AMOUNT_EPSILON) ? 'WARNING' : 'PASS',
    currencies: currencyRows
  }
}

const statusClasses = {
  PASS: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
  WARNING: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300'
} as const

export function PartnerSettlementReconciliationAuditDialog({
  open,
  onOpenChange,
  workspaceId,
  includeSalesAgentCommissionPartners = false,
  eligibleAgentPartnerIds = []
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  includeSalesAgentCommissionPartners?: boolean
  eligibleAgentPartnerIds?: readonly string[]
}) {
  const { t } = useTranslation()
  const { features } = useWorkspace()
  const partners = useBusinessPartners(open ? workspaceId : undefined, {
    includeRealEstateRoles: true,
    includeAgentRoles: includeSalesAgentCommissionPartners
  })
  const eligibleAgentPartnerIdSet = useMemo(
    () => new Set(eligibleAgentPartnerIds),
    [eligibleAgentPartnerIds]
  )
  const [partnerSnapshot, setPartnerSnapshot] = useState<BusinessPartner[] | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [settlementSnapshot, setSettlementSnapshot] = useState<{
    key: string
    balances: Record<string, PartnerSettlementBalanceSummary>
  } | null>(null)
  const [rows, setRows] = useState<PartnerAuditRow[]>([])
  const [stableStatementData, setStableStatementData] = useState<PartnerAccountStatementData | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const summaryRequestKeyRef = useRef<string | null>(null)
  const processedPartnerIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPartnerSnapshot(null)
    setActiveIndex(0)
    setSettlementSnapshot(null)
    setRows([])
    setIsRunning(true)
    setCancelled(false)
    setErrorKey(null)
    summaryRequestKeyRef.current = null
    processedPartnerIdRef.current = null
  }, [open])

  useEffect(() => {
    if (!open || errorKey || partners.isLoading || partners.isHydrating || partnerSnapshot !== null) return
    if (partners.hydrationFailed) {
      setErrorKey('partnerSettlementAudit.counterpartiesLoadFailed')
      setIsRunning(false)
      return
    }
    setPartnerSnapshot(partners.filter((partner) => (
      !includeSalesAgentCommissionPartners
      || !isAgentBusinessPartnerRole(partner.role)
      || eligibleAgentPartnerIdSet.has(partner.id)
    )))
  }, [eligibleAgentPartnerIdSet, errorKey, includeSalesAgentCommissionPartners, open, partnerSnapshot, partners])

  const partnerSnapshotKey = useMemo(
    () => partnerSnapshot?.map((partner) => partner.id).join('|') ?? null,
    [partnerSnapshot]
  )

  const activePartner = partnerSnapshot?.[activeIndex] ?? null
  const {
    statementData,
    isStatementDataLoading,
    isRefreshing,
    refreshError
  } = usePartnerAccountStatement(
    workspaceId,
    open && isRunning ? activePartner?.id : undefined,
    ALL_TIME_PERIOD
  )

  useEffect(() => {
    if (!open || !isRunning || !refreshError) return
    setErrorKey('partnerSettlementAudit.statementLoadFailed')
    setIsRunning(false)
  }, [isRunning, open, refreshError])

  const settlementBalances = settlementSnapshot?.key === partnerSnapshotKey
    ? settlementSnapshot.balances
    : null

  useEffect(() => {
    setStableStatementData(null)
    if (
      !open
      || !isRunning
      || !activePartner
      || isRefreshing
      || isStatementDataLoading
      || !statementData
      || statementData.partnerId !== activePartner.id
    ) return

    // The source refresh can resolve just before Dexie's live queries publish
    // their refreshed rows. Restart this quiet period if the derived statement
    // changes, so the audit records the settled ledger rather than that stale
    // intermediate render.
    const timeout = setTimeout(() => setStableStatementData(statementData), STATEMENT_STABILITY_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [
    activePartner,
    isRefreshing,
    isRunning,
    isStatementDataLoading,
    open,
    statementData
  ])

  useEffect(() => {
    if (!open || !partnerSnapshot || partnerSnapshotKey === null || isRefreshing || refreshError) return
    if (summaryRequestKeyRef.current === partnerSnapshotKey) return

    summaryRequestKeyRef.current = partnerSnapshotKey
    if (partnerSnapshot.length === 0) {
      setSettlementSnapshot({ key: partnerSnapshotKey, balances: {} })
      return
    }

    let cancelledRequest = false
    void getPartnerSettlementBalanceSummaries(workspaceId, partnerSnapshot.map((partner) => partner.id))
      .then((balances) => {
        if (!cancelledRequest) setSettlementSnapshot({ key: partnerSnapshotKey, balances })
      })
      .catch(() => {
        if (!cancelledRequest) {
          setErrorKey('partnerSettlementAudit.loadFailed')
          setIsRunning(false)
        }
      })

    return () => {
      cancelledRequest = true
    }
  }, [isRefreshing, open, partnerSnapshot, partnerSnapshotKey, refreshError, workspaceId])

  useEffect(() => {
    if (!open || !isRunning || !partnerSnapshot || !settlementBalances || errorKey) return
    if (activeIndex >= partnerSnapshot.length) {
      setIsRunning(false)
      return
    }
    if (
      !activePartner
      || isRefreshing
      || isStatementDataLoading
      || !statementData
      || stableStatementData !== statementData
      || statementData.partnerId !== activePartner.id
    ) return
    if (processedPartnerIdRef.current === activePartner.id) return

    const settlement = settlementBalances[activePartner.id]
    if (!settlement) {
      setErrorKey('partnerSettlementAudit.loadFailed')
      setIsRunning(false)
      return
    }

    processedPartnerIdRef.current = activePartner.id
    const statementBalances = getPartnerAccountStatementClosingBalances(statementData)
    const row = buildPartnerAuditRow(activePartner, settlement, statementBalances)
    setRows((current) => [...current, row])
    setActiveIndex((current) => current + 1)
  }, [
    activeIndex,
    activePartner,
    errorKey,
    isRefreshing,
    isStatementDataLoading,
    isRunning,
    open,
    partnerSnapshot,
    settlementBalances,
    stableStatementData,
    statementData
  ])

  function cancelAudit() {
    if (!isRunning) return
    setCancelled(true)
    setIsRunning(false)
  }

  const matchedCount = rows.filter((row) => row.status === 'PASS').length
  const mismatchCount = rows.filter((row) => row.status === 'WARNING').length
  const totalPartners = partnerSnapshot?.length ?? 0
  const currentPartnerName = activePartner?.partnerName

  return (
    <AppDialog open={open} onOpenChange={(next) => { if (!isRunning) onOpenChange(next) }}>
      <AppDialogContent
        className="max-w-5xl"
        showCloseButton={!isRunning}
        onEscapeKeyDown={(event) => { if (isRunning) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (isRunning) event.preventDefault() }}
      >
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
            {t('partnerSettlementAudit.title')}
          </AppDialogTitle>
        </AppDialogHeader>

        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('partnerSettlementAudit.description')}</p>

          {isRunning && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {partnerSnapshot === null
                ? t('partnerSettlementAudit.loadingCounterparties')
                : settlementBalances === null
                  ? t('partnerSettlementAudit.loadingSettlementBalances')
                  : isRefreshing || isStatementDataLoading || stableStatementData !== statementData
                    ? t('partnerSettlementAudit.loadingStatement')
                    : t('partnerSettlementAudit.progress', {
                      completed: rows.length,
                      total: totalPartners,
                      partner: currentPartnerName ?? ''
                    })}
            </div>
          )}

          {cancelled && (
            <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
              {t('partnerSettlementAudit.cancelled', { count: rows.length })}
            </p>
          )}

          {errorKey && (
            <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
              {t(errorKey)}
            </p>
          )}

          {rows.length > 0 && (
            <div className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 font-semibold">
                {mismatchCount === 0
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  : <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />}
                {t('partnerSettlementAudit.summary', {
                  matched: matchedCount,
                  mismatched: mismatchCount,
                  total: rows.length
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('partnerSettlementAudit.netExplanation')}</p>
            </div>
          )}

          {partnerSnapshot?.length === 0 && !isRunning && !errorKey && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('partnerSettlementAudit.empty')}
            </div>
          )}

          {rows.length > 0 && (
            <div role="list" aria-label={t('partnerSettlementAudit.results')} className="space-y-2">
              {rows.map((row) => (
                <details
                  key={row.partnerId}
                  role="listitem"
                  className={cn('rounded-lg border px-3 py-2.5', statusClasses[row.status])}
                  open={row.status === 'WARNING' || undefined}
                >
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      {row.status === 'WARNING'
                        ? <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                        : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      <span className="truncate">{row.partnerName}</span>
                      <span className="sr-only">{t(`partnerSettlementAudit.status.${row.status}`)}</span>
                    </span>
                    <span className="text-sm tabular-nums">
                      {row.status === 'WARNING'
                        ? t('partnerSettlementAudit.status.mismatch')
                        : t('partnerSettlementAudit.status.matched')}
                    </span>
                  </summary>
                  {row.currencies.length > 0 ? (
                    <div className="mt-3 overflow-x-auto rounded-md border border-current/10 bg-background/70">
                      <table className="w-full min-w-[760px] text-start text-xs sm:text-sm">
                        <thead className="bg-muted/50 text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">{t('partnerSettlementAudit.currency')}</th>
                            <th className="px-3 py-2 text-end font-medium"><span className="inline-flex items-center gap-1"><ArrowDownLeft className="h-3.5 w-3.5" />{t('partnerSettlement.collect')}</span></th>
                            <th className="px-3 py-2 text-end font-medium"><span className="inline-flex items-center gap-1"><ArrowUpRight className="h-3.5 w-3.5" />{t('partnerSettlement.pay')}</span></th>
                            <th className="px-3 py-2 text-end font-medium">{t('partnerSettlementAudit.netOpen')}</th>
                            <th className="px-3 py-2 text-end font-medium">{t('partnerSettlementAudit.statementBalance')}</th>
                            <th className="px-3 py-2 text-end font-medium">{t('partnerSettlementAudit.difference')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.currencies.map((currency) => (
                            <tr key={currency.currency} className="border-t border-current/10">
                              <td className="px-3 py-2 font-semibold uppercase">{currency.currency}</td>
                              <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(currency.collect, currency.currency, features.iqd_display_preference)}</td>
                              <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(currency.pay, currency.currency, features.iqd_display_preference)}</td>
                              <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(currency.netOpen, currency.currency, features.iqd_display_preference)}</td>
                              <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(currency.statement, currency.currency, features.iqd_display_preference)}</td>
                              <td className={cn('px-3 py-2 text-end font-semibold tabular-nums', Math.abs(currency.difference) > AMOUNT_EPSILON && 'text-destructive')}>
                                {formatCurrency(currency.difference, currency.currency, features.iqd_display_preference)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">{t('partnerSettlementAudit.noBalances')}</p>
                  )}
                </details>
              ))}
            </div>
          )}
        </AppDialogBody>

        <AppDialogFooter>
          {isRunning && (
            <Button type="button" variant="outline" onClick={cancelAudit}>
              <X className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('partnerSettlementAudit.cancel')}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={isRunning} onClick={() => onOpenChange(false)}>
            {t('transactionAudit.close')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
