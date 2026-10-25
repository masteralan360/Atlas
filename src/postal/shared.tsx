import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, MapPin, Check } from 'lucide-react'
import { Button, Input } from '@/ui/components'
import {
  SmallDialog,
  SmallDialogContent,
  SmallDialogHeader,
  SmallDialogTitle,
  SmallDialogBody,
} from '@/ui/components/small-dialog'
import { locations, locationLabel } from './domain'
import { usePostalPage, type PostalScope } from '@/local-db/postal'
import type { PostalBranch } from './domain'
import { AppPagination } from '@/ui/components/AppPagination'
import {
  usePaginationState,
  usePaginationBounds,
} from '@/hooks/usePaginationState'

export function PostalLoading() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="flex min-h-48 flex-col items-center justify-center gap-3"
    >
      <Loader2 className="h-7 w-7 animate-spin text-primary" />
      <span>{t('common.loading')}</span>
    </div>
  )
}
export function PostalError({ retry }: { retry: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex min-h-48 flex-col items-center justify-center gap-3 p-4 text-center"
    >
      <AlertCircle className="h-7 w-7 text-destructive" />
      <p>{t('postal.errors.failed')}</p>
      <Button variant="outline" onClick={retry}>
        {t('postal.retry')}
      </Button>
    </div>
  )
}
export function LocationPicker({
  governorate,
  area,
  disabled,
  onChange,
}: {
  governorate: string
  area: string
  disabled?: boolean
  onChange: (governorate: string, area: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [picker, setPicker] = useState<'governorate' | 'area' | null>(null)
  const [search, setSearch] = useState('')
  const options =
    picker === 'area'
      ? (locations.find((x) => x.id === governorate)?.areas ?? []).map((x) => ({
          id: x[0],
          label: locationLabel(x[0], i18n.language, governorate),
          aliases: x.join(' '),
        }))
      : locations.map((x) => ({
          id: x.id,
          label: locationLabel(x.id, i18n.language),
          aliases: `${x.en} ${x.ar} ${x.ku}`,
        }))
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['governorate', 'area'] as const).map((field) => (
          <div key={field} className="space-y-2">
            <label className="text-sm font-medium" htmlFor={`postal-${field}`}>
              {t(`postal.${field}`)} *
            </label>
            <Button
              id={`postal-${field}`}
              className="w-full justify-start"
              type="button"
              variant="outline"
              disabled={disabled || (field === 'area' && !governorate)}
              onClick={() => {
                setSearch('')
                setPicker(field)
              }}
            >
              <MapPin className="me-2 h-4 w-4 shrink-0" />
              {(field === 'governorate' ? governorate : area)
                ? locationLabel(
                    field === 'governorate' ? governorate : area,
                    i18n.language,
                    field === 'area' ? governorate : undefined,
                  )
                : t('postal.select')}
            </Button>
          </div>
        ))}
      </div>
      <SmallDialog
        open={!!picker}
        onOpenChange={(open) => {
          if (!open) setPicker(null)
        }}
      >
        <SmallDialogContent layout="structured">
          <SmallDialogHeader layout="structured" className="shrink-0">
            <SmallDialogTitle>
              {t(`postal.${picker ?? 'governorate'}`)}
            </SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="space-y-3">
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('common.search')}
              placeholder={t('common.search')}
            />
            <div className="grid gap-1">
              {options
                .filter((x) =>
                  `${x.aliases} ${x.label}`
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
                )
                .map((option) => (
                  <Button
                    key={option.id}
                    variant="ghost"
                    className="justify-between"
                    onClick={() => {
                      if (picker === 'governorate')
                        onChange(
                          option.id,
                          option.id === governorate ? area : '',
                        )
                      else onChange(governorate, option.id)
                      setPicker(null)
                    }}
                  >
                    {option.label}
                    {option.id === (picker === 'area' ? area : governorate) && (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                ))}
            </div>
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
    </>
  )
}
export function BranchPicker({
  scope,
  value,
  label,
  disabled,
  onChange,
}: {
  scope: PostalScope
  value: PostalBranch | null
  label: string
  disabled?: boolean
  onChange: (value: PostalBranch) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const pagination = usePaginationState({
    initialPageSize: 20,
    resetOn: [search],
  })
  const query = usePostalPage<PostalBranch>(
    {
      ...scope,
      kind: 'branches',
      search,
      page: pagination.currentPage,
      pageSize: pagination.pageSize,
    },
    open,
  )
  const bounds = usePaginationBounds({
    ...pagination,
    totalCount: query.data?.total,
    isLoading: query.isFetching,
    error: query.error,
  })
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label} *</label>
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <MapPin className="me-2 h-4 w-4" />
        {value?.name ?? t('postal.select')}
      </Button>
      <SmallDialog open={open} onOpenChange={setOpen}>
        <SmallDialogContent layout="structured">
          <SmallDialogHeader layout="structured" className="shrink-0">
            <SmallDialogTitle>{label}</SmallDialogTitle>
            <Input
              aria-label={t('common.search')}
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <AppPagination
              currentPage={bounds.currentPage}
              pageCount={bounds.pageCount}
              pageSize={pagination.pageSize}
              totalCount={query.data?.total ?? 0}
              onPageChange={pagination.setCurrentPage}
            />
          </SmallDialogHeader>
          <SmallDialogBody>
            {query.isFetching ? (
              <PostalLoading />
            ) : query.error ? (
              <PostalError retry={() => void query.refetch()} />
            ) : (
              <div className="grid gap-1">
                {query.data?.rows.map((branch) => (
                  <Button
                    type="button"
                    variant="ghost"
                    key={branch.id}
                    disabled={!branch.active}
                    onClick={() => {
                      onChange(branch)
                      setOpen(false)
                    }}
                  >
                    {branch.name}
                    {!branch.active && ` (${t('postal.inactive')})`}
                  </Button>
                ))}
              </div>
            )}
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
    </div>
  )
}
