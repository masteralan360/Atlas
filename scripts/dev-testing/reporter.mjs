import { relative } from 'node:path'

// A private stdout protocol between the allowlisted Vitest child and controller.
const emit = (event) => process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify(event)}\n`)
const errors = (rows = []) => rows.map((error) => {
  const comparison = error.expected !== undefined || error.actual !== undefined
    ? `\nExpected: ${JSON.stringify(error.expected)}\nActual: ${JSON.stringify(error.actual)}` : ''
  return (String(error.stack || error.message || error) + comparison).slice(0, 12_000)
})

export default class AtlasTestReporter {
  onTestModuleCollected(module) {
    emit({ type: 'collected', tests: [...module.children.allTests()].map((test) => this.serialize(test, 'pending')) })
  }

  onTestCaseReady(test) {
    emit({ type: 'test', test: this.serialize(test, 'running') })
  }

  onTestCaseResult(test) {
    emit({ type: 'test', test: this.serialize(test, test.result().state) })
  }

  onTestRunEnd(modules, unhandledErrors) {
    emit({ type: 'finished', errors: errors([
      ...unhandledErrors,
      ...modules.flatMap((module) => [
        ...module.errors(),
        ...[...module.children.allSuites()].flatMap((suite) => suite.errors())
      ])
    ]) })
  }

  serialize(test, status) {
    return {
      id: test.id,
      name: test.fullName,
      file: relative(process.cwd(), test.module.moduleId).replaceAll('\\', '/'),
      status,
      durationMs: test.diagnostic()?.duration || 0,
      errors: errors(test.result().errors)
    }
  }
}
