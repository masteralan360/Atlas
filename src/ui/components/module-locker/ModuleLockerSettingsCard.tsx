import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { History, KeyRound, Loader2, LockKeyhole, ShieldCheck, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { verifyLocalAccountPassword } from '@/auth/localAccountAuth'
import { supabase } from '@/auth/supabase'
import {
  getModuleLockerSnapshot,
  listModuleLockerAudit,
  removeModuleLockerPasskey,
  setModuleLockerPasskey,
  type ModuleLockerActor
} from '@/local-db/moduleLocker'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { useWorkspace } from '@/workspace'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle
} from '../dialog'
import { Button } from '../button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../card'
import { DeleteConfirmationModal } from '../DeleteConfirmationModal'
import { Input } from '../input'
import { Label } from '../label'
import { useToast } from '../use-toast'

type PasskeyFormAction = 'set' | 'change' | 'remove'

export function ModuleLockerSettingsCard() {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const { user, isSupabaseConfigured } = useAuth()
  const { isLocalMode, isDemoMode } = useWorkspace()
  const workspaceId = user?.workspaceId
  const actor = useMemo<ModuleLockerActor | null>(() => {
    if (!user) return null
    return { userId: user.id, name: user.name || user.email || t('settings.moduleLocker.unknownActor') }
  }, [t, user])
  const snapshot = useLiveQuery(
    () => (workspaceId ? getModuleLockerSnapshot(workspaceId) : undefined),
    [workspaceId]
  )
  const auditEvents = useLiveQuery(
    () => (workspaceId ? listModuleLockerAudit(workspaceId) : []),
    [workspaceId]
  ) ?? []
  const settings = snapshot?.settings ?? null
  const [formAction, setFormAction] = useState<PasskeyFormAction | null>(null)
  const [accountPassword, setAccountPassword] = useState('')
  const [newPasskey, setNewPasskey] = useState('')
  const [repeatPasskey, setRepeatPasskey] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] = useState(false)

  if (user?.role !== 'admin' || !workspaceId || !actor) return null

  const resetForm = () => {
    setAccountPassword('')
    setNewPasskey('')
    setRepeatPasskey('')
  }

  const openPasskeyForm = (action: PasskeyFormAction) => {
    resetForm()
    setFormAction(action)
  }

  const handleFormOpenChange = (open: boolean) => {
    if (!open && isSaving) return
    if (!open) {
      setFormAction(null)
      resetForm()
    }
  }

  const verifyCurrentAdminPassword = async () => {
    if (!accountPassword) {
      throw new Error(t('settings.moduleLocker.currentPasswordRequired'))
    }

    if (isLocalMode || isDemoMode || !isSupabaseConfigured) {
      const result = await verifyLocalAccountPassword(workspaceId, user.id, accountPassword)
      if (result.ok) return
      if (result.reason === 'locked') {
        throw new Error(
          t('settings.moduleLocker.localPasswordLocked', {
            seconds: Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1_000))
          })
        )
      }
      if (result.reason === 'missing') throw new Error(t('settings.moduleLocker.localPasswordUnavailable'))
      throw new Error(t('settings.moduleLocker.currentPasswordIncorrect'))
    }

    if (!user.email) throw new Error(t('settings.moduleLocker.currentPasswordUnavailable'))
    const { error } = await runSupabaseAction(
      'settings.verifyModuleLockerAdminPassword',
      () => supabase.auth.signInWithPassword({ email: user.email, password: accountPassword }),
      { timeoutMs: 15_000, platform: 'all' }
    ) as { error: Error | null }
    if (error) throw new Error(t('settings.moduleLocker.currentPasswordIncorrect'))
  }

  const canSavePasskey = Boolean(
    accountPassword &&
    (formAction === 'remove' || (newPasskey.trim() && newPasskey === repeatPasskey))
  )

  const handlePasskeySave = async () => {
    if (!formAction || !canSavePasskey) return
    setIsSaving(true)
    try {
      await verifyCurrentAdminPassword()
      if (formAction === 'remove') {
        await removeModuleLockerPasskey({ workspaceId, actor })
        toast({ title: t('settings.moduleLocker.removedToastTitle'), description: t('settings.moduleLocker.removedToastDescription') })
      } else {
        await setModuleLockerPasskey({
          workspaceId,
          passkey: newPasskey,
          actor
        })
        toast({
          title: formAction === 'set' ? t('settings.moduleLocker.setToastTitle') : t('settings.moduleLocker.changedToastTitle'),
          description: t('settings.moduleLocker.passkeySavedDescription')
        })
      }
      setFormAction(null)
      resetForm()
    } catch (error) {
      console.error('[ModuleLocker] Failed to save passkey settings:', error)
      toast({
        title: t('settings.moduleLocker.saveFailedTitle'),
        description: error instanceof Error ? error.message : t('settings.moduleLocker.saveFailedDescription'),
        variant: 'destructive'
      })
    } finally {
      setIsSaving(false)
    }
  }

  const formTitle = formAction === 'set'
    ? t('settings.moduleLocker.setDialogTitle')
    : formAction === 'change'
      ? t('settings.moduleLocker.changeDialogTitle')
      : t('settings.moduleLocker.removeDialogTitle')
  const formDescription = formAction === 'remove'
    ? t('settings.moduleLocker.removeDialogDescription')
    : t('settings.moduleLocker.passkeyDialogDescription')

  return (
    <>
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="h-5 w-5 text-primary" />
            {t('settings.moduleLocker.title')}
          </CardTitle>
          <CardDescription>{t('settings.moduleLocker.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {snapshot === undefined ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.moduleLocker.loading')}
            </div>
          ) : settings ? (
            <>
              <div className="flex flex-col gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <p className="font-medium">{t('settings.moduleLocker.configuredTitle')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t('settings.moduleLocker.configuredDescription')}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => openPasskeyForm('change')}>
                    <KeyRound className="mr-2 h-4 w-4" />
                    {t('settings.moduleLocker.changePasskey')}
                  </Button>
                  <Button type="button" variant="destructive" onClick={() => setIsDeleteConfirmationOpen(true)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('settings.moduleLocker.removePasskey')}
                  </Button>
                </div>
              </div>

              <div className="space-y-3 border-t pt-5">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-medium">{t('settings.moduleLocker.auditTitle')}</h3>
                </div>
                {auditEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('settings.moduleLocker.auditEmpty')}</p>
                ) : (
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {auditEvents.map((event) => (
                      <div key={event.id} className="rounded-md border border-border/70 px-3 py-2 text-sm">
                        <p className="font-medium">
                          {t(`settings.moduleLocker.auditActions.${event.action}`, { module: event.moduleName ?? t('settings.moduleLocker.moduleFallback') })}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('settings.moduleLocker.auditMeta', {
                            actor: event.actorName,
                            date: new Date(event.occurredAt).toLocaleString(i18n.language)
                          })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-4 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">{t('settings.moduleLocker.notConfiguredTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.moduleLocker.notConfiguredDescription')}</p>
              </div>
              <Button type="button" onClick={() => openPasskeyForm('set')}>
                <KeyRound className="mr-2 h-4 w-4" />
                {t('settings.moduleLocker.setPasskey')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <DeleteConfirmationModal
        isOpen={isDeleteConfirmationOpen}
        onClose={() => setIsDeleteConfirmationOpen(false)}
        onConfirm={() => {
          setIsDeleteConfirmationOpen(false)
          openPasskeyForm('remove')
        }}
        title={t('settings.moduleLocker.removeConfirmTitle')}
        description={t('settings.moduleLocker.removeConfirmDescription')}
        itemName={t('settings.moduleLocker.title')}
      />

      <AppDialog open={formAction !== null} onOpenChange={handleFormOpenChange}>
        <AppDialogContent className="max-w-md" showCloseButton={!isSaving}>
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              {formAction === 'remove' ? <Trash2 className="h-5 w-5 text-destructive" /> : <KeyRound className="h-5 w-5 text-primary" />}
              {formTitle}
            </AppDialogTitle>
            <AppDialogDescription>{formDescription}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="module-locker-current-password">{t('settings.moduleLocker.currentPasswordLabel')} *</Label>
                <Input
                  id="module-locker-current-password"
                  type="password"
                  autoComplete="off"
                  value={accountPassword}
                  onChange={(event) => setAccountPassword(event.target.value)}
                  disabled={isSaving}
                />
              </div>
              {formAction !== 'remove' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="module-locker-new-passkey">{t('settings.moduleLocker.newPasskeyLabel')} *</Label>
                    <Input
                      id="module-locker-new-passkey"
                      type="password"
                      autoComplete="off"
                      value={newPasskey}
                      onChange={(event) => setNewPasskey(event.target.value)}
                      disabled={isSaving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="module-locker-repeat-passkey">{t('settings.moduleLocker.repeatPasskeyLabel')} *</Label>
                    <Input
                      id="module-locker-repeat-passkey"
                      type="password"
                      autoComplete="off"
                      value={repeatPasskey}
                      onChange={(event) => setRepeatPasskey(event.target.value)}
                      disabled={isSaving}
                    />
                    {repeatPasskey && repeatPasskey !== newPasskey && (
                      <p className="text-xs text-destructive">{t('settings.moduleLocker.passkeyMismatch')}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={() => handleFormOpenChange(false)} disabled={isSaving}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant={formAction === 'remove' ? 'destructive' : 'default'}
              onClick={() => void handlePasskeySave()}
              disabled={!canSavePasskey || isSaving}
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSaving
                ? t('settings.moduleLocker.saving')
                : formAction === 'remove'
                  ? t('settings.moduleLocker.removePasskey')
                  : formAction === 'set'
                    ? t('settings.moduleLocker.setPasskey')
                    : t('settings.moduleLocker.changePasskey')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </>
  )
}
