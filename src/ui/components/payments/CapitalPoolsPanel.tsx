import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BadgeDollarSign,
  Coins,
  Landmark,
  Loader2,
  Pencil,
  Percent,
  Plus,
  ShieldCheck,
  Trash2,
  UsersRound
} from 'lucide-react'

import { useAuth } from '@/auth/AuthContext'
import {
  buildCapitalPoolBreakdown,
  deleteCapitalPool,
  saveCapitalPool,
  type CapitalPool,
  type CurrencyCode,
  type PaymentAccount,
  type PaymentAccountBalance,
  type PaymentAccountMovement,
  type PaymentTransaction
} from '@/local-db'
import { cn, formatCurrency } from '@/lib/utils'
import { useWorkspacePermissions } from '@/permissions'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  useToast,
} from '@/ui/components'
import { CurrencySelector } from '@/ui/components/CurrencySelector'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import {
  CapitalPoolTotalsComparison,
  SelectedCapitalPoolCharts
} from '@/ui/components/payments/CapitalPoolCharts'
import { PaymentAccountIcon } from '@/ui/components/payments/PaymentAccountIcon'

interface CapitalPoolsPanelProps {
  workspaceId: string
  pools: CapitalPool[]
  accounts: PaymentAccount[]
  balances: PaymentAccountBalance[]
  movements: PaymentAccountMovement[]
  transactions: PaymentTransaction[]
}

function getAccountBalance(
  balances: readonly PaymentAccountBalance[],
  accountId: string,
  currency: CurrencyCode
) {
  return balances.reduce(
    (sum, balance) =>
      !balance.isDeleted && balance.accountId === accountId && balance.currency === currency
        ? sum + Number(balance.balanceAmount || 0)
        : sum,
    0
  )
}

