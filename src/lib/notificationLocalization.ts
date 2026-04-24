type NotificationPayload = Record<string, unknown> | null | undefined

export type NotificationLanguage = 'en' | 'ar' | 'ku'

export type NotificationLocalizationInput = {
  notificationType: string
  payload?: NotificationPayload
  title?: string | null
  body?: string | null
  actionUrl?: string | null
  actionLabel?: string | null
}

export type NotificationLocalizationResult = {
  language: NotificationLanguage
  title: string
  body: string
  actionLabel: string
  actionUrl: string | null
  typeLabel: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toPayload(payload?: NotificationPayload): Record<string, unknown> {
  return isRecord(payload) ? payload : {}
}

function toLocale(language: NotificationLanguage): string {
  if (language === 'ar') return 'ar-IQ'
  if (language === 'ku') return 'ckb-IQ'
  return 'en-US'
}

function formatNumber(value: number, language: NotificationLanguage): string {
  try {
    return new Intl.NumberFormat(toLocale(language), { maximumFractionDigits: 2 }).format(value)
  } catch {
    return String(value)
  }
}

function formatAmount(value: number | null, currency: string, language: NotificationLanguage): string {
  if (value === null) return ''
  const formatted = formatNumber(value, language)
  const normalizedCurrency = readString(currency).toUpperCase()
  return normalizedCurrency ? `${formatted} ${normalizedCurrency}` : formatted
}

function formatDate(value: string, language: NotificationLanguage): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat(toLocale(language), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date)
  } catch {
    return value
  }
}

