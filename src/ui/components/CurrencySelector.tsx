import { useEffect } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Label } from './label'
import type { CurrencyCode } from '@/local-db/models'
import { useWorkspace } from '@/workspace'
import { ChevronDown } from 'lucide-react'
import { Button } from './button'
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface CurrencySelectorCommonProps {
    label?: string
    iqdDisplayPreference?: 'IQD' | 'د.ع'
    disabled?: boolean
    allowedCurrencies?: CurrencyCode[]
}

type CurrencySelectorProps = CurrencySelectorCommonProps & (
    | {
        multiple?: false
        value: CurrencyCode
        onChange: (value: CurrencyCode) => void
    }
    | {
        multiple: true
        value: CurrencyCode[]
        onChange: (value: CurrencyCode[]) => void
        allLabel: string
        multipleLabel: string
    }
)

const CURRENCY_LABELS: Record<string, { label: string; symbol: string }> = {
    usd: { label: 'USD', symbol: '$' },
    eur: { label: 'EUR', symbol: '€' },
    try: { label: 'TRY', symbol: '₺' },
    iqd: { label: 'IQD', symbol: '' }
}

function getCurrencyLabel(code: CurrencyCode, iqdDisplayPreference: 'IQD' | 'د.ع') {
    if (code === 'iqd') return iqdDisplayPreference === 'IQD' ? 'IQD' : 'د.ع (IQD)'
    const info = CURRENCY_LABELS[code]
    return info ? `${info.label} (${info.symbol})` : code.toUpperCase()
}

export function CurrencySelector(props: CurrencySelectorProps) {
    const { features } = useWorkspace()
    const defaultCurrency = features.default_currency || 'usd'

    useEffect(() => {
        if (props.multiple) return
        if (!props.allowedCurrencies && features.allowed_currencies.length <= 1 && props.value !== defaultCurrency) {
            props.onChange(defaultCurrency)
        }
    }, [features.allowed_currencies, props.allowedCurrencies, props.multiple, props.onChange, props.value, defaultCurrency])

    if (!props.allowedCurrencies && features.allowed_currencies.length <= 1) {
        return null
    }

    const currencies = props.allowedCurrencies ?? features.allowed_currencies

    if (props.multiple) {
        const selectionLabel = props.value.length === 0
            ? props.allLabel
            : props.value.length === 1
                ? getCurrencyLabel(props.value[0], props.iqdDisplayPreference ?? 'IQD')
                : props.multipleLabel

        return (
            <div className="space-y-2">
                {props.label && <Label>{props.label}</Label>}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button type="button" variant="outline" disabled={props.disabled} className="w-full justify-between font-normal" title={selectionLabel}>
                            <span className="truncate">{selectionLabel}</span>
                            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
                        <DropdownMenuCheckboxItem
                            checked={props.value.length === 0}
                            onCheckedChange={() => props.onChange([])}
                            onSelect={(event) => event.preventDefault()}
                            disabled={props.disabled}
                        >
                            {props.allLabel}
                        </DropdownMenuCheckboxItem>
                        {currencies.map((code) => (
                            <DropdownMenuCheckboxItem
                                key={code}
                                checked={props.value.includes(code)}
                                onCheckedChange={(checked) => props.onChange(
                                    checked
                                        ? props.value.includes(code) ? props.value : [...props.value, code]
                                        : props.value.filter((selectedCode) => selectedCode !== code),
                                )}
                                onSelect={(event) => event.preventDefault()}
                                disabled={props.disabled}
                            >
                                {getCurrencyLabel(code, props.iqdDisplayPreference ?? 'IQD')}
                            </DropdownMenuCheckboxItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        )
    }

    return (
        <div className="space-y-2">
            {props.label && <Label>{props.label}</Label>}
            <Select value={props.value} onValueChange={(v) => props.onChange(v as CurrencyCode)} disabled={props.disabled}>
                <SelectTrigger allowViewer={true}>
                    <SelectValue placeholder="Select Currency" />
                </SelectTrigger>
                <SelectContent>
                    {currencies.map((code) => {
                        return (
                            <SelectItem key={code} value={code}>
                                {getCurrencyLabel(code, props.iqdDisplayPreference ?? 'IQD')}
                            </SelectItem>
                        )
                    })}
                </SelectContent>
            </Select>
        </div>
    )
}
