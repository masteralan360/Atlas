import { useEffect, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/components'
import { cn, formatNumberWithCommas, parseFormattedNumber } from '@/lib/utils'
import type { CurrencyCode, IQDDisplayPreference } from '@/local-db/models'

interface MonthlyBudgetAllocationModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSave: (type: 'fixed' | 'percentage', value: number, currency: CurrencyCode) => Promise<void>
    revenue: number
    baseCurrency: CurrencyCode
    iqdPreference?: IQDDisplayPreference | boolean
    currentAllocation?: {
        type: 'fixed' | 'percentage'
        value: number
        currency: CurrencyCode
    }
}

const fieldClassName = "h-14 rounded-2xl border-border/60 bg-muted/40 text-base font-medium text-foreground transition-colors hover:bg-muted/60 focus:ring-orange-500/20 dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.09]"
const selectContentClassName = "rounded-2xl border-border/60 bg-popover/95 p-1 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/95"
const selectItemClassName = "cursor-pointer rounded-xl py-3 font-medium focus:bg-orange-500/10 focus:text-orange-600 dark:focus:bg-orange-500/15 dark:focus:text-orange-300"
const summaryLabelClassName = "text-[10px] font-black uppercase tracking-widest text-muted-foreground"

export function MonthlyBudgetAllocationModal({
    open,
    onOpenChange,
    onSave,
    revenue,
    baseCurrency,
    iqdPreference,
    currentAllocation
}: MonthlyBudgetAllocationModalProps) {
    const [type, setType] = useState<'fixed' | 'percentage'>(currentAllocation?.type || 'percentage')
    const [valueInput, setValueInput] = useState(currentAllocation?.value ? String(currentAllocation.value) : '80')
    const [currency, setCurrency] = useState<CurrencyCode>(currentAllocation?.currency || baseCurrency)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        if (open && currentAllocation) {
            setType(currentAllocation.type)
            setValueInput(String(currentAllocation.value))
            setCurrency(currentAllocation.currency)
        }
    }, [open, currentAllocation])

    const numericValue = parseFormattedNumber(valueInput) || 0
    const proposedLimit = type === 'percentage'
        ? (revenue * numericValue) / 100
        : numericValue
    const projectedSurplus = revenue - proposedLimit
    const surplusToneClass = projectedSurplus < 0
        ? 'text-rose-600 dark:text-rose-300'
        : 'text-emerald-600 dark:text-emerald-300'
    const iqdDisplayLabel = iqdPreference === 'IQD' ? 'IQD' : '\u062F.\u0639 (IQD)'

    const handleSave = async () => {
        setIsSaving(true)
        try {
            await onSave(type, numericValue, currency)
            onOpenChange(false)
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[420px] rounded-[32px] border border-border/60 bg-background/95 p-8 gap-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/95">
                <DialogHeader className="flex flex-row items-start gap-4 space-y-0 text-left">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-500 dark:bg-orange-500/15 dark:text-orange-300">
                        <TrendingUp className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <DialogTitle className="text-2xl font-black tracking-tight text-foreground">
                            Monthly Budget Allocation
                        </DialogTitle>
                        <p className="text-sm text-muted-foreground">
                            Define your spending limits for this month
                        </p>
                    </div>
                </DialogHeader>

                <div className="grid gap-6 py-2">
                    <div className="grid gap-2.5">
                        <Label className="text-sm font-semibold text-foreground">Allocation Type</Label>
                        <Select value={type} onValueChange={(value) => setType(value as 'fixed' | 'percentage')}>
                            <SelectTrigger className={cn(fieldClassName, '[&>span]:text-left')}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={selectContentClassName}>
                                <SelectItem value="fixed" className={selectItemClassName}>Fixed Amount</SelectItem>
                                <SelectItem value="percentage" className={selectItemClassName}>Percentage of Revenue</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-[1fr_140px] gap-4">
                        <div className="grid gap-2.5">
                            <Label className="text-sm font-semibold text-foreground">Amount / %</Label>
                            <div className="relative">
                                <Input
                                    value={valueInput}
                                    onChange={(e) => {
                                        const val = e.target.value
                                        if (type === 'percentage') {
                                            const numeric = parseFormattedNumber(val) || 0
                                            if (numeric > 100) {
                                                setValueInput('100')
                                                return
                                            }
                                        }
                                        setValueInput(formatNumberWithCommas(val))
                                    }}
                                    className={cn(fieldClassName, 'pr-10 text-lg font-bold tabular-nums')}
                                />
                                {type === 'percentage' && (
                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg font-bold text-muted-foreground">
                                        %
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="grid gap-2.5">
                            <Label className="text-sm font-semibold text-foreground">Currency</Label>
                            <Select value={currency} onValueChange={(value) => setCurrency(value as CurrencyCode)}>
                                <SelectTrigger className={cn(fieldClassName, 'px-3')}>
                                    <SelectValue placeholder="Select Currency" />
                                </SelectTrigger>
                                <SelectContent className={selectContentClassName}>
                                    <SelectItem value="usd" className={selectItemClassName}>USD ($)</SelectItem>
                                    <SelectItem value="eur" className={selectItemClassName}>EUR</SelectItem>
                                    <SelectItem value="try" className={selectItemClassName}>TRY</SelectItem>
                                    <SelectItem value="iqd" className={selectItemClassName}>{iqdDisplayLabel}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="rounded-[32px] border border-border/60 bg-muted/30 p-8 space-y-6 dark:border-white/10 dark:bg-white/[0.04]">
                        <div className="flex items-center justify-between">
                            <span className={summaryLabelClassName}>Proposed Budget Limit</span>
                            <div className="flex items-baseline gap-1.5">
                                <span className="text-2xl font-black text-foreground">{formatNumberWithCommas(proposedLimit.toFixed(0))}</span>
                                <span className="text-sm font-black text-foreground">{currency.toUpperCase()}</span>
                            </div>
                        </div>

                        <div className="h-px bg-border/70 dark:bg-white/10" />

                        <div className="flex items-center justify-between">
                            <span className={summaryLabelClassName}>Projected Surplus</span>
                            <div className="flex items-baseline gap-1.5">
                                <span className={cn('text-2xl font-black', surplusToneClass)}>{formatNumberWithCommas(projectedSurplus.toFixed(0))}</span>
                                <span className={cn('text-sm font-black', surplusToneClass)}>{currency.toUpperCase()}</span>
                            </div>
                        </div>

                        <p className="pt-2 text-center text-[11px] italic text-muted-foreground">
                            Remaining revenue after the proposed budget limit
                        </p>
                    </div>
                </div>

                <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="h-16 w-full rounded-2xl bg-[#10B981] text-lg font-black text-white transition-all hover:bg-[#059669] hover:shadow-lg hover:shadow-green-500/20 active:scale-[0.98]"
                >
                    {isSaving ? 'Saving...' : 'Save'}
                </Button>
            </DialogContent>
        </Dialog>
    )
}
