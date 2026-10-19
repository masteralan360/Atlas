import { useEffect, useState } from 'react'

interface SearchState<T> {
  query: string
  scopeKey: string
  items: T[]
  isLoading: boolean
  error: unknown
}

/** Searches only after the user has entered enough text to avoid broad reads. */
export function useDebouncedAutocompleteSearch<T>(
  query: string,
  enabled: boolean,
  search: (query: string, publishPartialResults?: (items: T[], complete?: boolean) => void) => Promise<T[]>,
  delay = 150,
  minQueryLength = 2,
  scopeKey = '',
) {
  const normalizedQuery = query.trim()
  const [state, setState] = useState<SearchState<T>>({
    query: '',
    scopeKey: '',
    items: [],
    isLoading: false,
    error: null,
  })

  useEffect(() => {
    let active = true
    if (!enabled || normalizedQuery.length < minQueryLength) {
      setState({ query: normalizedQuery, scopeKey, items: [], isLoading: false, error: null })
      return () => { active = false }
    }

    setState({ query: normalizedQuery, scopeKey, items: [], isLoading: true, error: null })
    const timeout = window.setTimeout(() => {
      const publishPartialResults = (items: T[], complete = false) => {
        if (active) {
          setState({ query: normalizedQuery, scopeKey, items, isLoading: !complete, error: null })
        }
      }
      void search(normalizedQuery, publishPartialResults)
        .then((items) => {
          if (active) setState({ query: normalizedQuery, scopeKey, items, isLoading: false, error: null })
        })
        .catch((error: unknown) => {
          if (active) setState({ query: normalizedQuery, scopeKey, items: [], isLoading: false, error })
        })
    }, delay)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [delay, enabled, minQueryLength, normalizedQuery, scopeKey, search])

  const hasCurrentResults = state.query === normalizedQuery && state.scopeKey === scopeKey
  return {
    items: hasCurrentResults ? state.items : [],
    isLoading: enabled && normalizedQuery.length >= minQueryLength
      && (!hasCurrentResults || state.isLoading),
    error: hasCurrentResults ? state.error : null,
  }
}
