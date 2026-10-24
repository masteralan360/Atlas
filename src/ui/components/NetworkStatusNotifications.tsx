import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionManager } from '@/lib/connectionManager'
import { toast } from '@/ui/components/use-toast'

export function NetworkStatusNotifications() {
  const { t } = useTranslation()
  const wasOfflineRef = useRef(false)

  useEffect(() => {
    return connectionManager.subscribe((event) => {
      if (event === 'offline') {
        wasOfflineRef.current = true
        toast({
          title: t('networkStatus.offlineTitle'),
          description: t('networkStatus.offlineDescription'),
          variant: 'destructive',
        })
        return
      }

      if (event === 'online' && wasOfflineRef.current) {
        wasOfflineRef.current = false
        toast({
          title: t('networkStatus.onlineTitle'),
          description: t('networkStatus.onlineDescription'),
          variant: 'default',
        })
      }
    })
  }, [t])

  return null
}
