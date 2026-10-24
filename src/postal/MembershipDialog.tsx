import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Users } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/components'
import { postalCommand, type PostalScope } from '@/local-db/postal'

export function MembershipDialog({
  scope,
  userId,
  leaderId,
  members,
  onClose,
  onSaved,
}: {
  scope: PostalScope
  userId: string
  leaderId: string
  members: Array<{ user_id: string; name?: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [replacement, setReplacement] = useState('')
  const action = usePostalAction()
  const valid =
    /^[A-Z0-9]{8}$/.test(code.replace(/-/g, '').toUpperCase()) &&
    (userId !== leaderId ||
      members.some((x) => x.user_id === replacement && x.user_id !== userId))
  const payload = { user_id: userId, code, replacement_leader_id: replacement }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex gap-2">
            <Users className="h-5 w-5" />
            {t('postal.moveMember')}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('postal.moveMemberHint')}
          </p>
          <Label htmlFor="postal-target-code">
            {t('postal.organizationCode')} *
          </Label>
          <Input
            id="postal-target-code"
            value={code}
            maxLength={9}
            disabled={action.busy}
            onChange={(e) => setCode(e.target.value)}
          />
          {userId === leaderId && (
            <>
              <Label>{t('postal.replacementLeader')} *</Label>
              <Select
                value={replacement}
                onValueChange={setReplacement}
                disabled={action.busy}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('postal.select')} />
                </SelectTrigger>
                <SelectContent>
                  {members
                    .filter((x) => x.user_id !== userId)
                    .map((x) => (
                      <SelectItem key={x.user_id} value={x.user_id}>
                        {x.name || x.user_id}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </>
          )}
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!valid || action.busy}
            onClick={() =>
              void action.run(JSON.stringify(payload), async (request) => {
                await postalCommand(scope, 'move_member', payload, request)
                onSaved()
              })
            }
          >
            {action.busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('postal.confirm')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
