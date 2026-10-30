import { describe, expect, it } from 'vitest'
import {
    canManageClinicalRegistryType,
    supportsClinicalPatientsAndServicePresets,
} from '@/i18n/clinicalRegistry'
import {
    getClinicalRegistryPresetId,
    isBeautyClinicalRegistryType,
    normalizeClinicalRegistryType,
} from '@/local-db/clinicalRegistryPreset'

describe('clinical registry preference', () => {
    it('uses a deterministic preset id for each workspace', () => {
        expect(getClinicalRegistryPresetId('workspace-a')).toBe(getClinicalRegistryPresetId('workspace-a'))
        expect(getClinicalRegistryPresetId('workspace-a')).not.toBe(getClinicalRegistryPresetId('workspace-b'))
    })

    it('defaults unsupported or missing preset values to medical', () => {
        expect(normalizeClinicalRegistryType('beauty')).toBe('beauty')
        expect(normalizeClinicalRegistryType('beauty2')).toBe('beauty2')
        expect(normalizeClinicalRegistryType('medical')).toBe('medical')
        expect(normalizeClinicalRegistryType('unknown')).toBe('medical')
        expect(normalizeClinicalRegistryType(undefined)).toBe('medical')
    })

    it('allows only admins with the clinical appointments workspace feature to manage the type', () => {
        expect(canManageClinicalRegistryType('admin', true)).toBe(true)
        expect(canManageClinicalRegistryType('admin', false)).toBe(false)
        expect(canManageClinicalRegistryType('staff', true)).toBe(false)
        expect(canManageClinicalRegistryType('viewer', true)).toBe(false)
        expect(canManageClinicalRegistryType('admin', true, 'beauty2')).toBe(true)
    })

    it('treats both beauty registry modes as Beauty Center behavior', () => {
        expect(isBeautyClinicalRegistryType('beauty')).toBe(true)
        expect(isBeautyClinicalRegistryType('beauty2')).toBe(true)
        expect(isBeautyClinicalRegistryType('medical')).toBe(false)
    })

    it('disables patients and service presets only for beauty2', () => {
        expect(supportsClinicalPatientsAndServicePresets('medical')).toBe(true)
        expect(supportsClinicalPatientsAndServicePresets('beauty')).toBe(true)
        expect(supportsClinicalPatientsAndServicePresets('beauty2')).toBe(false)
    })
})
