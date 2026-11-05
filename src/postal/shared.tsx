import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, MapPin, Check, Star } from 'lucide-react'
import { Button, Input } from '@/ui/components'
import {
  SmallDialog,
  SmallDialogContent,
  SmallDialogHeader,
  SmallDialogTitle,
  SmallDialogBody,
} from '@/ui/components/small-dialog'
import { locationLabel, type PostalLocationCatalog } from './domain'
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
  catalog,
  disabled,
  onChange,
}: {
  governorate: string
  area: string
  catalog: PostalLocationCatalog
  disabled?: boolean
  onChange: (governorate: string, area: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [picker, setPicker] = useState<'governorate' | 'area' | null>(null)
  const [search, setSearch] = useState('')
  const selectedGovernorate = catalog.governorates.find((entry) => entry.id === governorate)
  const options = picker === 'area'
    ? (() => {
        const current = selectedGovernorate?.areas.find((entry) => entry.id === area)
        const available = selectedGovernorate?.areas.filter((entry) => entry.isActive) ?? []
        const entries = current && !current.isActive
          ? [...available, current]
          : available
        if (area && !current) {
          return [
            ...entries.map((entry) => ({
              id: entry.id,
              label: `${locationLabel(entry.id, i18n.language, governorate, catalog)}${entry.isActive && selectedGovernorate?.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`,
              aliases: `${entry.en} ${entry.ar} ${entry.ku}`,
            })),
            { id: area, label: `${area} — ${t('postal.locationUnavailable')}`, aliases: area },
          ]
        }
        return entries.map((entry) => ({
          id: entry.id,
          label: `${locationLabel(entry.id, i18n.language, governorate, catalog)}${entry.isActive && selectedGovernorate?.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`,
          aliases: `${entry.en} ${entry.ar} ${entry.ku}`,
        }))
      })()
    : (() => {
        const current = catalog.governorates.find((entry) => entry.id === governorate)
        const available = catalog.governorates.filter((entry) => entry.isActive)
        const entries = current && !current.isActive ? [...available, current] : available
        if (governorate && !current) {
          return [
            ...entries.map((entry) => ({
              id: entry.id,
              label: `${locationLabel(entry.id, i18n.language, undefined, catalog)}${entry.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`,
              aliases: `${entry.en} ${entry.ar} ${entry.ku}`,
            })),
            { id: governorate, label: `${governorate} — ${t('postal.locationUnavailable')}`, aliases: governorate },
          ]
        }
        return entries.map((entry) => ({
          id: entry.id,
          label: `${locationLabel(entry.id, i18n.language, undefined, catalog)}${entry.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`,
          aliases: `${entry.en} ${entry.ar} ${entry.ku}`,
        }))
      })()
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
                    catalog,
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

export function GovernoratePicker({
  governorate,
  catalog,
  disabled,
  onChange,
}: {
  governorate: string
  catalog: PostalLocationCatalog
  disabled?: boolean
  onChange: (governorate: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selectedGovernorate = catalog.governorates.find((entry) => entry.id === governorate)
  const availableGovernorates = catalog.governorates.filter((entry) => entry.isActive)
  const governorates = selectedGovernorate && !selectedGovernorate.isActive
    ? [...availableGovernorates, selectedGovernorate]
    : availableGovernorates
  const options = governorates.map((governorateOption) => ({
    id: governorateOption.id,
    label: `${locationLabel(governorateOption.id, i18n.language, undefined, catalog)}${governorateOption.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`,
    aliases: `${governorateOption.en} ${governorateOption.ar} ${governorateOption.ku}`,
  }))

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="postal-branch-governorate">
        {t('postal.governorate')} *
      </label>
      <Button
        id="postal-branch-governorate"
        className="w-full justify-start"
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setSearch('')
          setOpen(true)
        }}
      >
        <MapPin className="me-2 h-4 w-4 shrink-0" />
        {governorate
          ? `${locationLabel(governorate, i18n.language, undefined, catalog)}${selectedGovernorate?.isActive ? '' : ` — ${t('postal.locationUnavailable')}`}`
          : t('postal.select')}
      </Button>
      <SmallDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOpen(false)
        }}
      >
        <SmallDialogContent layout="structured">
          <SmallDialogHeader layout="structured" className="shrink-0">
            <SmallDialogTitle>{t('postal.governorate')}</SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="space-y-3">
            <Input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t('common.search')}
              placeholder={t('common.search')}
            />
            <div className="grid gap-1">
              {options
                .filter((option) =>
                  `${option.aliases} ${option.label}`
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
                )
                .map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    variant="ghost"
                    className="justify-between"
                    disabled={disabled}
                    onClick={() => {
                      onChange(option.id)
                      setOpen(false)
                    }}
                  >
                    {option.label}
                    {option.id === governorate && <Check className="h-4 w-4" />}
                  </Button>
                ))}
            </div>
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
    </div>
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
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{value?.name ?? t('postal.select')}</span>
          {value?.is_primary && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              <Star className="h-3 w-3" />
              {t('postal.primary')}
            </span>
          )}
        </span>
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
                    <span className="flex items-center gap-2">
                      <span>{branch.name}</span>
                      {branch.is_primary && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          <Star className="h-3 w-3" />
                          {t('postal.primary')}
                        </span>
                      )}
                    </span>
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
