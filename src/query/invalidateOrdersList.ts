import { queryClient } from './queryClient'
import { queryKeys } from './queryKeys'

export function invalidateOrdersList(workspaceId: string | undefined, orderType: 'sales' | 'purchase') {
  if (!workspaceId) return
  if (orderType === 'sales') void queryClient.invalidateQueries({ queryKey: queryKeys.stockReservations.all(workspaceId) })

  void queryClient.invalidateQueries({
    queryKey: queryKeys.orders.all(workspaceId, orderType)
  })
}
