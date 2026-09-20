export interface ProductUnitPackagingDraft {
  relationshipId: string
  factor: string
  parentPrice: string
}

export const EMPTY_PRODUCT_UNIT_PACKAGING: ProductUnitPackagingDraft = {
  relationshipId: '',
  factor: '',
  parentPrice: '',
}
