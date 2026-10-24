"use client"

import * as React from "react"
import { Calendar as CalendarIcon, Clock } from "lucide-react"
import { dateMatchModifiers } from "react-day-picker"
import { useTranslation } from "react-i18next"

import {
  HOUR_DISPLAY_PREFERENCE_EVENT,
  cn,
  formatDate,
  formatDateTime,
  formatTime,
  getHourDisplayPreference,
} from "@/lib/utils"
import { Button } from "@/ui/components/button"
import { Calendar, type CalendarProps } from "@/ui/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/ui/popover"
import { isTauri } from "@/lib/platform"
import { TimePickerInput } from "./time-picker-input"

interface DateTimePickerProps {
  id?: string
  date: Date | undefined
  setDate: (date: Date | undefined) => void
  mode?: "date" | "date-time" | "time"
  placeholder?: string
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  buttonClassName?: string
  contentClassName?: string
  calendarProps?: Omit<CalendarProps, "mode" | "selected" | "onSelect" | "initialFocus">
  calendarFooter?: React.ReactNode
  showQuickActions?: boolean
}

export function DateTimePicker({
  id,
  date,
  setDate,
  mode = "date-time",
  placeholder = "Pick date",
  disabled = false,
  open,
  onOpenChange,
  buttonClassName,
  contentClassName,
  calendarProps,
  calendarFooter,
  showQuickActions = true,
}: DateTimePickerProps) {
  const minuteRef = React.useRef<HTMLInputElement>(null)
  const hourRef = React.useRef<HTMLInputElement>(null)
  const amPmRef = React.useRef<HTMLButtonElement>(null)
  const { t } = useTranslation()
  const [hourDisplayPreference, setHourDisplayPreference] = React.useState(getHourDisplayPreference)
  const [today] = React.useState(() => new Date())
  const [calendarMonth, setCalendarMonth] = React.useState(() => date ? new Date(date) : new Date(today))

  React.useEffect(() => {
    if (date) {
      setCalendarMonth(new Date(date))
    }
  }, [date])

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

  const hasDate = mode !== "time"
  const hasTime = mode !== "date"
  const formattedValue = React.useMemo(() => {
    if (!date) {
      return null
    }

    if (!hasDate) return formatTime(date, { preference: hourDisplayPreference })
    return hasTime ? formatDateTime(date) : formatDate(date)
  }, [date, hasDate, hasTime, hourDisplayPreference])

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

  const isDateFieldDateAllowed = React.useCallback((candidate: Date) => {
    const disabledDates = calendarProps?.disabled
    if (disabledDates && dateMatchModifiers(candidate, disabledDates)) {
      return false
    }

    const candidateMonth = candidate.getFullYear() * 12 + candidate.getMonth()
    const startMonth = calendarProps?.startMonth
    const endMonth = calendarProps?.endMonth
    if (startMonth && candidateMonth < startMonth.getFullYear() * 12 + startMonth.getMonth()) {
      return false
    }
    if (endMonth && candidateMonth > endMonth.getFullYear() * 12 + endMonth.getMonth()) {
      return false
    }

    return true
  }, [calendarProps?.disabled, calendarProps?.endMonth, calendarProps?.startMonth])

  const dateFieldDisabled = Boolean(
    disabled ||
    calendarProps?.disableNavigation ||
    calendarProps?.hideNavigation ||
    calendarProps?.month
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant={"outline"}
          disabled={disabled}
          className={cn(
            "w-full min-w-0 justify-start gap-2 text-start font-normal h-10 px-4 rounded-xl border-border/60",
            !date && "text-muted-foreground",
            buttonClassName
          )}
        >
          {hasDate ? <CalendarIcon className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
          {formattedValue
            ? <span className="min-w-0 truncate">{formattedValue}</span>
            : <span className="min-w-0 truncate">{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-auto rounded-2xl p-0", contentClassName)}
        align="center"
        sideOffset={8}
        collisionPadding={isTauri() ? { top: 56, bottom: 8, left: 8, right: 8 } : 8}
      >
        <div className="flex flex-col items-center">
          {hasDate ? (
            <Calendar
              {...calendarProps}
              dateField={{
                date: date ?? today,
                onChange: handleSelectDate,
                disabled: dateFieldDisabled,
                isDateAllowed: isDateFieldDateAllowed,
              }}
              month={calendarProps?.month ?? calendarMonth}
              onMonthChange={(month) => {
                calendarProps?.onMonthChange?.(month)
                setCalendarMonth(month)
              }}
              showMonthNumber
              mode="single"
              selected={date}
              onSelect={handleSelectDate}
              initialFocus
            />
          ) : null}
          {hasDate && calendarFooter ? (
            <div className="w-full border-t border-border/50 bg-secondary/10 p-3">
              {calendarFooter}
            </div>
          ) : null}
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
          {showQuickActions ? (
            <div className="flex w-full items-center justify-between border-t border-border/50 bg-secondary/10 p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setDate(undefined)}
              >
                {t("common.reset", { defaultValue: "Reset" })}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-3 text-xs font-medium bg-background border shadow-sm"
                onClick={() => hasDate ? handleSelectDate(new Date()) : setDate(new Date())}
              >
                {hasDate
                  ? t("common.today", { defaultValue: "Today" })
                  : t("common.now", { defaultValue: "Now" })}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
