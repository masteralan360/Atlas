import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useProductUnitConversions, useUnitRelationships } from '@/local-db'
import { formatHierarchicalQuantity, indexProductUnitContexts } from '@/lib/unitRelationships'

export function useProductQuantityFormatter(workspaceId?: string) {
  const { t, i18n } = useTranslation()
  const relationships = useUnitRelationships(workspaceId)
  const conversions = useProductUnitConversions(workspaceId)
  const contexts = useMemo(
    () => indexProductUnitContexts(conversions, relationships),
    [conversions, relationships],
  )
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 }),
    [i18n.language],
  )

  return useCallback((productId: string, baseQuantity: number, fallbackUnit: string) => {
    const context = contexts.get(productId)
    if (!context) {
      return `${numberFormatter.format(baseQuantity)} ${t(`products.units.${fallbackUnit}`, fallbackUnit)}`
    }

    return formatHierarchicalQuantity(
      baseQuantity,
      context.conversion.factor,
      t(`products.units.${context.relationship.parentUnitCode}`, context.relationship.parentUnitCode),
      t(`products.units.${context.relationship.childUnitCode}`, context.relationship.childUnitCode),
      t('common.and', { defaultValue: 'and' }),
      (value) => numberFormatter.format(value),
    )
  }, [contexts, numberFormatter, t])
}
