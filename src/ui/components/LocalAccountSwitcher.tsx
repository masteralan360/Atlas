import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Check,
  ChevronUp,
  KeyRound,
  Loader2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth";
import {
  CloudAccountSwitchError,
  requestCloudWorkspaceAccounts,
  type CloudWorkspaceAccount,
} from "@/auth/cloudAccountSwitcher";
import {
  listLocalWorkspaceAccounts,
  type LocalWorkspaceAccount,
} from "@/auth/localAccountAuth";
import { cn } from "@/lib/utils";
import { platformService } from "@/services/platformService";
import { connectionManager } from "@/lib/connectionManager";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface LocalAccountSwitcherProps {
  isCompact: boolean;
  nameRoleOnly?: boolean;
  shiftBadge?: "ready" | "complete" | null;
  manualShiftActiveDuration?: string | null;
}

type SwitcherAccount = {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: string;
  profileUrl?: string | null;
  hasCredential: boolean;
};

function AccountAvatar({
  account,
  className,
}: {
  account: Pick<SwitcherAccount, "name" | "profileUrl">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-primary to-emerald-600 font-bold text-white shadow-sm",
        className,
      )}
    >
      {account.profileUrl ? (
        <img
          src={
            account.profileUrl.startsWith("http")
              ? account.profileUrl
              : platformService.convertFileSrc(account.profileUrl)
          }
          alt={account.name}
          className="h-full w-full object-cover"
        />
      ) : (
        account.name.charAt(0).toUpperCase() || "U"
      )}
    </span>
  );
}

