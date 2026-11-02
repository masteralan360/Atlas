import { getAppSetting, setAppSetting } from '@/local-db/settings'

const getPrinterSettingKey = (workspaceId: string) =>
  `postal_auto_scan_printer_${workspaceId}`
const getEnabledSettingKey = (workspaceId: string) =>
  `postal_auto_scan_enabled_${workspaceId}`

export async function getPostalAutoScanPrinter(
  workspaceId: string,
): Promise<string | null> {
  if (!workspaceId) return null
  return (await getAppSetting(getPrinterSettingKey(workspaceId)))?.trim() || null
}

export async function savePostalAutoScanPrinter(
  workspaceId: string,
  printerName: string,
): Promise<void> {
  if (!workspaceId || !printerName.trim()) {
    throw new Error('postal_auto_scan_printer_required')
  }
  await setAppSetting(getPrinterSettingKey(workspaceId), printerName.trim())
}

export async function getPostalAutoScanEnabled(workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false
  return (await getAppSetting(getEnabledSettingKey(workspaceId))) === 'true'
}

export async function savePostalAutoScanEnabled(
  workspaceId: string,
  enabled: boolean,
): Promise<void> {
  if (!workspaceId) throw new Error('postal_auto_scan_workspace_required')
  await setAppSetting(getEnabledSettingKey(workspaceId), String(enabled))
}
