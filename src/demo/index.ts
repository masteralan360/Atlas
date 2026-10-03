export { DemoConfigPage } from './DemoConfigPage'
export { createDemoWorkspace, deleteDemoWorkspace } from './demoService'
export {
  captureDemoBrowserState,
  clearLocalDemoWorkspaceData,
  clearStoredDemoWorkspaces
} from './demoCleanup'
export { isDemoWorkspace, DEMO_CODE_PREFIX, DEMO_TIME_MIN, DEMO_TIME_MAX, DEMO_TIME_DEFAULT, DEMO_JOBS } from './demoConfig'
export type { DemoJob } from './demoConfig'

export const isDemoEnabled = (): boolean => {
  return import.meta.env.VITE_ENABLE_DEMO === 'true'
}
