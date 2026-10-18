import { useRoute } from 'wouter'

import { useAuth } from '@/auth/AuthContext'
import { LegacyPartnerDetailsView } from '@/ui/components/crm/LegacyPartnerDetailsView'

export function CustomerDetails() {
    const { user } = useAuth()
    const [match, params] = useRoute('/customers/:customerId')

    if (!match || !params?.customerId || !user?.workspaceId) {
        return null
    }

    return (
        <LegacyPartnerDetailsView
            workspaceId={user.workspaceId}
            partnerId={params.customerId}
            kind="customer"
        />
    )
}
