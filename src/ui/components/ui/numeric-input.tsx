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
  ({ value, onValueChange, allowDecimal = true, maxFractionDigits = 2, className, inputMode, dir, onFocus, onBlur, ...props }, ref) => {
    const [isEditing, setIsEditing] = React.useState(false)

    // Grouping separators are helpful when reviewing a value but make mobile
    // decimal keyboards and cursor placement unreliable while editing.
    const displayValue = isEditing ? value : formatNumericInput(value)

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = e.target.value
      const sanitized = sanitizeNumericInput(rawValue, {
        allowDecimal,
        maxFractionDigits,
        // The edit view never contains grouping commas, so a comma entered by
        // the keyboard is unambiguously a locale-specific decimal separator.
        commaAsDecimal: allowDecimal,
      })
      onValueChange(sanitized)
    }

    const handleFocus = (event: React.FocusEvent<HTMLInputElement>) => {
      setIsEditing(true)
      onFocus?.(event)
    }

    const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
      setIsEditing(false)
      onBlur?.(event)
    }

    return (
      <Input
        {...props}
        type="text"
        ref={ref}
        value={displayValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        inputMode={inputMode ?? (allowDecimal ? "decimal" : "numeric")}
        lang="en"
        dir={dir ?? "ltr"}
        className={className}
      />
    )
  }
)

NumericInput.displayName = "NumericInput"

export { NumericInput }
