import { useRoute } from 'wouter'

import { useAuth } from '@/auth/AuthContext'
import { PartnerDetailsView } from '@/ui/components/crm/PartnerDetailsView'

export function OnlineCustomerDetails() {
    const { user } = useAuth()
    const [match, params] = useRoute('/online-customers/:partnerId')

    if (!match || !params?.partnerId || !user?.workspaceId) {
        return null
    }

    return (
        <PartnerDetailsView
            workspaceId={user.workspaceId}
            partnerId={params.partnerId}
            kind="business_partner"
        />
    )
}