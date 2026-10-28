import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspacePermissions } from '@/permissions'
import { useToast } from '@/ui/components/use-toast'
import type { PostalScope } from '@/local-db/postal'
import type { PostalRole } from './domain'
import { supabase } from '@/auth/supabase'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'

export function usePostalScope(): PostalScope {
  const { user } = useAuth()
  const { hasPermission, permissionKeys } = useWorkspacePermissions()
  const role: PostalRole =
    user?.role === 'admin'
      ? 'admin'
      : hasPermission('postService.merchant')
        ? 'merchant'
        : 'office'
  const workspaceId = user?.workspaceId ?? ''
  const userId = user?.id ?? ''
  useEffect(() => {
    if (!workspaceId || !userId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.postal.all(workspaceId),
        })
      }, 100)
    }
    const channel = supabase.channel(`postal:${workspaceId}:${userId}`)
    for (const table of [
      'postal_shipments',
      'postal_events',
      'postal_transfers',
      'postal_cod_records',
      'postal_delivery_fee_records',
      'postal_branches',
      'postal_organizations',
      'postal_memberships',
    ]) {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `workspace_id=eq.${workspaceId}`,
        },
        refresh,
      )
    }
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'postal_memberships',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        clearTimeout(timer)
        // Membership changes alter visibility; discard previously visible rows immediately.
        void queryClient.resetQueries({
          queryKey: queryKeys.postal.all(workspaceId),
        })
      },
    )
    channel.subscribe()
    return () => {
      clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [workspaceId, userId])
  return {
    workspaceId,
    userId,
    role,
    permissionScope: permissionKeys
      .filter((x) => x.startsWith('postService.'))
      .sort()
      .join('|'),
  }
}
export function usePostalAction() {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const pending = useRef<{ signature: string; id: string }>()
  const { toast } = useToast()
  const { t } = useTranslation()
  async function run(
    signature: string,
    action: (requestId: string) => Promise<void>,
  ) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() }
    try {
      await action(pending.current.id)
      pending.current = undefined
    } catch (e) {
      const message =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : ''
      const key = message.includes('stale_shipment')
        ? 'stale'
        : message.includes('invalid_tariff') || message.includes('tariff_required')
          ? 'invalidTariff'
          : message.includes('tariff_locked')
            ? 'tariffLocked'
            : message.includes('invalid_transition')
              ? 'invalidTransition'
              : message.includes('invalid_payment')
                ? 'invalidPayment'
                : message.includes('cod_locked')
                  ? 'codLocked'
                  : 'failed'
      toast({
        title: t('common.error'),
        description: t(`postal.errors.${key}`),
        variant: 'destructive',
      })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return { busy, run }
}
