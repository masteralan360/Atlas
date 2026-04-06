"use client"

import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon, Clock } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/ui/components/button"
import { Calendar } from "@/ui/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/ui/popover"
import { TimePickerInput } from "./time-picker-input"

interface DateTimePickerProps {
  date: Date | undefined
  setDate: (date: Date | undefined) => void
  placeholder?: string
}

export function DateTimePicker({ date, setDate, placeholder = "Pick date" }: DateTimePickerProps) {
  const minuteRef = React.useRef<HTMLInputElement>(null)
  const hourRef = React.useRef<HTMLInputElement>(null)
  const amPmRef = React.useRef<HTMLButtonElement>(null)
  const { t } = useTranslation()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={"outline"}
          className={cn(
            "w-full justify-start text-left font-normal h-10 px-4 rounded-xl border-border/60",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP p") : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (!d) return
            const newDate = new Date(d)
            if (date) {
                newDate.setHours(date.getHours())
                newDate.setMinutes(date.getMinutes())
            }
            setDate(newDate)
          }}
          initialFocus
        />
        <div className="flex items-center gap-3 border-t p-3 bg-secondary/5">
          <Clock className="h-4 w-4 text-muted-foreground/60" />
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase text-muted-foreground/60 px-0.5">
              {t("common.time")}
            </span>
            <div className="flex items-center gap-1.5">
              <TimePickerInput
                picker="hours"
                date={date}
                setDate={setDate}
                ref={hourRef}
                onRightFocus={() => minuteRef.current?.focus()}
              />
              <span className="text-muted-foreground/40 font-bold">:</span>
              <TimePickerInput
                picker="minutes"
                date={date}
                setDate={setDate}
                ref={minuteRef}
                onLeftFocus={() => hourRef.current?.focus()}
                onRightFocus={() => amPmRef.current?.focus()}
              />
              <div className="ml-1">
                <TimePickerInput
                  picker="12hours"
                  date={date}
                  setDate={setDate}
                  ref={amPmRef}
                  onLeftFocus={() => minuteRef.current?.focus()}
                />
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
