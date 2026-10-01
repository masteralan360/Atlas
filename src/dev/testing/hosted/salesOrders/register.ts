import { describe, it } from 'vitest'
import catalog from './catalog.json'
import { setupHostedSaleOrders } from '../../fixtures/saleOrdersLive'
import { withScenario } from './harness'
import type { Domain } from './types'
import { customerChoices, lineChoices, unitChoices, priceChoices, currencyChoices, totalsChoices, creationChoices, quickChoice, quickTuples } from './choices'
import { approval, reservation, completion, collections, accounts, cancellation, standardReturns, correction, terminalStates } from './flows'
import { activation, schedule, financedReturn } from './financing'
import { authentication, access, remoteContracts, historical } from './security'
import { commissionSources, commissionSettlements } from './commissions'
import { marketplace } from './marketplace'
import { readPaths } from './reads'
import { concurrency, runnerEvidence } from './resilience'
import { ensurePreconditions } from './requirements'
import { variantsFor } from './matrix'

const handlers = [authentication, access, customerChoices, lineChoices, unitChoices, priceChoices, currencyChoices, totalsChoices,
    creationChoices, approval, reservation, completion, quickChoice, collections, accounts, activation, schedule, cancellation,
    standardReturns, financedReturn, correction, commissionSources, commissionSettlements, marketplace, terminalStates, readPaths,
    remoteContracts, concurrency, historical, runnerEvidence]

export function registerHostedSalesOrderDomain(id: string) {
    const domain: Domain | undefined = catalog.find(group => group.id === id)
    const handler = handlers[Number(id) - 1]
    if (!domain || !handler) throw new Error(`hosted_domain_unregistered:${id}`)
    describe(`Sale Orders · Supabase ${domain.id} · ${domain.name}`, () => {
        setupHostedSaleOrders()
        for (const family of domain.cases) {
            const selected: string[] = JSON.parse(process.env.ATLAS_LIVE_CASE_IDS || '[]')
            if (selected.length && !selected.includes(family.id)) continue
            const ordinal = Number(family.id.slice(-2))
            const tuples = id === '13' && ordinal <= 11 ? quickTuples(ordinal) : []
            if (tuples.length) for (const tuple of tuples) {
                const title = `${family.id} · ${family.name} / ${tuple.method}/${tuple.target}/${tuple.currency}/${tuple.paid ? 'paid' : 'unpaid'}/initial-${tuple.initial}/${tuple.lines}/${tuple.unit}/${tuple.account ? 'account' : 'no-account'}/${tuple.approval ? 'approval-request' : 'no-approval'}`
                it(title, () => { ensurePreconditions(family, tuple); return withScenario(family, s => quickChoice(s, tuple), { currency: tuple.currency }) }, 240_000)
            } else {
                const variants = variantsFor(family.id)
                if (variants.length) for (const variant of variants) it(`${family.id} · ${family.name} / ${variant.key}`, () => {
                    ensurePreconditions(family)
                    return withScenario(family, s => { s.variant = variant; return handler(s) })
                }, 600_000)
                else it(`${family.id} · ${family.name} → ${family.path} → ${family.integrity}`, () => { ensurePreconditions(family); return withScenario(family, handler) }, id === '28' && ordinal === 18 ? 43_200_000 : 600_000)
            }
        }
    })
}
