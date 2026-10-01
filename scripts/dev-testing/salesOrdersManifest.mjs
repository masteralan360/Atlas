import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const compiled = buildSync({
  absWorkingDir: root, entryPoints: ['src/dev/testing/hosted/salesOrders/matrix.ts'], bundle: true,
  write: false, platform: 'node', format: 'esm', alias: { '@': `${root}/src` }, logLevel: 'silent'
})
const { quickTuples, variantsFor } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const familySize = family => family.id.startsWith('SO-H13-') && Number(family.id.slice(-2)) <= 11 ? quickTuples(Number(family.id.slice(-2))).length : variantsFor(family.id).length || 1
export const hostedCatalog = JSON.parse(readFileSync(new URL('../../src/dev/testing/hosted/salesOrders/catalog.json', import.meta.url), 'utf8'))
export const hostedDenominator = hostedCatalog.map(domain => ({
  domainId: domain.id, families: domain.cases.length,
  tests: domain.cases.reduce((count, family) => count + familySize(family), 0)
}))
export const hostedTestCount = hostedDenominator.reduce((count, domain) => count + domain.tests, 0)
export function selectedDenominator(caseIds) {
  return hostedCatalog.flatMap(domain => domain.cases).filter(family => !caseIds?.length || caseIds.includes(family.id))
    .reduce((count, family) => count + familySize(family), 0)
}
