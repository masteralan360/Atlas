import { useState } from 'react'
import { RefreshCw, Globe, AlertCircle, Loader2, Calculator, Coins, X, Pencil, AlertTriangle, Plus, NotebookPen } from 'lucide-react'
import { useLocation } from 'wouter'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useWorkspace } from '@/workspace'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useTheme } from './theme-provider'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from './dialog'
import { Button } from './button'

// Component for showing offline/error state for a specific currency
function CurrencyOfflineRow({ currency, isMobile }: { currency: 'USD' | 'EUR' | 'TRY', isMobile: boolean }) {
    const { t } = useTranslation()

    const handleAddManually = (e: React.MouseEvent) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent('open-manual-rate-editor', { detail: { currency } }))
    }

    // Desktop: compact inline display (same size as regular currency rows)
    if (!isMobile) {
        return (
            <div className="flex items-center gap-1.5 text-amber-600">
                <span className="w-px h-3 bg-amber-500/30" />
                <AlertTriangle className="w-3 h-3" />
                <span>{currency}/IQD:</span>
                <button
                    onClick={handleAddManually}
                    className="text-[10px] underline underline-offset-2 hover:text-amber-500 transition-colors"
                >
                    + {t('exchange.addManual', 'Add')}
                </button>
            </div>
        )
    }

    // Mobile: full row with button
    return (
        <div className="w-full flex justify-between items-center p-3 border-t border-amber-500/20 rounded-xl bg-amber-500/5">
            <div className="flex flex-col items-start gap-1">
                <span className="text-amber-600 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {currency}/IQD: {t('exchange.sourceOffline', 'Source Offline')}
                </span>
                <span className="text-[10px] text-amber-600/70">{t('exchange.addManualFallback', 'Add a rate manually')}</span>
            </div>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 rounded-full bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700"
                onClick={handleAddManually}
            >
                <Plus className="w-3.5 h-3.5 mr-1" />
                {t('exchange.addManual', 'Add')}
            </Button>
        </div>
    )
}