export function CapitalPoolsPanel({
  workspaceId,
  pools,
  accounts,
  balances,
  movements,
  transactions
}: CapitalPoolsPanelProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const canManage = user?.role === 'admin' || (
    user?.role === 'staff' && hasPermission('paymentAccounts.manageCapitalPools')
  )

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.isActive && !account.isDeleted),
    [accounts]
  )
  const enabledCurrencies = features.allowed_currencies
  const initialCurrency = enabledCurrencies.includes(features.default_currency)
    ? features.default_currency
    : (enabledCurrencies[0] ?? 'iqd')

  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingPool, setEditingPool] = useState<CapitalPool | null>(null)
  const [poolName, setPoolName] = useState('')
  const [poolCurrency, setPoolCurrency] = useState<CurrencyCode>(initialCurrency)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [pendingDeletion, setPendingDeletion] = useState<CapitalPool | null>(null)

  useEffect(() => {
    if (selectedPoolId && pools.some((pool) => pool.id === selectedPoolId)) return
    setSelectedPoolId(pools[0]?.id ?? null)
  }, [pools, selectedPoolId])

  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? null
  const selectedBreakdown = useMemo(
    () => selectedPool ? buildCapitalPoolBreakdown(selectedPool, accounts, balances) : null,
    [accounts, balances, selectedPool]
  )

  const draftBreakdown = useMemo(
    () => buildCapitalPoolBreakdown(
      { currency: poolCurrency, accountIds: selectedAccountIds },
      accounts,
      balances
    ),
    [accounts, balances, poolCurrency, selectedAccountIds]
  )

  const availableCurrencies = useMemo(() => {
    if (!editingPool || enabledCurrencies.includes(editingPool.currency)) return enabledCurrencies
    return [editingPool.currency, ...enabledCurrencies.filter((currency) => currency !== editingPool.currency)]
  }, [editingPool, enabledCurrencies])

  const duplicateName = pools.some(
    (pool) =>
      pool.id !== editingPool?.id &&
      pool.name.trim().toLocaleLowerCase() === poolName.trim().toLocaleLowerCase()
  )
  const selectedConflict = pools.find(
    (pool) =>
      pool.id !== editingPool?.id &&
      pool.currency === poolCurrency &&
      pool.accountIds.some((accountId) => selectedAccountIds.includes(accountId))
  )
  const currencyAllowed = poolCurrency === editingPool?.currency || enabledCurrencies.includes(poolCurrency)
  const canSubmit = Boolean(
    canManage &&
    poolName.trim() &&
    poolName.trim().length <= 120 &&
    selectedAccountIds.length >= 2 &&
    !duplicateName &&
    !selectedConflict &&
    currencyAllowed &&
    !saving
  )

  function openPoolDialog(pool?: CapitalPool) {
    if (!canManage) return
    setEditingPool(pool ?? null)
    setPoolName(pool?.name ?? '')
    setPoolCurrency(pool?.currency ?? initialCurrency)
    setSelectedAccountIds(pool?.accountIds ?? [])
    setDialogOpen(true)
  }

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId]
    )
  }

  async function handleSave() {
    if (!canSubmit || !user) return
    setSaving(true)
    try {
      const saved = await saveCapitalPool(workspaceId, {
        id: editingPool?.id,
        name: poolName,
        currency: poolCurrency,
        accountIds: selectedAccountIds,
        enabledCurrencies,
        createdBy: user.id,
        canManage
      })
      setSelectedPoolId(saved.id)
      setDialogOpen(false)
      toast({ title: t('paymentAccounts.capitalPools.saved') })
    } catch (error: unknown) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('paymentAccounts.capitalPools.errors.saveRejected'),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!pendingDeletion) return
    setSaving(true)
    try {
      await deleteCapitalPool(workspaceId, pendingDeletion.id, canManage)
      if (selectedPoolId === pendingDeletion.id) setSelectedPoolId(null)
      setPendingDeletion(null)
      toast({ title: t('paymentAccounts.capitalPools.deleted') })
    } catch (error: unknown) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('paymentAccounts.capitalPools.errors.deleteFailed'),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold tracking-tight">{t('paymentAccounts.capitalPools.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.capitalPools.subtitle')}</p>
        </div>
        {canManage ? (
          <Button type="button" onClick={() => openPoolDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            {t('paymentAccounts.capitalPools.newPool')}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground lg:self-auto">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('paymentAccounts.capitalPools.readOnly')}
          </span>
        )}
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border/60 pb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5 text-primary" />
                {t('paymentAccounts.capitalPools.poolList')}
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.capitalPools.poolListDescription')}</p>
            </div>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              {t('paymentAccounts.capitalPools.poolCount', { count: pools.length })}
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {pools.length === 0 ? (
            <div className="py-12 text-center">
              <Landmark className="mx-auto h-10 w-10 text-primary/70" />
              <h3 className="mt-4 text-lg font-semibold">{t('paymentAccounts.capitalPools.emptyTitle')}</h3>
              <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">{t('paymentAccounts.capitalPools.emptyDescription')}</p>
              {canManage ? (
                <Button type="button" variant="outline" className="mt-5" onClick={() => openPoolDialog()}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('paymentAccounts.capitalPools.newPool')}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {pools.map((pool) => {
                const breakdown = buildCapitalPoolBreakdown(pool, accounts, balances)
                const isSelected = selectedPoolId === pool.id
                return (
                  <button
                    key={pool.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedPoolId(pool.id)}
                    className={cn(
                      'rounded-2xl border bg-card p-5 text-start shadow-sm transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected && 'border-primary ring-1 ring-primary'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="rounded-xl bg-primary/10 p-2 text-primary"><Landmark className="h-5 w-5" /></span>
                      <span className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-bold uppercase">{pool.currency}</span>
                    </div>
                    <h3 className="mt-4 truncate font-bold">{pool.name}</h3>
                    <p className="mt-2 text-xl font-black tabular-nums">
                      {formatCurrency(breakdown.totalCapital, pool.currency, features.iqd_display_preference, 2)}
                    </p>
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <UsersRound className="h-3.5 w-3.5" />
                      {t('paymentAccounts.capitalPools.memberCount', { count: pool.accountIds.length })}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <CapitalPoolTotalsComparison
        pools={pools}
        accounts={accounts}
        balances={balances}
        iqdDisplayPreference={features.iqd_display_preference}
      />

      {selectedPool && selectedBreakdown ? (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border/60">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="rounded-xl bg-primary/10 p-2 text-primary"><BadgeDollarSign className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <CardTitle className="truncate">{selectedPool.name}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('paymentAccounts.capitalPools.liveBalanceDescription', { currency: selectedPool.currency.toUpperCase() })}
                  </p>
                </div>
              </div>
              {canManage ? (
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => openPoolDialog(selectedPool)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t('common.edit')}
                  </Button>
                  <Button type="button" variant="destructive" size="sm" onClick={() => setPendingDeletion(selectedPool)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('common.delete')}
                  </Button>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid gap-3 border-b border-border/60 bg-primary/[0.03] p-5 sm:grid-cols-2">
              <div className="rounded-2xl border bg-background/70 p-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Coins className="h-4 w-4 text-primary" />
                  {t('paymentAccounts.capitalPools.totalCapital')}
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">
                  {formatCurrency(selectedBreakdown.totalCapital, selectedPool.currency, features.iqd_display_preference, 2)}
                </p>
              </div>
              <div className="rounded-2xl border bg-background/70 p-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <UsersRound className="h-4 w-4 text-primary" />
                  {t('paymentAccounts.capitalPools.members')}
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums">{selectedBreakdown.members.length}</p>
              </div>
            </div>

            {selectedBreakdown.totalCapital === 0 ? (
              <p className="border-b border-border/60 px-5 py-4 text-sm font-medium text-muted-foreground">
                {t('paymentAccounts.capitalPools.noCapital')}
              </p>
            ) : null}

            <div className="divide-y divide-border/60">
              {selectedBreakdown.members.map((member) => {
                const account = accounts.find((item) => item.id === member.accountId)
                return (
                  <div key={member.accountId} className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                        <PaymentAccountIcon iconKey={account?.iconKey} accountType={account?.accountType} className="h-4 w-4" />
                      </span>
                      <span className="truncate font-semibold">{member.accountName}</span>
                    </div>
                    <span className="font-bold tabular-nums sm:text-end">
                      {formatCurrency(member.balanceAmount, selectedPool.currency, features.iqd_display_preference, 2)}
                    </span>
                    <span className="inline-flex min-w-20 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-sm font-bold tabular-nums text-primary sm:justify-end">
                      <Percent className="h-3.5 w-3.5" />
                      {member.sharePercent.toFixed(2)}%
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {selectedPool && selectedBreakdown ? (
        <SelectedCapitalPoolCharts
          pools={pools}
          accounts={accounts}
          selectedPool={selectedPool}
          breakdown={selectedBreakdown}
          movements={movements}
          transactions={transactions}
          iqdDisplayPreference={features.iqd_display_preference}
        />
      ) : null}

      <AppDialog open={dialogOpen} onOpenChange={(next) => !saving && setDialogOpen(next)}>
        <AppDialogContent
          className="max-w-3xl"
          showCloseButton={!saving}
          onPointerDownOutside={(event) => saving && event.preventDefault()}
          onEscapeKeyDown={(event) => saving && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>
              {editingPool ? t('paymentAccounts.capitalPools.editPool') : t('paymentAccounts.capitalPools.newPool')}
            </AppDialogTitle>
            <AppDialogDescription>{t('paymentAccounts.capitalPools.editorDescription')}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="capital-pool-name">{t('paymentAccounts.capitalPools.name')} *</Label>
                <Input
                  id="capital-pool-name"
                  value={poolName}
                  maxLength={120}
                  disabled={saving}
                  onChange={(event) => setPoolName(event.target.value)}
                />
                {duplicateName ? <p className="text-sm font-medium text-destructive">{t('paymentAccounts.capitalPools.errors.duplicateName')}</p> : null}
              </div>

              <CurrencySelector
                value={poolCurrency}
                onChange={setPoolCurrency}
                label={`${t('common.currency')} *`}
                iqdDisplayPreference={features.iqd_display_preference}
                allowedCurrencies={availableCurrencies}
                disabled={saving}
              />

              <section className="overflow-hidden rounded-2xl border border-border/60" aria-labelledby="capital-pool-accounts-label">
                <div className="border-b border-border/60 bg-muted/30 p-4">
                  <h3 id="capital-pool-accounts-label" className="flex items-center gap-2 font-semibold">
                    <UsersRound className="h-4 w-4 text-primary" />
                    {t('paymentAccounts.capitalPools.selectAccounts')} *
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.capitalPools.selectAccountsDescription')}</p>
                </div>
                <div className="max-h-72 divide-y divide-border/60 overflow-y-auto">
                  {activeAccounts.length === 0 ? (
                    <p className="p-5 text-center text-sm text-muted-foreground">{t('paymentAccounts.capitalPools.noActiveAccounts')}</p>
                  ) : activeAccounts.map((account) => {
                    const isSelected = selectedAccountIds.includes(account.id)
                    const conflictingPool = pools.find(
                      (pool) =>
                        pool.id !== editingPool?.id &&
                        pool.currency === poolCurrency &&
                        pool.accountIds.includes(account.id)
                    )
                    const cannotSelect = Boolean(conflictingPool && !isSelected)
                    const balance = getAccountBalance(balances, account.id, poolCurrency)
                    return (
                      <div key={account.id} className={cn('flex items-center gap-3 p-4', cannotSelect && 'opacity-60')}>
                        <Checkbox
                          id={`capital-pool-account-${account.id}`}
                          checked={isSelected}
                          disabled={saving || cannotSelect}
                          onCheckedChange={() => toggleAccount(account.id)}
                        />
                        <Label htmlFor={`capital-pool-account-${account.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <span className="rounded-lg bg-primary/10 p-2 text-primary">
                            <PaymentAccountIcon iconKey={account.iconKey} accountType={account.accountType} className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{account.name}</span>
                            {conflictingPool ? (
                              <span className="block truncate text-xs font-normal text-destructive">
                                {t('paymentAccounts.capitalPools.belongsToPool', { pool: conflictingPool.name })}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-sm font-bold tabular-nums">
                            {formatCurrency(balance, poolCurrency, features.iqd_display_preference, 2)}
                          </span>
                        </Label>
                      </div>
                    )
                  })}
                </div>
              </section>

              {selectedAccountIds.length < 2 ? (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t('paymentAccounts.capitalPools.errors.minimumAccounts')}
                </p>
              ) : null}
              {selectedConflict ? (
                <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">
                  {t('paymentAccounts.capitalPools.errors.accountConflict', {
                    account: activeAccounts.find((account) => selectedConflict.accountIds.includes(account.id) && selectedAccountIds.includes(account.id))?.name,
                    pool: selectedConflict.name
                  })}
                </p>
              ) : null}

              <div className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <Coins className="h-4 w-4 text-primary" />
                    {t('paymentAccounts.capitalPools.livePreview')}
                  </span>
                  <span className="text-lg font-black tabular-nums">
                    {formatCurrency(draftBreakdown.totalCapital, poolCurrency, features.iqd_display_preference, 2)}
                  </span>
                </div>
                {draftBreakdown.members.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {draftBreakdown.members.map((member) => (
                      <span key={member.accountId} className="rounded-full border bg-background px-2.5 py-1 text-xs font-semibold">
                        {member.accountName} · {member.sharePercent.toFixed(2)}%
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={!canSubmit} onClick={handleSave}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Landmark className="mr-2 h-4 w-4" />}
              {saving ? t('paymentAccounts.capitalPools.saving') : t('common.save')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={!!pendingDeletion}
        onClose={() => { if (!saving) setPendingDeletion(null) }}
        onConfirm={handleDelete}
        isLoading={saving}
        itemName={pendingDeletion?.name ?? ''}
        title={t('paymentAccounts.capitalPools.deleteTitle')}
        description={t('paymentAccounts.capitalPools.deleteDescription')}
      />
    </div>
  )
}
