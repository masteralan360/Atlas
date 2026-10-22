import { queryClient } from './queryClient'
import { queryKeys } from './queryKeys'

export function invalidateOrdersList(workspaceId: string | undefined, orderType: 'sales' | 'purchase') {
  if (!workspaceId) return

  void queryClient.invalidateQueries({
    queryKey: queryKeys.orders.all(workspaceId, orderType)
  })
}
