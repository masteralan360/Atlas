import type { PlanCapabilityKey, PlanModuleKey } from '@/plans/workspacePlans'

export const DEMO_TIME_MIN = 5
export const DEMO_TIME_MAX = 45
export const DEMO_TIME_DEFAULT = 15
export const DEMO_CODE_PREFIX = 'demo.'

export type DemoJob = 'general'

export interface DemoJobConfig {
  id: DemoJob
  label: string
}

export const DEMO_JOBS: DemoJobConfig[] = [
  {
    id: 'general',
    label: 'General Demo',
  },
]

type DemoOptionalModuleGrant =
  | { type: 'module'; key: PlanModuleKey }
  | { type: 'capability'; key: PlanCapabilityKey }

/** Optional demo codes map directly to the app's existing workspace entitlements. */
export const DEMO_OPTIONAL_MODULE_GRANTS = {
  INSPOS: { type: 'module', key: 'instant_pos' },
  KDS: { type: 'module', key: 'kds' },
  AGENT: { type: 'module', key: 'agents' },
  SAC: { type: 'module', key: 'sales_agent_commissions' },
  ASA: { type: 'module', key: 'agent_sales_accounts' },
  ME: { type: 'module', key: 'manual_entry' },
  CE: { type: 'module', key: 'currency_exchange' },
  CA: { type: 'module', key: 'clinical_appointments' },
  OFB: { type: 'capability', key: 'orderFreeBonus' },
  PB: { type: 'capability', key: 'priceBooks' },
  QO: { type: 'capability', key: 'quickOrder' },
  BPGP: { type: 'capability', key: 'businessPartnerGroupPrivacy' },
  SERV: { type: 'module', key: 'services' },
  CSC: { type: 'module', key: 'cashier_shift_control' },
  ACT: { type: 'module', key: 'activities' },
  REAL: { type: 'module', key: 'real_estate' },
  POST: { type: 'module', key: 'post_service' },
  CRS: { type: 'module', key: 'car_rental' },
  TT: { type: 'module', key: 'travel_transportation' },
  CP: { type: 'module', key: 'customer_profitability' },
  CO: { type: 'module', key: 'commerce_operations' },
  GM: { type: 'module', key: 'garden_management' },
} as const satisfies Record<string, DemoOptionalModuleGrant>

export type DemoOptionalModuleCode = keyof typeof DEMO_OPTIONAL_MODULE_GRANTS

export const DEMO_OPTIONAL_MODULE_CODES = Object.keys(
  DEMO_OPTIONAL_MODULE_GRANTS,
) as DemoOptionalModuleCode[]

export function isDemoOptionalModuleCode(value: string): value is DemoOptionalModuleCode {
  return Object.prototype.hasOwnProperty.call(DEMO_OPTIONAL_MODULE_GRANTS, value)
}

export function isDemoOptionalModuleCodePrefix(value: string): boolean {
  return DEMO_OPTIONAL_MODULE_CODES.some((code) => code.startsWith(value))
}

export interface DemoOptionalModuleCodeIssues {
  invalidCodes: string[]
  incompleteCode: string | null
  hasMalformedSeparator: boolean
  requiresAgentCode: boolean
}

export function inspectDemoOptionalModuleCodes(value: string): DemoOptionalModuleCodeIssues {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '-')
  if (!normalized) {
    return {
      invalidCodes: [],
      incompleteCode: null,
      hasMalformedSeparator: false,
      requiresAgentCode: false,
    }
  }

  const codes = normalized.split('-')
  const finalCode = codes[codes.length - 1]
  const invalidCodes = codes.filter((code, index) => Boolean(code)
    && !isDemoOptionalModuleCode(code)
    && (index < codes.length - 1 || !isDemoOptionalModuleCodePrefix(code)))
  const incompleteCode = finalCode
    && !isDemoOptionalModuleCode(finalCode)
    && isDemoOptionalModuleCodePrefix(finalCode)
    ? finalCode
    : null

  return {
    invalidCodes,
    incompleteCode,
    hasMalformedSeparator: codes.some((code) => !code),
    requiresAgentCode: (codes.includes('SAC') || codes.includes('ASA')) && !codes.includes('AGENT'),
  }
}

/** Strictly resolves user-supplied codes; callers must not rely on UI validation. */
export function parseDemoOptionalModuleCodes(value: string): DemoOptionalModuleGrant[] {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '-')
  if (!normalized) return []

  const codes = normalized.split('-')
  const grants = new Map<string, DemoOptionalModuleGrant>()

  for (const code of codes) {
    if (!/^[A-Z]+$/.test(code) || !isDemoOptionalModuleCode(code)) {
      throw new Error(`Unsupported optional demo module code: ${code || '(empty)'}`)
    }

    const grant = DEMO_OPTIONAL_MODULE_GRANTS[code]
    grants.set(`${grant.type}:${grant.key}`, grant)
  }

  if (inspectDemoOptionalModuleCodes(normalized).requiresAgentCode) {
    throw new Error('AGENT is required when granting SAC or ASA')
  }

  return [...grants.values()]
}

export function buildDemoCode(job: DemoJob, minutes: number): string {
  const suffix = Math.random().toString(36).substring(2, 8)
  return `demo.${job}.${minutes}.${suffix}`
}

export function isDemoWorkspace(code: string | undefined | null): boolean {
  if (!code) return false
  return code.startsWith(DEMO_CODE_PREFIX)
}
