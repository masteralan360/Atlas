import { createElement } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchState = vi.hoisted(() => ({
    items: [] as Array<Record<string, unknown>>,
    isLoading: false,
    error: null as unknown,
}))

vi.mock('react-i18next', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-i18next')>()
    return {
        ...actual,
        useTranslation: () => ({
            t: (key: string) => ({
                'common.autocomplete.searching': 'Searching…',
                'common.autocomplete.noResults': 'No matches found.',
                'common.autocomplete.searchFailed': 'Search could not be completed. Try again.',
                'businessPartners.addPartner': 'Add Business Partner',
                'customers.title': 'Customers',
            }[key] || key),
        }),
    }
})

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ hasCapability: () => false }) }))
vi.mock('@/local-db/businessPartnerGroups', () => ({
    useBusinessPartnerGroupVisibility: () => ({ isLoading: false, visiblePartnerIds: null, scopeKey: 'all' }),
}))
vi.mock('@/local-db/businessPartners', () => ({
    cacheBusinessPartnerAutocompleteSelection: vi.fn(),
    searchBusinessPartnerAutocompleteSuggestions: vi.fn(),
}))
vi.mock('@/ui/components/useDebouncedAutocompleteSearch', () => ({
    useDebouncedAutocompleteSearch: () => searchState,
}))
vi.mock('@/ui/components/AutocompletePopover', async () => {
    return {
        AutocompletePopover: ({ anchor, children }: { anchor: ReactNode; children: ReactNode }) => (
            <div>{anchor}{children}</div>
        ),
    }
})
vi.mock('@/ui/components/input', async () => {
    const React = await import('react')
    return {
        Input: React.forwardRef<HTMLInputElement, ComponentProps<'input'>>((props, ref) => (
            <input {...props} ref={ref} />
        )),
    }
})
import { PartnerAutocompleteInput } from './PartnerAutocompleteInput'
import { activatePartnerCreation, canDisplayPartnerAutocompleteResults } from './partnerAutocompleteAddPartner'
import type { BusinessPartner } from '@/local-db/models'

const buyerFixture = {
    id: 'partner-1',
    workspaceId: 'workspace-1',
    partnerName: 'Existing Buyer',
    role: 'customer',
    phone: '555-0100',
} as BusinessPartner

function renderAutocomplete(options: {
    value?: string
    addPartner?: {
        onActivate: (partnerName: string) => void
        active?: boolean
        canCreate?: boolean
    }
} = {}) {
    return renderToStaticMarkup(createElement(PartnerAutocompleteInput, {
        value: options.value ?? 'New Buyer Name',
        onChange: vi.fn(),
        onSelectPartner: vi.fn(),
        workspaceId: 'workspace-1',
        addPartner: options.addPartner,
    }))
}

describe('PartnerAutocompleteInput inline partner option', () => {
    beforeEach(() => {
        searchState.items = []
        searchState.isLoading = false
        searchState.error = null
    })

    it('shows the localized no-match feedback and add action whenever configured and search completes empty', () => {
        const markup = renderAutocomplete({
            addPartner: { onActivate: vi.fn() },
        })

        expect(markup).toContain('value="New Buyer Name"')
        expect(markup).toContain('No matches found.')
        expect(markup).toContain('Add Business Partner')
        expect(markup).not.toContain('Allow inline partner creation')
    })

    it('passes the current typed name verbatim into inline mode', () => {
        const onActivate = vi.fn()
        const config = { onActivate }

        expect(activatePartnerCreation(config, '  New Buyer  ', false)).toBe(true)
        expect(onActivate).toHaveBeenCalledOnce()
        expect(onActivate).toHaveBeenCalledWith('  New Buyer  ')
    })

    it('rejects inline activation when not configured, unavailable, or disabled', () => {
        const onActivate = vi.fn()
        const config = { onActivate }

        expect(activatePartnerCreation(undefined, 'New Buyer', false)).toBe(false)
        expect(activatePartnerCreation({ ...config, canCreate: false }, 'New Buyer', false)).toBe(false)
        expect(activatePartnerCreation(config, 'New Buyer', true)).toBe(false)
        expect(onActivate).not.toHaveBeenCalled()
    })

    it('does not show the dropdown add action or no-match feedback while search is loading or failed', () => {
        const config = { onActivate: vi.fn() }

        searchState.isLoading = true
        const loadingMarkup = renderAutocomplete({ addPartner: config })
        expect(loadingMarkup).toContain('Searching…')
        expect(loadingMarkup).toContain('aria-label="Add Business Partner"')
        expect(loadingMarkup).not.toContain('<span>Add Business Partner</span>')
        expect(loadingMarkup).not.toContain('No matches found.')

        searchState.isLoading = false
        searchState.error = new Error('offline')
        const failedMarkup = renderAutocomplete({ addPartner: config })
        expect(failedMarkup).toContain('Search could not be completed. Try again.')
        expect(failedMarkup).toContain('aria-label="Add Business Partner"')
        expect(failedMarkup).not.toContain('<span>Add Business Partner</span>')
        expect(failedMarkup).not.toContain('No matches found.')
    })

    it('keeps an existing partner suggestion without the dropdown add action', () => {
        searchState.items = [buyerFixture as unknown as Record<string, unknown>]

        const markup = renderAutocomplete({
            addPartner: { onActivate: vi.fn() },
        })

        expect(markup).toContain('Existing Buyer')
        expect(markup).toContain('aria-label="Add Business Partner"')
        expect(markup).not.toContain('<span>Add Business Partner</span>')
        expect(markup).not.toContain('No matches found.')
    })

    it('keeps the feature disabled for callers that do not opt in', () => {
        const markup = renderAutocomplete()

        expect(markup).toContain('No matches found.')
        expect(markup).not.toContain('Add Business Partner')
    })

    it('shows the attached plus action before searching and hides it while active or selected', () => {
        const config = { onActivate: vi.fn() }
        const initialMarkup = renderAutocomplete({ value: '', addPartner: config })
        const activeMarkup = renderAutocomplete({ value: 'New Buyer Name', addPartner: { ...config, active: true } })
        const selectedMarkup = renderAutocomplete({ value: 'Existing Buyer', addPartner: { ...config, canCreate: false } })

        expect(initialMarkup).toContain('aria-label="Add Business Partner"')
        expect(initialMarkup).toContain('rounded-e-none rounded-s-lg border-e-0')
        expect(initialMarkup).toContain('rounded-s-none')
        expect(initialMarkup).toContain('value=""')
        expect(activeMarkup).not.toContain('aria-label="Add Business Partner"')
        expect(selectedMarkup).not.toContain('aria-label="Add Business Partner"')
    })

    it('blocks autocomplete results while inline partner creation is active', () => {
        expect(canDisplayPartnerAutocompleteResults(true, false, false)).toBe(true)
        expect(canDisplayPartnerAutocompleteResults(true, false, true)).toBe(false)
        expect(canDisplayPartnerAutocompleteResults(true, true, false)).toBe(false)
    })

    it('does not offer partner creation until the search can complete', () => {
        const markup = renderAutocomplete({
            value: 'AB',
            addPartner: { onActivate: vi.fn() },
        })

        expect(markup).not.toContain('<span>Add Business Partner</span>')
        expect(markup).not.toContain('No matches found.')
    })

})
