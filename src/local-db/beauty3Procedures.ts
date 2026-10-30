export const BEAUTY3_PROCEDURE_PRESET_CATEGORY = 'beauty3_procedure' as const
export const BEAUTY3_OTHER_PROCEDURE_TYPE = 'other' as const

export const BEAUTY3_BUILT_IN_PROCEDURES = [
  {
    value: 'builtin:dermal_filler',
    translationKey: 'beauty3Appointments.procedureTypes.dermalFiller',
  },
  {
    value: 'builtin:botox',
    translationKey: 'beauty3Appointments.procedureTypes.botox',
  },
  {
    value: 'builtin:mesotherapy',
    translationKey: 'beauty3Appointments.procedureTypes.mesotherapy',
  },
  {
    value: 'builtin:skin_treatment',
    translationKey: 'beauty3Appointments.procedureTypes.skinTreatment',
  },
  {
    value: 'builtin:device_based_treatments',
    translationKey: 'beauty3Appointments.procedureTypes.deviceBasedTreatments',
  },
  {
    value: 'builtin:plasma_treatment',
    translationKey: 'beauty3Appointments.procedureTypes.plasmaTreatment',
  },
  {
    value: BEAUTY3_OTHER_PROCEDURE_TYPE,
    translationKey: 'beauty3Appointments.procedureTypes.other',
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
