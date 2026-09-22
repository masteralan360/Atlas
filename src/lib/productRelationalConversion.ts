import type { Inventory } from '@/local-db/models'

export type RelationalConversionFormDraft = {
  unit: string
  quantity: number | ''
  storageId: string
  price: string
  costPrice: string
  perQuantity: string
}

export type RelationalConversionPriceBookDraft = {
  price: string
  costPrice: string
  parentPrice?: string
}

type RelationalConversionDraftResult<
  TForm extends RelationalConversionFormDraft,
  TPriceBook extends RelationalConversionPriceBookDraft,
> = {
  formData: Omit<TForm, keyof RelationalConversionFormDraft> & RelationalConversionFormDraft
  priceBookRows: Array<
    Omit<TPriceBook, keyof RelationalConversionPriceBookDraft>
    & RelationalConversionPriceBookDraft
  >
}

/**
 * A saved single-unit product starts its related-unit edit like a new product:
 * no inherited stock or prices, and one explicit destination storage.
 */
export function createRelationalConversionDraft<
  TForm extends RelationalConversionFormDraft,
  TPriceBook extends RelationalConversionPriceBookDraft,
>(input: {
  formData: TForm
  priceBookRows: TPriceBook[]
  childUnitCode: string
  inventoryRows: Array<Pick<Inventory, 'storageId'>>
}): RelationalConversionDraftResult<TForm, TPriceBook> {
  const storageId = input.inventoryRows.length === 1
    ? input.inventoryRows[0].storageId
    : ''

  return {
    formData: {
      ...input.formData,
      unit: input.childUnitCode,
      quantity: '' as const,
      storageId,
      price: '',
      costPrice: '',
      perQuantity: '1',
    },
    priceBookRows: input.priceBookRows.map((row) => ({
      ...row,
      price: '',
      costPrice: '',
      parentPrice: '',
    })),
  }
}
