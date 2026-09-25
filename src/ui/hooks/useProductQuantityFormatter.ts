import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useProductUnitConversions, useUnitRelationships } from '@/local-db'
import { getProductStockPresentation } from '@/lib/productStockPresentation'
import { indexProductUnitContexts } from '@/lib/unitRelationships'

export function useProductQuantityPresentation(workspaceId?: string) {
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
    return getProductStockPresentation(
      baseQuantity,
      t(`products.units.${fallbackUnit}`, fallbackUnit),
      context ? {
        factor: context.conversion.factor,
        largerUnitLabel: t(`products.units.${context.relationship.parentUnitCode}`, context.relationship.parentUnitCode),
        smallerUnitLabel: t(`products.units.${context.relationship.childUnitCode}`, context.relationship.childUnitCode),
        conjunction: t('common.and', { defaultValue: 'and' }),
      } : null,
      (value) => numberFormatter.format(value),
    )
  }, [contexts, numberFormatter, t])
}

export function useProductQuantityFormatter(workspaceId?: string) {
  const getPresentation = useProductQuantityPresentation(workspaceId)
  return useCallback(
    (productId: string, baseQuantity: number, fallbackUnit: string) =>
      getPresentation(productId, baseQuantity, fallbackUnit).label,
    [getPresentation],
  )
}