export function LocalAccountSwitcher({
  isCompact,
  nameRoleOnly = false,
  shiftBadge = null,
  manualShiftActiveDuration = null,
}: LocalAccountSwitcherProps) {
  const { t } = useTranslation();
  const { user, switchLocalAccount, switchCloudAccount } = useAuth();
  const isLocalMode = user?.workspaceMode === "local";
  const isCloudMode = user?.workspaceMode === "cloud" || user?.workspaceMode === "hybrid";
  const [isOnline, setIsOnline] = useState(
    () => connectionManager.getState().isOnline && navigator.onLine !== false,
  );
  const [cloudAccounts, setCloudAccounts] = useState<CloudWorkspaceAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [accountsLoadError, setAccountsLoadError] = useState(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<SwitcherAccount | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);

  const storedAccounts = useLiveQuery(
    () => isLocalMode ? listLocalWorkspaceAccounts(user?.workspaceId ?? "") : Promise.resolve([]),
    [isLocalMode, user?.workspaceId],
    [],
  );

  useEffect(() => {
    const updateOnline = () => {
      setIsOnline(connectionManager.getState().isOnline && navigator.onLine !== false);
    };
    const unsubscribe = connectionManager.subscribe(updateOnline);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    updateOnline();
    return () => {
      unsubscribe();
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    if (!isCloudMode || !user?.workspaceId || !isOnline || !isSwitcherOpen) {
      setCloudAccounts([]);
      setIsLoadingAccounts(false);
      setAccountsLoadError(false);
      return;
    }

    let isCurrent = true;
    setIsLoadingAccounts(true);
    setAccountsLoadError(false);
    void requestCloudWorkspaceAccounts(user.workspaceId)
      .then((accounts) => {
        if (isCurrent) setCloudAccounts(accounts);
      })
      .catch(() => {
        if (isCurrent) {
          setCloudAccounts([]);
          setAccountsLoadError(true);
        }
      })
      .finally(() => {
        if (isCurrent) setIsLoadingAccounts(false);
      });

    return () => { isCurrent = false; };
  }, [isCloudMode, user?.workspaceId, user?.id, isOnline, isSwitcherOpen]);

  const accounts = useMemo(() => {
    if (!user?.workspaceId) return storedAccounts;
    if (storedAccounts.some((account) => account.id === user.id)) {
      return storedAccounts;
    }

    return [
      {
        id: user.id,
        workspaceId: user.workspaceId,
        email: user.email,
        name: user.name,
        role: user.role,
        profileUrl: user.profileUrl,
        hasCredential: false,
      },
      ...storedAccounts,
    ];
  }, [storedAccounts, user]);

  if (!user || (!isLocalMode && !isCloudMode)) {
    return null;
  }

  const localCurrentAccount: SwitcherAccount = {
    id: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    name: user.name,
    role: user.role,
    profileUrl: user.profileUrl,
    hasCredential:
      accounts.find((account) => account.id === user.id)?.hasCredential ?? false,
  };

  const currentAccount: SwitcherAccount = isLocalMode
    ? localCurrentAccount
    : {
        id: user.id,
        workspaceId: user.workspaceId,
        email: user.email,
        name: user.name,
        role: user.role,
        profileUrl: user.profileUrl,
        hasCredential: true,
      };
  const visibleAccounts: SwitcherAccount[] = isLocalMode
    ? accounts
    : cloudAccounts.map((account) => ({
        ...account,
        workspaceId: user.workspaceId,
        hasCredential: true,
      }));

  const openPasswordDialog = (account: LocalWorkspaceAccount) => {
    setSelectedAccount(account);
    setPassword("");
    setError(null);
  };

  const closePasswordDialog = () => {
    if (isSwitching) return;
    setSelectedAccount(null);
    setPassword("");
    setError(null);
  };

  const handleSwitch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAccount || !password || (isCloudMode && !isOnline)) return;

    setIsSwitching(true);
    setError(null);
    const result = isLocalMode
      ? await switchLocalAccount(selectedAccount.id, password)
      : await switchCloudAccount(selectedAccount.id, password);
    if (result.error) {
      if (isCloudMode && result.error instanceof CloudAccountSwitchError) {
        setError(t(`accounts.cloudSwitchErrors.${result.error.code}`));
      } else {
        setError(result.error.message);
      }
      setIsSwitching(false);
      return;
    }

    window.location.reload();
  };

  return (
    <>
      <DropdownMenu
        open={isSwitcherOpen}
        onOpenChange={(open) => {
          setIsSwitcherOpen(open);
          if (open && isCloudMode && isOnline) {
            setIsLoadingAccounts(true);
            setAccountsLoadError(false);
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              isCompact && "flex-col gap-1 px-1",
              nameRoleOnly && !isCompact && "gap-1 px-1",
              manualShiftActiveDuration && "mb-3",
            )}
            title={t(isLocalMode ? "accounts.openSwitcher" : "accounts.openCloudSwitcher")}
          >
            {!nameRoleOnly && (
              <span className="relative shrink-0">
                <AccountAvatar account={currentAccount} className="h-9 w-9 text-sm" />
                {shiftBadge ? (
                  <span className="pointer-events-none absolute -bottom-1 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap">
                    <span
                      className={cn(
                        "block rounded-[3px] border px-1.5 py-0.5 text-[8px] font-bold leading-none text-white shadow-sm",
                        shiftBadge === "ready"
                          ? "border-emerald-200 bg-emerald-500 dark:border-emerald-300/40"
                          : "border-primary/30 bg-primary",
                      )}
                      title={t(
                        shiftBadge === "ready"
                          ? "paymentAccounts.readyShiftBadge"
                          : "paymentAccounts.completeShiftBadge",
                      )}
                      aria-label={t(
                        shiftBadge === "ready"
                          ? "paymentAccounts.shiftStatuses.available"
                          : "paymentAccounts.completeShift",
                      )}
                    >
                      {t(
                        shiftBadge === "ready"
                          ? "paymentAccounts.readyShiftBadge"
                          : "paymentAccounts.completeShiftBadge",
                      )}
                    </span>
                    {manualShiftActiveDuration ? (
                      <span
                        className="absolute left-1/2 top-full -mt-px -translate-x-1/2 rounded-[3px] border border-muted-foreground/25 bg-muted px-1.5 py-0.5 font-mono text-[8px] font-bold leading-none text-muted-foreground shadow-sm"
                        title={t("paymentAccounts.manualShiftActiveDuration", {
                          time: manualShiftActiveDuration,
                        })}
                        aria-label={t("paymentAccounts.manualShiftActiveDuration", {
                          time: manualShiftActiveDuration,
                        })}
                      >
                        {manualShiftActiveDuration}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            )}
            {(!isCompact || nameRoleOnly) && (
              <div
                className={cn(
                  "min-w-0 flex-1",
                  nameRoleOnly && isCompact && "max-w-[80px] text-center",
                )}
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {currentAccount.name}
                </p>
                <p className="truncate text-xs capitalize text-muted-foreground">
                  {currentAccount.role}
                </p>
              </div>
            )}
            <ChevronUp
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground",
                isCompact && "h-3.5 w-3.5",
              )}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[280px] rounded-xl border-border/70 bg-background/95 p-2 backdrop-blur-xl"
        >
          <DropdownMenuLabel className="pb-2">
            <div className="space-y-1">
              <p>
                {t("accounts.switchAccount", {
                  defaultValue: "Switch Account",
                })}
              </p>
              <p className="text-xs font-normal text-muted-foreground">
                {t(isLocalMode ? "accounts.localWorkspaceOnly" : "accounts.cloudWorkspaceOnly")}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-[280px] overflow-y-auto">
            {isCloudMode && !isOnline ? (
              <DropdownMenuItem disabled className="gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100">
                <KeyRound className="h-4 w-4 shrink-0" />
                {t("accounts.cloudSwitchOffline")}
              </DropdownMenuItem>
            ) : isCloudMode && isLoadingAccounts ? (
              <DropdownMenuItem disabled className="gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("accounts.loadingMembers")}
              </DropdownMenuItem>
            ) : accountsLoadError ? (
              <DropdownMenuItem disabled className="rounded-lg px-3 py-2 text-xs text-destructive data-[disabled]:opacity-100">
                {t("accounts.cloudMembersUnavailable")}
              </DropdownMenuItem>
            ) : visibleAccounts.length === 0 ? (
              <DropdownMenuItem
                disabled
                className="rounded-lg px-3 py-2 text-xs text-muted-foreground data-[disabled]:opacity-100"
              >
                {t("accounts.noneAvailable", {
                  defaultValue: "No local accounts available.",
                })}
              </DropdownMenuItem>
            ) : (
              visibleAccounts.map((account) => {
                const isCurrent = account.id === user.id;
                const isCurrentAndReady = isCurrent && account.hasCredential;

                return (
                  <DropdownMenuItem
                    key={account.id}
                    disabled={isCurrentAndReady || (isCloudMode && !isOnline)}
                    onSelect={() => openPasswordDialog(account)}
                    className="gap-3 rounded-lg px-3 py-2 data-[disabled]:opacity-100"
                  >
                    <span className="relative">
                      <AccountAvatar
                        account={account}
                        className="h-8 w-8 text-xs"
                      />
                      {isCurrent && (
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground">
                          <Check className="h-2.5 w-2.5" />
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-foreground">
                        {account.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {isCloudMode
                          ? account.email
                          : account.hasCredential
                            ? t("accounts.offlineReady")
                            : account.email
                              ? t("accounts.setupRequired")
                              : t("accounts.onlineSignInRequired")}
                      </p>
                    </div>
                    {isCloudMode ? (
                      <KeyRound className="h-4 w-4 shrink-0 text-primary" />
                    ) : account.hasCredential ? (
                      <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <KeyRound className="h-4 w-4 shrink-0 text-amber-500" />
                    )}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <AppDialog
        open={Boolean(selectedAccount)}
        onOpenChange={(open) => {
          if (!open) closePasswordDialog();
        }}
      >
        <AppDialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <form onSubmit={handleSwitch} className="flex min-h-0 flex-1 flex-col">
            <AppDialogHeader>
              <AppDialogTitle className="flex items-center gap-2">
                <UserRound className="h-5 w-5 text-primary" />
                {isLocalMode && selectedAccount?.id === user.id
                  ? t("accounts.prepareOffline", {
                      defaultValue: "Prepare Offline Access",
                    })
                  : t("accounts.confirmSwitch")}
              </AppDialogTitle>
              <AppDialogDescription>
                {isCloudMode
                  ? t("accounts.cloudConfirmSwitchDescription")
                  : selectedAccount?.hasCredential
                  ? t("accounts.enterPasswordFor", {
                      defaultValue:
                        "Enter {{name}}'s password to switch accounts.",
                      name: selectedAccount.name,
                    })
                  : t("accounts.firstSetupDescription", {
                      defaultValue:
                        "This account needs one online password validation on this device. Future switches will work fully offline.",
                    })}
              </AppDialogDescription>
            </AppDialogHeader>

            <AppDialogBody className="space-y-5">
              <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/35 p-3">
                {selectedAccount && (
                  <AccountAvatar account={selectedAccount} className="h-10 w-10 text-sm" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{selectedAccount?.name}</p>
                  {isCloudMode ? (
                    <p className="truncate text-xs text-muted-foreground">{selectedAccount?.email}</p>
                  ) : (
                    <p className="truncate text-xs capitalize text-muted-foreground">{selectedAccount?.role}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="account-switcher-password">
                  {t("auth.password")} *
                </Label>
                <Input
                  id="account-switcher-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isSwitching}
                />
              </div>

              {error && (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </AppDialogBody>

            <AppDialogFooter>
              <Button
                type="button"
                variant="ghost"
                allowViewer
                onClick={closePasswordDialog}
                disabled={isSwitching}
              >
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                type="submit"
                allowViewer
                disabled={!password || isSwitching || (isCloudMode && !isOnline)}
              >
                {isSwitching && <Loader2 className="h-4 w-4 animate-spin" />}
                {isLocalMode && selectedAccount?.id === user.id
                  ? t("accounts.prepare", { defaultValue: "Prepare" })
                  : t("accounts.switch")}
              </Button>
            </AppDialogFooter>
          </form>
        </AppDialogContent>
      </AppDialog>
    </>
  );
}
