import { useState, useEffect } from 'react'
import { TrendingUp } from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Button,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    CurrencySelector
} from '@/ui/components'
import { formatNumberWithCommas, parseFormattedNumber } from '@/lib/utils'
import type { CurrencyCode } from '@/local-db/models'

interface MonthlyBudgetAllocationModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSave: (type: 'fixed' | 'percentage', value: number, currency: CurrencyCode) => Promise<void>
    revenue: number
    baseCurrency: CurrencyCode
    iqdPreference?: "IQD" | "د.ع" | boolean
    currentAllocation?: {
        type: 'fixed' | 'percentage'
        value: number
        currency: CurrencyCode
    }
}

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
            <DialogContent className="sm:max-w-[420px] rounded-[32px] p-8 gap-6 border-none shadow-2xl">
                <DialogHeader className="flex flex-row items-start gap-4 space-y-0">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-orange-500">
                        <TrendingUp className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <DialogTitle className="text-2xl font-black tracking-tight text-[#0F172A]">
                            Monthly Budget Allocation
                        </DialogTitle>
                        <p className="text-sm text-slate-400">
                            Define your spending limits for this month
                        </p>
                    </div>
                </DialogHeader>

                <div className="grid gap-6 py-2">
                    <div className="grid gap-2.5">
                        <Label className="text-sm font-semibold text-[#0F172A]">Allocation Type</Label>
                        <Select value={type} onValueChange={(v: any) => setType(v)}>
                            <SelectTrigger className="h-14 rounded-2xl border-slate-100 bg-slate-50/50 text-base font-medium transition-all hover:bg-slate-50 focus:ring-orange-500/20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-2xl border-slate-100 p-1">
                                <SelectItem value="fixed" className="rounded-xl py-3 font-medium focus:bg-orange-50 focus:text-orange-600 cursor-pointer">Fixed Amount</SelectItem>
                                <SelectItem value="percentage" className="rounded-xl py-3 font-medium focus:bg-orange-50 focus:text-orange-600 cursor-pointer">Percentage of Revenue</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-[1fr_140px] gap-4">
                        <div className="grid gap-2.5">
                            <Label className="text-sm font-semibold text-[#0F172A]">Amount / %</Label>
                            <div className="relative">
                                <Input
                                    value={valueInput}
                                    onChange={(e) => setValueInput(formatNumberWithCommas(e.target.value))}
                                    className="h-14 rounded-2xl border-slate-100 bg-slate-50/50 pr-10 text-lg font-bold transition-all hover:bg-slate-50 focus:ring-orange-500/20"
                                />
                                {type === 'percentage' && (
                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg font-bold text-slate-300">
                                        %
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="grid gap-2.5">
                            <Label className="text-sm font-semibold text-[#0F172A]">Currency</Label>
                            <div className="h-14">
                                <CurrencySelector 
                                    value={currency} 
                                    onChange={setCurrency} 
                                    iqdDisplayPreference={iqdPreference ? "د.ع" : "IQD"}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="rounded-[32px] border border-slate-100 bg-slate-50/30 p-8 space-y-6">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Proposed Budget Limit</span>
                            <div className="flex items-baseline gap-1.5">
                                <span className="text-2xl font-black text-[#0F172A]">{formatNumberWithCommas(proposedLimit.toFixed(0))}</span>
                                <span className="text-sm font-black text-[#0F172A]">{currency.toUpperCase()}</span>
                            </div>
                        </div>

                        <div className="h-px bg-slate-100" />

                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Projected Surplus</span>
                            <div className="flex items-baseline gap-1.5">
                                <span className="text-2xl font-black text-[#10B981]">{formatNumberWithCommas(projectedSurplus.toFixed(0))}</span>
                                <span className="text-sm font-black text-[#10B981]">{currency.toUpperCase()}</span>
                            </div>
                        </div>

                        <p className="text-[11px] italic text-slate-400 text-center pt-2">
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
