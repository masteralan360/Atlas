import { useRoute } from 'wouter'

import { useAuth } from '@/auth/AuthContext'
import { LegacyPartnerDetailsView } from '@/ui/components/crm/LegacyPartnerDetailsView'

export function SupplierDetails() {
    const { user } = useAuth()
    const [match, params] = useRoute('/suppliers/:supplierId')

    if (!match || !params?.supplierId || !user?.workspaceId) {
        return null
    }

    return (
        <LegacyPartnerDetailsView
            workspaceId={user.workspaceId}
            partnerId={params.supplierId}
            kind="supplier"
        />
    )
}
