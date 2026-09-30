import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useProductUoms } from '@/local-db'
import { getProductStockPresentation } from '@/lib/productStockPresentation'
import { indexProductUomsByProduct } from '@/lib/productUoms'

export function useProductQuantityPresentation(workspaceId?: string) {
  const { t, i18n } = useTranslation()
  const productUoms = useProductUoms(workspaceId)
  const contexts = useMemo(() => indexProductUomsByProduct(productUoms), [productUoms])
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 }),
    [i18n.language],
  )

  return useCallback((productId: string, baseQuantity: number, fallbackUnit: string) => {
    const context = contexts.get(productId) ?? []
    const largerUom = context
      .filter((row) => !row.isBase && row.coefficient > 1)
      .sort((left, right) => right.coefficient - left.coefficient)[0]
    const baseUom = context.find((row) => row.isBase)
    return getProductStockPresentation(
      baseQuantity,
      t(`products.units.${baseUom?.unitCode ?? fallbackUnit}`, baseUom?.unitCode ?? fallbackUnit),
      largerUom ? {
        factor: largerUom.coefficient,
        largerUnitLabel: t(`products.units.${largerUom.unitCode}`, largerUom.unitCode),
        smallerUnitLabel: t(`products.units.${baseUom?.unitCode ?? fallbackUnit}`, baseUom?.unitCode ?? fallbackUnit),
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
