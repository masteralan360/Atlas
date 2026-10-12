import { useEffect, useState } from 'react'

interface SearchState<T> {
  query: string
  items: T[]
  isLoading: boolean
  error: unknown
}

/** Searches only after the user has entered enough text to avoid broad reads. */
export function useDebouncedAutocompleteSearch<T>(
  query: string,
  enabled: boolean,
  search: (query: string) => Promise<T[]>,
  delay = 250,
  minQueryLength = 2,
) {
  const normalizedQuery = query.trim()
  const [state, setState] = useState<SearchState<T>>({
    query: '',
    items: [],
    isLoading: false,
    error: null,
  })

  useEffect(() => {
    let active = true
    if (!enabled || normalizedQuery.length < minQueryLength) {
      setState({ query: normalizedQuery, items: [], isLoading: false, error: null })
      return () => { active = false }
    }

    setState({ query: normalizedQuery, items: [], isLoading: true, error: null })
    const timeout = window.setTimeout(() => {
      void search(normalizedQuery)
        .then((items) => {
          if (active) setState({ query: normalizedQuery, items, isLoading: false, error: null })
        })
        .catch((error: unknown) => {
          if (active) setState({ query: normalizedQuery, items: [], isLoading: false, error })
        })
    }, delay)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [delay, enabled, minQueryLength, normalizedQuery, search])

  const hasCurrentResults = state.query === normalizedQuery
  return {
    items: hasCurrentResults ? state.items : [],
    isLoading: enabled && normalizedQuery.length >= minQueryLength
      && (!hasCurrentResults || state.isLoading),
    error: hasCurrentResults ? state.error : null,
  }
}
