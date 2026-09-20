import type {
  Product,
  ProductUnitConversion,
  Unit,
  UnitRef,
  UnitRelationship,
} from '@/local-db/models'
import { DEFAULT_UNITS, normalizeUnitCode } from '@/local-db/models'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'

export interface UnitDescriptor {
  ref: UnitRef
  code: string
  isDynamic: boolean
  customUnitId?: string
}

export interface ProductUnitContext {
  conversion: ProductUnitConversion
  relationship: UnitRelationship
}

export type ProductUnitSelectionOption =
  | {
    kind: 'unit'
    value: `unit:${string}`
    unitCode: string
    isDynamic: boolean
    icon: string | null
  }
  | {
    kind: 'relationship'
    value: `relationship:${string}`
    relationshipId: string
    parentUnitCode: string
    childUnitCode: string
    isDynamic: boolean
  }

export function builtinUnitRef(code: string): UnitRef {
  return `builtin:${normalizeUnitCode(code).toLowerCase()}`
}

export function customUnitRef(id: string): UnitRef {
  return `custom:${id}`
}

export function getUnitDescriptors(customUnits: readonly Unit[]): UnitDescriptor[] {
  return [
    ...DEFAULT_UNITS.map((unit) => ({
      ref: builtinUnitRef(unit.code),
      code: unit.code,
      isDynamic: unit.isDynamic,
    })),
    ...customUnits
      .filter((unit) => !unit.isDeleted)
      .map((unit) => ({
        ref: customUnitRef(unit.id),
        code: normalizeUnitCode(unit.code),
        isDynamic: unit.isDynamic,
        customUnitId: unit.id,
      })),
  ]
}

export function findUnitDescriptor(
  descriptors: readonly UnitDescriptor[],
  ref: string | null | undefined,
): UnitDescriptor | undefined {
  return descriptors.find((unit) => unit.ref === ref)
}

export function findUnitDescriptorByCode(
  descriptors: readonly UnitDescriptor[],
  code: string | null | undefined,
): UnitDescriptor | undefined {
  const normalized = normalizeUnitCode(code).toLowerCase()
  return descriptors.find((unit) => normalizeUnitCode(unit.code).toLowerCase() === normalized)
}

export function buildProductUnitSelectionOptions(
  units: ReadonlyArray<{ value: string; isDynamic: boolean; icon: string | null }>,
  relationships: readonly UnitRelationship[],
  selectedRelationshipId?: string | null,
): ProductUnitSelectionOption[] {
  const activeRelationships = relationships.filter((row) => (
    !row.isDeleted && (!row.isArchived || row.id === selectedRelationshipId)
  ))
  const reservedCodes = new Set(
    relationships
      .filter((row) => !row.isDeleted && !row.isArchived)
      .flatMap((row) => [row.parentUnitCode, row.childUnitCode])
      .map((code) => normalizeUnitCode(code).toLowerCase()),
  )

  return [
    ...activeRelationships.map((relationship): ProductUnitSelectionOption => ({
      kind: 'relationship',
      value: `relationship:${relationship.id}`,
      relationshipId: relationship.id,
      parentUnitCode: relationship.parentUnitCode,
      childUnitCode: relationship.childUnitCode,
      isDynamic: units.find((unit) => (
        normalizeUnitCode(unit.value).toLowerCase()
        === normalizeUnitCode(relationship.childUnitCode).toLowerCase()
      ))?.isDynamic === true,
    })),
    ...units
      .filter((unit) => !reservedCodes.has(normalizeUnitCode(unit.value).toLowerCase()))
      .map((unit): ProductUnitSelectionOption => ({
        kind: 'unit',
        value: `unit:${unit.value}`,
        unitCode: unit.value,
        isDynamic: unit.isDynamic,
        icon: unit.icon,
      })),
  ]
}

export function getUnitRefsUsedByProducts(
  products: readonly Product[],
  conversions: readonly ProductUnitConversion[],
  relationships: readonly UnitRelationship[],
  descriptors: readonly UnitDescriptor[],
) {
  const activeProducts = products.filter((product) => !product.isDeleted)
  const activeProductIds = new Set(activeProducts.map((product) => product.id))
  const usedRefs = new Set<UnitRef>()

  for (const product of activeProducts) {
    const descriptor = findUnitDescriptorByCode(descriptors, product.unit)
    if (descriptor) usedRefs.add(descriptor.ref)
  }

  const relationshipsById = new Map(
    relationships.filter((row) => !row.isDeleted).map((row) => [row.id, row]),
  )
  for (const conversion of conversions) {
    if (conversion.isDeleted || !activeProductIds.has(conversion.productId)) continue
    const relationship = relationshipsById.get(conversion.relationshipId)
    if (!relationship) continue
    usedRefs.add(relationship.parentUnitRef)
    usedRefs.add(relationship.childUnitRef)
  }

  return usedRefs
}

