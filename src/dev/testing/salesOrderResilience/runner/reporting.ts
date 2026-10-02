import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Action, SalesOrderModel } from '../model/modelTypes'
import type { SalesOrderGraph } from '../drivers/SalesOrderDriver'

export interface FailureEvidence {
    suite: 'Sales Order Resilience Lab'
    seed: number
    run: number
    sequence: Action[]
    failedCommand: Action
    invariant: string
    before: SalesOrderModel
    after: SalesOrderModel
    observed?: SalesOrderGraph
    driver: unknown
}
export async function saveLabReport(report: object) {
    const directory = join(process.cwd(), '.atlas-dev-testing', 'resilience')
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${process.env.ATLAS_LIVE_RUN_ID ?? 'module'}-${Date.now()}.json`)
    await writeFile(file, JSON.stringify(report, null, 2))
    return file
}
