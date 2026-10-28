// Isolated UI fixture. Browser checks intercept network calls and execute the
// real migration in PGlite; this fixture never supplies production auth.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../src/i18n/config'
import '../../src/index.css'
import { ShipmentForm } from '../../src/postal/ShipmentForm'
import { ShipmentTimeline } from '../../src/postal/ShipmentTimeline'
import { RecipientContactFlow } from '../../src/postal/RecipientContactFlow'
import { ShipmentLabel } from '../../src/postal/ShipmentLabel'
import { preparePostalLabel } from '../../src/postal/printing'
import { getPrintPreviewEditorSource } from '../../src/lib/printPreviewEditorStore'
import type { PostalEvent, PostalShipment } from '../../src/postal/domain'
import { resolvePostalQr } from '../../src/local-db/postal'
import {
  BranchDialog,
  OrganizationDialog,
} from '../../src/postal/ManagementDialogs'
import { MembershipDialog } from '../../src/postal/MembershipDialog'
import { CreateShipmentFlow } from '../../src/postal/CreateShipmentFlow'
import { WorkspaceAccountCreation } from '../../src/ui/components/workspace/WorkspaceAccountCreation'
import PostalServicePage from '../../src/ui/pages/PostalServicePage'
import { OrganizationAccountStatement } from '../../src/postal/OrganizationAccountStatement'
import { DateRangeProvider } from '../../src/context/DateRangeContext'
import { UiAccessProvider } from '../../src/context/UiAccessContext'
import { OperationDialog } from '../../src/postal/OperationDialog'
import { CodPaymentDialog } from '../../src/postal/CodPaymentDialog'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '../../src/query/queryClient'
import { AuthProvider } from '../../src/auth/AuthContext'
import { WorkspaceProvider } from '../../src/workspace/WorkspaceContext'
import { WorkspacePermissionsProvider } from '../../src/permissions/WorkspacePermissionsContext'

if (
  !import.meta.env.DEV ||
  !(window as Window & { __ATLAS_POSTAL_BROWSER_TEST__?: boolean })
    .__ATLAS_POSTAL_BROWSER_TEST__
) {
  throw new Error(
    'This fixture is only available to the isolated Post Service browser checks.',
  )
}

const scope = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000011',
  role: 'merchant' as const,
  permissionScope: 'postService.merchant',
}
const shipment: PostalShipment = {
  id: '00000000-0000-4000-8000-000000000021',
  shipment_number: 42,
  qr_id: '00000000-0000-4000-8000-000000000022',
  workspace_id: scope.workspaceId,
  organization_id: '00000000-0000-4000-8000-000000000023',
  recipient_name: 'Recipient',
  primary_phone: '07501234567',
  backup_phone: '009647701234567',
  governorate: 'erbil',
  area: 'ankawa',
  address: 'Street 12',
  cod_amount: -25000,
  pieces: 2,
  fragile: true,
  delivery_notes: 'Handle carefully',
  state: 'delivered',
  current_branch_id: null,
  revision: 1,
  created_at: '2026-10-24T09:00:00Z',
  updated_at: '2026-10-24T09:00:00Z',
  deleted_at: null,
}
const kinds = [
  'created',
  'receive',
  'transfer_authorized',
  'dispatch',
  'arrive',
  'transfer_authorized',
  'dispatch',
  'arrive',
  'out_for_delivery',
  'deliver',
  'cod_recorded',
  'merchant_account_updated',
]
const events: PostalEvent[] = kinds.map((event_type, index) => ({
  id: String(index),
  sequence: index,
  event_type,
  previous_state: null,
  resulting_state: index >= 9 ? 'delivered' : 'received',
  actor_name: 'Office employee',
  created_at: `2026-10-24T${String(index + 1).padStart(2, '0')}:00:00Z`,
  notes: null,
  metadata:
    index > 1 && index < 8
      ? { origin_name: 'Erbil', destination_name: 'Baghdad' }
      : {},
}))
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WorkspaceProvider>
          <WorkspacePermissionsProvider>
            {children}
          </WorkspacePermissionsProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
