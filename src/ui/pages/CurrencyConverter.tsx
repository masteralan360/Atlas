import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Input,
    Label,
} from '@/ui/components'
import {
    ArrowLeft,
    RefreshCw,
    ArrowRightLeft,
    Calculator,
} from 'lucide-react'
import { formatCurrency, formatNumberWithCommas } from '@/lib/utils'
import type { CurrencyCode } from '@/local-db'

export function CurrencyConverter() {
    const { t } = useTranslation()
    const [, setLocation] = useLocation()
    const { exchangeData, eurRates, tryRates, refresh, lastUpdated } = useExchangeRate()
    const { features } = useWorkspace()

    const [amount, setAmount] = useState<string>('1')
    const [fromCurrency, setFromCurrency] = useState<CurrencyCode>('usd')
    const [toCurrency, setToCurrency] = useState<CurrencyCode>('iqd')
    const [result, setResult] = useState<number>(0)

    const handleBack = () => {
        if (window.history.length > 2) {
            window.history.back()
        } else {
            setLocation('/')
        }
    }

    const handleAmountChange = (val: string) => {
        if (val === '') {
            setAmount('')
            return
        }
        // Only allow numbers and one decimal point
        const cleanVal = val.replace(/[^0-9.]/g, '')
        const parts = cleanVal.split('.')
        if (parts.length > 2) return // Don't allow multiple dots

        // Format with commas
        const formatted = formatNumberWithCommas(parts[0]) + (parts.length > 1 ? '.' + parts[1] : '')
        setAmount(formatted)
    }

    const convertPrice = useCallback((amountValue: number, from: CurrencyCode, to: CurrencyCode) => {
        if (from === to) return amountValue

        const getRate = (pair: 'usd_iqd' | 'usd_eur' | 'eur_iqd') => {
            if (pair === 'usd_iqd') return exchangeData ? exchangeData.rate / 100 : null
            if (pair === 'usd_eur') return eurRates.usd_eur ? eurRates.usd_eur.rate / 100 : null
            if (pair === 'eur_iqd') return eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            return null
        }

        let converted = amountValue

        if (from === 'usd' && to === 'iqd') {
            const r = getRate('usd_iqd'); if (r) converted = amountValue * r
        } else if (from === 'iqd' && to === 'usd') {
            const r = getRate('usd_iqd'); if (r) converted = amountValue / r
        } else if (from === 'usd' && to === 'eur') {
            const r = getRate('usd_eur'); if (r) converted = amountValue * r
        } else if (from === 'eur' && to === 'usd') {
            const r = getRate('usd_eur'); if (r) converted = amountValue / r
        } else if (from === 'eur' && to === 'iqd') {
            const r = getRate('eur_iqd'); if (r) converted = amountValue * r
        } else if (from === 'iqd' && to === 'eur') {
            const r = getRate('eur_iqd'); if (r) converted = amountValue / r
        } else if (from === 'try' && to === 'iqd') {
            if (tryRates.try_iqd) converted = amountValue * (tryRates.try_iqd.rate / 100)
        } else if (from === 'iqd' && to === 'try') {
            if (tryRates.try_iqd) converted = amountValue / (tryRates.try_iqd.rate / 100)
        } else if (from === 'usd' && to === 'try') {
            if (tryRates.usd_try) converted = amountValue * (tryRates.usd_try.rate / 100)
        } else if (from === 'try' && to === 'usd') {
            if (tryRates.usd_try) converted = amountValue / (tryRates.usd_try.rate / 100)
        } else if (from === 'try' && to === 'eur') {
            const tryIqdRate = tryRates.try_iqd ? tryRates.try_iqd.rate / 100 : null
            const eurIqdRate = eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            if (tryIqdRate && eurIqdRate) converted = (amountValue * tryIqdRate) / eurIqdRate
        } else if (from === 'eur' && to === 'try') {
            const eurIqdRate = eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            const tryIqdRate = tryRates.try_iqd ? tryRates.try_iqd.rate / 100 : null
            if (eurIqdRate && tryIqdRate) converted = (amountValue * eurIqdRate) / tryIqdRate
        }

        return to === 'iqd' ? Math.round(converted) : Math.round(converted * 100) / 100
    }, [exchangeData, eurRates, tryRates])

    useEffect(() => {
        const numAmount = parseFloat(amount.replace(/,/g, '')) || 0
        setResult(convertPrice(numAmount, fromCurrency, toCurrency))
    }, [amount, fromCurrency, toCurrency, convertPrice])

    const handleSwap = () => {
        setFromCurrency(toCurrency)
        setToCurrency(fromCurrency)
    }

    const availableCurrencies: CurrencyCode[] = ['usd', 'iqd']
    if (features.eur_conversion_enabled) availableCurrencies.push('eur')
    if (features.try_conversion_enabled) availableCurrencies.push('try')

    return (
        <div className="min-h-[calc(100vh-4rem)] flex flex-col gap-6 p-6 max-w-4xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleBack}
                        className="rounded-full"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                            <Calculator className="w-6 h-6 text-primary" />
                            {t('pos.currencyConverter') || 'Currency Converter'}
                        </h1>
                        <p className="text-muted-foreground text-sm">
                            Real-time exchange rates
                        </p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refresh()}
                    className="gap-2 text-xs font-medium"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {lastUpdated ? `${t('settings.exchangeRate.lastUpdated') || 'Updated'}: ${lastUpdated}` : t('settings.exchangeRate.refresh') || 'Refresh'}
                </Button>
            </div>

            {/* Main Converter Card */}
            <div className="grid gap-6">
                <div className="bg-card border border-border rounded-2xl p-8 shadow-xl shadow-primary/5 space-y-8 relative overflow-hidden">
                    {/* Background Decorative Element */}
                    <div className="absolute -top-24 -right-24 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none" />

                    <div className="grid md:grid-cols-[1fr,auto,1fr] items-end gap-6 relative">
                        {/* From */}
                        <div className="space-y-3">
                            <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground/70">
                                {t('pos.from') || 'From'}
                            </Label>
                            <div className="relative group">
                                <Input
                                    type="text"
                                    value={amount}
                                    onChange={(e) => handleAmountChange(e.target.value)}
                                    className="h-16 text-2xl font-bold pl-4 pr-24 rounded-xl border-2 focus-visible:ring-primary/20 transition-all"
                                    placeholder="0.00"
                                />
                                <select
                                    value={fromCurrency}
                                    onChange={(e) => setFromCurrency(e.target.value as CurrencyCode)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 h-12 bg-muted border-none rounded-lg px-3 font-bold uppercase text-sm focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer hover:bg-muted/80 transition-colors min-w-[80px] text-center"
                                >
                                    {availableCurrencies.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {/* Swap Button */}
                        <div className="flex justify-center pb-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleSwap}
                                className="h-12 w-12 rounded-full bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shadow-sm transition-transform active:scale-90"
                                title={t('pos.swap') || 'Swap Currencies'}
                            >
                                <ArrowRightLeft className="w-6 h-6" />
                            </Button>
                        </div>

                        {/* To */}
                        <div className="space-y-3">
                            <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground/70">
                                {t('pos.to') || 'To'}
                            </Label>
                            <div className="relative group">
                                <div className="h-16 w-full bg-muted/30 border-2 border-border rounded-xl flex items-center pl-4 pr-24 text-2xl font-bold text-primary transition-all">
                                    {formatCurrency(result, toCurrency, features.iqd_display_preference)}
                                </div>
                                <select
                                    value={toCurrency}
                                    onChange={(e) => setToCurrency(e.target.value as CurrencyCode)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 h-12 bg-muted border-none rounded-lg px-3 font-bold uppercase text-sm focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer hover:bg-muted/80 transition-colors min-w-[80px] text-center"
                                >
                                    {availableCurrencies.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Quick Result Summary */}
                    <div className="pt-6 border-t border-border/50 flex flex-col items-center text-center">
                        <div className="text-muted-foreground text-sm uppercase tracking-widest font-medium mb-1">
                            {t('pos.result') || 'Result'}
                        </div>
                        <div className="text-4xl md:text-5xl font-black text-foreground tracking-tight">
                            {formatCurrency(result, toCurrency, features.iqd_display_preference)}
                        </div>
                        <p className="mt-2 text-muted-foreground text-sm font-medium">
                            1 {fromCurrency.toUpperCase()} = {formatCurrency(convertPrice(1, fromCurrency, toCurrency), toCurrency, features.iqd_display_preference)}
                        </p>
                    </div>
                </div>

                {/* Info Grid */}
                <div className="grid md:grid-cols-1 gap-6">
                    <div className="bg-card border border-border rounded-2xl p-6 flex flex-col justify-center">
                        <h3 className="font-bold text-xs mb-3 uppercase tracking-widest opacity-50 text-center">Exchange Rate Sources</h3>
                        <div className="space-y-2.5">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground font-medium">USD/IQD</span>
                                <span className="font-bold uppercase text-primary">{exchangeData?.source || 'N/A'}</span>
                            </div>
                            {features.eur_conversion_enabled && eurRates.eur_iqd && (
                                <div className="flex justify-between items-center text-sm border-t border-border/50 pt-2">
                                    <span className="text-muted-foreground font-medium">EUR/IQD</span>
                                    <span className="font-bold uppercase text-primary">{eurRates.eur_iqd.source}</span>
                                </div>
                            )}
                            {features.try_conversion_enabled && tryRates.try_iqd && (
                                <div className="flex justify-between items-center text-sm border-t border-border/50 pt-2">
                                    <span className="text-muted-foreground font-medium">TRY/IQD</span>
                                    <span className="font-bold uppercase text-primary">{tryRates.try_iqd.source}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
