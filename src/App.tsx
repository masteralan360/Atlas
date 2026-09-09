import { Redirect, Route, Switch, Router, Link } from "wouter";
import { useHashLocation } from "@/hooks/useHashLocation";
import { AuthProvider, ProtectedRoute, GuestRoute, useAuth } from "@/auth";
import { WorkspaceProvider } from "@/workspace";
import { WorkspaceWarmup } from "@/workspace/WorkspaceWarmup";
import { Layout, Toaster, TitleBar, PatchNoteModal, PostSaveInvoiceDialog, Progress } from "@/ui/components";
import { DeviceTokenBootstrap } from "@/ui/components/DeviceTokenBootstrap";
import { SubscriptionExpiryWarningModal } from "@/ui/components/SubscriptionExpiryWarningModal";
import { WorkspacePaymentController, WorkspacePaymentStatusDialog } from "@/ui/components/WorkspacePaymentDialog";
import { WorkspaceExtraDaysDialog } from "@/ui/components/WorkspaceExtraDaysDialog";
import { WorkspaceAdminMessageDialog } from "@/ui/components/WorkspaceAdminMessageDialog";
import { lazy, Suspense, useEffect, useCallback, useState } from "react";
import { usePatchNotes } from "@/hooks/usePatchNotes";
import { Clock3, Download, LoaderCircle, RotateCw, Upload } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "@/workspace";
import { ExchangeRateProvider } from "@/context/ExchangeRateContext";
import { DateRangeProvider } from "@/context/DateRangeContext";
import { UiAccessProvider } from "@/context/UiAccessContext";
import { WorkspacePermissionsProvider } from "@/permissions";
import { FleetLocationSharingProvider } from "@/fleet/FleetLocationSharingContext";
import { AutoSyncOverlay } from "@/ui/components/AutoSyncOverlay";
import { OfflineEntryOverlay } from "@/ui/components/OfflineEntryOverlay";
import { SyncIntegrityOverlay } from "@/ui/components/SyncIntegrityOverlay";
import {
  isBackendConfigurationRequired,
  isSupabaseConfigured,
} from "@/auth/supabase";
import { isMobile, isDesktop } from "./lib/platform";
import { DemoTutorialProvider, isDemoEnabled } from "@/demo";
import { getPathWithLang } from "@/lib/i18nRouting";
import i18n from "@/i18n/config";
import { ClinicalRegistryLocaleSync } from "@/i18n/ClinicalRegistryLocaleSync";
import { useFavicon } from "@/hooks/useFavicon";
import { whatsappManager } from "@/lib/whatsappWebviewManager";
import { useKdsStream } from "@/hooks/useKdsStream";
import { UsbBackupWarningModal } from "@/ui/components/UsbBackupWarningModal";
import { WorkspaceLocationPrompt } from "@/ui/components/WorkspaceLocationPrompt";
import { validateUsbBackupOnStartup, pickUsbBackupDestination, copyDbToUsb } from "@/local-db/usbBackup";
import { clearUsbBackupSettings } from "@/local-db/usbBackupSettings";
import { useClinicalRegistryType } from "@/local-db/clinicalPresets";
import { supportsClinicalPatientsAndServicePresets } from "@/i18n/clinicalRegistry";
import {
  areApplicationUpdatesDisabled,
  UPDATE_PREFERENCE_CHANGED_EVENT,
} from "@/lib/updatePreference";
import { createUpdateSafetyBackupIfNeeded } from "@/local-db/sqliteBackup";
import { checkForTauriUpdate } from "@/lib/tauriUpdater";

// @ts-ignore
const isTauri = !!window.__TAURI_INTERNALS__;

// Critical pages - eager load for Tauri desktop, lazy for web/mobile
import { Dashboard as DashboardEager } from "@/ui/pages/Dashboard";
import { POS as POSEager } from "@/ui/pages/POS";
import { Products as ProductsEager } from "@/ui/pages/Products";
import {
  ProductClonePage as ProductClonePageEager,
  ProductCreatePage as ProductCreatePageEager,
  ProductEditPage as ProductEditPageEager,
} from "@/ui/pages/ProductFormPage";
import { Sales as SalesEager } from "@/ui/pages/Sales";
import { DashboardSkeleton } from "@/ui/components/skeletons/DashboardSkeleton";

