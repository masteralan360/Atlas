import { TestController } from './controller.mjs'

const value = (flag) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const controller = new TestController({ onGroupResult: (group) => console.log(`${group.id}: ${group.status} (${group.tests.length} checks)`) })
process.once('SIGINT', () => { if (controller.run) controller.cancel(controller.run.id) })
try {
  const run = controller.start({
    suiteId: value('--suite') ?? 'sale-orders',
    groupIds: value('--groups')?.split(','),
    seed: value('--seed') === undefined ? undefined : Number(value('--seed')),
    samples: value('--samples') === undefined ? undefined : Number(value('--samples'))
  })
  console.log(`Running ${run.suiteId}, seed ${run.seed}, ${run.samples} generated cases`)
  await controller.completion
  console.log(`Full environment checks unavailable: ${run.unavailable.join(', ')}`)
  console.log(`Report: ${run.reportPath ?? 'unavailable'}`)
  process.exitCode = run.status === 'passed' ? 0 : 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
