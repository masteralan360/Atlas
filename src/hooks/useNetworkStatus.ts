import { useState, useEffect } from 'react'
import { setNetworkStatus } from '@/lib/network'
import { connectionManager } from '@/lib/connectionManager'

export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(() => connectionManager.getState().isOnline)

    useEffect(() => {
        const updateOnlineState = (online: boolean) => {
            setIsOnline(prev => {
                if (prev === online) return prev
                setNetworkStatus(online)
                return online
            })
        }

        const unsubscribe = connectionManager.subscribe((event) => {
            switch (event) {
                case 'online':
                    updateOnlineState(true)
                    break
                case 'offline':
                    updateOnlineState(false)
                    break
                case 'heartbeat':
                    // heartbeat confirms we're still online
                    updateOnlineState(true)
                    break
                case 'wake':
                    // wake event triggers connectivity re-check via heartbeat
                    break
            }
        })

        return unsubscribe
    }, [])

    return isOnline
}
