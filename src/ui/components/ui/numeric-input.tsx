"use client"

import * as React from "react"
import { Input } from "@/ui/components/input"
import { formatNumericInput, sanitizeNumericInput } from "@/lib/utils"

export interface NumericInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string
  onValueChange: (value: string) => void
  allowDecimal?: boolean
  maxFractionDigits?: number
}

const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  ({ value, onValueChange, allowDecimal = true, maxFractionDigits = 2, className, ...props }, ref) => {
    
    // The display value is the formatted version of the internal value
    const displayValue = React.useMemo(() => formatNumericInput(value), [value])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = e.target.value
      // Sanitize the input to get the raw numeric string (no commas, valid decimals)
      const sanitized = sanitizeNumericInput(rawValue, {
        allowDecimal,
        maxFractionDigits,
      })
      onValueChange(sanitized)
    }

    return (
      <Input
        {...props}
        ref={ref}
        value={displayValue}
        onChange={handleChange}
        className={className}
      />
    )
  }
)

NumericInput.displayName = "NumericInput"

export { NumericInput }
