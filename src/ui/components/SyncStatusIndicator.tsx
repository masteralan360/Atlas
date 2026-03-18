import { useState } from 'react'
import { usePendingSyncCount } from '@/local-db/hooks'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useWorkspace } from '@/workspace'
import { ManualSyncModal } from './ManualSyncModal'
import { cn } from '@/lib/utils'
import { CloudOff, Check, AlertCircle } from 'lucide-react'
import { useTheme } from './theme-provider'

export function SyncStatusIndicator() {
    const pendingCount = usePendingSyncCount()
    const isOnline = useNetworkStatus()
    const { isLocalMode } = useWorkspace()
    const [isModalOpen, setIsModalOpen] = useState(false)
    const { style } = useTheme()

    let status = {
        icon: Check,
        label: 'Synced',
        color: 'text-emerald-500',
        bgColor: 'bg-emerald-500/10',
        dotColor: 'bg-emerald-500',
        clickable: false
    }

    if (isLocalMode) {
        status = {
            icon: Check,
            label: 'Local Mode',
            color: 'text-sky-600',
            bgColor: 'bg-sky-500/10',
            dotColor: 'bg-sky-500',
            clickable: false
        }
    } else if (!isOnline) {
        status = {
            icon: CloudOff,
            label: pendingCount > 0 ? `Offline (${pendingCount})` : 'Offline',
            color: 'text-red-500',
            bgColor: 'bg-red-500/10',
            dotColor: 'bg-red-500',
            clickable: false
        }
    } else if (pendingCount > 0) {
        status = {
            icon: AlertCircle,
            label: `Sync Needed (${pendingCount})`,
            color: 'text-amber-500',
            bgColor: 'bg-amber-500/10',
            dotColor: 'bg-amber-500',
            clickable: true
        }
    }

    const { icon: Icon, label, color, bgColor, dotColor, clickable } = status

    return (
        <>
            <button
                onClick={() => isOnline && pendingCount > 0 && setIsModalOpen(true)}
                disabled={isLocalMode || !isOnline || pendingCount === 0}
                className={cn(
                    'flex items-center gap-2 px-3 py-1.5 transition-all text-xs font-bold',
                    style === 'neo-orange' ? 'neo-indicator' : cn(bgColor, 'rounded-full'),
                    clickable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default opacity-80'
                )}
                title={clickable ? "Click to sync changes" : undefined}
            >
                <div className={cn(
                    'w-2 h-2',
                    style === 'neo-orange' ? "rounded-none" : "rounded-full",
                    dotColor
                )} />
                <Icon className={cn('w-4 h-4', style === 'neo-orange' ? 'text-current' : color)} />
                <span className={cn(style === 'neo-orange' ? 'text-current' : color)}>{label}</span>
            </button>

            <ManualSyncModal
                open={isModalOpen}
                onOpenChange={setIsModalOpen}
            />
        </>
    )
}
