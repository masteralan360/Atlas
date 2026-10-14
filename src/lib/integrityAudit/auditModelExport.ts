import { isTauri } from '@/lib/platform'
import { buildIntegrityAuditModel } from './auditModel'
import type { IntegrityAuditResult } from './types'

function safeFilePart(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'transaction'
}

export async function downloadIntegrityAuditModel(result: IntegrityAuditResult): Promise<void> {
  const model = buildIntegrityAuditModel(result)
  const content = JSON.stringify(model, null, 2)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reference = safeFilePart(result.transactionNumber ?? result.transactionId)
  const fileName = `transaction-integrity-audit-${reference}-${timestamp}.json`

  if (isTauri()) {
    const { BaseDirectory, writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(fileName, content, { baseDir: BaseDirectory.Download })
    return
  }

  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
