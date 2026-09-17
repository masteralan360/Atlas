import * as React from "react"
import { cn, convertArabicIndicToLatin, formatDate, formatDateTime, formatTime, sanitizeNumericInput } from "@/lib/utils"
import { useOptionalAuth } from "@/auth"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & { allowViewer?: boolean }>(
    ({ className, type, allowViewer = false, disabled, onChange, onWheel, value, defaultValue, placeholder, inputMode, lang, dir, step, ...props }, ref) => {
        const user = useOptionalAuth()?.user
        const isViewer = user?.role === 'viewer'
        const effectiveDisabled = disabled || (isViewer && !allowViewer)
        const isFormattedNativeInput = type === 'date' || type === 'datetime-local' || type === 'time'
        const isNativeNumberInput = type === 'number'
        const numericStep = step === 'any' ? Number.NaN : Number(step)
        const allowsDecimals = step === 'any' || (step !== undefined && Number.isFinite(numericStep) && !Number.isInteger(numericStep))
        // Windows can replace digits inside native number controls based on a
        // user's regional setting after focus leaves the field. Use a text
        // control with a numeric keyboard instead, so Atlas owns the rendered
        // value and always shows Latin digits.
        const renderedInputType = isNativeNumberInput ? 'text' : type
        const resolvedInputMode = isNativeNumberInput ? inputMode ?? (allowsDecimals ? 'decimal' : 'numeric') : inputMode
        const usesNumericKeyboard = isNativeNumberInput || resolvedInputMode === 'numeric' || resolvedInputMode === 'decimal'
        const numericLanguage = usesNumericKeyboard ? 'en' : lang
        // Direction remains inherited from the selected app language (RTL for
        // Arabic/Kurdish, LTR for English); only the numeric language is fixed.
        const numericDirection = dir

        const getInitialValue = React.useCallback(() => {
            const raw = typeof value === 'string' ? value :
                       typeof defaultValue === 'string' ? defaultValue :
                       typeof value === 'number' ? String(value) :
                       typeof defaultValue === 'number' ? String(defaultValue) : ''
            
            return type !== 'password' ? convertArabicIndicToLatin(raw) : raw
        }, [defaultValue, value, type])

        const [displaySourceValue, setDisplaySourceValue] = React.useState(getInitialValue)

        React.useEffect(() => {
            if (value !== undefined) {
                setDisplaySourceValue(getInitialValue())
            }
        }, [getInitialValue, value])

        const getFormattedDisplayValue = React.useCallback((rawValue: string) => {
            if (!rawValue) {
                if (placeholder) return placeholder
                if (type === 'date') return 'dd/mm/yy'
                if (type === 'datetime-local') return 'dd/mm/yy --:--'
                if (type === 'time') return '--:--'
                return ''
            }

            if (type === 'date') {
                return formatDate(rawValue)
            }

            if (type === 'datetime-local') {
                return formatDateTime(rawValue)
            }

            if (type === 'time') {
                const match = rawValue.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
                if (!match) return rawValue

                const parsed = new Date()
                parsed.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0)
                return formatTime(parsed, { includeSeconds: Boolean(match[3]) })
            }

            return rawValue
        }, [placeholder, type])

        const inputClasses = cn(
            "flex h-11 w-full rounded-xl border border-border/80 bg-background/80 px-4 py-2 text-base shadow-sm shadow-black/[0.03] ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground transition-all hover:border-primary/45 hover:bg-background focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-background/50 md:text-sm",
            className
        )

        const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
            if (type !== 'password') {
                event.target.value = convertArabicIndicToLatin(event.target.value)
            }

            if (isNativeNumberInput) {
                event.target.value = sanitizeNumericInput(event.target.value, {
                    allowDecimal: allowsDecimals,
                    maxFractionDigits: 20
                })
            }

            if (isFormattedNativeInput) {
                setDisplaySourceValue(event.target.value)
            }
            onChange?.(event)
        }

        const handleWheel = (event: React.WheelEvent<HTMLInputElement>) => {
            if (isNativeNumberInput) {
                (event.target as HTMLInputElement).blur()
            }
            onWheel?.(event)
        }

        if (isFormattedNativeInput) {
            const displayValue = getFormattedDisplayValue(displaySourceValue)

            return (
                <div className="relative">
                    <input
                        type={renderedInputType}
                        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                        ref={ref}
                        disabled={effectiveDisabled}
                        onChange={handleChange}
                        onWheel={handleWheel}
                        value={value}
                        defaultValue={defaultValue}
                        placeholder={placeholder}
                        inputMode={resolvedInputMode}
                        lang={numericLanguage}
                        dir={numericDirection}
                        step={isNativeNumberInput ? undefined : step}
                        {...props}
                    />
                    <div
                        className={cn(
                            inputClasses,
                            "pointer-events-none items-center overflow-hidden whitespace-nowrap",
                            "peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:border-primary",
                            effectiveDisabled && "opacity-50"
                        )}
                    >
                        <span className={displaySourceValue ? 'text-foreground' : 'text-muted-foreground'}>
                            {displayValue}
                        </span>
                    </div>
                </div>
            )
        }

        return (
            <input
                type={renderedInputType}
                className={inputClasses}
                ref={ref}
                disabled={effectiveDisabled}
                onChange={handleChange}
                onWheel={handleWheel}
                value={value}
                defaultValue={defaultValue}
                placeholder={placeholder}
                inputMode={resolvedInputMode}
                lang={numericLanguage}
                dir={numericDirection}
                step={isNativeNumberInput ? undefined : step}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
