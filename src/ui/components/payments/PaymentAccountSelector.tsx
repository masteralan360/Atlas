import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'

import { usePaymentAccountBalancesState, usePaymentAccountsState, type PaymentAccount } from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import { Label } from '@/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { useWorkspace } from '@/workspace'
import { PaymentAccountIcon } from './PaymentAccountIcon'
import { resolvePaymentAccountEffectiveValue, resolvePaymentAccountSelection } from './paymentAccountSelection'

interface PaymentAccountSelectorProps {
  workspaceId?: string
  value?: string | null
  onValueChange: (account: PaymentAccount | null) => void
  disabled?: boolean
  label?: string
  cashDrawerOnly?: boolean
  /** Use false when an owning workflow requires a real payment account. */
  allowNoAccount?: boolean
  /** Payment forms can opt into their workspace's preselected account. */
  applyDefault?: boolean
  placeholder?: string
  /** Marks the account used by the original transaction in reversal workflows. */
  originAccountId?: string | null
}

/** Optional by design: leaving it empty preserves a normal ledger payment. */
export function PaymentAccountSelector({
  workspaceId,
  value,
  onValueChange,
  disabled = false,
  label,
  cashDrawerOnly = false,
  allowNoAccount = true,
  applyDefault = true,
  placeholder,
  originAccountId,
}: PaymentAccountSelectorProps) {
  const { t } = useTranslation()
  const { features } = useWorkspace()
  const { accounts, isReady: areAccountsReady } = usePaymentAccountsState(workspaceId)
  // Balance data is deliberately non-blocking. The account/preselection state
  // determines when the selector is ready; balances enrich it afterward.
  const { balances, isReady: areBalancesReady } = usePaymentAccountBalancesState(workspaceId)
  const options = useMemo(
    () => accounts.filter((account) => account.isActive && (!cashDrawerOnly || account.accountType === 'cash_drawer')),
    [accounts, cashDrawerOnly],
  )
  const defaultAccount = useMemo(
    () => options.find((account) => account.isDefaultForPaymentSelector) ?? null,
    [options],
  )
  const balancesByAccount = useMemo(() => {
    const grouped = new Map<string, typeof balances>()

    balances.forEach((balance) => {
      const current = grouped.get(balance.accountId) ?? []
      current.push(balance)
      grouped.set(balance.accountId, current)
    })

    grouped.forEach((accountBalances) => {
      accountBalances.sort((left, right) => left.currency.localeCompare(right.currency))
    })

    return grouped
  }, [balances])
  const [retainedSelectedAccount, setRetainedSelectedAccount] = useState<PaymentAccount | null>(null)
  const [explicitlyLedgerOnly, setExplicitlyLedgerOnly] = useState(false)
  const lastObservedValue = useRef<string | null | undefined>(undefined)
  const scheduledDefaultAccountId = useRef<string | null>(null)
  const effectiveValue = resolvePaymentAccountEffectiveValue(
    value,
    retainedSelectedAccount,
    explicitlyLedgerOnly,
  )
  const selection = resolvePaymentAccountSelection(
    effectiveValue,
    accounts,
    options,
    retainedSelectedAccount,
    allowNoAccount,
  )

  useEffect(() => {
    if (value) {
      const currentAccount = accounts.find((account) => account.id === value)
      if (currentAccount) setRetainedSelectedAccount(currentAccount)
      setExplicitlyLedgerOnly(false)
    }
  }, [accounts, value])

  useEffect(() => {
    // Wait until the parent form has run its own opening-state reset before
    // applying the workspace default. Without this boundary, a parent can
    // reset its account state back to null after the selector paints a default;
    // choosing ledger-only then becomes a no-op and appears delayed.
    if (!areAccountsReady || !applyDefault || value || explicitlyLedgerOnly || retainedSelectedAccount || !defaultAccount) return
    if (scheduledDefaultAccountId.current === defaultAccount.id) return

    scheduledDefaultAccountId.current = defaultAccount.id
    const timer = window.setTimeout(() => {
      setRetainedSelectedAccount(defaultAccount)
      onValueChange(defaultAccount)
    }, 0)

    return () => {
      window.clearTimeout(timer)
      if (scheduledDefaultAccountId.current === defaultAccount.id) scheduledDefaultAccountId.current = null
    }
  }, [areAccountsReady, applyDefault, defaultAccount, explicitlyLedgerOnly, onValueChange, retainedSelectedAccount, value])

  useEffect(() => {
    const previousValue = lastObservedValue.current
    lastObservedValue.current = value ?? null

    // If a failed submission or transient parent refresh clears an account
    // that was already resolved, restore it on the next task. An explicit
    // ledger-only selection never enters this recovery path.
    if (value || explicitlyLedgerOnly || !retainedSelectedAccount || !previousValue) return

    const timer = window.setTimeout(() => onValueChange(retainedSelectedAccount), 0)
    return () => window.clearTimeout(timer)
  }, [explicitlyLedgerOnly, onValueChange, retainedSelectedAccount, value])

  const isSelectionReady = areAccountsReady
    && (!applyDefault || Boolean(effectiveValue) || !defaultAccount || explicitlyLedgerOnly)
  const selectedAccountBalances = selection.selectedAccount
    ? balancesByAccount.get(selection.selectedAccount.id) ?? []
    : []

  const handleValueChange = (next: string) => {
    if (next === '__none__') {
      if (!allowNoAccount) return
      setRetainedSelectedAccount(null)
      setExplicitlyLedgerOnly(true)
      onValueChange(null)
      return
    }

    const nextAccount = options.find((account) => account.id === next)
    // Never turn an unresolved or retained selection into a ledger-only
    // payment. Only a deliberate choice of "No account" may emit null.
    if (!nextAccount) return

    setRetainedSelectedAccount(nextAccount)
    setExplicitlyLedgerOnly(false)
    onValueChange(nextAccount)
  }

  const balanceLoadingIndicator = <span aria-label={t('paymentAccounts.balancesLoading', { defaultValue: 'Loading posted balances' })} className="inline-flex shrink-0 items-center gap-1.5"><span className="h-3 w-14 animate-pulse rounded bg-muted" /><span className="h-3 w-9 animate-pulse rounded bg-muted" /></span>

  return (
    <div className="grid gap-2">
      <Label className="flex items-center gap-1.5">
        <ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-500" />
        {label ?? t('paymentAccounts.selectorLabel', { defaultValue: 'Payment Account (optional)' })}
      </Label>
      {!isSelectionReady ? (
        <div
          aria-busy="true"
          aria-label={t('paymentAccounts.selectorLoading', { defaultValue: 'Loading payment account selection' })}
          className="h-10 w-full animate-pulse rounded-xl border border-amber-400/70 bg-amber-500/5"
        />
      ) : (
      <Select
        value={selection.selectedValue}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger className="border-amber-400/70 hover:border-amber-500 focus:border-amber-500 focus:ring-amber-500/20">
          {selection.selectedAccount ? (
            <div className="flex w-full min-w-0 items-center gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <PaymentAccountIcon iconKey={selection.selectedAccount.iconKey} accountType={selection.selectedAccount.accountType} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{selection.selectedAccount.name}</span>
                {selection.selectedAccount.id === originAccountId ? <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">{t('paymentAccounts.originalTransactionAccount', { defaultValue: 'Original' })}</span> : null}
              </span>
              {!areBalancesReady ? balanceLoadingIndicator : selectedAccountBalances.length ? (
                <span className="ml-auto flex shrink-0 items-center text-xs font-semibold tabular-nums text-foreground">
                  {selectedAccountBalances.slice(0, 2).map((balance, index) => (
                    <span key={balance.id} className={index > 0 ? "ml-1.5 border-s border-amber-400/50 ps-1.5" : undefined}>
                      {formatCurrency(balance.balanceAmount, balance.currency, features.iqd_display_preference)}
                    </span>
                  ))}
                  {selectedAccountBalances.length > 2 ? <span className="ml-1.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">+{selectedAccountBalances.length - 2}</span> : null}
                </span>
              ) : <span className="ms-auto shrink-0 text-xs text-muted-foreground">{t('paymentAccounts.noBalance', { defaultValue: 'No posted balance' })}</span>}
            </div>
          ) : selection.selectionUnavailable ? (
            <span className="truncate text-amber-600 dark:text-amber-400">{t('paymentAccounts.selectedAccountUnavailable', { defaultValue: 'Selected payment account unavailable' })}</span>
          ) : (
            <SelectValue placeholder={placeholder ?? t('paymentAccounts.noAccount', { defaultValue: 'No account — ledger only' })} />
          )}
        </SelectTrigger>
        <SelectContent>
          {allowNoAccount ? <SelectItem value="__none__">{t('paymentAccounts.noAccount', { defaultValue: 'No account — ledger only' })}</SelectItem> : null}
          {selection.displayOptions.map((account) => {
            const requiresReview = selection.selectionNeedsReview && account.id === selection.selectedAccount?.id
            const accountBalances = balancesByAccount.get(account.id) ?? []
            return (
              <SelectItem key={account.id} value={account.id} disabled={requiresReview}>
                <span className="flex w-full min-w-0 items-center gap-3">
                  <span className="flex min-w-0 items-center gap-2"><PaymentAccountIcon iconKey={account.iconKey} accountType={account.accountType} className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{account.name}</span>{account.id === originAccountId ? <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">{t('paymentAccounts.originalTransactionAccount', { defaultValue: 'Original' })}</span> : null}{requiresReview ? <span className="text-xs text-amber-600 dark:text-amber-400">{t('paymentAccounts.selectedAccountNeedsReview', { defaultValue: 'Review selection' })}</span> : null}</span>
                  {!areBalancesReady ? balanceLoadingIndicator : accountBalances.length ? (
                    <span className="ms-auto flex shrink-0 items-center text-xs font-semibold tabular-nums text-muted-foreground">
                      {accountBalances.map((balance, index) => (
                        <span key={balance.id} className={index > 0 ? "ms-1.5 border-s border-border ps-1.5" : undefined}>
                          {formatCurrency(balance.balanceAmount, balance.currency, features.iqd_display_preference)}
                        </span>
                      ))}
                    </span>
                  ) : <span className="ms-auto shrink-0 text-xs text-muted-foreground">{t('paymentAccounts.noBalance', { defaultValue: 'No posted balance' })}</span>}
                </span>
              </SelectItem>
            )
          })}
          {selection.selectionUnavailable && selection.selectedValue ? <SelectItem value={selection.selectedValue} disabled>{t('paymentAccounts.selectedAccountUnavailable', { defaultValue: 'Selected payment account unavailable' })}</SelectItem> : null}
        </SelectContent>
      </Select>
      )}
    </div>
  )
}
