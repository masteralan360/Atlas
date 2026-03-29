import * as React from "react"
import { cn } from "@/lib/utils"
import { useOptionalAuth } from "@/auth"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & { allowViewer?: boolean }>(
    ({ className, type, allowViewer = false, disabled, ...props }, ref) => {
        const user = useOptionalAuth()?.user
        const isViewer = user?.role === 'viewer'
        const effectiveDisabled = disabled || (isViewer && !allowViewer)

        return (
            <input
                type={type}
                className={cn(
                    "flex h-11 w-full rounded-xl border border-input bg-background/50 px-4 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary transition-smooth disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                    className
                )}
                ref={ref}
                disabled={effectiveDisabled}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
