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

export function buildDemoCode(job: DemoJob, minutes: number): string {
  const suffix = Math.random().toString(36).substring(2, 8)
  return `demo.${job}.${minutes}.${suffix}`
}

export function isDemoWorkspace(code: string | undefined | null): boolean {
  if (!code) return false
  return code.startsWith(DEMO_CODE_PREFIX)
}
