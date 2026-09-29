import { useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { toast } from '@/ui/components/use-toast'
import { getNetworkStatus, subscribeNetworkStatus } from '@/lib/network'
import { getAppMaintenanceSnapshot, subscribeAppMaintenance } from '@/lib/appMaintenanceState'

export function useNetworkStatus() {
    const isOnline = useSyncExternalStore(subscribeNetworkStatus, getNetworkStatus, getNetworkStatus)
    const maintenanceBlocking = useSyncExternalStore(
        subscribeAppMaintenance,
        () => getAppMaintenanceSnapshot().eligible && (
            getAppMaintenanceSnapshot().active || getAppMaintenanceSnapshot().checking
        ),
        () => false
    )
    const [wasOffline, setWasOffline] = useState(false)
    const prevIsOnline = useRef(isOnline)

    // "Back online" toast
    useEffect(() => {
        if (isOnline && wasOffline) {
            toast({
                title: "Back online",
                description: "You are connected to the internet. You can now sync your changes.",
                variant: "default",
            })
            setWasOffline(false)
        }
    }, [isOnline, wasOffline])

    // "Offline" toast – only on actual transition, not on initial mount
    useEffect(() => {
        if (prevIsOnline.current === true && isOnline === false && !maintenanceBlocking) {
            setWasOffline(true)
            toast({
                title: "You are offline",
                description: "Changes will be saved locally and can be synced when you're back online.",
                variant: "destructive",
            })
        }
        prevIsOnline.current = isOnline
    }, [isOnline, maintenanceBlocking])

    return isOnline
}
