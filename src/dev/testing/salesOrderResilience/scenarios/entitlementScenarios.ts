import type { WorkspacePlan } from '@/local-db/models'
export const entitlementScenarios: { id: string; label: string; plan: WorkspacePlan; override?: 'grant' | 'revoke'; allowed: boolean }[] = [
    { id: 'SORL-AUTH-001', label: 'business', plan: 'business', allowed: true },
    { id: 'SORL-AUTH-002', label: 'enterprise', plan: 'enterprise', allowed: true },
    { id: 'SORL-AUTH-003', label: 'basic', plan: 'basic', allowed: false },
    { id: 'SORL-AUTH-004', label: 'grant', plan: 'basic', override: 'grant', allowed: true },
    { id: 'SORL-AUTH-005', label: 'revoke', plan: 'business', override: 'revoke', allowed: false }
]
