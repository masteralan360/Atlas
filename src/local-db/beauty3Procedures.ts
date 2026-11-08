import type { Beauty3ProcedureFaceArea } from './models'

export const BEAUTY3_PROCEDURE_PRESET_CATEGORY = 'beauty3_procedure' as const
export const BEAUTY3_OTHER_PROCEDURE_TYPE = 'other' as const

export const BEAUTY3_PROCEDURE_FACE_AREA_IDS: Beauty3ProcedureFaceArea[] = [
  'forehead',
  'glabella',
  'left_temple',
  'right_temple',
  'left_under_eye',
  'right_under_eye',
  'left_cheek',
  'right_cheek',
  'nose',
  'lips',
  'chin',
  'left_jawline',
  'right_jawline',
  'neck',
]

export const BEAUTY3_BUILT_IN_PROCEDURE_FACE_AREAS: Record<string, Beauty3ProcedureFaceArea[]> = {
  'builtin:dermal_filler': ['left_cheek', 'right_cheek', 'lips'],
  'builtin:botox': ['forehead', 'glabella', 'left_temple', 'right_temple'],
  'builtin:mesotherapy': ['left_under_eye', 'right_under_eye', 'left_cheek', 'right_cheek'],
  'builtin:skin_treatment': ['nose'],
  'builtin:device_based_treatments': ['left_jawline', 'right_jawline'],
  'builtin:plasma_treatment': ['left_under_eye', 'right_under_eye'],
  [BEAUTY3_OTHER_PROCEDURE_TYPE]: ['neck'],
}

const BEAUTY3_PROCEDURE_FACE_AREA_ID_SET = new Set<string>(BEAUTY3_PROCEDURE_FACE_AREA_IDS)

export function normalizeBeauty3ProcedureFaceAreas(value: unknown): Beauty3ProcedureFaceArea[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((area): area is Beauty3ProcedureFaceArea => (
    typeof area === 'string' && BEAUTY3_PROCEDURE_FACE_AREA_ID_SET.has(area)
  )))]
}

export function getDefaultBeauty3ProcedureFaceAreas(value: string): Beauty3ProcedureFaceArea[] {
  return [...(BEAUTY3_BUILT_IN_PROCEDURE_FACE_AREAS[value] ?? [])]
}

export function getBeauty3ProcedureDisplayNameOverride(
  value: string,
  presets: readonly { name: string; displayName?: string | null }[] | undefined,
): string | undefined {
  const displayName = presets?.find((preset) => preset.name === value)?.displayName?.trim()
  return displayName || undefined
}

export function getBeauty3ProcedureFaceAreas(value: string, storedAreas: unknown): Beauty3ProcedureFaceArea[] {
  const areas = normalizeBeauty3ProcedureFaceAreas(storedAreas)
  if (areas.length > 0 || !BEAUTY3_BUILT_IN_PROCEDURE_FACE_AREAS[value]) return areas
  return getDefaultBeauty3ProcedureFaceAreas(value)
}

export const BEAUTY3_BUILT_IN_PROCEDURES = [
  {
    value: 'builtin:dermal_filler',
    translationKey: 'beauty3Appointments.procedureTypes.dermalFiller',
    defaultPriceIqd: 40_000,
  },
  {
    value: 'builtin:botox',
    translationKey: 'beauty3Appointments.procedureTypes.botox',
    defaultPriceIqd: 50_000,
  },
  {
    value: 'builtin:mesotherapy',
    translationKey: 'beauty3Appointments.procedureTypes.mesotherapy',
    defaultPriceIqd: 30_000,
  },
  {
    value: 'builtin:skin_treatment',
    translationKey: 'beauty3Appointments.procedureTypes.skinTreatment',
    defaultPriceIqd: 25_000,
  },
  {
    value: 'builtin:device_based_treatments',
    translationKey: 'beauty3Appointments.procedureTypes.deviceBasedTreatments',
    defaultPriceIqd: 50_000,
  },
  {
    value: 'builtin:plasma_treatment',
    translationKey: 'beauty3Appointments.procedureTypes.plasmaTreatment',
    defaultPriceIqd: 35_000,
  },
  {
    value: BEAUTY3_OTHER_PROCEDURE_TYPE,
    translationKey: 'beauty3Appointments.procedureTypes.other',
    defaultPriceIqd: 0,
  },
] as const

export const BEAUTY3_BUILT_IN_PROCEDURE_LABELS = [
  'Dermal Filler',
  'Botox',
  'Mesotherapy',
  'Skin Treatment',
  'Device-Based Treatments',
  'Plasma Treatment',
  'Other',
  'فیلەری دەرمال',
  'بۆتۆکس',
  'میزۆتێراپی',
  'چارەسەری پێست',
  'چارەسەری بە ئامێر',
  'چارەسەری پلازما',
  'تر',
  'حشوات جلدية',
  'بوتوكس',
  'الميزوثيرابي',
  'علاج البشرة',
  'العلاجات بالأجهزة',
  'العلاج بالبلازما',
  'أخرى',
]

const BUILT_IN_PROCEDURE_VALUES = new Set<string>(
  BEAUTY3_BUILT_IN_PROCEDURES.map((procedure) => procedure.value),
)

export function getBeauty3BuiltInProcedurePriceIqd(value: string): number | undefined {
  return BEAUTY3_BUILT_IN_PROCEDURES.find((procedure) => procedure.value === value)?.defaultPriceIqd
}

export function isBeauty3BuiltInProcedureType(value: string | null | undefined): boolean {
  return Boolean(value && BUILT_IN_PROCEDURE_VALUES.has(value))
}

export function isReservedBeauty3ProcedureName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase()
  return normalized.startsWith('builtin:')
    || normalized === BEAUTY3_OTHER_PROCEDURE_TYPE
    || BEAUTY3_BUILT_IN_PROCEDURE_LABELS.some(
      (label) => label.toLocaleLowerCase() === normalized,
    )
}
