import { isTauri } from '@/lib/platform'
import type { ModuleWideIntegrityAuditRow } from './moduleWide'

export type ModuleWideIntegrityAuditExportType = 'warnings' | 'failures' | 'warnings-and-failures'

export function getModuleWideIntegrityAuditExportRows(
  rows: readonly ModuleWideIntegrityAuditRow[],
  type: ModuleWideIntegrityAuditExportType
): ModuleWideIntegrityAuditRow[] {
  return rows.filter(row => type === 'warnings'
    ? row.warnings > 0
    : type === 'failures'
      ? row.failed > 0
      : row.warnings > 0 || row.failed > 0)
}

export async function downloadModuleWideIntegrityAuditReferences(
  rows: readonly ModuleWideIntegrityAuditRow[],
  type: ModuleWideIntegrityAuditExportType
): Promise<void> {
  const matches = getModuleWideIntegrityAuditExportRows(rows, type)
  if (matches.length === 0) return

  const contents = matches.map(row => row.transactionReference).join('\n')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `transaction-integrity-audit-${type}-${timestamp}.txt`

  if (isTauri()) {
    const { BaseDirectory, writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(fileName, contents, { baseDir: BaseDirectory.Download })
    return
  }

  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
