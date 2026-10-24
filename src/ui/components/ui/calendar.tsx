"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CaptionLabel as DefaultCaptionLabel, DayPicker, type CaptionLabelProps } from "react-day-picker";
import { useTranslation } from "react-i18next";

import { cn, convertArabicIndicToLatin } from "@/lib/utils";
import { buttonVariants } from "@/ui/components/button";
import {
  MONTH_DISPLAY_PREFERENCE_EVENT,
  formatLocalizedMonthYear,
  getMonthDisplayPreference,
} from "@/lib/monthDisplay";

export type CalendarProps = React.ComponentProps<typeof DayPicker> & {
  showMonthNumber?: boolean
  dateField?: {
    date: Date
    onChange: (date: Date) => void
    disabled?: boolean
    isDateAllowed?: (date: Date) => boolean
  }
};

type DateFieldPart = "day" | "month" | "year"
type DateFieldValues = Record<DateFieldPart, string>

const DATE_FIELD_PARTS: DateFieldPart[] = ["day", "month", "year"]
const DateFieldContext = React.createContext<CalendarProps["dateField"]>(undefined)

function getDateFieldValues(date: Date): DateFieldValues {
  return {
    day: String(date.getDate()),
    month: String(date.getMonth() + 1),
    year: String(date.getFullYear()).padStart(4, "0"),
  }
}

function getDaysInMonth(year: number, month: number) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function DateFieldCaptionLabel(props: CaptionLabelProps) {
  const dateField = React.useContext(DateFieldContext)
  if (!dateField) {
    return <DefaultCaptionLabel {...props} />
  }

  return <DateFieldInput {...props} dateField={dateField} />
}

