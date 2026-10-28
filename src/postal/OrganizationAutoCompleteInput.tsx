import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Loader2 } from 'lucide-react'
import { Input } from '@/ui/components/input'
import { AutocompletePopover } from '@/ui/components/AutocompletePopover'
import { useDebouncedAutocompleteSearch } from '@/ui/components/useDebouncedAutocompleteSearch'
import { searchPostalStatementOrganizations } from '@/local-db/postalStatement'
import type { PostalScope } from '@/local-db/postal'
import type { PostalOrganization } from './domain'

export function OrganizationAutoCompleteInput({
  id, scope, value, onChange, onSelectOrganization, disabled = false,
}: {
  id?: string
  scope: PostalScope
  value: string
  onChange: (value: string) => void
  onSelectOrganization: (organization: PostalOrganization) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(-1)
  const { workspaceId, userId, role, permissionScope } = scope
  const search = useCallback((query: string) => searchPostalStatementOrganizations(
    { workspaceId, userId, role, permissionScope }, query,
  ), [workspaceId, userId, role, permissionScope])
  const result = useDebouncedAutocompleteSearch(value, focused && !disabled, search, 250, 3,
    JSON.stringify([workspaceId, userId, role, permissionScope]))
  const open = focused && !disabled && value.trim().length >= 3
  const select = (organization: PostalOrganization) => {
    setFocused(false)
    setActive(-1)
    onChange(organization.name)
    onSelectOrganization(organization)
    inputRef.current?.focus()
    setFocused(false)
  }
  return (
    <AutocompletePopover open={open} onOpenChange={setFocused} anchor={(
      <div data-autocomplete-popover-anchor className="w-full min-w-0">
        <Input id={id} ref={inputRef} value={value} disabled={disabled}
          placeholder={t('postal.statement.searchOrganization')}
          role="combobox" aria-autocomplete="list" aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 && result.items[active] ? `${listId}-${active}` : undefined}
          aria-busy={result.isLoading}
          onFocus={() => setFocused(true)}
          onChange={(event) => { setActive(-1); setFocused(true); onChange(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { setFocused(false); setActive(-1) }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setFocused(true)
              setActive((index) => {
                const count = result.items.length
                if (!count) return -1
                if (index < 0) return event.key === 'ArrowDown' ? 0 : count - 1
                return (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
              })
            }
            if (event.key === 'Enter' && open && !result.isLoading && result.items[active]) {
              event.preventDefault(); select(result.items[active])
            }
          }} />
      </div>
    )}>
      <div className="rounded-xl border bg-popover shadow-lg">
        {result.isLoading ? (
          <div role="status" className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.autocomplete.searching')}
          </div>
        ) : result.error ? (
          <p role="alert" className="px-3 py-4 text-center text-sm text-muted-foreground">{t('common.autocomplete.searchFailed')}</p>
        ) : !result.items.length ? (
          <p role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">{t('common.autocomplete.noResults')}</p>
        ) : null}
        <div role="listbox" id={listId} aria-label={t('postal.organizations')}>
          {!result.isLoading && !result.error && result.items.map((organization, index) => (
            <button key={organization.id} id={`${listId}-${index}`} type="button" role="option"
              aria-selected={active === index}
              className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm hover:bg-accent focus:bg-accent focus:outline-none ${active === index ? 'bg-accent' : ''}`}
              onMouseDown={(event) => event.preventDefault()} onClick={() => select(organization)}>
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
              <span className="shrink-0 rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-xs" dir="ltr">{organization.code}</span>
            </button>
          ))}
        </div>
      </div>
    </AutocompletePopover>
  )
}