function Fixture() {
  const view = new URLSearchParams(location.search).get('view')
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState<PostalShipment>()
  const [source, setSource] = useState<PostalShipment>()
  if (view === 'statement')
    return <Providers><DateRangeProvider><UiAccessProvider>
      <main className="w-full min-w-0 p-3 sm:p-6"><OrganizationAccountStatement scope={{ ...scope,
        userId: '00000000-0000-4000-8000-000000000012', role: 'office', permissionScope: 'postService.officeEmployee' }} /></main>
    </UiAccessProvider></DateRangeProvider></Providers>
  if (view === 'dashboard')
    return (
      <QueryClientProvider client={queryClient}>
        <DateRangeProvider>
          <UiAccessProvider>
          <PostalServicePage />
          </UiAccessProvider>
        </DateRangeProvider>
      </QueryClientProvider>
    )
  if (view === 'account')
    return <WorkspaceAccountCreation accountType="postalMerchant" />
  if (view === 'branch')
    return (
      <BranchDialog
        scope={{ ...scope, role: 'admin' }}
        onClose={() => setOpen(false)}
      />
    )
  if (view === 'membership')
    return (
      <MembershipDialog
        scope={{ ...scope, role: 'admin' }}
        userId={scope.userId}
        leaderId={scope.userId}
        members={[
          { user_id: scope.userId, name: 'Leader' },
          { user_id: '00000000-0000-4000-8000-000000000099', name: 'Member' },
        ]}
        onClose={() => setOpen(false)}
        onSaved={() => setOpen(false)}
      />
    )
  if (view === 'choose')
    return (
      <CreateShipmentFlow
        scope={scope}
        onClose={() => setOpen(false)}
        onSaved={() => setOpen(false)}
      />
    )
  if (view === 'organization')
    return (
      <Providers>
        <OrganizationDialog
          scope={{ ...scope, role: 'admin' }}
          organization={{
            id: new URLSearchParams(location.search).get('org')!,
            workspace_id: scope.workspaceId,
            name: 'Merchant organization',
            code: 'ABCD2345',
            leader_id: scope.userId,
          }}
          onClose={() => setOpen(false)}
        />
      </Providers>
    )
  if (view === 'operation')
    return (
      <Providers>
        <OperationDialog
          scope={{ ...scope, role: 'admin' }}
          shipment={{ ...shipment, state: 'received' }}
          operation="out_for_delivery"
          onClose={() => setOpen(false)}
        />
      </Providers>
    )
  if (view === 'payment')
    return (
      <Providers>
        <CodPaymentDialog
          scope={{ ...scope, role: 'admin' }}
          shipment={shipment}
          summary={{ collected: 0, settled: 0 }}
          kind="collection"
          onClose={() => setOpen(false)}
        />
      </Providers>
    )
  if (view === 'copy')
    return (
      <main>
        {!source ? (
          <button
            onClick={async () =>
              setSource(
                await resolvePostalQr(
                  scope,
                  new URLSearchParams(location.search).get('qr')!,
                ),
              )
            }
          >
            Read QR
          </button>
        ) : (
          open && (
            <ShipmentForm
              scope={scope}
              source={source}
              onClose={() => setOpen(false)}
              onSaved={(row) => {
                setSaved(row)
                setOpen(false)
              }}
            />
          )
        )}
        {saved && <p data-testid="saved">{JSON.stringify(saved)}</p>}
      </main>
    )
  if (view === 'timeline')
    return (
      <main className="p-4">
        <ShipmentTimeline events={events} state="delivered" />
      </main>
    )
  if (view === 'contact')
    return (
      <main>
        <button onClick={() => setOpen(true)}>Open contact</button>
        {open && (
          <RecipientContactFlow
            primary={shipment.primary_phone}
            backup={shipment.backup_phone}
            onClose={() => setOpen(false)}
          />
        )}
      </main>
    )
  if (view === 'label')
    return (
      <>
        <ShipmentLabel shipment={shipment} />
        <button
          onClick={async () => {
            preparePostalLabel(shipment, scope.workspaceId, i18n.t.bind(i18n))
            const source = getPrintPreviewEditorSource()!
            const element = source.templatePreview!.createElement({
              note: 'Edited label note',
            })
            const blob = await source.templatePreview!.buildPdf(element)
            ;(window as unknown as { pdfResult: object }).pdfResult = {
              size: blob.size,
              type: blob.type,
              qr: shipment.qr_id,
              buffer: Array.from(new Uint8Array(await blob.arrayBuffer())),
            }
          }}
        >
          Build PDF
        </button>
      </>
    )
  return (
    <main>
      {open && (
        <ShipmentForm
          scope={scope}
          onClose={() => setOpen(false)}
          onSaved={(row) => {
            setSaved(row)
            setOpen(false)
          }}
        />
      )}
      {saved && <p data-testid="saved">{JSON.stringify(saved)}</p>}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    <Fixture />
  </I18nextProvider>,
)
