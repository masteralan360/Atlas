"use client"

import * as React from "react"
import { Input } from "@/ui/components/input"
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select"

export interface TimePickerInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  picker: "hours" | "minutes" | "12hours"
  date: Date | undefined
  setDate: (date: Date | undefined) => void
  onRightFocus?: () => void
  onLeftFocus?: () => void
}

const TimePickerInput = React.forwardRef<
  HTMLInputElement | HTMLButtonElement,
  TimePickerInputProps
>(
  (
    {
      className,
      type = "tel",
      value,
      id,
      name,
      date,
      setDate,
      onChange,
      onKeyDown,
      picker,
      onLeftFocus,
      onRightFocus,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation()

    /**
     * compute current value from date
     */
    const calculatedValue = React.useMemo(() => {
      if (!date) return "00"
      if (picker === "hours") return date.getHours().toString().padStart(2, "0")
      if (picker === "minutes") return date.getMinutes().toString().padStart(2, "0")
      if (picker === "12hours") {
        const hours = date.getHours()
        const isPM = hours >= 12
        return isPM ? "PM" : "AM"
      }
      return "00"
    }, [date, picker])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Tab") return
      if (picker === "12hours") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "a" || e.key === "p" || e.key === "A" || e.key === "P") {
          e.preventDefault()
          const isPM = date ? date.getHours() >= 12 : false
          const newDate = new Date(date || new Date())
          if (isPM) newDate.setHours(newDate.getHours() - 12)
          else newDate.setHours(newDate.getHours() + 12)
          setDate(newDate)
        }
        return
      }

      if (e.key === "ArrowRight") onRightFocus?.()
      if (e.key === "ArrowLeft") onLeftFocus?.()
      if (["ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault()
        const step = e.key === "ArrowUp" ? 1 : -1
        const newValue = parseInt(calculatedValue) + step
        if (picker === "hours") {
          const newDate = new Date(date || new Date())
          newDate.setHours((newValue + 24) % 24)
          setDate(newDate)
        } else if (picker === "minutes") {
          const newDate = new Date(date || new Date())
          newDate.setMinutes((newValue + 60) % 60)
          setDate(newDate)
        }
      }
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (picker === "12hours") return
      const val = e.target.value.slice(-2)
      const num = parseInt(val)
      if (isNaN(num)) return

      const newDate = new Date(date || new Date())
      if (picker === "hours") {
        newDate.setHours(num % 24)
      } else {
        newDate.setMinutes(num % 60)
      }
      setDate(newDate)
      if (val.length === 2) onRightFocus?.()
    }

    if (picker === "12hours") {
      return (
        <Select
          value={date ? (date.getHours() >= 12 ? "PM" : "AM") : "AM"}
          onValueChange={(value) => {
            if (!date) return
            const newDate = new Date(date)
            const currentHours = newDate.getHours()
            if (value === "PM" && currentHours < 12) {
              newDate.setHours(currentHours + 12)
            } else if (value === "AM" && currentHours >= 12) {
              newDate.setHours(currentHours - 12)
            }
            setDate(newDate)
          }}
        >
          <SelectTrigger
            ref={ref as React.Ref<HTMLButtonElement>}
            className={cn(
              "w-[100px] text-center font-mono text-base tabular-nums focus:bg-accent focus:text-accent-foreground px-2",
              className
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AM">{t("common.am")}</SelectItem>
            <SelectItem value="PM">{t("common.pm")}</SelectItem>
          </SelectContent>
        </Select>
      )
    }

    return (
      <Input
        ref={ref as React.Ref<HTMLInputElement>}
        id={id || picker}
        name={name || picker}
        role="spinbutton"
        aria-valuemax={picker === "hours" ? 23 : 59}
        aria-valuemin={0}
        className={cn(
          "w-[48px] text-center font-mono text-base tabular-nums focus:bg-accent focus:text-accent-foreground rounded-lg h-9 border-border/40 px-1",
          className
        )}
        value={calculatedValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        type={type}
        inputMode="decimal"
        {...props}
      />
    )
  }
)

TimePickerInput.displayName = "TimePickerInput"

export { TimePickerInput }