function DateFieldInput({
  dateField,
  ...captionProps
}: CaptionLabelProps & { dateField: NonNullable<CalendarProps["dateField"]> }) {
  const { t } = useTranslation()
  const [values, setValues] = React.useState(() => getDateFieldValues(dateField.date))
  const [activePart, setActivePart] = React.useState<DateFieldPart | null>(null)
  const inputRefs = React.useRef<Record<DateFieldPart, HTMLInputElement | null>>({
    day: null,
    month: null,
    year: null,
  })
  const rootRef = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    if (!activePart) {
      setValues(getDateFieldValues(dateField.date))
    }
  }, [activePart, dateField.date])

  const moveToPart = React.useCallback((part: DateFieldPart | undefined) => {
    if (!part) return
    const input = inputRefs.current[part]
    input?.focus()
    input?.select()
  }, [])

  const rejectInput = () => setValues({ ...values })

  const updatePart = (part: DateFieldPart, nextValue: string) => {
    const maxLength = part === "year" ? 4 : 2
    const normalizedValue = convertArabicIndicToLatin(nextValue)
    if (!/^\d*$/.test(normalizedValue)) {
      rejectInput()
      return
    }

    const nextValues = { ...values, [part]: normalizedValue.slice(0, maxLength) }

    const day = Number(nextValues.day)
    const month = Number(nextValues.month)
    const year = Number(nextValues.year)
    if (part === "day" && nextValues.day !== "" && (day > 31 || (nextValues.day.length === 2 && day < 1))) {
      rejectInput()
      return
    }
    if (part === "month" && nextValues.month !== "" && (month > 12 || (nextValues.month.length === 2 && month < 1))) {
      rejectInput()
      return
    }
    if (part === "year" && nextValues.year.length === 4 && (year < 1 || year > 9999)) {
      rejectInput()
      return
    }

    const dayIsValid = nextValues.day !== "" && day >= 1 && day <= 31
    const monthIsValid = nextValues.month !== "" && month >= 1 && month <= 12
    const yearIsValid = nextValues.year.length === 4 && year >= 1 && year <= 9999

    if (dayIsValid && monthIsValid && yearIsValid) {
      const maximumDay = getDaysInMonth(year, month)
      if (day > maximumDay && part === "day") {
        rejectInput()
        return
      }

      const validDay = Math.min(day, maximumDay)
      const nextDate = new Date(dateField.date)
      nextDate.setFullYear(year, month - 1, validDay)

      if (dateField.isDateAllowed?.(nextDate) === false) {
        rejectInput()
        return
      }

      if (validDay !== day) {
        nextValues.day = String(validDay)
      }
      dateField.onChange(nextDate)
    }

    setValues(nextValues)

    const shouldAdvance = part === "year"
      ? nextValues.year.length === 4
      : nextValues[part].length === 2

    if (shouldAdvance) {
      const partIndex = DATE_FIELD_PARTS.indexOf(part)
      moveToPart(DATE_FIELD_PARTS[partIndex + 1])
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, part: DateFieldPart) => {
    const partIndex = DATE_FIELD_PARTS.indexOf(part)
    if ((event.key === "/" || event.key === "-" || (event.key === "ArrowRight" && event.currentTarget.selectionStart === event.currentTarget.value.length)) && partIndex < DATE_FIELD_PARTS.length - 1) {
      event.preventDefault()
      moveToPart(DATE_FIELD_PARTS[partIndex + 1])
    } else if ((event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0) || (event.key === "Backspace" && event.currentTarget.value === "")) {
      if (partIndex > 0) {
        event.preventDefault()
        moveToPart(DATE_FIELD_PARTS[partIndex - 1])
      }
    }
  }

  const labelForPart: Record<DateFieldPart, string> = {
    day: t("common.dateField.day"),
    month: t("common.dateField.month"),
    year: t("common.dateField.year"),
  }

  return (
    <span
      {...captionProps}
      ref={rootRef}
      dir="ltr"
      className={cn(captionProps.className, "inline-flex items-center justify-center gap-0.5 tabular-nums")}
      onBlur={(event) => {
        captionProps.onBlur?.(event)
        if (!(event.relatedTarget instanceof Node) || !rootRef.current?.contains(event.relatedTarget)) {
          setActivePart(null)
        }
      }}
      aria-label={t("common.date")}
    >
      {DATE_FIELD_PARTS.map((part, index) => (
        <React.Fragment key={part}>
          {index > 0 ? <span aria-hidden="true" className="text-muted-foreground/70">/</span> : null}
          <input
            ref={(input) => { inputRefs.current[part] = input }}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={part === "year" ? 4 : 2}
            aria-label={labelForPart[part]}
            disabled={dateField.disabled}
            value={values[part]}
            className={cn(
              "h-7 rounded-sm border-0 bg-transparent p-0 text-center text-sm font-medium text-foreground outline-none focus:bg-primary/10 focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50",
              part === "year" ? "w-[2.8rem]" : "w-[1.35rem]"
            )}
            onFocus={(event) => {
              setActivePart(part)
              event.currentTarget.select()
            }}
            onChange={(event) => updatePart(part, event.currentTarget.value)}
            onKeyDown={(event) => handleKeyDown(event, part)}
          />
        </React.Fragment>
      ))}
    </span>
  )
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  showMonthNumber = false,
  dateField,
  ...props
}: CalendarProps) {
  const { i18n } = useTranslation()
  const [preference, setPreference] = React.useState(getMonthDisplayPreference)

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }

    const handlePreferenceChange = () => {
      setPreference(getMonthDisplayPreference())
    }

    window.addEventListener(MONTH_DISPLAY_PREFERENCE_EVENT, handlePreferenceChange)
    return () => window.removeEventListener(MONTH_DISPLAY_PREFERENCE_EVENT, handlePreferenceChange)
  }, [])

  const formatMonthCaption = React.useCallback(
    (month: Date) => {
      const caption = formatLocalizedMonthYear(month, i18n.language, preference)
      return showMonthNumber
        ? `${caption} · ${String(month.getMonth() + 1).padStart(2, "0")}`
        : caption
    },
    [i18n.language, preference, showMonthNumber]
  )

  return (
    <DateFieldContext.Provider value={dateField}>
      <DayPicker
        showOutsideDays={showOutsideDays}
        className={cn("p-3", className)}
        classNames={{
          months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
          month: "space-y-4",
          month_caption: "flex justify-center pt-1 relative items-center h-9 w-full",
          caption_label: "text-sm font-medium",
          nav: "flex items-center",
          button_previous: cn(
            buttonVariants({ variant: "outline" }),
            "h-8 w-8 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-1 top-1 z-30"
          ),
          button_next: cn(
            buttonVariants({ variant: "outline" }),
            "h-8 w-8 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-1 top-1 z-30"
          ),
          month_grid: "w-full border-collapse space-y-1",
          weekdays: "flex",
          weekday:
            "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
          week: "flex w-full mt-2",
          day: "h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
          day_button: cn(
            buttonVariants({ variant: "ghost" }),
            "h-9 w-9 p-0 font-normal aria-selected:opacity-100 hover:bg-primary/10 hover:text-primary"
          ),
          range_end: "day-range-end",
          selected:
            "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
          today: "bg-accent text-accent-foreground",
          outside:
            "day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
          disabled: "text-muted-foreground opacity-50",
          range_middle:
            "aria-selected:bg-accent aria-selected:text-accent-foreground",
          hidden: "invisible",
          ...classNames,
        }}
        components={{
          ...props.components,
          Chevron: ({ orientation }) => {
            if (orientation === "left") {
              return <ChevronLeft className="h-4 w-4" />;
            }
            return <ChevronRight className="h-4 w-4" />;
          },
          ...(dateField ? { CaptionLabel: DateFieldCaptionLabel } : {}),
        }}
        {...props}
        formatters={{
          formatMonthCaption,
          ...props.formatters,
        }}
      />
    </DateFieldContext.Provider>
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
