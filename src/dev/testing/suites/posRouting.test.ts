import { describe, expect, it } from 'vitest'
import { getPosCheckoutRoute, type PosPaymentType } from '@/lib/posPaymentPolicy'

describe('Regular POS transaction routing', () => {
    for (const isActivitiesStorage of [false, true]) for (const isServicesStorage of [false, true]) for (const quickOrderEnabled of [false, true]) {
        const policy = { isActivitiesStorage, isServicesStorage, quickOrderEnabled }
        for (const paymentType of ['cash', 'digital', 'loan', 'order'] as PosPaymentType[]) {
            it(`${paymentType} / activities ${isActivitiesStorage} / services ${isServicesStorage} / Quick Order ${quickOrderEnabled}`, () => {
                const expected = paymentType === 'order' ? quickOrderEnabled && !isActivitiesStorage ? 'quick-order' : 'blocked'
                    : paymentType === 'loan' && isActivitiesStorage ? 'blocked'
                        : isActivitiesStorage ? 'activity' : 'sale'
                expect(getPosCheckoutRoute(paymentType, policy)).toBe(expected)
            })
        }
    }
})