export function countActiveProductsByRelationship(
  products: readonly Product[],
  conversions: readonly ProductUnitConversion[],
) {
  const activeProductIds = new Set(products.filter((product) => !product.isDeleted).map((product) => product.id))
  const counts = new Map<string, number>()
  for (const conversion of conversions) {
    if (conversion.isDeleted || !activeProductIds.has(conversion.productId)) continue
    counts.set(conversion.relationshipId, (counts.get(conversion.relationshipId) ?? 0) + 1)
  }
  return counts
}

export function assertValidUnitRelationship(
  input: Pick<UnitRelationship, 'parentUnitRef' | 'childUnitRef'>,
  existing: readonly UnitRelationship[],
  excludedId?: string,
) {
  if (!input.parentUnitRef || !input.childUnitRef || input.parentUnitRef === input.childUnitRef) {
    throw new Error('unit_relationship_same_unit')
  }

  const active = existing.filter((row) => !row.isDeleted && !row.isArchived && row.id !== excludedId)
  if (active.some((row) => row.parentUnitRef === input.parentUnitRef && row.childUnitRef === input.childUnitRef)) {
    throw new Error('unit_relationship_duplicate')
  }
  if (active.some((row) => row.parentUnitRef === input.childUnitRef && row.childUnitRef === input.parentUnitRef)) {
    throw new Error('unit_relationship_reverse')
  }

  const outgoing = new Map<string, string[]>()
  for (const row of active) {
    outgoing.set(row.parentUnitRef, [...(outgoing.get(row.parentUnitRef) ?? []), row.childUnitRef])
  }
  outgoing.set(input.parentUnitRef, [...(outgoing.get(input.parentUnitRef) ?? []), input.childUnitRef])

  const visit = (ref: string, seen: Set<string>): boolean => {
    if (ref === input.parentUnitRef && seen.size > 0) return true
    if (seen.has(ref)) return false
    const nextSeen = new Set(seen).add(ref)
    return (outgoing.get(ref) ?? []).some((next) => visit(next, nextSeen))
  }
  if (visit(input.childUnitRef, new Set())) {
    throw new Error('unit_relationship_cycle')
  }
}

export function assertValidProductUnitFactor(factor: number, childIsDynamic: boolean) {
  if (!Number.isFinite(factor) || factor <= 0 || (!childIsDynamic && !Number.isInteger(factor))) {
    throw new Error(childIsDynamic ? 'unit_factor_positive' : 'unit_factor_whole')
  }
}

export function soldQuantityToInventoryQuantity(quantity: number, factor = 1): number {
  return roundQuantity(quantity * factor)
}

export function inventoryQuantityToSellingAvailability(quantity: number, factor = 1): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(factor) || factor <= 0) return 0
  return roundQuantity(quantity / factor)
}

/**
 * POS Order lines can contain paid and free quantities. Both consume the
 * selected product's inventory, while only the paid quantity contributes to
 * the line price. Keep the conversion here so every POS stock check, badge,
 * and batch allocation uses the same quantity.
 */
export function getCartInventoryQuantity(item: {
  quantity: number
  freeBonusQuantity?: number | null
  unit_factor?: number | null
}): number {
  return soldQuantityToInventoryQuantity(
    getOrderLineInventoryQuantity(item),
    item.unit_factor ?? 1,
  )
}

export interface HierarchicalQuantityParts {
  parentQuantity: number
  childQuantity: number
}

export function splitHierarchicalQuantity(baseQuantity: number, factor: number): HierarchicalQuantityParts {
  if (!Number.isFinite(baseQuantity) || !Number.isFinite(factor) || factor <= 0) {
    return { parentQuantity: 0, childQuantity: roundQuantity(Math.max(0, baseQuantity || 0)) }
  }
  const normalized = roundQuantity(Math.max(0, baseQuantity))
  const parentQuantity = Math.floor((normalized + 1e-9) / factor)
  const childQuantity = roundQuantity(normalized - parentQuantity * factor)
  return { parentQuantity, childQuantity: Math.abs(childQuantity) < 1e-6 ? 0 : childQuantity }
}

export function formatHierarchicalQuantity(
  baseQuantity: number,
  factor: number,
  parentLabel: string,
  childLabel: string,
  conjunction: string,
  formatNumber: (value: number) => string = (value) => new Intl.NumberFormat().format(value),
) {
  const { parentQuantity, childQuantity } = splitHierarchicalQuantity(baseQuantity, factor)
  const parent = `${formatNumber(parentQuantity)} ${parentLabel}`
  const child = `${formatNumber(childQuantity)} ${childLabel}`
  if (parentQuantity > 0 && childQuantity > 0) return `${parent} ${conjunction} ${child}`
  if (parentQuantity > 0) return parent
  return child
}

export function indexProductUnitContexts(
  conversions: readonly ProductUnitConversion[],
  relationships: readonly UnitRelationship[],
) {
  const relationshipsById = new Map(relationships.filter((row) => !row.isDeleted).map((row) => [row.id, row]))
  const contexts = new Map<string, ProductUnitContext>()
  for (const conversion of conversions) {
    if (conversion.isDeleted) continue
    const relationship = relationshipsById.get(conversion.relationshipId)
    if (relationship) contexts.set(conversion.productId, { conversion, relationship })
  }
  return contexts
}