function formatMonth(value: string, language: NotificationLanguage): string {
  if (!/^\d{4}-\d{2}$/.test(value)) return value
  const date = new Date(`${value}-01T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat(toLocale(language), {
      year: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(date)
  } catch {
    return value
  }
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.map((part) => readString(part)).filter(Boolean).join(' | ')
}

function formatNotificationTypeFallback(notificationType: string): string {
  return notificationType
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function normalizeNotificationLanguage(value?: string | null): NotificationLanguage {
  const normalized = readString(value).toLowerCase()
  if (normalized === 'ar' || normalized.startsWith('ar-')) return 'ar'
  if (normalized === 'ku' || normalized.startsWith('ku-') || normalized === 'ckb' || normalized.startsWith('ckb-')) return 'ku'
  return 'en'
}

export function localizeNotification(input: NotificationLocalizationInput, requestedLanguage?: string | null): NotificationLocalizationResult {
  const language = normalizeNotificationLanguage(requestedLanguage)
  const payload = toPayload(input.payload)
  const actionUrl = readString(input.actionUrl) || readString(payload.route) || null
  const fallbackTitle = readString(input.title) || formatNotificationTypeFallback(input.notificationType)
  const fallbackBody = readString(input.body)
  const fallbackActionLabel = readString(input.actionLabel) || (language === 'ar' ? '\u0641\u062a\u062d' : language === 'ku' ? '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5' : 'Open')

  if (input.notificationType === 'marketplace_order_pending') {
    const orderNumber = readString(payload.order_number)
    const customerName = readString(payload.customer_name)
    const itemCount = readNumber(payload.item_count)
    const amountText = formatAmount(readNumber(payload.amount), readString(payload.currency), language)

    if (language === 'ar') {
      return {
        language,
        title: orderNumber ? `\u0637\u0644\u0628 \u0645\u062a\u062c\u0631 \u0645\u0639\u0644\u0642 ${orderNumber}` : '\u0637\u0644\u0628 \u0645\u062a\u062c\u0631 \u0645\u0639\u0644\u0642',
        body: joinParts([
          customerName,
          itemCount !== null ? `${formatNumber(itemCount, language)} \u0639\u0646\u0635\u0631` : '',
          amountText,
        ]) || fallbackBody,
        actionLabel: '\u0641\u062a\u062d \u0627\u0644\u0637\u0644\u0628',
        actionUrl,
        typeLabel: '\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631',
      }
    }

    if (language === 'ku') {
      return {
        language,
        title: orderNumber ? `\u062f\u0627\u0648\u0627\u06a9\u0627\u0631\u06cc\u06cc \u0628\u0627\u0632\u0627\u0695\u06cc \u0686\u0627\u0648\u06d5\u0695\u0648\u0627\u0646 ${orderNumber}` : '\u062f\u0627\u0648\u0627\u06a9\u0627\u0631\u06cc\u06cc \u0628\u0627\u0632\u0627\u0695\u06cc \u0686\u0627\u0648\u06d5\u0695\u0648\u0627\u0646',
        body: joinParts([
          customerName,
          itemCount !== null ? `${formatNumber(itemCount, language)} \u06a9\u0627\u0695\u0627` : '',
          amountText,
        ]) || fallbackBody,
        actionLabel: '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5\u06cc \u062f\u0627\u0648\u0627\u06a9\u0627\u0631\u06cc',
        actionUrl,
        typeLabel: '\u062f\u0627\u0648\u0627\u06a9\u0627\u0631\u06cc\u06cc\u06d5\u06a9\u0627\u0646\u06cc \u0628\u0627\u0632\u0627\u0695',
      }
    }

    return {
      language,
      title: orderNumber ? `Pending marketplace order ${orderNumber}` : 'Pending marketplace order',
      body: joinParts([
        customerName,
        itemCount !== null ? `${formatNumber(itemCount, language)} item${itemCount === 1 ? '' : 's'}` : '',
        amountText,
      ]) || fallbackBody,
      actionLabel: 'Open order',
      actionUrl,
      typeLabel: 'Marketplace Orders',
    }
  }

  if (input.notificationType === 'loan_installment_overdue') {
    const loanNo = readString(payload.loan_no)
    const borrowerName = readString(payload.borrower_name)
    const overdueInstallmentCount = readNumber(payload.overdue_installment_count)
    const amountText = formatAmount(readNumber(payload.amount), readString(payload.currency), language)

    if (language === 'ar') {
      return {
        language,
        title: loanNo ? `\u0627\u0644\u0642\u0631\u0636 ${loanNo} \u0644\u062f\u064a\u0647 \u0623\u0642\u0633\u0627\u0637 \u0645\u062a\u0623\u062e\u0631\u0629` : '\u0623\u0642\u0633\u0627\u0637 \u0642\u0631\u0636 \u0645\u062a\u0623\u062e\u0631\u0629',
        body: joinParts([
          borrowerName,
          overdueInstallmentCount !== null ? `${formatNumber(overdueInstallmentCount, language)} \u0642\u0633\u0637 \u0645\u062a\u0623\u062e\u0631` : '',
          amountText,
        ]) || fallbackBody,
        actionLabel: '\u0641\u062a\u062d \u0627\u0644\u0623\u0642\u0633\u0627\u0637',
        actionUrl,
        typeLabel: '\u0623\u0642\u0633\u0627\u0637 \u0627\u0644\u0642\u0631\u0648\u0636',
      }
    }

    if (language === 'ku') {
      return {
        language,
        title: loanNo ? `\u0642\u06d5\u0631\u0632\u06cc ${loanNo} \u0642\u06cc\u0633\u062a\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648 \u0647\u06d5\u06cc\u06d5` : '\u0642\u06cc\u0633\u062a\u06cc \u0642\u06d5\u0631\u0632 \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648',
        body: joinParts([
          borrowerName,
          overdueInstallmentCount !== null ? `${formatNumber(overdueInstallmentCount, language)} \u0642\u0633\u0637\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648` : '',
          amountText,
        ]) || fallbackBody,
        actionLabel: '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5\u06cc \u0642\u06cc\u0633\u062a\u06d5\u06a9\u0627\u0646',
        actionUrl,
        typeLabel: '\u0642\u06cc\u0633\u062a\u06d5\u06a9\u0627\u0646\u06cc \u0642\u06d5\u0631\u0632',
      }
    }

    return {
      language,
      title: loanNo ? `Loan ${loanNo} has overdue installments` : 'Overdue loan installments',
      body: joinParts([
        borrowerName,
        overdueInstallmentCount !== null ? `${formatNumber(overdueInstallmentCount, language)} overdue installment${overdueInstallmentCount === 1 ? '' : 's'}` : '',
        amountText,
      ]) || fallbackBody,
      actionLabel: 'Open installments',
      actionUrl,
      typeLabel: 'Loan Installments',
    }
  }

  if (input.notificationType === 'expense_item_overdue') {
    const seriesName = readString(payload.series_name)
    const categoryLabel = readString(payload.subcategory) || readString(payload.category)
    const amountText = formatAmount(readNumber(payload.amount), readString(payload.currency), language)
    const dueDate = formatDate(readString(payload.due_date), language)

    if (language === 'ar') {
      return {
        language,
        title: seriesName ? `\u0645\u0635\u0631\u0648\u0641 \u0645\u062a\u0623\u062e\u0631: ${seriesName}` : '\u0645\u0635\u0631\u0648\u0641 \u0645\u062a\u0623\u062e\u0631',
        body: joinParts([
          categoryLabel,
          amountText,
          dueDate ? `\u0627\u0644\u0627\u0633\u062a\u062d\u0642\u0627\u0642 ${dueDate}` : '',
        ]) || fallbackBody,
        actionLabel: '\u0641\u062a\u062d \u0627\u0644\u0645\u064a\u0632\u0627\u0646\u064a\u0629',
        actionUrl,
        typeLabel: '\u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a \u0627\u0644\u0645\u062a\u0623\u062e\u0631\u0629',
      }
    }

    if (language === 'ku') {
      return {
        language,
        title: seriesName ? `\u062e\u06d5\u0631\u062c\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648: ${seriesName}` : '\u062e\u06d5\u0631\u062c\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648',
        body: joinParts([
          categoryLabel,
          amountText,
          dueDate ? `\u0628\u06d5\u0631\u0648\u0627\u0631\u06cc ${dueDate}` : '',
        ]) || fallbackBody,
        actionLabel: '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5\u06cc \u0628\u0648\u062f\u062c\u06d5',
        actionUrl,
        typeLabel: '\u062e\u06d5\u0631\u062c\u06cc\u06cc\u06d5 \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648\u06d5\u06a9\u0627\u0646',
      }
    }

    return {
      language,
      title: seriesName ? `Overdue expense: ${seriesName}` : 'Overdue expense',
      body: joinParts([
        categoryLabel,
        amountText,
        dueDate ? `Due ${dueDate}` : '',
      ]) || fallbackBody,
      actionLabel: 'Open budget',
      actionUrl,
      typeLabel: 'Overdue Expenses',
    }
  }

  if (input.notificationType === 'payroll_overdue') {
    const employeeName = readString(payload.employee_name)
    const employeeRole = readString(payload.employee_role)
    const amountText = formatAmount(readNumber(payload.amount), readString(payload.currency), language)
    const monthLabel = formatMonth(readString(payload.month), language)

    if (language === 'ar') {
      return {
        language,
        title: employeeName ? `\u0631\u0627\u062a\u0628 \u0645\u062a\u0623\u062e\u0631 \u0644\u0640 ${employeeName}` : '\u0631\u0627\u062a\u0628 \u0645\u062a\u0623\u062e\u0631',
        body: joinParts([
          employeeRole || '\u0645\u0648\u0638\u0641',
          amountText,
          monthLabel,
        ]) || fallbackBody,
        actionLabel: '\u0641\u062a\u062d \u0627\u0644\u0645\u064a\u0632\u0627\u0646\u064a\u0629',
        actionUrl,
        typeLabel: '\u0627\u0644\u0631\u0648\u0627\u062a\u0628 \u0627\u0644\u0645\u062a\u0623\u062e\u0631\u0629',
      }
    }

    if (language === 'ku') {
      return {
        language,
        title: employeeName ? `\u0645\u0648\u0648\u0686\u06d5\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648 \u0628\u06c6 ${employeeName}` : '\u0645\u0648\u0648\u0686\u06d5\u06cc \u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0648\u0648',
        body: joinParts([
          employeeRole || '\u06a9\u0627\u0631\u0645\u06d5\u0646\u062f',
          amountText,
          monthLabel,
        ]) || fallbackBody,
        actionLabel: '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5\u06cc \u0628\u0648\u062f\u062c\u06d5',
        actionUrl,
        typeLabel: '\u062f\u0648\u0627\u06a9\u06d5\u0648\u062a\u0646\u06cc \u0645\u0648\u0648\u0686\u06d5',
      }
    }

    return {
      language,
      title: employeeName ? `Payroll overdue for ${employeeName}` : 'Payroll overdue',
      body: joinParts([
        employeeRole || 'Employee',
        amountText,
        monthLabel,
      ]) || fallbackBody,
      actionLabel: 'Open budget',
      actionUrl,
      typeLabel: 'Payroll Overdue',
    }
  }

  if (input.notificationType === 'inventory_low_stock') {
    const productName = readString(payload.product_name)
    const storageName = readString(payload.storage_name)
    const quantity = readNumber(payload.quantity)
    const unit = readString(payload.unit)
    const minStockLevel = readNumber(payload.min_stock_level)

    if (language === 'ar') {
      return {
        language,
        title: productName ? `\u0645\u062e\u0632\u0648\u0646 \u0645\u0646\u062e\u0641\u0636: ${productName}` : '\u0645\u062e\u0632\u0648\u0646 \u0645\u0646\u062e\u0641\u0636',
        body: joinParts([
          storageName,
          quantity !== null ? `\u0627\u0644\u0645\u062a\u0628\u0642\u064a ${formatNumber(quantity, language)}${unit ? ` ${unit}` : ''}` : '',
          minStockLevel !== null ? `\u0627\u0644\u062d\u062f \u0627\u0644\u0623\u062f\u0646\u0649 ${formatNumber(minStockLevel, language)}` : '',
        ]) || fallbackBody,
        actionLabel: '\u0641\u062a\u062d \u0627\u0644\u0645\u062e\u0627\u0632\u0646',
        actionUrl,
        typeLabel: '\u0627\u0644\u0645\u062e\u0632\u0648\u0646 \u0627\u0644\u0645\u0646\u062e\u0641\u0636',
      }
    }

    if (language === 'ku') {
      return {
        language,
        title: productName ? `\u06a9\u06d5\u0645\u06cc \u06a9\u0627\u06b5\u0627: ${productName}` : '\u06a9\u06d5\u0645\u06cc \u06a9\u0627\u06b5\u0627',
        body: joinParts([
          storageName,
          quantity !== null ? `${formatNumber(quantity, language)}${unit ? ` ${unit}` : ''} \u0645\u0627\u0648\u06d5` : '',
          minStockLevel !== null ? `\u06a9\u06d5\u0645\u062a\u0631\u06cc\u0646 ${formatNumber(minStockLevel, language)}` : '',
        ]) || fallbackBody,
        actionLabel: '\u06a9\u0631\u062f\u0646\u06d5\u0648\u06d5\u06cc \u06a9\u06c6\u06af\u0627\u06a9\u0627\u0646',
        actionUrl,
        typeLabel: '\u06a9\u06d5\u0645\u06cc \u06a9\u0627\u06b5\u0627',
      }
    }

    return {
      language,
      title: productName ? `Low stock: ${productName}` : 'Low stock',
      body: joinParts([
        storageName,
        quantity !== null ? `${formatNumber(quantity, language)}${unit ? ` ${unit}` : ''} remaining` : '',
        minStockLevel !== null ? `Min ${formatNumber(minStockLevel, language)}` : '',
      ]) || fallbackBody,
      actionLabel: 'Open storages',
      actionUrl,
      typeLabel: 'Low Stock',
    }
  }

  return {
    language,
    title: fallbackTitle,
    body: fallbackBody,
    actionLabel: fallbackActionLabel,
    actionUrl,
    typeLabel: formatNotificationTypeFallback(input.notificationType),
  }
}
