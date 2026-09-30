import type { Product, ProductUom, Unit, UnitRef } from '@/local-db/models'
import { DEFAULT_UNITS, normalizeUnitCode } from '@/local-db/models'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'

export interface UomDescriptor {
  ref: UnitRef
  code: string
  isDynamic: boolean
  customUnitId?: string
}

export type ProductUomOption = ProductUom & { isDynamic: boolean }

export type ProductUomOrderOption = {
  kind: 'single' | 'base' | 'converted'
  uomId: string
  unitRef: UnitRef
  unitCode: string
  baseUnitRef: UnitRef
  baseUnitCode: string
  factor: number
  isDynamic: boolean
  isBase: boolean
  isDefaultSelling: boolean
  sellingPrice: number
  costPrice: number | null
  minimumSellingPrice: number | null
}

export function builtinUnitRef(code: string): UnitRef {
  return `builtin:${normalizeUnitCode(code).toLowerCase()}`
}

export function customUnitRef(id: string): UnitRef {
  return `custom:${id}`
}

export function getUomDescriptors(customUnits: readonly Unit[]): UomDescriptor[] {
  return [
    ...DEFAULT_UNITS.map((unit) => ({
      ref: builtinUnitRef(unit.code),
      code: unit.code,
      isDynamic: unit.isDynamic,
    })),
    ...customUnits.filter((unit) => !unit.isDeleted).map((unit) => ({
      ref: customUnitRef(unit.id),
      code: normalizeUnitCode(unit.code),
      isDynamic: unit.isDynamic,
      customUnitId: unit.id,
    })),
  ]
}

export function findUomDescriptor(descriptors: readonly UomDescriptor[], ref: string | null | undefined) {
  return descriptors.find((unit) => unit.ref === ref)
}

export function findUomDescriptorByCode(descriptors: readonly UomDescriptor[], code: string | null | undefined) {
  const normalized = normalizeUnitCode(code).toLocaleLowerCase()
  return descriptors.find((unit) => normalizeUnitCode(unit.code).toLocaleLowerCase() === normalized)
}

export function productUomRefForCode(code: string, customUnits: readonly Unit[]): UnitRef {
  const normalized = normalizeUnitCode(code).toLocaleLowerCase()
  const custom = customUnits.find((unit) => !unit.isDeleted
    && normalizeUnitCode(unit.code).toLocaleLowerCase() === normalized)
  return custom ? customUnitRef(custom.id) : builtinUnitRef(code)
}

export function getActiveProductUoms(
  product: Pick<Product, 'id' | 'unit' | 'price' | 'costPrice' | 'minimumSellingPrice' | 'currency'>,
  rows: readonly ProductUom[],
  descriptors: readonly UomDescriptor[],
): ProductUomOption[] {
  const active = rows.filter((row) => row.productId === product.id && row.isActive && !row.isDeleted)
  const base = active.find((row) => row.isBase) ?? {
    id: `legacy-base:${product.id}`,
    workspaceId: '',
    productId: product.id,
    unitRef: findUomDescriptorByCode(descriptors, product.unit)?.ref ?? builtinUnitRef(product.unit),
    unitCode: normalizeUnitCode(product.unit),
    coefficient: 1,
    isBase: true,
    isActive: true,
    isDefaultSelling: true,
    sellingPrice: product.price,
    costPrice: product.costPrice,
    minimumSellingPrice: product.minimumSellingPrice ?? null,
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    syncStatus: 'synced' as const,
    lastSyncedAt: null,
  }
  const ordered = [base, ...active.filter((row) => !row.isBase)]
  return ordered.map((row) => ({
    ...row,
    isDefaultSelling: row.isDefaultSelling === true || (!ordered.some((item) => item.isDefaultSelling) && row.isBase),
    isDynamic: findUomDescriptor(descriptors, row.unitRef)?.isDynamic === true,
  }))
}

export function buildProductUomOrderOptions(
  product: Pick<Product, 'id' | 'unit' | 'price' | 'costPrice' | 'minimumSellingPrice' | 'currency' | 'isService'>,
  rows: readonly ProductUom[],
  descriptors: readonly UomDescriptor[],
): ProductUomOrderOption[] {
  if (product.isService) {
    return [{
      kind: 'single',
      uomId: '',
      unitRef: builtinUnitRef('service'),
      unitCode: 'service',
      baseUnitRef: builtinUnitRef('service'),
      baseUnitCode: 'service',
      factor: 1,
      isDynamic: true,
      isBase: true,
      isDefaultSelling: true,
      sellingPrice: product.price,
      costPrice: product.costPrice,
      minimumSellingPrice: product.minimumSellingPrice ?? null,
    }]
  }
  const active = getActiveProductUoms(product, rows, descriptors)
  const base = active.find((row) => row.isBase) ?? active[0]
  return active.map((row) => ({
    kind: row.isBase ? (active.length > 1 ? 'base' : 'single') : 'converted',
    uomId: row.id,
    unitRef: row.unitRef,
    unitCode: row.unitCode,
    baseUnitRef: base.unitRef,
    baseUnitCode: base.unitCode,
    factor: row.coefficient,
    isDynamic: row.isDynamic,
    isBase: row.isBase,
    isDefaultSelling: row.isDefaultSelling === true,
    sellingPrice: row.sellingPrice,
    costPrice: row.costPrice,
    minimumSellingPrice: row.minimumSellingPrice,
  }))
}

export function indexProductUomsByProduct(rows: readonly ProductUom[]) {
  const contexts = new Map<string, ProductUom[]>()
  for (const row of rows) {
    if (row.isDeleted || !row.isActive) continue
    const productRows = contexts.get(row.productId) ?? []
    productRows.push(row)
    contexts.set(row.productId, productRows)
  }
  return contexts
}

export function soldQuantityToInventoryQuantity(quantity: number, coefficient = 1) {
  return roundQuantity(quantity * coefficient)
}

export function assertValidOrderUnitQuantity(quantity: number, isDynamic: boolean) {
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('order_uom_quantity_invalid')
  if (!isDynamic && !Number.isInteger(quantity)) throw new Error('order_uom_quantity_whole')
  if (Math.abs(quantity - roundQuantity(quantity)) > 1e-9) throw new Error('order_uom_quantity_precision')
}

export function inventoryQuantityToSellingAvailability(quantity: number, coefficient = 1) {
  if (!Number.isFinite(quantity) || !Number.isFinite(coefficient) || coefficient <= 0) return 0
  return roundQuantity(quantity / coefficient)
}

/** Paid and free POS quantities consume stock in the selected UoM. */
export function getCartInventoryQuantity(item: {
  quantity: number
  freeBonusQuantity?: number | null
  unit_factor?: number | null
}) {
  return soldQuantityToInventoryQuantity(
    getOrderLineInventoryQuantity(item),
    item.unit_factor ?? 1,
  )
}
