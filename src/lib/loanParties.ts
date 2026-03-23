import type { Loan, LoanLinkedPartyType } from '@/local-db/models'

type Translate = (key: string) => string

type LoanPartySource = Pick<Loan, 'linkedPartyType' | 'linkedPartyName'>

export interface LoanPartySelection {
    linkedPartyType: LoanLinkedPartyType
    linkedPartyId: string
    linkedPartyName: string
    borrowerName: string
    borrowerPhone: string
    borrowerAddress: string
}

function translateLoanParty(t: Translate, key: string, fallback: string) {
    const value = t(key)
    return value === key ? fallback : value
}

export function getLoanLinkedPartyTypeLabel(_type: LoanLinkedPartyType, t: Translate) {
    return translateLoanParty(t, 'loans.partyTypes.customer', 'Customer')
}

export function hasLoanLinkedParty(loan: LoanPartySource | null | undefined): loan is LoanPartySource & {
    linkedPartyType: LoanLinkedPartyType
    linkedPartyName: string
} {
    return !!loan?.linkedPartyType && !!loan.linkedPartyName
}

export function getLoanLinkedPartySummary(loan: LoanPartySource | null | undefined, t: Translate) {
    if (!hasLoanLinkedParty(loan)) {
        return null
    }

    return `${translateLoanParty(t, 'loans.belongsTo', 'Belongs to')}: ${getLoanLinkedPartyTypeLabel(loan.linkedPartyType, t)} - ${loan.linkedPartyName}`
}
