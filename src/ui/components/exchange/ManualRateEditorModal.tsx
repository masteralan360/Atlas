'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components';
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useTranslation } from 'react-i18next';
import { Coins, Save, X, Info } from 'lucide-react';
import { useExchangeRate } from '@/context/ExchangeRateContext';
import { useTheme } from '../theme-provider';
import { clearManualExchangeRate, setManualExchangeRate } from '@/lib/manualExchangeRates';

interface ManualRateEditorModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialCurrency?: 'USD' | 'EUR' | 'TRY';
}

export function ManualRateEditorModal({ open, onOpenChange, initialCurrency = 'USD' }: ManualRateEditorModalProps) {
    const { t } = useTranslation();
    const { style } = useTheme();
    const { allRates, refresh: refreshRates } = useExchangeRate();
    const [currency, setCurrency] = useState<'USD' | 'EUR' | 'TRY'>(initialCurrency);
    const [rate, setRate] = useState<string>('');
    const inputRef = useRef<HTMLInputElement>(null);
    const cursorPos = useRef<number | null>(null);

    const formatWithCommas = (val: string) => {
        const digits = val.replace(/\D/g, '');
        if (!digits) return '';
        return parseInt(digits).toLocaleString('en-US');
    };

    // Fix cursor position after formatting
    useEffect(() => {
        if (inputRef.current && cursorPos.current !== null) {
            inputRef.current.setSelectionRange(cursorPos.current, cursorPos.current);
            cursorPos.current = null;
        }
    });

    const lastOpenedInitialCurrency = useRef<string | null>(null);



    useEffect(() => {
        if (open) {
            // Only force-sync with initialCurrency if it changed or it's a fresh open
            if (lastOpenedInitialCurrency.current !== initialCurrency) {
                setCurrency(initialCurrency);
                const savedRate = localStorage.getItem(`manual_rate_${initialCurrency.toLowerCase()}_iqd`) || '';
                setRate(formatWithCommas(savedRate));
                lastOpenedInitialCurrency.current = initialCurrency;
            }
        } else {
            lastOpenedInitialCurrency.current = null;
        }
    }, [open, initialCurrency]);

    const handleCurrencyChange = (val: string) => {
        const cur = val as 'USD' | 'EUR' | 'TRY';
        setCurrency(cur);
        const saved = localStorage.getItem(`manual_rate_${cur.toLowerCase()}_iqd`) || '';
        setRate(formatWithCommas(saved));
    };

    const handleRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const target = e.target;
        const rawValue = target.value;

        const digits = rawValue.replace(/\D/g, '');
        const formattedValue = formatWithCommas(digits);

        // Calculate cursor position adjustment
        const originalCursor = target.selectionStart || 0;

        setRate(formattedValue);


        // Simple heuristic for cursor: if we added a comma before the cursor, shift it
        // Or better: just calculate based on length difference if input was at the end
        if (originalCursor === rawValue.length) {
            cursorPos.current = formattedValue.length;
        } else {
            // For middle-string edits, we try to stay at the same character
            // This is complex, but usually, just letting React handle it or shifting corectly works.
            // For now, let's just use length for end-edits and keep selection for others.
            cursorPos.current = originalCursor + (formattedValue.length - rawValue.length);
        }
    };

    const getPlaceholder = () => {
        let avg: number | undefined;
        if (currency === 'USD') avg = allRates?.usd_iqd?.average;
        else if (currency === 'EUR') avg = allRates?.eur_iqd?.average;
        else if (currency === 'TRY') avg = allRates?.try_iqd?.average;

        if (avg) return t('exchange.averagePlaceholder', { rate: avg.toLocaleString() });
        return t('exchange.enterNumber');
    };

    const handleSave = async () => {
        const rateVal = parseInt(rate.replace(/,/g, ''));

        if (isNaN(rateVal) || rateVal <= 0) {
            // If empty or 0, switch back to live source for this currency
            clearManualExchangeRate(currency);

            onOpenChange(false);
            refreshRates();
            return;
        }

        setManualExchangeRate(currency, rateVal);

        // Refresh and close
        onOpenChange(false);
        refreshRates();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent showCloseButton={false} className={cn(
                    "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
                    "max-w-md p-0 overflow-hidden",
                    style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-2xl border-emerald-500/20"
                )}>
                    <DialogPrimitive.Description className="sr-only">Manual Exchange Rate Editor</DialogPrimitive.Description>

                    <DialogHeader className="p-6 border-b bg-emerald-500/5 items-start text-start">
                        <DialogTitle className="flex items-center gap-2 text-emerald-600">
                            <Coins className="w-5 h-5" />
                            {t('exchange.manualEntryTitle')}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="p-6 space-y-6">
                        <div className="space-y-2">
                            <Label>{t('common.currency', 'Currency')}</Label>
                            <Select value={currency} onValueChange={handleCurrencyChange}>
                                <SelectTrigger className="h-12 text-lg">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="USD">USD/IQD</SelectItem>
                                    <SelectItem value="EUR">EUR/IQD</SelectItem>
                                    <SelectItem value="TRY">TRY/IQD</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label>{t('exchange.manualRate')}</Label>
                            <div className="relative">
                                <Input
                                    ref={inputRef}
                                    value={rate}
                                    onChange={handleRateChange}
                                    placeholder={getPlaceholder()}
                                    className="h-14 text-2xl font-bold tracking-tight pl-4 pr-16"
                                    type="text"
                                    autoFocus
                                />
                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">
                                    IQD
                                </div>
                            </div>
                            <div className="text-xs text-muted-foreground flex items-start gap-1">
                                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>{t('exchange.manualRateHint')}</span>
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="p-4 bg-secondary/30 gap-2">
                        <Button
                            variant="ghost"
                            className={cn(
                                "flex-1 h-12 font-bold",
                                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white" : "rounded-xl"
                            )}
                            onClick={() => onOpenChange(false)}
                        >
                            <X className="w-4 h-4 mr-2" />
                            {t('common.cancel')}
                        </Button>
                        <Button
                            className={cn(
                                "flex-1 h-12 font-black",
                                style === 'neo-orange' ? "rounded-[var(--radius)] bg-emerald-500 text-black border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-xl bg-emerald-500 hover:bg-emerald-600"
                            )}
                            onClick={handleSave}
                        >
                            <Save className="w-4 h-4 mr-2" />
                            {t('common.save')}
                        </Button>
                    </DialogFooter>

                    <DialogPrimitive.Close className="absolute right-4 top-4 rtl:right-auto rtl:left-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground z-[70]">
                        <X className="h-4 w-4" />
                        <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
            </DialogContent>
        </Dialog>
    );
}
