"use client"

import * as React from "react"
import { Calendar as CalendarIcon, Clock } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  HOUR_DISPLAY_PREFERENCE_EVENT,
  cn,
  formatDate,
  formatDateTime,
  getHourDisplayPreference,
} from "@/lib/utils"
import { Button } from "@/ui/components/button"
import { Calendar } from "@/ui/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/ui/popover"
import { TimePickerInput } from "./time-picker-input"

interface DateTimePickerProps {
  id?: string
  date: Date | undefined
  setDate: (date: Date | undefined) => void
  mode?: "date" | "date-time"
  placeholder?: string
  disabled?: boolean
  buttonClassName?: string
  contentClassName?: string
}

export function DateTimePicker({
  id,
  date,
  setDate,
  mode = "date-time",
  placeholder = "Pick date",
  disabled = false,
  buttonClassName,
  contentClassName,
}: DateTimePickerProps) {
  const minuteRef = React.useRef<HTMLInputElement>(null)
  const hourRef = React.useRef<HTMLInputElement>(null)
  const amPmRef = React.useRef<HTMLButtonElement>(null)
  const { t } = useTranslation()
  const [hourDisplayPreference, setHourDisplayPreference] = React.useState(getHourDisplayPreference)

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }

    const handlePreferenceChange = () => {
      setHourDisplayPreference(getHourDisplayPreference())
    }

    window.addEventListener(HOUR_DISPLAY_PREFERENCE_EVENT, handlePreferenceChange)
    return () => window.removeEventListener(HOUR_DISPLAY_PREFERENCE_EVENT, handlePreferenceChange)
  }, [])

  const hasTime = mode === "date-time"
  const formattedValue = React.useMemo(() => {
    if (!date) {
      return null
    }

    return hasTime ? formatDateTime(date) : formatDate(date)
  }, [date, hasTime, hourDisplayPreference])

  const handleSelectDate = (selectedDate: Date | undefined) => {
    if (!selectedDate) {
      return
    }

    const nextDate = new Date(selectedDate)
    if (hasTime) {
      const baseDate = date || new Date()
      nextDate.setHours(baseDate.getHours(), baseDate.getMinutes(), baseDate.getSeconds(), 0)
    } else {
      nextDate.setHours(0, 0, 0, 0)
    }

    setDate(nextDate)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant={"outline"}
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal h-10 px-4 rounded-xl border-border/60",
            !date && "text-muted-foreground",
            buttonClassName
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {formattedValue ? <span className="truncate">{formattedValue}</span> : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-auto rounded-2xl p-0", contentClassName)}
        align="center"
        sideOffset={8}
      >
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={date}
            onSelect={handleSelectDate}
            initialFocus
          />
          {hasTime ? (
            <div className="flex w-full items-center justify-center gap-3 border-t bg-secondary/5 p-3">
              <Clock className="h-4 w-4 text-muted-foreground/60" />
              <div className="flex flex-col gap-1.5">
                <span className="px-0.5 text-[10px] font-bold uppercase text-muted-foreground/60">
                  {t("common.time")}
                </span>
                <div className="flex items-center gap-1.5">
                  <TimePickerInput
                    picker="hours"
                    hourCycle={hourDisplayPreference === "12-hour" ? 12 : 24}
                    date={date}
                    setDate={setDate}
                    ref={hourRef}
                    onRightFocus={() => minuteRef.current?.focus()}
                  />
                  <span className="font-bold text-muted-foreground/40">:</span>
                  <TimePickerInput
                    picker="minutes"
                    date={date}
                    setDate={setDate}
                    ref={minuteRef}
                    onLeftFocus={() => hourRef.current?.focus()}
                    onRightFocus={() => amPmRef.current?.focus()}
                  />
                  {hourDisplayPreference === "12-hour" ? (
                    <div className="ml-1">
                      <TimePickerInput
                        picker="period"
                        date={date}
                        setDate={setDate}
                        ref={amPmRef}
                        onLeftFocus={() => minuteRef.current?.focus()}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
