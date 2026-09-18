export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled'
export interface TestResult {
    id: string
    name: string
    file: string
    status: TestStatus
    durationMs: number
    errors: string[]
}
export interface TestGroup {
    id: string
    titleKey: string
    layer: string
    files: string[]
}
export interface SuiteDefinition {
    titleKey: string
    samplesHelpKey?: string
    coverageHelpKey?: string
    groups: TestGroup[]
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
export interface RunnerSession {
    token: string
    suites: Record<string, SuiteDefinition>
    run: TestRun | null
}
