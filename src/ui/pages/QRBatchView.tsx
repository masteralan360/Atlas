import { QRBatchDetail } from '@/postal/QRBatches'
import { usePostalScope } from '@/postal/usePostalAccess'

export default function QRBatchView({ batchId }: { batchId: string }) {
  const scope = usePostalScope()
  return <QRBatchDetail key={`${scope.workspaceId}:${scope.userId}:${scope.role}:${scope.permissionScope}:${batchId}`} scope={scope} batchId={batchId} />
}
