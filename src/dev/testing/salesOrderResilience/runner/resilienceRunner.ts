import * as fc from 'fast-check'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import type { Action, LabConfiguration } from '../model/modelTypes'
import type { SalesOrderDriver } from '../drivers/SalesOrderDriver'
import { applyAction, isValidAction, newModel } from '../model/modelState'
import { assertInvariants } from '../invariants'
import { commandArbitraries } from '../commands/commands'
import { saveLabReport, type FailureEvidence } from './reporting'

export interface RunnerOptions { seed?: number; runs?: number; maxCommands?: number; path?: string; replayPath?: string }
export async function runSequence(driver: SalesOrderDriver, sequence: readonly Action[]) {
    const model = newModel(driver.configuration)
    for (const action of sequence) {
        if (!isValidAction(action, model)) throw new Error(`scenario.invalidPrecondition: ${JSON.stringify(action)}`)
        await driver.execute(action); applyAction(action, model); await assertInvariants(model, driver)
    }
    return model
}
export async function runResilience(createDriver: (configuration: LabConfiguration) => Promise<SalesOrderDriver>, options: RunnerOptions = {}) {
    const seed = options.seed ?? Number(process.env.ATLAS_TEST_SEED ?? 20261002)
    const runs = options.runs ?? Number(process.env.ATLAS_TEST_SAMPLES ?? 100)
    let run = 0
    let failure: FailureEvidence | undefined
    const maxCommands = Number(process.env.SORL_MAX_COMMANDS ?? options.maxCommands ?? 60)
    const commands = fc.commands(commandArbitraries, { maxCommands, ...(options.replayPath ? { replayPath: options.replayPath } : {}) })
    const configurations = fc.record({ currency: fc.constantFrom('usd' as const, 'iqd' as const),
        method: fc.constantFrom(...STANDARD_PAYMENT_METHODS), account: fc.boolean() })
    const details = await fc.check(fc.asyncProperty(configurations, commands, async (configuration, sequence) => {
        let driver: SalesOrderDriver | undefined
        const model = newModel(configuration)
        const executed: Action[] = []
        let action: Action = { name: 'CreateOrder' }
        let before = structuredClone(model)
        try {
            driver = await createDriver(configuration)
            // Every sample starts with a real order. Remaining commands have model preconditions.
            executed.push(action)
            await driver.execute(action); applyAction(action, model); await assertInvariants(model, driver)
            for (const step of sequence) {
                if (!step.check(model)) continue
                action = JSON.parse(step.toString()) as Action
                before = structuredClone(model)
                executed.push(action)
                await step.run(model, driver)
            }
        } catch (error) {
            failure = { suite: 'Sales Order Resilience Lab', seed, run, sequence: [...executed], failedCommand: action,
                invariant: error instanceof Error ? error.message : String(error), before, after: structuredClone(model),
                observed: await driver?.readDatabaseGraph().catch(() => undefined), driver: driver?.diagnostics() ?? { stage: 'fixture', configuration } }
            throw error
        } finally { run++; await driver?.close() }
    }), { seed: seed | 0, numRuns: runs, path: options.path, verbose: 1, endOnFailure: false })
    if (details.failed) {
        const counterexample = details.counterexample?.[1]?.toString() ?? ''
        const replayPath = counterexample.match(/replayPath="([^"]+)"/)?.[1] ?? ''
        const boundary = (failure?.driver as { boundary?: string; mode?: string })
        const adapter = boundary?.boundary === 'supabase' ? ` --boundary=supabase --mode=${boundary.mode}` : ''
        const replay = `npm run test:sales-order-resilience:replay -- --seed=${seed} --max-commands=${maxCommands} --path=${details.counterexamplePath} --replay-path=${replayPath}${adapter}`
        const report = { ...failure, seed, run: details.numRuns, attempt: failure?.run, maxCommands, failed: true, shrinks: details.numShrinks, path: details.counterexamplePath, replayPath, counterexample, replay,
            error: details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance) }
        const file = await saveLabReport(report)
        throw new Error(`Sales Order Resilience Lab FAILED\n${JSON.stringify(report, null, 2)}\nReport: ${file}`)
    }
    return { suite: 'sales-order-resilience', seed, runs: details.numRuns, failed: false }
}
