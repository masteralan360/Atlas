import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useDragControls } from 'motion/react'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Input } from '@/ui/components/input'
import {
  Button,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/components'
import { X, RefreshCw, ArrowRightLeft, Calculator } from 'lucide-react'
import { formatCurrency, formatNumberWithCommas } from '@/lib/utils'
import type { CurrencyCode } from '@/local-db'

const STORAGE_KEY = 'currency-converter-popup-size'
const DEFAULT_WIDTH = 560
const MIN_WIDTH = 360
const MIN_HEIGHT = 300

interface CurrencyConverterPopupProps {
  open: boolean
  onClose: () => void
}

function loadSize() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return { width: parsed.width, height: parsed.height }
      }
    }
  } catch {}
  return { width: DEFAULT_WIDTH, height: null as number | null }
}

export function CurrencyConverterPopup({ open, onClose }: CurrencyConverterPopupProps) {
  const { t, i18n } = useTranslation()
  const { exchangeData, eurRates, tryRates, refresh, lastUpdated } = useExchangeRate()
  const { features } = useWorkspace()

  const dragControls = useDragControls()
  const [size, setSize] = useState(() => loadSize())
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (size.width !== DEFAULT_WIDTH || size.height !== null) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(size))
    }
  }, [size])

  const handleResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const rect = popupRef.current?.getBoundingClientRect()
    if (!rect) return
    resizeStart.current = { x: clientX, y: clientY, w: rect.width, h: rect.height }
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!resizeStart.current) return
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
      const dx = clientX - resizeStart.current.x
      const dy = clientY - resizeStart.current.y
      const vw = Math.max(MIN_WIDTH, resizeStart.current.w + dx)
      const vh = Math.max(MIN_HEIGHT, resizeStart.current.h + dy)
      setSize({ width: vw, height: vh })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      resizeStart.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleMouseMove, { passive: false })
    window.addEventListener('touchend', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleMouseMove)
      window.removeEventListener('touchend', handleMouseUp)
    }
  }, [isResizing])

  const handleDoubleClick = useCallback(() => {
    setSize({ width: DEFAULT_WIDTH, height: null })
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  const [amount, setAmount] = useState<string>('1')
  const [fromCurrency, setFromCurrency] = useState<CurrencyCode>('usd')
  const [toCurrency, setToCurrency] = useState<CurrencyCode>('iqd')
  const [result, setResult] = useState<number>(0)
  const isRtl = i18n.dir() === 'rtl'

  const handleAmountChange = (val: string) => {
    if (val === '') {
      setAmount('')
      return
    }
    const cleanVal = val.replace(/[^0-9.]/g, '')
    const parts = cleanVal.split('.')
    if (parts.length > 2) return
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

  const availableCurrencies: CurrencyCode[] = features.allowed_currencies

  const getCurrencySign = (code: string) => {
    switch (code.toLowerCase()) {
      case 'usd': return '$'
      case 'iqd': return features.iqd_display_preference === 'د.ع' ? 'د.ع' : 'IQD'
      case 'eur': return '€'
      case 'try': return '₺'
      default: return ''
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      <motion.div
        ref={popupRef}
        drag
        dragControls={dragControls}
        dragMomentum={false}
        whileDrag={{ scale: 1.02 }}
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="pointer-events-auto absolute right-4 top-4 overflow-y-auto bg-card border border-border rounded-2xl shadow-2xl"
        style={{ width: size.width, height: size.height ?? undefined }}
      >
        <div className="flex items-center justify-between p-4 pb-2 border-b border-border/50 cursor-grab active:cursor-grabbing" onPointerDown={(e) => dragControls.start(e)}>
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-primary" />
            <h2 className="text-base font-bold text-foreground">
              {t('pos.currencyConverter') || 'Currency Converter'}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refresh()}
              className="h-8 w-8 rounded-full"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 rounded-full hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-[1fr,auto,1fr] items-end gap-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">
                {t('pos.from') || 'From'}
              </Label>
              <div className="relative">
                <Input
                  type="text"
                  value={amount}
                  onChange={(e) => handleAmountChange(e.target.value)}
                  className="h-11 text-lg font-bold pl-3 pr-28 rounded-xl border-2 focus-visible:ring-primary/20 font-mono"
                  placeholder="0.00"
                />
                {!isRtl && (
                  <div className="absolute right-[105px] top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                    <span className="text-base font-bold text-muted-foreground/50 border-r border-border pr-2">
                      {getCurrencySign(fromCurrency)}
                    </span>
                  </div>
                )}
                <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                  <Select value={fromCurrency} onValueChange={(v) => setFromCurrency(v as CurrencyCode)}>
                    <SelectTrigger className="h-9 bg-muted border-none rounded-lg px-2 font-bold uppercase text-xs focus:ring-2 focus:ring-primary/20 min-w-[85px] text-center shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[200]">
                      {availableCurrencies.map(c => (
                        <SelectItem key={c} value={c}>
                          <span className="font-bold">{c.toUpperCase()}</span>
                          <span className="ml-1 text-muted-foreground font-normal">({getCurrencySign(c)})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="flex justify-center pb-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSwap}
                className="h-9 w-9 rounded-full bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20"
                title={t('pos.swap') || 'Swap Currencies'}
              >
                <ArrowRightLeft className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">
                {t('pos.to') || 'To'}
              </Label>
              <div className="relative">
                <div className="h-11 w-full bg-muted/30 border-2 border-border rounded-xl flex items-center pl-3 pr-28 text-lg font-bold text-primary">
                  {formatCurrency(result, toCurrency, features.iqd_display_preference)}
                </div>
                <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                  <Select value={toCurrency} onValueChange={(v) => setToCurrency(v as CurrencyCode)}>
                    <SelectTrigger className="h-9 bg-muted border-none rounded-lg px-2 font-bold uppercase text-xs focus:ring-2 focus:ring-primary/20 min-w-[85px] text-center shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[200]">
                      {availableCurrencies.map(c => (
                        <SelectItem key={c} value={c}>
                          <span className="font-bold">{c.toUpperCase()}</span>
                          <span className="ml-1 text-muted-foreground font-normal">({getCurrencySign(c)})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-border/50 flex flex-col items-center text-center">
            <div className="text-muted-foreground text-[10px] uppercase tracking-widest font-medium mb-0.5">
              {t('pos.result') || 'Result'}
            </div>
            <div className="text-2xl font-black text-foreground tracking-tight">
              {formatCurrency(result, toCurrency, features.iqd_display_preference)}
            </div>
            <p className="mt-0.5 text-muted-foreground text-xs font-medium">
              1 {fromCurrency.toUpperCase()} = {formatCurrency(convertPrice(1, fromCurrency, toCurrency), toCurrency, features.iqd_display_preference)}
            </p>
          </div>

          <div className="pt-2 border-t border-border/50">
            <h3 className="font-bold text-[10px] mb-2 uppercase tracking-widest opacity-50 text-center">
              Exchange Rate Sources
            </h3>
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs">
                <span className="text-muted-foreground font-medium">USD/IQD</span>
                <span className="font-bold uppercase text-primary">{exchangeData?.source || 'N/A'}</span>
              </div>
              {features.allowed_currencies.includes('eur') && eurRates.eur_iqd && (
                <div className="flex justify-between items-center text-xs border-t border-border/50 pt-1.5">
                  <span className="text-muted-foreground font-medium">EUR/IQD</span>
                  <span className="font-bold uppercase text-primary">{eurRates.eur_iqd.source}</span>
                </div>
              )}
              {features.allowed_currencies.includes('try') && tryRates.try_iqd && (
                <div className="flex justify-between items-center text-xs border-t border-border/50 pt-1.5">
                  <span className="text-muted-foreground font-medium">TRY/IQD</span>
                  <span className="font-bold uppercase text-primary">{tryRates.try_iqd.source}</span>
                </div>
              )}
            </div>
          </div>

          {lastUpdated && (
            <p className="text-[10px] text-muted-foreground/60 text-center">
              {t('settings.exchangeRate.lastUpdated') || 'Updated'}: {lastUpdated}
            </p>
          )}
        </div>

        <div
          className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize"
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
          onDoubleClick={handleDoubleClick}
        >
          <svg
            viewBox="0 0 16 16"
            className="w-4 h-4 absolute bottom-1 right-1 text-muted-foreground/40"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M13 3L3 13" />
            <path d="M13 7L7 13" />
            <path d="M13 11L11 13" />
          </svg>
        </div>
      </motion.div>
    </div>
  )
}
