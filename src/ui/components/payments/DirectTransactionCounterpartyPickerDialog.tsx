import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Search, UserRound, Users } from 'lucide-react'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import type { DirectCounterpartyScope, DirectCounterparty } from '@/local-db/directTransactionCounterparties'
import { useDirectCounterpartyPage } from '@/local-db/directTransactionHooks'
import { AppDialog, AppDialogContent, AppDialogHeader, AppDialogTitle, AppDialogDescription, AppDialogBody,
  AppDialogFooter, AppPagination, Button, Badge } from '@/ui/components'
import { Input } from '@/ui/components/input'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { DIRECT_TRANSACTION_PAGE_SIZES, readDirectTransactionPageSize, saveDirectTransactionPageSize } from './directTransactionPageSize'

export function DirectTransactionCounterpartyPickerDialog({ open, onOpenChange, workspaceId, selectedPartnerId, onSelect }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  selectedPartnerId?: string | null
  onSelect: (counterparty: DirectCounterparty) => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<DirectCounterpartyScope>('all')
  const pagination = usePaginationState({ resetOn: [workspaceId, search, scope],
    initialPageSize: readDirectTransactionPageSize('direct_counterparties_page_size'),
    onPageSizeChange: size => saveDirectTransactionPageSize('direct_counterparties_page_size', size) })
  const page = useDirectCounterpartyPage(workspaceId, { scope, search, page: pagination.currentPage, pageSize: pagination.pageSize }, open)
  const bounds = usePaginationBounds({ currentPage: pagination.currentPage, setCurrentPage: pagination.setCurrentPage,
    totalCount: page.data?.totalCount, pageSize: pagination.pageSize, isLoading: page.isLoading, error: page.error })
  return <AppDialog open={open} onOpenChange={onOpenChange}>
    <AppDialogContent className="max-w-3xl">
      <AppDialogHeader>
        <AppDialogTitle>{t('directTransactionModal.counterparties.title')}</AppDialogTitle>
        <AppDialogDescription>{t('directTransactionModal.counterparties.description')}</AppDialogDescription>
        <ModulePageFreshness tableNames={['business_partners', 'agents', 'agent_types']} />
        <div className="relative"><Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={event => setSearch(event.target.value)} className="ps-9"
            aria-label={t('directTransactionModal.counterparties.search')} placeholder={t('directTransactionModal.counterparties.search')} />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('directTransactionModal.counterparties.scope')}>
          {(['all', ...(page.scope.partners ? ['partners'] : []), ...(page.scope.agents ? ['agents'] : [])] as DirectCounterpartyScope[]).map(value =>
            <Button key={value} type="button" variant={scope === value ? 'default' : 'outline'} aria-pressed={scope === value}
              onClick={() => setScope(value)}><Users className="me-2 h-4 w-4" />{t(`directTransactionModal.counterparties.${value}`)}</Button>)}
        </div>
        <AppPagination currentPage={bounds.currentPage} pageCount={bounds.pageCount} totalCount={page.data?.totalCount ?? 0}
          pageSize={pagination.pageSize} onPageChange={pagination.setCurrentPage} onPageSizeChange={pagination.setPageSize}
          pageSizeOptions={DIRECT_TRANSACTION_PAGE_SIZES} />
      </AppDialogHeader>
      <AppDialogBody className="space-y-2">
        {page.isLoading ? <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />{t('common.loading')}</div>
          : page.error ? <div role="alert" className="py-10 text-center"><p>{t('common.autocomplete.searchFailed')}</p>
            <Button type="button" variant="outline" onClick={() => void page.refetch()}>{t('directTransactionModal.counterparties.retry')}</Button></div>
          : !page.data?.items.length ? <p className="py-10 text-center text-muted-foreground">{t('common.autocomplete.noResults')}</p>
          : page.data.items.map(item => <button key={item.partner.id} type="button"
            className="flex w-full items-center gap-3 rounded-xl border p-3 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => { onSelect(item); onOpenChange(false) }}>
            {item.agent ? <UserRound className="h-5 w-5 shrink-0 text-primary" /> : <Users className="h-5 w-5 shrink-0" />}
            <span className="min-w-0 flex-1"><span className="block break-words font-semibold">{item.partner.partnerName}</span>
              <span className="block text-xs text-muted-foreground">{[item.partner.phone, item.agent?.zone].filter(Boolean).join(' · ')}</span></span>
            <Badge variant="outline" className="max-w-[45%] whitespace-normal break-words">{item.agent
              ? item.customType?.name || t(`businessPartners.agent.types.${item.agent.agentType}`) : t('directTransactions.businessPartnerLink')}</Badge>
            {selectedPartnerId === item.partner.id ? <Check className="h-4 w-4 shrink-0 text-primary" aria-label={t('businessPartners.linked')} /> : null}
          </button>)}
      </AppDialogBody>
      <AppDialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button></AppDialogFooter>
    </AppDialogContent>
  </AppDialog>
}
