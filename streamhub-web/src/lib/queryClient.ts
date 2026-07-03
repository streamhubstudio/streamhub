import { QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/api'

/** Shared react-query client. Don't retry auth failures. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiRequestError && error.status === 401) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
  },
})
