import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useOptionalAuth } from "@/auth"

const Checkbox = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean, onCheckedChange?: (checked: boolean) => void, allowViewer?: boolean }>(
    ({ className, checked, onCheckedChange, allowViewer = false, disabled, ...props }, ref) => {
        const user = useOptionalAuth()?.user
        const isViewer = user?.role === 'viewer'
        const effectiveDisabled = disabled || (isViewer && !allowViewer)

        return (
            <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                ref={ref}
                disabled={effectiveDisabled}
                onClick={() => onCheckedChange?.(!checked)}
                className={cn(
                    "peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
                    checked ? "bg-primary text-primary-foreground" : "bg-transparent",
                    className
                )}
                {...props}
            >
                {checked && (
                    <div className={cn("flex items-center justify-center text-current")}>
                        <Check className="h-3 w-3" strokeWidth={3} />
                    </div>
                )}
            </button>
        )
    }
)
Checkbox.displayName = "Checkbox"

export { Checkbox }
