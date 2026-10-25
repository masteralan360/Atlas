import { useCallback, useMemo } from 'react'

import { useUnits, useUnitsState } from '@/local-db/hooks'
import { DEFAULT_UNITS, normalizeUnitCode, type Unit } from '@/local-db/models'
import { ProductUnitIcon } from '@/ui/components/ProductUnitIcon'

export interface WorkspaceUnitOption {
    value: string
    isDynamic: boolean
    icon: string | null
}

function buildWorkspaceUnitOptions(customUnits: Unit[]): WorkspaceUnitOption[] {
    const builtInOptions: WorkspaceUnitOption[] = DEFAULT_UNITS.map((def) => ({
        value: normalizeUnitCode(def.code),
        isDynamic: def.isDynamic,
        icon: def.icon ?? null,
    }))
    const customOptions: WorkspaceUnitOption[] = customUnits.map((unit) => ({
        value: normalizeUnitCode(unit.code),
        isDynamic: unit.isDynamic,
        icon: unit.icon ?? null,
    }))
    return [
        ...builtInOptions.sort((left, right) => left.value.localeCompare(right.value)),
        ...customOptions.sort((left, right) => left.value.localeCompare(right.value)),
    ]
}

/**
 * Units available to a workspace. Built-in units are hardcoded in the app
 * (DEFAULT_UNITS) and are NOT stored in the database; the units table only
 * holds workspace-created custom units.
 */
export function useWorkspaceUnits(workspaceId: string | undefined): WorkspaceUnitOption[] {
    const customUnits = useUnits(workspaceId)
    return useMemo(() => buildWorkspaceUnitOptions(customUnits), [customUnits])
}

export function isUnitDynamic(unit: string | undefined, dynamicCodes: readonly string[]): unit is string {
    return !!unit && dynamicCodes.includes(normalizeUnitCode(unit))
}

export function getDynamicUnitAdjustmentLabel(
    t: (key: string, options?: Record<string, unknown>) => string,
    unit: string,
    dynamicCodes: readonly string[],
) {
    if (!dynamicCodes.includes(unit)) {
        return t('units.adjustDynamic', { defaultValue: 'Adjust quantity' })
    }
    if (unit === 'm²') return t('pos.adjustM2') || 'Adjust m²'
    if (unit === 'Kg') return t('pos.adjustKg') || 'Adjust Kg'

    return 'Adjust Meter'
}

export function getQuantityStep(unit: string | undefined | null, dynamicCodes: readonly string[]): string {
    return isUnitDynamic(unit ?? '', dynamicCodes) ? '0.01' : '1'
}

export interface UnitRegistry {
    options: WorkspaceUnitOption[]
    dynamicCodes: string[]
    isReady: boolean
    isDynamicUnit: (unit: string | undefined) => unit is string
    getUnitIcon: (unit: string, className?: string) => React.ReactElement
}

export function useUnitRegistry(workspaceId: string | undefined): UnitRegistry {
    const { rows: customUnits, isReady } = useUnitsState(workspaceId)
    const options = useMemo(() => buildWorkspaceUnitOptions(customUnits), [customUnits])
    const dynamicCodes = useMemo(
        () => options.filter((option) => option.isDynamic).map((option) => option.value),
        [options],
    )
    const isDynamicUnit = useCallback(
        (unit: string | undefined): unit is string => isUnitDynamic(unit, dynamicCodes),
        [dynamicCodes],
    )
    const getUnitIcon = useCallback(
        (unit: string, className?: string) => {
            const option = options.find((candidate) => candidate.value === normalizeUnitCode(unit))
            return <ProductUnitIcon unit={unit} iconName={option?.icon ?? null} className={className} />
        },
        [options],
    )
    return { options, dynamicCodes, isReady, isDynamicUnit, getUnitIcon }
}
