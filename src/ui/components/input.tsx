import * as React from "react"
import { cn, formatDate, formatDateTime, formatTime } from "@/lib/utils"
import { useOptionalAuth } from "@/auth"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & { allowViewer?: boolean }>(
    ({ className, type, allowViewer = false, disabled, onChange, value, defaultValue, placeholder, ...props }, ref) => {
        const user = useOptionalAuth()?.user
        const isViewer = user?.role === 'viewer'
        const effectiveDisabled = disabled || (isViewer && !allowViewer)
        const isFormattedNativeInput = type === 'date' || type === 'datetime-local' || type === 'time'

        const getInitialValue = React.useCallback(() => {
            if (typeof value === 'string') return value
            if (typeof defaultValue === 'string') return defaultValue
            if (typeof value === 'number') return String(value)
            if (typeof defaultValue === 'number') return String(defaultValue)
            return ''
        }, [defaultValue, value])

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
            "flex h-11 w-full rounded-xl border border-input bg-background/50 px-4 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary transition-smooth disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            className
        )

        const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
            if (isFormattedNativeInput) {
                setDisplaySourceValue(event.target.value)
            }
            onChange?.(event)
        }

        if (isFormattedNativeInput) {
            const displayValue = getFormattedDisplayValue(displaySourceValue)

            return (
                <div className="relative">
                    <input
                        type={type}
                        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                        ref={ref}
                        disabled={effectiveDisabled}
                        onChange={handleChange}
                        value={value}
                        defaultValue={defaultValue}
                        placeholder={placeholder}
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
                type={type}
                className={inputClasses}
                ref={ref}
                disabled={effectiveDisabled}
                onChange={handleChange}
                value={value}
                defaultValue={defaultValue}
                placeholder={placeholder}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