// For web/mobile, wrap eager components in a lazy-like wrapper for consistency
const Dashboard = isTauri
  ? DashboardEager
  : lazy(() =>
      import("@/ui/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
    );
const POS = isTauri
  ? POSEager
  : lazy(() => import("@/ui/pages/POS").then((m) => ({ default: m.POS })));
const Products = isTauri
  ? ProductsEager
  : lazy(() =>
      import("@/ui/pages/Products").then((m) => ({ default: m.Products })),
    );
const Services = lazy(() =>
  import("@/ui/pages/Services").then((m) => ({ default: m.Services })),
);
const ServiceFormPage = lazy(() =>
  import("@/ui/pages/ServiceFormPage").then((m) => ({ default: m.ServiceFormPage })),
);
const ProductCreatePage = isTauri
  ? ProductCreatePageEager
  : lazy(() =>
      import("@/ui/pages/ProductFormPage").then((m) => ({
        default: m.ProductCreatePage,
      })),
    );
const ProductEditPage = isTauri
  ? ProductEditPageEager
  : lazy(() =>
      import("@/ui/pages/ProductFormPage").then((m) => ({
        default: m.ProductEditPage,
      })),
    );
const ProductClonePage = isTauri
  ? ProductClonePageEager
  : lazy(() =>
      import("@/ui/pages/ProductFormPage").then((m) => ({
        default: m.ProductClonePage,
      })),
    );
const Sales = isTauri
  ? SalesEager
  : lazy(() => import("@/ui/pages/Sales").then((m) => ({ default: m.Sales })));

// Other pages - always lazy loaded
const Login = lazy(() =>
  import("@/ui/pages/Login").then((m) => ({ default: m.Login })),
);
const Register = lazy(() =>
  import("@/ui/pages/Register").then((m) => ({ default: m.Register })),
);
const PaygGraphPage = lazy(() =>
  import("@/ui/pages/PaygGraphPage").then((m) => ({
    default: m.PaygGraphPage,
  })),
);
const InvoicesHistory = lazy(() =>
  import("@/ui/pages/InvoicesHistory").then((m) => ({
    default: m.InvoicesHistory,
  })),
);
const Members = lazy(() =>
  import("@/ui/pages/Members").then((m) => ({ default: m.Members })),
);
const Settings = lazy(() =>
  import("@/ui/pages/Settings").then((m) => ({ default: m.Settings })),
);
const Help = lazy(() =>
  import("@/ui/pages/Help").then((m) => ({ default: m.Help })),
);
const WorkspaceRegistration = lazy(() =>
  import("@/ui/pages/WorkspaceRegistration").then((m) => ({
    default: m.WorkspaceRegistration,
  })),
);
const Revenue = lazy(() =>
  import("@/ui/pages/Revenue").then((m) => ({ default: m.Revenue })),
);
const Budget = lazy(() =>
  import("@/ui/pages/Budget").then((m) => ({ default: m.Budget })),
);
const TeamPerformance = lazy(() =>
  import("@/ui/pages/TeamPerformance").then((m) => ({
    default: m.TeamPerformance,
  })),
);
const WorkspaceConfiguration = lazy(() =>
  import("@/ui/pages/WorkspaceConfiguration").then((m) => ({
    default: m.WorkspaceConfiguration,
  })),
);
const LockedWorkspace = lazy(() =>
  import("@/ui/pages/LockedWorkspace").then((m) => ({
    default: m.LockedWorkspace,
  })),
);
const CurrencyConverter = lazy(() =>
  import("@/ui/pages/CurrencyConverter").then((m) => ({
    default: m.CurrencyConverter,
  })),
);
const Notebook = lazy(() =>
  import("@/ui/pages/Notebook").then((m) => ({ default: m.Notebook })),
);
const PrintPreviewEditorPage = lazy(() =>
  import("@/ui/pages/PrintPreviewEditorPage").then((m) => ({
    default: m.PrintPreviewEditorPage,
  })),
);
const CustomTemplates = lazy(() =>
  import("@/ui/pages/CustomTemplates").then((m) => ({
    default: m.CustomTemplates,
  })),
);
const ConnectionConfiguration = lazy(() =>
  import("@/ui/pages/ConnectionConfiguration").then((m) => ({
    default: m.ConnectionConfiguration,
  })),
);
const WhatsApp = lazy(() =>
  import("@/ui/pages/WhatsAppWeb").then((m) => ({ default: m.default })),
);
const InstantPOS = lazy(() =>
  import("@/ui/pages/InstantPOS").then((m) => ({ default: m.InstantPOS })),
);
const KDSDashboard = lazy(() =>
  import("@/ui/pages/KDSDashboard").then((m) => ({ default: m.KDSDashboard })),
);
const Discounts = lazy(() =>
  import("@/ui/pages/Discounts").then((m) => ({ default: m.Discounts })),
);
const Storages = lazy(() =>
  import("@/ui/pages/Storages").then((m) => ({ default: m.default })),
);
const UnitsPage = lazy(() =>
  import("@/ui/pages/UnitsPage").then((m) => ({ default: m.default })),
);
const InventoryTransfer = lazy(() =>
  import("@/ui/pages/InventoryTransfer").then((m) => ({ default: m.default })),
);
const InventoryTransactions = lazy(() =>
  import("@/ui/pages/InventoryTransactions").then((m) => ({
    default: m.InventoryTransactionsPage,
  })),
);
const StockAdjustments = lazy(() =>
  import("@/ui/pages/StockAdjustments").then((m) => ({
    default: m.StockAdjustments,
  })),
);
const HR = lazy(() =>
  import("@/ui/pages/HR").then((m) => ({ default: m.default })),
);
const Loans = lazy(() =>
  import("@/ui/pages/Loans").then((m) => ({ default: m.Loans })),
);
const Installments = lazy(() =>
  import("@/ui/pages/Loans").then((m) => ({ default: m.Installments })),
);
const InstallmentSales = lazy(() =>
  import("@/ui/pages/Loans").then((m) => ({ default: m.InstallmentSales })),
);
const BusinessPartners = lazy(() =>
  import("@/ui/pages/BusinessPartners").then((m) => ({
    default: m.BusinessPartners,
  })),
);
const BusinessPartnerDetails = lazy(() =>
  import("@/ui/pages/BusinessPartnerDetails").then((m) => ({
    default: m.BusinessPartnerDetails,
  })),
);
const AccountStatements = lazy(() =>
  import("@/ui/pages/AccountStatements").then((m) => ({
    default: m.AccountStatements,
  })),
);
const OnlineCustomers = lazy(() =>
  import("@/ui/pages/OnlineCustomers").then((m) => ({
    default: m.OnlineCustomers,
  })),
);
const OnlineCustomerDetails = lazy(() =>
  import("@/ui/pages/OnlineCustomerDetails").then((m) => ({
    default: m.OnlineCustomerDetails,
  })),
);
const Agents = lazy(() =>
  import("@/ui/pages/Agents").then((m) => ({ default: m.Agents })),
);
const AgentCommissionSettings = lazy(() =>
  import("@/ui/pages/AgentCommissionSettings").then((m) => ({
    default: m.AgentCommissionSettings,
  })),
);
const PostService = lazy(() =>
  import("@/ui/pages/PostService").then((m) => ({ default: m.PostService })),
);
const CarRental = lazy(() =>
  import("@/ui/pages/CarRental").then((m) => ({ default: m.CarRental })),
);
const AgentDetails = lazy(() =>
  import("@/ui/pages/AgentDetails").then((m) => ({ default: m.AgentDetails })),
);
const FleetManagement = lazy(() =>
  import("@/ui/pages/FleetManagement").then((m) => ({ default: m.FleetManagement })),
);
const AgentLocationSharing = lazy(() =>
  import("@/ui/pages/AgentLocationSharing").then((m) => ({ default: m.AgentLocationSharing })),
);
const Customers = lazy(() =>
  import("@/ui/pages/Customers").then((m) => ({ default: m.Customers })),
);
const CustomerDetails = lazy(() =>
  import("@/ui/pages/CustomerDetails").then((m) => ({
    default: m.CustomerDetails,
  })),
);
const Suppliers = lazy(() =>
  import("@/ui/pages/Suppliers").then((m) => ({ default: m.Suppliers })),
);
const SupplierDetails = lazy(() =>
  import("@/ui/pages/SupplierDetails").then((m) => ({
    default: m.SupplierDetails,
  })),
);
const Orders = lazy(() =>
  import("@/ui/pages/Orders").then((m) => ({ default: m.Orders })),
);
const Ecommerce = lazy(() =>
  import("@/ui/pages/Ecommerce").then((m) => ({ default: m.Ecommerce })),
);
const RealEstate = lazy(() =>
  import("@/ui/pages/RealEstate").then((m) => ({ default: m.RealEstate })),
);
const TravelTransportation = lazy(() =>
  import("@/ui/pages/TravelTransportation").then((m) => ({ default: m.TravelTransportation })),
);
const Activities = lazy(() =>
  import("@/ui/pages/Activities").then((m) => ({ default: m.Activities })),
);
const ManualEntry = lazy(() =>
  import("@/ui/pages/ManualEntry").then((m) => ({ default: m.ManualEntry })),
);
const ManualEntryTemplates = lazy(() =>
  import("@/ui/pages/ManualEntryTemplates").then((m) => ({ default: m.ManualEntryTemplates })),
);
const CurrencyExchange = lazy(() =>
  import("@/ui/pages/CurrencyExchange").then((m) => ({
    default: m.CurrencyExchange,
  })),
);
const ClinicalAppointments = lazy(() =>
  import("@/ui/pages/ClinicalAppointments").then((m) => ({
    default: m.ClinicalAppointments,
  })),
);
const ClinicalPatients = lazy(() =>
  import("@/ui/pages/ClinicalPatients").then((m) => ({
    default: m.ClinicalPatients,
  })),
);
const ClinicalPatientDetails = lazy(() =>
  import("@/ui/pages/ClinicalPatientDetails").then((m) => ({
    default: m.ClinicalPatientDetails,
  })),
);
const ClinicalPresets = lazy(() =>
  import("@/ui/pages/ClinicalPresets").then((m) => ({
    default: m.ClinicalPresets,
  })),
);

const Ledger = lazy(() =>
  import("@/ui/pages/Ledger").then((m) => ({ default: m.Ledger })),
);
const Payments = lazy(() =>
  import("@/ui/pages/Payments").then((m) => ({ default: m.Payments })),
);
const PaymentAccounts = lazy(() =>
  import("@/ui/pages/PaymentAccounts").then((m) => ({ default: m.PaymentAccounts })),
);
const CashierShifts = lazy(() =>
  import("@/ui/pages/CashierShifts").then((m) => ({ default: m.CashierShifts })),
);
const CashierShiftDetails = lazy(() =>
  import("@/ui/pages/CashierShiftDetails").then((m) => ({ default: m.CashierShiftDetails })),
);
const DirectTransactions = lazy(() =>
  import("@/ui/pages/DirectTransactions").then((m) => ({
    default: m.DirectTransactions,
  })),
);
const ModuleLauncher = lazy(() =>
  import("@/ui/pages/ModuleLauncher").then((m) => ({
    default: m.ModuleLauncher,
  })),
);

const DemoConfigPage = lazy(() =>
  import("@/demo").then((m) => ({
    default: m.DemoConfigPage,
  })),
);

function LoadingState() {
  const [isSlow, setIsSlow] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsSlow(true);
      console.warn(
        "[Diagnostics] Loading is taking longer than 7s. Displaying safety refresh button.",
      );
    }, 7000);
    return () => clearTimeout(timer);
  }, []);

  const handleRefresh = () => {
    console.log(
      "[Diagnostics] User triggered manual refresh from SlowLoadingNotice.",
    );
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 max-w-sm text-center px-6">
        <div className="relative">
          <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          {isSlow && (
            <div className="absolute inset-0 flex items-center justify-center animate-pulse">
              <RotateCw className="w-5 h-5 text-primary" />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-foreground font-medium animate-pulse">
            {isSlow
              ? t("common.loadingSlow") || "Taking longer than usual..."
              : t("common.loading") || "Loading..."}
          </p>
          {isSlow && (
            <p className="text-sm text-muted-foreground animate-in fade-in slide-in-from-top-2 duration-700">
              {t("common.loadingStuckMessage") ||
                "The connection might be slow or interrupted. Try refreshing the application."}
            </p>
          )}
        </div>

        {isSlow && (
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium shadow-lg animate-in fade-in zoom-in duration-500"
          >
            <RotateCw className="w-4 h-4" />
            {t("common.refresh") || "Refresh App"}
          </button>
        )}
      </div>
    </div>
  );
}

function compareVersions(v1: string, v2: string): number {
  const p1 = v1
    .replace(/[^0-9.]/g, "")
    .split(".")
    .map(Number);
  const p2 = v2
    .replace(/[^0-9.]/g, "")
    .split(".")
    .map(Number);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

const DEFERRED_UPDATE_SESSION_KEY = "atlas_deferred_update_version";
const PENDING_UPDATE_VERSION_KEY = "atlas_pending_update_version";

type UpdateDialogState =
  | {
      kind: "update";
      update: Update;
      mandatory: boolean;
    }
  | {
      kind: "notice";
      title: string;
      message: string;
    };

type DownloadState = {
  status: "downloading" | "installing" | "error";
  downloadedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
  errorMessage?: string;
};

function formatDataSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1;

  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function formatEstimatedTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  if (seconds < 60) return "< 1 min";

  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function UpdateHandler() {
  const { setPendingUpdate, isLoading: isWorkspaceLoading } = useWorkspace();
  const { user, isLoading: isAuthLoading } = useAuth();
  const { t } = useTranslation();
  const [updatesDisabled, setUpdatesDisabled] = useState(() =>
    areApplicationUpdatesDisabled(),
  );
  const [isBlocked, setIsBlocked] = useState(
    () => sessionStorage.getItem("version_blocked") === "true",
  );
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState | null>(
    null,
  );
  const [downloadState, setDownloadState] = useState<DownloadState | null>(
    null,
  );
  const [downloadUpdate, setDownloadUpdate] = useState<Update | null>(null);
  const [deferredUpdate, setDeferredUpdate] = useState<Update | null>(null);

  useEffect(() => {
    const syncPreference = () => {
      setUpdatesDisabled(areApplicationUpdatesDisabled());
    };

    window.addEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncPreference);
    return () => {
      window.removeEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, syncPreference);
    };
  }, []);

  useEffect(() => {
    if (!updatesDisabled) return;

    // Dismiss any already-discovered update. From this point onward no updater
    // request, download, or installation path can be started by this session.
    setUpdateDialog(null);
    setDeferredUpdate(null);
    setDownloadUpdate(null);
    setDownloadState(null);
    setIsBlocked(false);
    setPendingUpdate(null);
    localStorage.removeItem(PENDING_UPDATE_VERSION_KEY);
    sessionStorage.removeItem(DEFERRED_UPDATE_SESSION_KEY);
    sessionStorage.removeItem("version_blocked");
  }, [setPendingUpdate, updatesDisabled]);

  const deferUpdate = useCallback(
    (update: Update) => {
      sessionStorage.setItem(DEFERRED_UPDATE_SESSION_KEY, update.version);
      localStorage.setItem(PENDING_UPDATE_VERSION_KEY, update.version);
      setDeferredUpdate(update);
      setPendingUpdate({
        version: update.version,
        date: update.date,
        body: update.body,
      });
      setUpdateDialog(null);
    },
    [setPendingUpdate],
  );

  const startUpdateDownload = useCallback(
    async (update: Update) => {
      if (updatesDisabled) return;

      setUpdateDialog(null);
      setDeferredUpdate(null);
      setPendingUpdate(null);
      localStorage.removeItem(PENDING_UPDATE_VERSION_KEY);
      sessionStorage.removeItem(DEFERRED_UPDATE_SESSION_KEY);
      setDownloadUpdate(update);
      setDownloadState({
        status: "downloading",
        downloadedBytes: 0,
        totalBytes: undefined,
        bytesPerSecond: 0,
      });

      let downloadedBytes = 0;
      let totalBytes: number | undefined;
      let lastSampleBytes = 0;
      let lastSampleAt = performance.now();
      let bytesPerSecond = 0;

      try {
        await update.download((event) => {
          switch (event.event) {
            case "Started":
              totalBytes = event.data.contentLength;
              lastSampleAt = performance.now();
              setDownloadState({
                status: "downloading",
                downloadedBytes: 0,
                totalBytes,
                bytesPerSecond: 0,
              });
              break;
            case "Progress": {
              downloadedBytes += event.data.chunkLength;
              const now = performance.now();
              const elapsed = now - lastSampleAt;

              // Use a short rolling sample instead of the lifetime average so the
              // displayed transfer speed and ETA respond to network changes.
              if (elapsed >= 250) {
                bytesPerSecond =
                  ((downloadedBytes - lastSampleBytes) / elapsed) * 1000;
                lastSampleBytes = downloadedBytes;
                lastSampleAt = now;
              }

              setDownloadState({
                status: "downloading",
                downloadedBytes,
                totalBytes,
                bytesPerSecond,
              });
              break;
            }
            case "Finished":
              setDownloadState({
                status: "installing",
                downloadedBytes,
                totalBytes,
                bytesPerSecond: 0,
              });
              break;
          }
        });

        await createUpdateSafetyBackupIfNeeded(user?.workspaceId);
        await update.install();

        localStorage.removeItem(PENDING_UPDATE_VERSION_KEY);
        sessionStorage.removeItem(DEFERRED_UPDATE_SESSION_KEY);
        setPendingUpdate(null);
        setDownloadState((current) =>
          current
            ? { ...current, status: "installing", bytesPerSecond: 0 }
            : current,
        );
      } catch (error) {
        console.error("[Tauri] Failed to download or install update:", error);
        setDownloadState((current) => ({
          status: "error",
          downloadedBytes: current?.downloadedBytes ?? 0,
          totalBytes: current?.totalBytes,
          bytesPerSecond: 0,
          errorMessage: t("updater.downloadFailed"),
        }));
      }
    },
    [setPendingUpdate, t, updatesDisabled, user?.workspaceId],
  );

  const checkForUpdates = useCallback(
    async (isManual = false, bypassThrottle = false) => {
      // Wait until the persisted Local Mode preference has been resolved. This
      // is deliberately before every latest.json request and updater plugin
      // call, so a disabled installation remains isolated from R2.
      if (
        !isTauri ||
        updatesDisabled ||
        isAuthLoading ||
        isWorkspaceLoading
      ) {
        return;
      }

      // --- DEBUG: Easy to remove check log ---
      console.log(
        `[DEBUG-UPDATER] Triggered check. Manual: ${isManual}, Last Check: ${localStorage.getItem("last_auto_update_check")}`,
      );
      // ---------------------------------------

      const lastCheck = localStorage.getItem("last_auto_update_check");
      const checkedThisSession = sessionStorage.getItem("startup_checked");
      const now = Date.now();
      const twelveHours = 12 * 60 * 60 * 1000;

      // The minimum-version check is intentionally performed for every check.
      // A manual check from the mandatory screen must remain mandatory too.
      let mandatoryUpdate =
        sessionStorage.getItem("version_blocked") === "true";
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const currentVersion = await getVersion();

        const res = await fetch(
          "https://asaas-r2-proxy.alanepic360.workers.dev/atlas-updates/latest.json",
          { cache: "no-store" },
        );
        if (res.ok) {
          const remoteConfig = await res.json();

          mandatoryUpdate = Boolean(
            remoteConfig.min_version &&
              compareVersions(currentVersion, remoteConfig.min_version) < 0,
          );

          if (mandatoryUpdate) {
            console.error(
              `[Security] Version blocked. App: ${currentVersion}, Required: ${remoteConfig.min_version}`,
            );
            sessionStorage.setItem("version_blocked", "true");
            setIsBlocked(true);
          } else {
            sessionStorage.removeItem("version_blocked");
            setIsBlocked(false);
          }
        }
      } catch (err) {
        console.warn(
          "[Updater] Failed to check mandatory version from latest.json:",
          err,
        );
      }

      // "Later" is a session-level deferral. It survives a page refresh, but
      // disappears when the app is revisited. The persistent version marker lets
      // that next launch bypass the 12-hour polling interval and check again.
      const deferredVersion = sessionStorage.getItem(
        DEFERRED_UPDATE_SESSION_KEY,
      );
      if (!mandatoryUpdate && deferredVersion) {
        console.log(
          "[Tauri] Update was deferred for this app session; skipping prompt.",
        );
        return;
      }

      const pendingVersion = localStorage.getItem(PENDING_UPDATE_VERSION_KEY);
      const shouldRecheckDeferredUpdate = Boolean(pendingVersion);

      // Skip automatic checks if already checked this session (refresh protection)
      // OR if checked within the last 12 hours (interval protection)
      if (!isManual && !mandatoryUpdate && !bypassThrottle) {
        if (checkedThisSession && !shouldRecheckDeferredUpdate) {
          console.log(
            "[Tauri] Skipping automatic update check (already checked this session/refresh)",
          );
          return;
        }

        if (
          lastCheck &&
          now - parseInt(lastCheck) < twelveHours &&
          !shouldRecheckDeferredUpdate
        ) {
          console.log(
            "[Tauri] Skipping automatic update check (checked within last 12h)",
          );
          // Still mark session as checked so refreshes don't keep pinging the logic
          sessionStorage.setItem("startup_checked", "true");
          return;
        }
      }

      try {
        if (isMobile()) {
          console.log("[Tauri] Android custom update check...");
          const { getVersion } = await import("@tauri-apps/api/app");
          const { open } = await import("@tauri-apps/plugin-shell");

          const currentVersion = await getVersion();

          const response = await fetch(
            "https://asaas-r2-proxy.alanepic360.workers.dev/atlas-updates/latest.json",
            { cache: "no-store" },
          );

          if (response.ok) {
            const data = await response.json();

            // Update timestamps
            localStorage.setItem("last_auto_update_check", now.toString());
            sessionStorage.setItem("startup_checked", "true");

            if (data.version && data.version !== currentVersion) {
              console.log(`[Tauri] Android Update available: ${data.version}`);

              let downloadUrl =
                data.android?.url || data.platforms?.android?.url;

              // Fallback check if it's strictly under android-*
              if (!downloadUrl && data.platforms) {
                const androidKey = Object.keys(data.platforms).find((k) =>
                  k.startsWith("android"),
                );
                if (androidKey) {
                  downloadUrl = data.platforms[androidKey].url;
                }
              }

              if (downloadUrl) {
                console.log(
                  "[Tauri] Opening Android APK URL automatically:",
                  downloadUrl,
                );
                await open(downloadUrl);
                setPendingUpdate(null);
              } else {
                console.error("[Tauri] Android APK URL not found in JSON");
                setUpdateDialog({
                  kind: "notice",
                  title: t("settings.updater.title"),
                  message: t("updater.downloadUrlMissing"),
                });
              }
            } else {
              console.log("[Tauri] No Android updates available");
              if (isManual) {
                setUpdateDialog({
                  kind: "notice",
                  title: t("settings.updater.title"),
                  message: t("settings.updater.notAvailable"),
                });
              }
            }
          }
          return;
        }

        console.log("[Tauri] Checking for updates...");
        const update = await checkForTauriUpdate();

        // Update timestamps
        localStorage.setItem("last_auto_update_check", now.toString());
        sessionStorage.setItem("startup_checked", "true");

        if (update) {
          console.log(`[Tauri] Update available: ${update.version}`);
          setDeferredUpdate(null);
          setPendingUpdate(null);
          setUpdateDialog({
            kind: "update",
            update,
            mandatory: mandatoryUpdate,
          });
        } else {
          console.log("[Tauri] No updates available");
          localStorage.removeItem(PENDING_UPDATE_VERSION_KEY);
          setDeferredUpdate(null);
          setPendingUpdate(null);
          if (isManual) {
            setUpdateDialog({
              kind: "notice",
              title: t("settings.updater.title"),
              message: t("settings.updater.notAvailable"),
            });
          }
        }
      } catch (error) {
        console.error("[Tauri] Failed to check for updates:", error);
        if (isManual || mandatoryUpdate) {
          setUpdateDialog({
            kind: "notice",
            title: t("settings.updater.title"),
            message: t("updater.checkFailed"),
          });
        }
      }
    },
    [isAuthLoading, isWorkspaceLoading, setPendingUpdate, t, updatesDisabled],
  );

  useEffect(() => {
    const pendingVersion = localStorage.getItem(PENDING_UPDATE_VERSION_KEY);
    if (pendingVersion) {
      setPendingUpdate({ version: pendingVersion });
    }

    const handleOpenPendingUpdate = () => {
      if (deferredUpdate) {
        setUpdateDialog({
          kind: "update",
          update: deferredUpdate,
          mandatory: false,
        });
        return;
      }

      // The deferred updater object is only valid for the current app session.
      // After a reload, check again so the same dialog can be reconstructed.
      // Checking for an update never downloads or installs it.
      void checkForUpdates(true);
    };

    window.addEventListener("open-pending-update", handleOpenPendingUpdate);
    return () => {
      window.removeEventListener(
        "open-pending-update",
        handleOpenPendingUpdate,
      );
    };
  }, [checkForUpdates, deferredUpdate, setPendingUpdate]);

  useEffect(() => {
    if (isTauri && !updatesDisabled && !isAuthLoading && !isWorkspaceLoading) {
      // 1. Startup check: bypass the 12-hour polling throttle.
      void checkForUpdates(false, true);

      // 2. Background interval check (every 4 hours)
      const intervalTimer = setInterval(
        () => {
          const lastCheck = localStorage.getItem("last_auto_update_check");
          const now = Date.now();
          const twelveHours = 12 * 60 * 60 * 1000;

          if (!lastCheck || now - parseInt(lastCheck) >= twelveHours) {
            console.log(
              "[Tauri] 12h interval passed while app open. Checking...",
            );
            checkForUpdates();
          }
        },
        4 * 60 * 60 * 1000,
      );

      const handleManualCheck = () => {
        checkForUpdates(true);
      };

      window.addEventListener("check-for-updates", handleManualCheck);

      const handleKeyDown = async (e: KeyboardEvent) => {
        if (e.key === "F11" && !isMobile()) {
          e.preventDefault();
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const window = getCurrentWindow();
          const fullscreen = await window.isFullscreen();
          const maximized = await window.isMaximized();

          console.log(
            "[Tauri] F11: Toggling fullscreen to:",
            !fullscreen,
            "(Maximized:",
            maximized,
            ")",
          );

          if (!fullscreen && maximized) {
            await window.unmaximize();
          }

          await window.setFullscreen(!fullscreen);
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => {
        clearInterval(intervalTimer);
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("check-for-updates", handleManualCheck);
      };
    }
  }, [checkForUpdates, isAuthLoading, isWorkspaceLoading, updatesDisabled]);

  const isDownloading = Boolean(downloadState);
  const isInstalling = downloadState?.status === "installing";
  const progressPercent =
    downloadState?.totalBytes && downloadState.totalBytes > 0
      ? Math.min(
          100,
          (downloadState.downloadedBytes / downloadState.totalBytes) * 100,
        )
      : 0;
  const estimatedTime = formatEstimatedTime(
    downloadState?.totalBytes && downloadState.bytesPerSecond > 0
      ? (downloadState.totalBytes - downloadState.downloadedBytes) /
          downloadState.bytesPerSecond
      : null,
  );
  const updateIsMandatory =
    updateDialog?.kind === "update" && updateDialog.mandatory;

  return (
    <>
      {isBlocked && (
        <div className="fixed inset-0 z-[9999] bg-background/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
        <div className="max-w-md w-full p-8 border border-border/50 bg-card rounded-2xl shadow-2xl flex flex-col items-center gap-6">
          <div className="w-16 h-16 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mb-2">
            <RotateCw className="w-8 h-8 animate-spin-slow" />
          </div>
          <div className="space-y-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Update Required
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Your application version is critically outdated and no longer
              supported. You must update to the latest version to continue using
              Atlas.
            </p>
          </div>
          <button
            onClick={() => checkForUpdates(true)}
            className="w-full mt-4 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium shadow-md hover:shadow-lg active:scale-[0.98]"
          >
            Check for Updates
          </button>
        </div>
        </div>
      )}

      {updateDialog && !isDownloading && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-6 text-center backdrop-blur-md animate-in fade-in duration-200">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="update-dialog-title"
            className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-8 shadow-2xl"
          >
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Download className="h-7 w-7" />
            </div>
            <h2 id="update-dialog-title" className="text-xl font-bold text-foreground">
              {updateDialog.kind === "update"
                ? updateDialog.mandatory
                  ? t("updater.requiredTitle")
                  : t("updater.title")
                : updateDialog.title}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {updateDialog.kind === "update"
                ? updateDialog.mandatory
                  ? t("updater.requiredMessage", {
                      version: updateDialog.update.version,
                    })
                  : t("updater.message", {
                      version: updateDialog.update.version,
                    })
                : updateDialog.message}
            </p>
            {updateDialog.kind === "update" && updateDialog.update.body && (
              <p className="mt-3 rounded-xl bg-muted/50 p-3 text-start text-xs leading-relaxed text-muted-foreground whitespace-pre-line">
                {updateDialog.update.body}
              </p>
            )}
            <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              {updateDialog.kind === "notice" ? (
                <button
                  onClick={() => setUpdateDialog(null)}
                  className="w-full rounded-xl border border-border bg-background px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:w-auto"
                >
                  {t("common.close")}
                </button>
              ) : (
                <>
                  {!updateIsMandatory && (
                    <button
                      onClick={() => deferUpdate(updateDialog.update)}
                      className="w-full rounded-xl border border-border bg-background px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:w-auto"
                    >
                      {t("updater.later")}
                    </button>
                  )}
                  <button
                    onClick={() => startUpdateDownload(updateDialog.update)}
                    className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90 hover:shadow-lg active:scale-[0.98] sm:w-auto"
                  >
                    {t("updater.updateNow")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {downloadState && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-background/95 p-6 backdrop-blur-md animate-in fade-in duration-200">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="update-download-title"
            className="w-full max-w-lg rounded-2xl border border-border/50 bg-card p-6 shadow-2xl sm:p-8"
          >
            {downloadState.status === "error" ? (
              <>
                <h2 id="update-download-title" className="text-xl font-bold text-foreground">
                  {t("updater.downloadFailed")}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {downloadState.errorMessage}
                </p>
                <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  {!isBlocked && downloadUpdate && (
                    <button
                      onClick={() => deferUpdate(downloadUpdate)}
                      className="w-full rounded-xl border border-border bg-background px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:w-auto"
                    >
                      {t("updater.later")}
                    </button>
                  )}
                  {downloadUpdate && (
                    <button
                      onClick={() => startUpdateDownload(downloadUpdate)}
                      className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90 hover:shadow-lg active:scale-[0.98] sm:w-auto"
                    >
                      {t("common.retry")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <LoaderCircle className="h-6 w-6 animate-spin" />
                  </div>
                  <div>
                    <h2 id="update-download-title" className="text-xl font-bold text-foreground">
                      {isInstalling ? t("updater.installing") : t("updater.downloading")}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {isInstalling
                        ? t("updater.installingDescription")
                        : t("updater.downloadDescription")}
                    </p>
                  </div>
                </div>

                <div className="mt-7 space-y-3">
                  <Progress value={isInstalling ? 100 : progressPercent} className="h-3" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {formatDataSize(downloadState.downloadedBytes)}
                      {downloadState.totalBytes
                        ? ` / ${formatDataSize(downloadState.totalBytes)}`
                        : ""}
                    </span>
                    <span>
                      {downloadState.totalBytes
                        ? `${Math.round(isInstalling ? 100 : progressPercent)}%`
                        : t("updater.calculating")}
                    </span>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Download className="h-3.5 w-3.5" />
                      {t("updater.downloadSpeed")}
                    </div>
                    <p className="mt-1 text-sm font-semibold text-foreground">
                      {formatDataSize(
                        isInstalling ? 0 : downloadState.bytesPerSecond,
                      )}/s
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Upload className="h-3.5 w-3.5" />
                      {t("updater.uploadSpeed")}
                    </div>
                    <p className="mt-1 text-sm font-semibold text-foreground">0 B/s</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      {t("updater.estimatedTime")}
                    </div>
                    <p className="mt-1 text-sm font-semibold text-foreground">
                      {isInstalling
                        ? t("updater.calculating")
                        : estimatedTime || t("updater.calculating")}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FaviconHandler() {
  useFavicon();
  return null;
}

function DeepLinkHandler() {
    useEffect(() => {
        if (!isTauri) return;

        let unlisten: (() => void) | undefined;

        const setup = async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const unlistenFn = await listen<string>('deep-link', (event) => {
                    const route = event.payload;
                    window.location.hash = getPathWithLang(route, i18n.language);
                });
                unlisten = unlistenFn;
            } catch (err) {
                console.warn('[DeepLink] Failed to listen:', err);
            }
        };

        setup();

        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    return null;
}

function KdsSecurityGuard({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();

  useEffect(() => {
    // Restricted mode: Web browser on port 4004
    // We use port 4004 as the hardcoded identifier for the KDS stream server
    const isRemoteKds = !isTauri && window.location.port === "4004";

    if (isRemoteKds && location !== "/kds/local") {
      console.warn("[Security] Restricting remote KDS client to /kds/local");
      window.location.replace(`/#${getPathWithLang('/kds/local', i18n.language)}`);
    }
  }, [location]);

  return <>{children}</>;
}

function ClinicalPatientsAndServicePresetsGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const registryType = useClinicalRegistryType(user?.workspaceId);

  if (!supportsClinicalPatientsAndServicePresets(registryType)) {
    return <Redirect to="/clinical-appointments" />;
  }

  return <>{children}</>;
}

function KdsStreamAutostart() {
  const { features } = useWorkspace();
  const isHost = isDesktop();
  const { status, startStream } = useKdsStream(isHost);

  useEffect(() => {
    if (isHost && features.kds && status === "idle") {
      console.log("[KDS] Autostarting stream...");
      startStream(4004).catch((err: any) => {
        console.error("[KDS] Autostart failed:", err);
      });
    }
  }, [isHost, features.kds, status, startStream]);

  return null;
}

function WhatsAppPlanGuard() {
  const { hasCapability } = useWorkspace();
  const canUseWhatsApp = hasCapability("whatsappIntegration");

  useEffect(() => {
    if (!isTauri || isMobile()) return;

    if (!canUseWhatsApp) {
      whatsappManager.setEnabled(false);
      return;
    }

    const autoLaunch = localStorage.getItem("whatsapp_auto_launch") === "true";
    if (autoLaunch) {
      console.log("[WhatsApp Startup] Auto-launching WhatsApp in background...");
      whatsappManager.getOrCreate(0, 0, 0, 0).catch((err) => {
        console.error("[WhatsApp Startup] Failed to auto-launch:", err);
      });
    }
  }, [canUseWhatsApp]);

  return null;
}

function FirstTimeRedirect() {
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    if (localStorage.getItem('atlas_first_time_done')) return;

    localStorage.setItem('atlas_first_time_done', 'true');
    localStorage.setItem('modules_view_mode', 'grid');
    window.location.hash = getPathWithLang('/modules', i18n.language);
  }, [isAuthenticated, isLoading]);

  return null;
}

function UsbBackupStartupValidator() {
  const [modalOpen, setModalOpen] = useState(false);
  const [missingDest, setMissingDest] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;

    let cancelled = false;

    const check = async () => {
      const result = await validateUsbBackupOnStartup();
      if (cancelled) return;
      if (!result.valid && result.destination) {
        setMissingDest(result.destination);
        setModalOpen(true);
      }
    };

    check();
    return () => { cancelled = true; };
  }, []);

  const handleRetry = async () => {
    setIsRetrying(true);
    const result = await validateUsbBackupOnStartup();
    setIsRetrying(false);
    if (result.valid) {
      setModalOpen(false);
      setMissingDest(null);
    }
  };

  const handleChangeDestination = async () => {
    const path = await pickUsbBackupDestination();
    if (path) {
      await copyDbToUsb(path);
      setModalOpen(false);
      setMissingDest(null);
    }
  };

  const handleDisable = () => {
    clearUsbBackupSettings();
    setModalOpen(false);
    setMissingDest(null);
  };

  return missingDest ? (
    <UsbBackupWarningModal
      open={modalOpen}
      destination={missingDest}
      onRetry={handleRetry}
      onChangeDestination={handleChangeDestination}
      onDisable={handleDisable}
      isRetrying={isRetrying}
    />
  ) : null;
}

function App() {
  const { showModal, currentPatch, version, dismissModal } = usePatchNotes();

  useEffect(() => {
    if (isMobile()) {
      document.documentElement.setAttribute("data-mobile", "true");
    } else {
      document.documentElement.removeAttribute("data-mobile");
    }
  }, []);

  return (
    <AuthProvider>
      <DeviceTokenBootstrap />
      <WorkspaceProvider>
        <ClinicalRegistryLocaleSync />
        <WorkspacePermissionsProvider>
          <FleetLocationSharingProvider>
            <UiAccessProvider>
            <DateRangeProvider>
              <KdsStreamAutostart />
              <FirstTimeRedirect />
              <WhatsAppPlanGuard />
              <UpdateHandler />
              <WorkspaceWarmup />
              <DeepLinkHandler />
              <UsbBackupStartupValidator />
              <SubscriptionExpiryWarningModal />
              <WorkspaceLocationPrompt />
              <WorkspacePaymentController />
              <WorkspacePaymentStatusDialog />
              <WorkspaceExtraDaysDialog />
              <WorkspaceAdminMessageDialog />
              <FaviconHandler />
              <AutoSyncOverlay />
              <OfflineEntryOverlay />
              <SyncIntegrityOverlay />
              {!isMobile() && <TitleBar />}
              {isTauri &&
              isBackendConfigurationRequired &&
              !isSupabaseConfigured ? (
                <Suspense fallback={<LoadingState />}>
                  <ConnectionConfiguration />
                </Suspense>
              ) : (
                <ExchangeRateProvider>
                  <KdsSecurityGuard>
                    <Suspense fallback={<LoadingState />}>
                      <Router hook={useHashLocation}>
                        <DemoTutorialProvider>
                        <Switch>
                      {/* Guest Routes */}
                      <Route path="/login">
                        <GuestRoute>
                          <Login />
                        </GuestRoute>
                      </Route>
                      <Route path="/register">
                        <GuestRoute>
                          <Register />
                        </GuestRoute>
                      </Route>
                      {!isTauri && (
                        <Route path="/graph">
                          <PaygGraphPage />
                        </Route>
                      )}
                      {isDemoEnabled() && (
                        <Route path="/demo-setup">
                          <DemoConfigPage />
                        </Route>
                      )}

                      {/* Locked Workspace Route - no layout, standalone page */}
                      <Route path="/locked-workspace">
                        <ProtectedRoute>
                          <LockedWorkspace />
                        </ProtectedRoute>
                      </Route>

                      {/* Connection Configuration Route */}
                      {isBackendConfigurationRequired && (
                        <Route path="/connection-configuration">
                          <ConnectionConfiguration />
                        </Route>
                      )}

                      {/* Protected Routes */}
                      <Route path="/">
                        <ProtectedRoute>
                          <Layout>
                            <Suspense fallback={<DashboardSkeleton />}>
                              <Dashboard />
                            </Suspense>
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/help">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                        >
                          <Layout>
                            <Help />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/pos">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="pos"
                          requiredPermission="pos.access"
                        >
                          <Layout>
                            <POS />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/instant-pos/table/:tableNumber">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="instant_pos"
                          requiredPermission="instantPos.access"
                        >
                          <Layout>
                            <InstantPOS />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/instant-pos">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="instant_pos"
                          requiredPermission="instantPos.access"
                        >
                          <Layout>
                            <InstantPOS />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/kds">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="kds"
                        >
                          <Layout>
                            <KDSDashboard />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/kds/local">
                        <div className="h-screen w-screen bg-background text-foreground overflow-hidden">
                          <KDSDashboard />
                        </div>
                      </Route>
                      <Route path="/sales">
                        <ProtectedRoute requiredFeature="sales_history" requiredPermission="salesHistory.access">
                          <Layout>
                            <Sales />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/business-partners">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="businessPartners.access"
                        >
                          <Layout>
                            <BusinessPartners />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/business-partners/account-statement">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="businessPartners.access"
                        >
                          <Layout>
                            <AccountStatements />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/business-partners/:partnerId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="businessPartners.access"
                        >
                          <Layout>
                            <BusinessPartnerDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/online-customers">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="ecommerce"
                          requiredPermission="ecommerce.access"
                        >
                          <Layout>
                            <OnlineCustomers />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/online-customers/:partnerId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="ecommerce"
                          requiredPermission="ecommerce.access"
                        >
                          <Layout>
                            <OnlineCustomerDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/agents">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="agents"
                          requiredPermission="agents.access"
                        >
                          <Layout>
                            <Agents />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/agents/commission-settings">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="agents"
                          requiredPermission="agents.access"
                        >
                          <Layout>
                            <AgentCommissionSettings />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/post-service">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="post_service"
                          requiredPermission="postService.access"
                        >
                          <Layout>
                            <PostService />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/car-rental">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="car_rental"
                          requiredPermission="carRental.access"
                        >
                          <Layout>
                            <CarRental />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/car-rental/vehicles">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="car_rental"
                          requiredPermission="carRental.access"
                        >
                          <Layout>
                            <CarRental initialTab="vehicles" />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/car-rental/requests">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="car_rental"
                          requiredPermission="carRental.access"
                        >
                          <Layout>
                            <CarRental initialTab="requests" />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/car-rental/contracts">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="car_rental"
                          requiredPermission="carRental.access"
                        >
                          <Layout>
                            <CarRental initialTab="contracts" />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/agents/fleet">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="agents"
                          requiredPermission="fleet.access"
                        >
                          <Layout>
                            <FleetManagement />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/agents/location-sharing">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="agents"
                          requiredPermission="fleet.shareLocation"
                        >
                          <Layout>
                            <AgentLocationSharing />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/agents/:agentId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="agents"
                          requiredPermission="agents.access"
                        >
                          <Layout>
                            <AgentDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/customers">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="customers.access"
                        >
                          <Layout>
                            <Customers />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/customers/:customerId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="customers.access"
                        >
                          <Layout>
                            <CustomerDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/suppliers">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="suppliers.access"
                        >
                          <Layout>
                            <Suppliers />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/suppliers/:supplierId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="crm"
                          requiredPermission="suppliers.access"
                        >
                          <Layout>
                            <SupplierDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/new/sales">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredPermission="orders.saleOrdersAccess"
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/new/purchase">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredPermission="orders.purchaseOrdersAccess"
                          requiresSupplierAccess
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/edit/sales/:orderId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff"]}
                          requiredFeature="orders"
                          requiredPermission="orders.saleOrdersAccess"
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/edit/purchase/:orderId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff"]}
                          requiredFeature="orders"
                          requiredPermission="orders.purchaseOrdersAccess"
                          requiresSupplierAccess
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredAnyPermission={["orders.saleOrdersAccess", "orders.purchaseOrdersAccess"]}
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/sales">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredPermission="orders.saleOrdersAccess"
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/purchase">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredPermission="orders.purchaseOrdersAccess"
                          requiresSupplierAccess
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/orders/:orderId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="orders"
                          requiredAnyPermission={["orders.saleOrdersAccess", "orders.purchaseOrdersAccess"]}
                        >
                          <Layout>
                            <Orders />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/ecommerce">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff"]}
                          requiredFeature="ecommerce"
                          requiredPermission="ecommerce.access"
                        >
                          <Layout>
                            <Ecommerce />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/ecommerce/:orderId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff"]}
                          requiredFeature="ecommerce"
                          requiredPermission="ecommerce.access"
                        >
                          <Layout>
                            <Ecommerce />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/real-estate">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="real_estate"
                          requiredPermission="realEstate.access"
                        >
                          <Layout>
                            <RealEstate />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/real-estate/new">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="real_estate"
                          requiredPermission="realEstate.access"
                        >
                          <Layout>
                            <RealEstate />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/real-estate/:transactionId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="real_estate"
                          requiredPermission="realEstate.access"
                        >
                          <Layout>
                            <RealEstate />
                          </Layout>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/travel-transportation">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="travel_transportation"
                          requiredPermission="travelTransportation.access"
                        >
                          <Layout>
                            <TravelTransportation />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/travel-transportation/new">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="travel_transportation"
                          requiredPermission="travelTransportation.access"
                        >
                          <Layout>
                            <TravelTransportation />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/travel-transportation/:bookingId/edit">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="travel_transportation"
                          requiredPermission="travelTransportation.access"
                        >
                          <Layout>
                            <TravelTransportation />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/travel-transportation/:bookingId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="travel_transportation"
                          requiredPermission="travelTransportation.access"
                        >
                          <Layout>
                            <TravelTransportation />
                          </Layout>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/activities">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="activities"
                          requiredPermission="activities.access"
                        >
                          <Layout>
                            <Activities />
                          </Layout>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/manual-entry">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="manual_entry"
                          requiredPermission="manualEntry.access"
                        >
                          <Layout>
                            <ManualEntry />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/manual-entry/templates">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="manual_entry"
                          requiredPermission="manualEntryTemplates.access"
                        >
                          <Layout>
                            <ManualEntryTemplates />
                          </Layout>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/currency-exchange">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="currency_exchange"
                          requiredPermission="currencyExchange.access"
                        >
                          <Layout>
                            <CurrencyExchange />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/currency-exchange/new">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="currency_exchange"
                          requiredPermission="currencyExchange.access"
                        >
                          <Layout>
                            <CurrencyExchange />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/currency-exchange/rules">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="currency_exchange"
                          requiredPermission="currencyExchangeFeeRules.access"
                        >
                          <Layout>
                            <CurrencyExchange />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/currency-exchange/safes">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="currency_exchange"
                          requiredPermission="currencyExchange.access"
                        >
                          <Layout>
                            <CurrencyExchange />
                          </Layout>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/clinical-appointments/new">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalAppointments.access"
                        >
                          <Layout>
                            <ClinicalAppointments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/clinical-appointments/:id/edit">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalAppointments.access"
                        >
                          <Layout>
                            <ClinicalAppointments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/clinical-appointments">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalAppointments.access"
                        >
                          <Layout>
                            <ClinicalAppointments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/clinical-appointments/patients">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalPatients.access"
                        >
                          <ClinicalPatientsAndServicePresetsGuard>
                            <Layout>
                              <ClinicalPatients />
                            </Layout>
                          </ClinicalPatientsAndServicePresetsGuard>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/clinical-appointments/patients/:patientId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalPatients.access"
                        >
                          <ClinicalPatientsAndServicePresetsGuard>
                            <Layout>
                              <ClinicalPatientDetails />
                            </Layout>
                          </ClinicalPatientsAndServicePresetsGuard>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/clinical-presets">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="clinical_appointments"
                          requiredPermission="clinicalAppointments.access"
                        >
                          <ClinicalPatientsAndServicePresetsGuard>
                            <Layout>
                              <ClinicalPresets />
                            </Layout>
                          </ClinicalPatientsAndServicePresetsGuard>
                        </ProtectedRoute>
                      </Route>

                      <Route path="/ledger">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="ledger"
                          requiredPermission="ledger.access"
                        >
                          <Layout>
                            <Ledger />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/payments">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="payments"
                          requiredPermission="payment.access"
                        >
                          <Layout>
                            <Payments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/direct-transactions">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="direct_transactions"
                          requiredPermission="directTransaction.access"
                        >
                          <Layout>
                            <DirectTransactions />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/modules">
                        <ProtectedRoute>
                          <Layout>
                            <ModuleLauncher />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/revenue">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="net_revenue"
                          requiredPermission="revenueAnalytics.access"
                        >
                          <Layout>
                            <Revenue />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/budget">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="budget"
                          requiredPermission="budget.access"
                        >
                          <Layout>
                            <Budget />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      {/* <Route path="/monthly-comparison">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="monthly_comparison"
                        >
                          <Layout>
                            <MonthlyComparison />
                          </Layout>
                        </ProtectedRoute>
                      </Route> */}
                      <Route path="/performance">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="team_performance"
                          requiredPermission="teamPerformance.access"
                        >
                          <Layout>
                            <TeamPerformance />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/whatsapp">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="allow_whatsapp"
                        >
                          <Layout>
                            <WhatsApp />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/products/new">
                        <ProtectedRoute requiredFeature="products" requiredPermission="products.access">
                          <Layout>
                            <ProductCreatePage />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/payment-accounts/cashier-shifts/:shiftId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="cashier_shift_control"
                          requiredPermission="cashierShiftControl.access"
                        >
                          <Layout>
                            <CashierShiftDetails />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/payment-accounts/cashier-shifts">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="cashier_shift_control"
                          requiredPermission="cashierShiftControl.access"
                        >
                          <Layout>
                            <CashierShifts />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/payment-accounts">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="payment_accounts"
                          requiredPermission="paymentAccounts.access"
                        >
                          <Layout>
                            <PaymentAccounts />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/services/new">
                        <ProtectedRoute requiredFeature="services" requiredPermission="products.access">
                          <Layout><ServiceFormPage /></Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/services/:serviceId">
                        <ProtectedRoute requiredFeature="services" requiredPermission="products.access">
                          <Layout><ServiceFormPage /></Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/services">
                        <ProtectedRoute requiredFeature="services" requiredPermission="products.access">
                          <Layout><Services /></Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/products/:productId/clone">
                        <ProtectedRoute requiredFeature="products" requiredPermission="products.access">
                          <Layout>
                            <ProductClonePage />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/products/:productId">
                        <ProtectedRoute requiredFeature="products" requiredPermission="products.access">
                          <Layout>
                            <ProductEditPage />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/products">
                        <ProtectedRoute requiredFeature="products" requiredPermission="products.access">
                          <Layout>
                            <Products />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/units">
                        <ProtectedRoute requiredFeature="products" requiredPermission="products.access">
                          <Layout>
                            <UnitsPage />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/discounts">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff"]}
                          requiredFeature="discounts"
                          requiredPermission="discounts.access"
                        >
                          <Layout>
                            <Discounts />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/storages">
                        <ProtectedRoute requiredFeature="storages" requiredPermission="storages.access">
                          <Layout>
                            <Storages />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/inventory-transfer">
                        <ProtectedRoute requiredFeature="inventory_transfer" requiredPermission="inventoryTransfer.access">
                          <Layout>
                            <InventoryTransfer />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/inventory-transactions">
                        <ProtectedRoute requiredFeature="inventory_transactions" requiredPermission="inventoryTransactions.access">
                          <Layout>
                            <InventoryTransactions />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/stock-adjustments">
                        <ProtectedRoute requiredFeature="stock_adjustments" requiredPermission="stockAdjustments.access">
                          <Layout>
                            <StockAdjustments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/hr">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="hr"
                          requiredPermission="hr.access"
                        >
                          <Layout>
                            <HR />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/loans">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="loans"
                          requiredPermission="loans.access"
                        >
                          <Layout>
                            <Loans />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/loans/:loanId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="loans"
                          requiredPermission="loans.access"
                        >
                          <Layout>
                            <Loans />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/installments">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredAnyFeature={["installments", "crm", "real_estate"]}
                          requiredPermission="installments.access"
                        >
                          <Layout>
                            <Installments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/installments/sales">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="installments"
                          requiredPermission="installments.access"
                        >
                          <Layout>
                            <InstallmentSales />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/installments/sales/:saleId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="installments"
                          requiredPermission="installments.access"
                        >
                          <Layout>
                            <InstallmentSales />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/installments/:loanId">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="installments"
                          requiredPermission="installments.access"
                        >
                          <Layout>
                            <Installments />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/invoices-history/upload-files">
                        <ProtectedRoute requiredFeature="invoices_history" requiredPermission="invoiceHistory.access">
                          <Layout>
                            <InvoicesHistory />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/invoices-history">
                        <ProtectedRoute requiredFeature="invoices_history" requiredPermission="invoiceHistory.access">
                          <Layout>
                            <InvoicesHistory />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/print-preview-editor">
                        <ProtectedRoute>
                          <Suspense fallback={null}>
                            <PrintPreviewEditorPage />
                          </Suspense>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/currency-converter">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredCapability="multiCurrency"
                        >
                          <Layout>
                            <CurrencyConverter />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/notebook">
                        <ProtectedRoute>
                          <Layout>
                            <Notebook />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/members">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                          requiredFeature="members"
                        >
                          <Layout>
                            <Members />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/custom-templates">
                        <ProtectedRoute allowedRoles={["admin"]}>
                          <Layout>
                            <CustomTemplates />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/workspace-registration">
                        <ProtectedRoute allowKicked={true}>
                          <WorkspaceRegistration />
                        </ProtectedRoute>
                      </Route>
                      <Route path="/settings">
                        <ProtectedRoute
                          allowedRoles={["admin", "staff", "viewer"]}
                        >
                          <Layout>
                            <Settings />
                          </Layout>
                        </ProtectedRoute>
                      </Route>
                      <Route path="/workspace-configuration">
                        <ProtectedRoute allowedRoles={["admin"]}>
                          <WorkspaceConfiguration />
                        </ProtectedRoute>
                      </Route>

                      {/* 404 */}
                      <Route>
                        <div className="min-h-screen flex items-center justify-center bg-background">
                          <div className="text-center">
                            <h1 className="text-6xl font-bold gradient-text mb-4">
                              404
                            </h1>
                            <p className="text-muted-foreground mb-4">
                              Page not found
                            </p>
                            <Link
                              href="/"
                              className="text-primary hover:underline"
                            >
                              Go home
                            </Link>
                          </div>
                        </div>
                      </Route>
                    </Switch>
                  <PostSaveInvoiceDialog />
                  </DemoTutorialProvider>
                  </Router>
                </Suspense>
              </KdsSecurityGuard>
            </ExchangeRateProvider>
              )}
              <Toaster />
              {isTauri && currentPatch && (
                <PatchNoteModal
                  isOpen={showModal}
                  onClose={dismissModal}
                  version={version}
                  date={currentPatch.date}
                  highlights={currentPatch.highlights}
                  teamMessages={currentPatch.teamMessages}
                />
              )}
            </DateRangeProvider>
            </UiAccessProvider>
          </FleetLocationSharingProvider>
        </WorkspacePermissionsProvider>
      </WorkspaceProvider>
    </AuthProvider>
  );
}

export default App;
