import type { ClinicalRegistryType, UserRole } from '@/local-db/models'

export type { ClinicalRegistryType }

export function supportsClinicalPatientsAndServicePresets(
    registryType: ClinicalRegistryType,
): boolean {
    return registryType !== 'beauty2' && registryType !== 'beauty3'
}

export function canManageClinicalRegistryType(
    role: UserRole | undefined,
    hasClinicalAppointmentsFeature: boolean,
    _registryType: ClinicalRegistryType = 'medical',
): boolean {
    return role === 'admin'
        && hasClinicalAppointmentsFeature
}