export function ExchangeRateList({ isMobile = false }: { isMobile?: boolean }) {
    const { exchangeData, eurRates, tryRates, status, currencyStatus, lastUpdated, allRates } = useExchangeRate()
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const { style } = useTheme()

    // Primary currency status determines overall indicator color
    // Desktop: Always green if USD works (even if secondary currencies are offline)
    // Only show red if ALL currencies fail
    const usdWorks = currencyStatus.usd !== 'error' && !!exchangeData
    const isLoading = status === 'loading'
    const allFailed = currencyStatus.usd === 'error' &&
        (!features.eur_conversion_enabled || currencyStatus.eur === 'error') &&
        (!features.try_conversion_enabled || currencyStatus.try === 'error')

    return (
        <div className={cn(
            "flex items-center gap-2 px-3 py-1.5 transition-all border w-fit",
            style === 'neo-orange' ? "neo-indicator" : cn(
                "rounded-full",
                !isLoading && usdWorks && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
                !isLoading && !usdWorks && !allFailed && 'bg-amber-500/10 border-amber-500/20 text-amber-600',
                !isLoading && allFailed && 'bg-red-500/10 border-red-500/20 text-red-500',
                isLoading && 'bg-secondary border-border text-muted-foreground'
            ),
            isMobile && "flex-col items-start rtl:items-start rounded-xl p-2 w-full gap-2 border-none bg-transparent"
        )}>
            <div className="flex items-center gap-2">
                {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : usdWorks ? (
                    <Globe className="w-4 h-4" />
                ) : allFailed ? (
                    <AlertCircle className="w-4 h-4" />
                ) : (
                    <AlertTriangle className="w-4 h-4" />
                )}
                {isMobile && <span className="font-bold text-sm uppercase tracking-wider">{t('common.exchangeRates')}</span>}
            </div>


            <div className={cn(
                "text-xs font-bold font-mono flex items-center gap-3",
                isMobile && "flex-col items-start rtl:items-start text-base w-full gap-4"
            )}>
                {isLoading ? (
                    <span>{t('common.loading')}</span>
                ) : (
                    <>
                        {/* USD/IQD Section */}
                        {currencyStatus.usd === 'error' ? (
                            <CurrencyOfflineRow currency="USD" isMobile={isMobile} />
                        ) : exchangeData && (
                            <div className={cn("flex items-center gap-2", isMobile && "w-full justify-between p-3 rounded-xl hover:bg-emerald-500/5 transition-colors")}>
                                <div className="flex flex-col items-start gap-1">
                                    <span>USD/IQD: {exchangeData.rate.toLocaleString()}</span>
                                    {isMobile && allRates?.usd_iqd?.average && (
                                        <span className="text-[10px] text-muted-foreground">{t('exchange.marketAverage')}: {allRates.usd_iqd.average.toLocaleString()}</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] opacity-70 font-normal uppercase">
                                        {exchangeData.source === 'manual' ? t('exchange.manual') : exchangeData.source}
                                    </span>
                                    {isMobile && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 rounded-full"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                window.dispatchEvent(new CustomEvent('open-manual-rate-editor', { detail: { currency: 'USD' } }));
                                            }}
                                        >
                                            <Pencil className="w-3.5 h-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* EUR/IQD Section */}
                        {features.eur_conversion_enabled && (
                            currencyStatus.eur === 'error' ? (
                                <CurrencyOfflineRow currency="EUR" isMobile={isMobile} />
                            ) : eurRates.eur_iqd && (
                                <div className={cn("flex items-center gap-3", isMobile && "w-full justify-between p-3 border-t border-emerald-500/10 rounded-xl hover:bg-emerald-500/5 transition-colors")}>
                                    {!isMobile && <span className="w-px h-3 bg-current/20" />}
                                    <div className="flex flex-col items-start gap-1">
                                        <span>EUR/IQD: {eurRates.eur_iqd.rate.toLocaleString()}</span>
                                        {isMobile && allRates?.eur_iqd?.average && (
                                            <span className="text-[10px] text-muted-foreground">{t('exchange.marketAverage')}: {allRates.eur_iqd.average.toLocaleString()}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] opacity-70 font-normal uppercase">
                                            {eurRates.eur_iqd.source === 'manual' ? t('exchange.manual') : eurRates.eur_iqd.source}
                                        </span>
                                        {isMobile && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-full"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    window.dispatchEvent(new CustomEvent('open-manual-rate-editor', { detail: { currency: 'EUR' } }));
                                                }}
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            )
                        )}

                        {/* TRY/IQD Section */}
                        {features.try_conversion_enabled && (
                            currencyStatus.try === 'error' ? (
                                <CurrencyOfflineRow currency="TRY" isMobile={isMobile} />
                            ) : tryRates.try_iqd && (
                                <div className={cn("flex items-center gap-3", isMobile && "w-full justify-between p-3 border-t border-emerald-500/10 rounded-xl hover:bg-emerald-500/5 transition-colors")}>
                                    {!isMobile && <span className="w-px h-3 bg-current/20" />}
                                    <div className="flex flex-col items-start gap-1">
                                        <span>TRY/IQD: {tryRates.try_iqd.rate.toLocaleString()}</span>
                                        {isMobile && allRates?.try_iqd?.average && (
                                            <span className="text-[10px] text-muted-foreground">{t('exchange.marketAverage')}: {allRates.try_iqd.average.toLocaleString()}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] opacity-70 font-normal uppercase">
                                            {tryRates.try_iqd.source === 'manual' ? t('exchange.manual') : tryRates.try_iqd.source}
                                        </span>
                                        {isMobile && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-full"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    window.dispatchEvent(new CustomEvent('open-manual-rate-editor', { detail: { currency: 'TRY' } }));
                                                }}
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            )
                        )}
                    </>
                )}
            </div>

            <div className={cn("flex items-center gap-2", isMobile && "mt-auto w-full pt-4 border-t border-emerald-500/20 justify-between")}>
                {!isLoading && (usdWorks || !allFailed) && (
                    <div className={cn(
                        "w-1.5 h-1.5 rounded-full animate-pulse",
                        usdWorks ? "bg-emerald-500" : "bg-amber-500"
                    )} />
                )}


                {!isLoading && lastUpdated && (
                    <span className="text-[10px] font-medium opacity-60">
                        {lastUpdated}
                    </span>
                )}
            </div>
        </div>
    )
}

export function ExchangeRateIndicator() {
    const [location, setLocation] = useLocation()
    const { status, refresh } = useExchangeRate()
    const { t, i18n } = useTranslation()
    const { style } = useTheme()
    const [isOpen, setIsOpen] = useState(false)
    const direction = i18n.dir()
    const isCurrencyConverterPage = location === '/currency-converter'
    const isNotebookPage = location === '/notebook'

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <div className="flex items-center gap-2">
                {/* Desktop View */}
                <div className="hidden md:flex items-center gap-2">
                    <button
                        onClick={() => setLocation('/notebook')}
                        className={cn(
                            "p-1.5 hover:bg-secondary border transition-all group",
                            style === 'neo-orange'
                                ? "rounded-[var(--radius)] border-black dark:border-white bg-white dark:bg-black"
                                : "rounded-lg hover:bg-secondary border-transparent hover:border-border",
                            isNotebookPage && "border-border bg-secondary text-foreground"
                        )}
                        title={t('notebook.label') || 'Notebook'}
                    >
                        <NotebookPen className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </button>

                    <button
                        onClick={() => setLocation('/currency-converter')}
                        className={cn(
                            "p-1.5 hover:bg-secondary border transition-all group",
                            style === 'neo-orange'
                                ? "rounded-[var(--radius)] border-black dark:border-white bg-white dark:bg-black"
                                : "rounded-lg hover:bg-secondary border-transparent hover:border-border",
                            isCurrencyConverterPage && "border-border bg-secondary text-foreground"
                        )}
                        title="Currency Converter"
                    >
                        <Calculator className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </button>

                    <DialogTrigger asChild>
                        <div className="cursor-pointer hover:opacity-80 transition-opacity">
                            <ExchangeRateList />
                        </div>
                    </DialogTrigger>

                    <button
                        onClick={refresh}
                        disabled={status === 'loading'}
                        className={cn(
                            "p-1.5 border transition-all group",
                            style === 'neo-orange' ? "rounded-[var(--radius)] border-black dark:border-white bg-white dark:bg-black" : "rounded-lg hover:bg-secondary border-transparent hover:border-border",
                            status === 'loading' && "opacity-50 cursor-not-allowed"
                        )}
                        title="Refresh Exchange Rate"
                    >
                        <RefreshCw className={cn(
                            "w-4 h-4 transition-transform",
                            style === 'neo-orange' ? "text-black dark:text-white" : "text-muted-foreground group-hover:text-foreground",
                            status === 'loading' && "animate-spin"
                        )} />
                    </button>
                </div>

                {/* Mobile View */}
                <div className="md:hidden flex items-center gap-2">
                    <DialogTrigger asChild>
                        <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                                "flex items-center gap-2 h-9 px-3 transition-all",
                                style === 'neo-orange' ? "neo-indicator" : cn(
                                    "rounded-full border-emerald-500/20 bg-emerald-500/5 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-600",
                                    status === 'loading' && "opacity-70 animate-pulse",
                                    status === 'error' && "border-red-500/20 bg-red-500/5 text-red-500 hover:text-red-600"
                                )
                            )}
                        >
                            <Globe className={cn("w-4 h-4", status === 'loading' && "animate-spin")} />
                            <span className="text-xs font-bold uppercase tracking-tight">Live Rate</span>
                        </Button>
                    </DialogTrigger>

                    <Button
                        variant="outline"
                        size="icon"
                        className={cn(
                            "h-9 w-9 rounded-full transition-all",
                            style === 'neo-orange'
                                ? "rounded-[var(--radius)] border-black dark:border-white bg-white dark:bg-black"
                                : cn(
                                    "border-border/70 bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
                                    isNotebookPage && "border-primary/20 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                                )
                        )}
                        onClick={() => setLocation('/notebook')}
                        title={t('notebook.label') || 'Notebook'}
                    >
                        <NotebookPen className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <DialogContent dir={direction} className={cn(
                "max-w-[calc(100vw-2rem)] sm:max-w-md p-0 overflow-hidden shadow-2xl animate-in zoom-in duration-300",
                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-2xl border-emerald-500/20"
            )}>
                <DialogHeader className="p-6 border-b bg-emerald-500/5 items-start rtl:items-start text-start rtl:text-start relative overflow-hidden">
                    {/* Decorative background for modal header */}
                    <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full -mr-12 -mt-12 blur-2xl" />

                    <DialogTitle className="flex items-center gap-2 text-emerald-600 font-black tracking-tight text-xl">
                        <Coins className="w-6 h-6" />
                        {t('common.exchangeRates')}
                    </DialogTitle>
                </DialogHeader>

                <div className="p-2">
                    <ExchangeRateList isMobile />
                </div>

                <div className="p-4 bg-secondary/30 flex flex-col gap-2 border-t">
                    <div className="flex gap-2 w-full">
                        <Button
                            variant="outline"
                            className="flex-1 rounded-xl h-11 font-bold shadow-sm"
                            onClick={() => {
                                setIsOpen(false)
                                setLocation('/currency-converter')
                            }}
                        >
                            <Calculator className="w-4 h-4 mr-2 opacity-60" />
                            Converter
                        </Button>
                        <Button
                            className="flex-1 rounded-xl h-11 bg-emerald-500 hover:bg-emerald-600 text-white font-black shadow-lg shadow-emerald-500/20"
                            onClick={() => refresh()}
                            disabled={status === 'loading'}
                        >
                            <RefreshCw className={cn("w-4 h-4 mr-2", status === 'loading' && "animate-spin")} />
                            {t('common.refresh')}
                        </Button>
                    </div>
                    <Button
                        variant="ghost"
                        className="w-full text-muted-foreground h-10 hover:bg-transparent"
                        onClick={() => setIsOpen(false)}
                    >
                        <X className="w-4 h-4 mr-2 opacity-40" />
                        {t('common.done')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
