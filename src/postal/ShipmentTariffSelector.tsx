import { useTranslation } from 'react-i18next'
import { Check, Package } from 'lucide-react'
import { Button } from '@/ui/components'
import type { PostalTariffOption } from './domain'

export function ShipmentTariffSelector({
  id,
  options,
  value,
  disabled,
  reviewing = false,
  onChange,
}: {
  id: string
  options: PostalTariffOption[]
  value: PostalTariffOption | null
  disabled?: boolean
  reviewing?: boolean
  onChange: (value: PostalTariffOption) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      id={id}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-hint`}
      aria-invalid={!value}
      className="space-y-2"
    >
      <p id={`${id}-label`} className="text-sm font-medium">
        {t('postal.shipmentSize')} *
      </p>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {t(reviewing ? 'postal.tariffAssignmentHint' : 'postal.tariffCreationHint')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = value?.size === option.size && value.fee === option.fee
          return (
            <Button
              key={`${option.size}:${option.fee}`}
              type="button"
              variant={selected ? 'default' : 'outline'}
              className="h-auto min-h-20 justify-between gap-3 p-4 text-start"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(option)}
            >
              <span className="flex items-start gap-3">
                <Package className="mt-0.5 h-5 w-5 shrink-0" />
                <span className="space-y-1">
                  <span className="block font-semibold">
                    {t(`postal.shipmentSizes.${option.size}`)}
                  </span>
                  {option.zone && (
                    <span className="block text-xs opacity-80">
                      {t(`postal.tariffZones.${option.zone}`)}
                    </span>
                  )}
                  <span className="block text-sm">
                    {option.fee.toLocaleString()} {t('postal.iqd')}
                  </span>
                </span>
              </span>
              {selected && <Check className="h-5 w-5 shrink-0" />}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
