import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { Button, DateTimePicker } from '@/ui/components'
import { useDateRange } from '@/context/DateRangeContext'
import type { DateRangeType } from '@/context/DateRangeContext'
import { cn, parseLocalDateValue, formatLocalDateValue } from '@/lib/utils'

type CustomDates = {
    start: string
    end: string
}

type DateRangeParent = 'today' | 'month'
type DateRangeSubfilter = { value: DateRangeType; label: string }

interface DateRangeFiltersProps {
    className?: string
    label?: string
    labelDotClassName?: string
    allTimeButtonClassName?: string
    showAllTime?: boolean
    showYesterday?: boolean
    dateRange?: DateRangeType
    customDates?: CustomDates
    onDateRangeChange?: (range: DateRangeType) => void
    onCustomDatesChange?: (dates: CustomDates) => void
}

export function DateRangeFilters({
    className,
    label,
    labelDotClassName,
    allTimeButtonClassName,
    showAllTime = true,
    showYesterday = true,
    dateRange: controlledDateRange,
    customDates: controlledCustomDates,
    onDateRangeChange,
    onCustomDatesChange
}: DateRangeFiltersProps) {
    const { t } = useTranslation()
    const [openSubfilterParent, setOpenSubfilterParent] = useState<DateRangeParent | null>(null)
    const [touchTapPendingParent, setTouchTapPendingParent] = useState<DateRangeParent | null>(null)
    const {
        dateRange: contextDateRange,
        customDates: contextCustomDates,
        setDateRange: setContextDateRange,
        setCustomDates: setContextCustomDates
    } = useDateRange()
    const dateRange = controlledDateRange ?? contextDateRange
    const customDates = controlledCustomDates ?? contextCustomDates
    const setDateRange = onDateRangeChange ?? setContextDateRange
    const subfiltersByParent: Record<DateRangeParent, DateRangeSubfilter[]> = {
        today: showYesterday ? [{ value: 'yesterday', label: t('performance.filters.yesterday') }] : [],
        month: [{ value: 'lastMonth', label: t('performance.filters.lastMonth') }]
    }
    const updateCustomDates = (next: Partial<CustomDates>) => {
        if (onCustomDatesChange) {
            onCustomDatesChange({ ...customDates, ...next })
            return
        }
        setContextCustomDates((current) => ({ ...current, ...next }))
    }
    const selectDateRange = (range: DateRangeType) => {
        setTouchTapPendingParent(null)
        setOpenSubfilterParent(null)
        setDateRange(range)
    }
    const handleParentRangeClick = (range: DateRangeParent) => {
        const isTouchLayout = typeof window.matchMedia === 'function'
            && window.matchMedia('(hover: none)').matches
        setDateRange(range)

        if (subfiltersByParent[range].length > 0 && isTouchLayout) {
            if (touchTapPendingParent === range) {
                setOpenSubfilterParent(range)
                setTouchTapPendingParent(null)
            } else if (openSubfilterParent !== range) {
                setOpenSubfilterParent(null)
                setTouchTapPendingParent(range)
            } else {
                setTouchTapPendingParent(null)
            }
        }
    }
    const renderParentRange = (range: DateRangeParent, label: string) => {
        const subfilters = subfiltersByParent[range]
        const isVisible = subfilters.length > 0 && (
            openSubfilterParent === range || subfilters.some((subfilter) => dateRange === subfilter.value)
        )

        return (
            <div
                key={range}
                className="relative"
                onMouseEnter={() => {
                    const supportsHover = typeof window.matchMedia !== 'function'
                        || window.matchMedia('(hover: hover)').matches
                    if (supportsHover && subfilters.length > 0) setOpenSubfilterParent(range)
                }}
                onMouseLeave={() => {
                    const supportsHover = typeof window.matchMedia !== 'function'
                        || window.matchMedia('(hover: hover)').matches
                    if (supportsHover) {
                        setOpenSubfilterParent(null)
                        setTouchTapPendingParent(null)
                    }
                }}
            >
                <Button
                    variant={dateRange === range ? 'default' : 'ghost'}
                    size="sm"
                    allowViewer={true}
                    onClick={() => handleParentRangeClick(range)}
                    className={cn(
                        "text-xs h-8 px-4 transition-all duration-200",
                        dateRange === range && "shadow-sm",
                        isVisible && "rounded-b-none"
                    )}
                    type="button"
                    aria-expanded={subfilters.length > 0 ? isVisible : undefined}
                >
                    {label}
                </Button>
                {subfilters.length > 0 && (
                    <div
                        aria-hidden={!isVisible}
                        className={cn(
                            "absolute left-1/2 top-full z-50 -mt-px grid w-max min-w-full -translate-x-1/2 origin-top grid-rows-[0fr] overflow-hidden rounded-lg border border-t-0 border-border bg-popover text-popover-foreground shadow-md transition-all duration-200 ease-out motion-reduce:transition-none",
                            isVisible
                                ? "grid-rows-[1fr] translate-y-0 scale-y-100 opacity-100"
                                : "pointer-events-none -translate-y-1 scale-y-95 opacity-0"
                        )}
                    >
                        <div className="min-h-0 overflow-hidden p-1">
                            {subfilters.map((subfilter) => (
                                <Button
                                    key={subfilter.value}
                                    variant={dateRange === subfilter.value ? 'default' : 'ghost'}
                                    size="sm"
                                    allowViewer={true}
                                    onClick={() => selectDateRange(subfilter.value)}
                                    className={cn("h-8 w-max min-w-full justify-start whitespace-nowrap px-4 text-xs", dateRange === subfilter.value && "shadow-sm")}
                                    type="button"
                                    tabIndex={isVisible ? 0 : -1}
                                >
                                    {subfilter.label}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className={cn("relative rounded-2xl border border-border/70 bg-background/95 p-2.5 shadow-sm", className)}>
            {label && (
                <div className="mb-1.5 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-muted-foreground">
                    <span className={cn("h-2 w-2 rounded-full bg-primary", labelDotClassName)} />
                    {label}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
                <div className="bg-secondary/50 p-1 rounded-lg flex items-center gap-1 shadow-sm border border-border/50">
                    {renderParentRange('today', t('performance.filters.today'))}
                    {renderParentRange('month', t('performance.filters.thisMonth'))}
                    {showAllTime && (
                        <Button
                            variant={dateRange === 'allTime' ? 'default' : 'ghost'}
                            size="sm"
                            allowViewer={true}
                            onClick={() => selectDateRange('allTime')}
                            className={cn("text-xs h-8 px-4 transition-all duration-200", allTimeButtonClassName, dateRange === 'allTime' && "shadow-sm")}
                            type="button"
                        >
                            {t('performance.filters.allTime') || 'All Time'}
                        </Button>
                    )}
                    <Button
                        variant={dateRange === 'custom' ? 'default' : 'ghost'}
                        size="sm"
                        allowViewer={true}
                        onClick={() => selectDateRange('custom')}
                        className={cn("text-xs h-8 px-2.5 transition-all duration-200", dateRange === 'custom' && "shadow-sm")}
                        type="button"
                        title={t('performance.filters.custom')}
                    >
                        <Calendar className="w-3.5 h-3.5" />
                    </Button>
                </div>

                {dateRange === 'custom' && (
                    <div className="flex items-center gap-2 bg-secondary/30 p-1 px-3 rounded-lg border border-border/50 animate-in fade-in slide-in-from-left-2 duration-300">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{t('performance.filters.start')}</span>
                            <DateTimePicker
                                mode="date"
                                date={parseLocalDateValue(customDates.start)}
                                setDate={(value) => updateCustomDates({ start: value ? formatLocalDateValue(value) : '' })}
                                buttonClassName="h-8 text-xs w-36 bg-background/50 border-none focus-visible:ring-1 focus-visible:ring-primary/50 transition-all font-mono"
                                placeholder="dd/mm/yy"
                            />
                        </div>
                        <div className="w-px h-4 bg-border/50 mx-1" />
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{t('performance.filters.end')}</span>
                            <DateTimePicker
                                mode="date"
                                date={parseLocalDateValue(customDates.end)}
                                setDate={(value) => updateCustomDates({ end: value ? formatLocalDateValue(value) : '' })}
                                buttonClassName="h-8 text-xs w-36 bg-background/50 border-none focus-visible:ring-1 focus-visible:ring-primary/50 transition-all font-mono"
                                placeholder="dd/mm/yy"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
