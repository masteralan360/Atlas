export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled'
export interface TestResult {
    id: string
    name: string
    file: string
    status: TestStatus
    durationMs: number
    errors: string[]
    environment?: 'isolated' | 'hosted-supabase'
}
export interface TestGroup {
    id: string
    titleKey: string
    layer: string
    files: string[]
    isolatedGroupId?: string
}
export interface SuiteDefinition {
    titleKey: string
    samplesHelpKey?: string
    coverageHelpKey?: string
    liveCoverageHelpKey?: string
    groups: TestGroup[]
    liveGroups?: TestGroup[]
    unavailable: string[]
}
export interface GroupResult {
    id: string
    status: TestStatus
    tests: TestResult[]
    errors: string[]
}
export interface TestRun {
    id: string
    suiteId: string
    environment: 'isolated' | 'hosted-supabase'
    target?: { host: string; workspaceId: string; workspaceName: string }
    mode?: 'cloud' | 'hybrid'
    fixtures?: Record<string, string | null>[]
    seed: number
    samples: number
    startedAt: string
    finishedAt?: string
    status: RunStatus
    cancelRequested: boolean
    groups: GroupResult[]
    unavailable: string[]
    reportPath?: string
}
export type LiveReadiness =
    | { status: 'ready'; target: { host: string; workspaceId: string; workspaceName: string }; mode: 'cloud' | 'hybrid' }
    | { status: 'blocked'; reason: string }
export interface RunnerSession {
    token: string
    suites: Record<string, SuiteDefinition>
    run: TestRun | null
}
