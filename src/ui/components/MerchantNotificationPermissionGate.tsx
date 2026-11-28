import { useCallback, useEffect, useRef, useState } from 'react'
import { BellRing, CircleAlert, Settings2, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspacePermissions } from '@/permissions'
import { isAndroidPwa, isIosPwa, isTauri } from '@/lib/platform'
import { registerDeviceTokenIfNeeded } from '@/services/notificationDevice'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'

type MobilePwaPlatform = 'ios' | 'android'
type GatePermission = NotificationPermission | 'unsupported'

function getInstalledMobilePwaPlatform(): MobilePwaPlatform | null {
  if (typeof window === 'undefined' || isTauri()) return null
  if (isIosPwa()) return 'ios'

  if (isAndroidPwa()) {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return 'android'
    } catch {
      return null
    }
  }

  return null
}

function readPermission(platform: MobilePwaPlatform | null): GatePermission {
  if (!platform || typeof window === 'undefined') return 'unsupported'

  const hasNotificationApi = 'Notification' in window
    && typeof Notification.requestPermission === 'function'
  const hasPushApi = 'PushManager' in window
    && 'serviceWorker' in navigator
  if (!hasNotificationApi || !hasPushApi) return 'unsupported'

  return Notification.permission
}

export function MerchantNotificationPermissionGate() {
  const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const { hasPermission, isLoading: isPermissionsLoading } = useWorkspacePermissions()
  const { t, i18n } = useTranslation()
  const platform = getInstalledMobilePwaPlatform()
  const [permission, setPermission] = useState<GatePermission>(() => readPermission(platform))
  const [isRequesting, setIsRequesting] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const requestInFlight = useRef(false)
  const previousPermission = useRef<GatePermission>(permission)

  const isMerchant = isAuthenticated
    && user?.role === 'staff'
    && !isAuthLoading
    && !isPermissionsLoading
    && hasPermission('postService.merchant')
  const isGateActive = Boolean(platform && isMerchant)

  const revalidate = useCallback(() => {
    setPermission(readPermission(platform))
  }, [platform])

  useEffect(() => {
    if (!isGateActive || !platform) return

    let disposed = false
    const check = () => {
      if (!disposed) revalidate()
    }

    check()
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    document.addEventListener('visibilitychange', check)

    let permissionStatus: PermissionStatus | undefined
    if (navigator.permissions?.query) {
      void navigator.permissions.query({ name: 'notifications' as PermissionName })
        .then((status) => {
          if (disposed) return
          permissionStatus = status
          status.addEventListener('change', check)
          check()
        })
        .catch(() => {
          // iOS and some embedded browsers do not expose notification permissions here.
        })
    }

    return () => {
      disposed = true
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
      document.removeEventListener('visibilitychange', check)
      permissionStatus?.removeEventListener('change', check)
    }
  }, [isGateActive, platform, revalidate])

  useEffect(() => {
    const previous = previousPermission.current
    previousPermission.current = permission

    if (
      previous !== 'granted'
      && permission === 'granted'
      && isMerchant
      && user?.id
    ) {
      void registerDeviceTokenIfNeeded(user.id, i18n.resolvedLanguage ?? i18n.language)
    }
  }, [i18n.language, i18n.resolvedLanguage, isMerchant, permission, user?.id])

  const handleEnableNotifications = () => {
    if (requestInFlight.current) return

    const currentPermission = readPermission(platform)
    setPermission(currentPermission)

    if (currentPermission !== 'default') {
      // A denied permission must be changed in system or browser settings.
      return
    }

    requestInFlight.current = true
    setIsRequesting(true)
    setRequestError(false)

    // Keep this call directly in the click handler for iOS Home Screen web apps.
    let permissionRequest: Promise<NotificationPermission>
    try {
      permissionRequest = Notification.requestPermission()
    } catch {
      requestInFlight.current = false
      setIsRequesting(false)
      setRequestError(true)
      revalidate()
      return
    }

    void permissionRequest
      .then(() => revalidate())
      .catch(() => {
        setRequestError(true)
        revalidate()
      })
      .finally(() => {
        requestInFlight.current = false
        setIsRequesting(false)
      })
  }

  if (!isGateActive || permission === 'granted') return null

  const isUnsupported = permission === 'unsupported'
  const isDenied = permission === 'denied'
  const instructionsKey = isUnsupported
    ? platform === 'ios'
      ? 'notifications.merchantGate.unsupportedIos'
      : 'notifications.merchantGate.unsupportedAndroid'
    : isDenied
      ? platform === 'ios'
        ? 'notifications.merchantGate.deniedIos'
        : 'notifications.merchantGate.deniedAndroid'
      : 'notifications.merchantGate.defaultHint'
  const InstructionIcon = isUnsupported ? Smartphone : isDenied ? Settings2 : BellRing

  return (
    <AppDialog open onOpenChange={() => undefined}>
      <AppDialogContent
        mobileFullscreen={false}
        showCloseButton={false}
        overlayClassName="z-[9998] bg-black/80 backdrop-blur-sm"
        className="!fixed !inset-0 !left-0 !top-0 !z-[9999] !h-[100dvh] !max-h-[100dvh] !w-screen !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !rounded-none !border-0 !bg-background !p-0"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <AppDialogHeader className="items-center text-center">
          <AppDialogTitle className="flex items-center gap-3 text-xl sm:text-2xl">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <BellRing aria-hidden="true" className="h-5 w-5" />
            </span>
            {t('notifications.merchantGate.title')}
          </AppDialogTitle>
        </AppDialogHeader>

        <AppDialogBody className="flex items-center justify-center">
          <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-2 py-8 text-center">
            {isUnsupported ? (
              <CircleAlert aria-hidden="true" className="h-12 w-12 text-amber-500" />
            ) : (
              <Smartphone aria-hidden="true" className="h-12 w-12 text-primary" />
            )}
            <AppDialogDescription className="text-base leading-relaxed text-foreground sm:text-lg">
              {t('notifications.merchantGate.message')}
            </AppDialogDescription>

            <div
              role="status"
              aria-live="polite"
              className="w-full rounded-2xl border border-border/70 bg-muted/40 p-4 text-start sm:p-5"
            >
              <div className="flex items-start gap-3">
                <InstructionIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                  {t(instructionsKey)}
                </p>
              </div>
            </div>

            {requestError && (
              <p role="alert" className="text-sm text-destructive">
                {t('notifications.merchantGate.requestFailed')}
              </p>
            )}
          </div>
        </AppDialogBody>

        <AppDialogFooter className="justify-center">
          <Button
            type="button"
            size="lg"
            className="min-h-12 w-full max-w-sm gap-2 text-base font-semibold"
            disabled={isRequesting || isUnsupported}
            onClick={handleEnableNotifications}
          >
            {isRequesting ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
            ) : (
              <BellRing aria-hidden="true" className="h-4 w-4" />
            )}
            {t('notifications.merchantGate.enable')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
