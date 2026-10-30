import { v5 as uuidv5 } from 'uuid'
import type { ClinicalRegistryType } from './models'

export const DEFAULT_CLINICAL_REGISTRY_TYPE: ClinicalRegistryType = 'medical'
export const CLINICAL_REGISTRY_PRESET_CATEGORY = 'registry_type' as const

const CLINICAL_REGISTRY_PRESET_NAMESPACE = '10ea9ebd-7a86-49d8-99cc-ec5348f30685'

export function getClinicalRegistryPresetId(workspaceId: string): string {
  return uuidv5(workspaceId, CLINICAL_REGISTRY_PRESET_NAMESPACE)
}

export function normalizeClinicalRegistryType(value: string | null | undefined): ClinicalRegistryType {
  if (value === 'beauty' || value === 'beauty2' || value === 'beauty3') return value
  return DEFAULT_CLINICAL_REGISTRY_TYPE
}

export function isBeautyClinicalRegistryType(value: ClinicalRegistryType): boolean {
  return value === 'beauty' || value === 'beauty2' || value === 'beauty3'
}
