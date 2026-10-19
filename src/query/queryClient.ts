import { QueryClient } from '@tanstack/react-query'

/**
 * The Query cache is intentionally memory-only. Dexie and the existing offline
 * mutation queue remain Atlas' durable local data and synchronization layer.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
})

