import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'

export type SnoozedItemType = 'loan' | 'budget' | 'exchange' | 'marketplace'

export interface SnoozedItem {
    id: string
    type: SnoozedItemType
    title: string
    subtitle?: string
    amount?: number
    currency?: string
    timestamp?: string
    priority?: 'warning' | 'info'
    onAction: () => void
    onUnsnooze: () => void
}

interface UnifiedSnoozeContextType {
    items: SnoozedItem[]
    registerItems: (sourceId: string, sourceItems: SnoozedItem[]) => void
    unregisterItems: (sourceId: string) => void
}

const UnifiedSnoozeContext = createContext<UnifiedSnoozeContextType | undefined>(undefined)

export function UnifiedSnoozeProvider({ children }: { children: React.ReactNode }) {
    const [sourceRegistry, setSourceRegistry] = useState<Record<string, SnoozedItem[]>>({})

    const registerItems = useCallback((sourceId: string, sourceItems: SnoozedItem[]) => {
        setSourceRegistry(prev => {
            // Only update if changed to avoid re-renders
            if (JSON.stringify(prev[sourceId]) === JSON.stringify(sourceItems)) return prev
            return { ...prev, [sourceId]: sourceItems }
        })
    }, [])

    const unregisterItems = useCallback((sourceId: string) => {
        setSourceRegistry(prev => {
            if (!(sourceId in prev)) return prev
            const next = { ...prev }
            delete next[sourceId]
            return next
        })
    }, [])

    const allItems = useMemo(() => {
        return Object.values(sourceRegistry).flat()
    }, [sourceRegistry])

    return (
        <UnifiedSnoozeContext.Provider value={{ items: allItems, registerItems, unregisterItems }}>
            {children}
        </UnifiedSnoozeContext.Provider>
    )
}

export function useUnifiedSnooze() {
    const context = useContext(UnifiedSnoozeContext)
    if (!context) {
        throw new Error('useUnifiedSnooze must be used within a UnifiedSnoozeProvider')
    }
    return context
}
