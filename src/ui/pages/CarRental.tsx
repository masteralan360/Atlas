import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import {
  Car,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Link2,
  Plus,
  Search,
  Unlink,
} from "lucide-react";

import { useAuth } from "@/auth";
import { useDateRange } from "@/context/DateRangeContext";
import { isDateInDateRange } from "@/lib/dateRangeFilters";
import { getRentalVehicleDisplayLabel } from "@/lib/carRentalPresentation";
import { STANDARD_PAYMENT_METHODS } from "@/lib/paymentMethods";
import {
  cn,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumberWithCommas,
  formatNumericInput,
  parseFormattedNumber,
  sanitizeNumericInput,
} from "@/lib/utils";
import {
  activateRentalContract,
  cancelRentalContract,
  closeRentalContract,
  createRentalContract,
  createRentalRequest,
  createRentalVehicle,
  INVALID_RENTAL_VEHICLE_YEAR_ERROR,
  getRentalContractPaymentSummary,
  RENTAL_VEHICLE_YEAR_MAX,
  RENTAL_VEHICLE_YEAR_MIN,
  recordRentalContractPayment,
  reserveRentalContract,
  returnRentalContract,
  updateRentalRequestStatus,
  updateRentalVehicle,
  useBusinessPartners,
  usePaymentTransactions,
  useRentalContracts,
  useRentalRequests,
  useRentalVehicles,
  type CurrencyCode,
  type BusinessPartner,
  type PaymentAccount,
  type RentalContract,
  type RentalPaymentKind,
  type RentalRequest,
  type RentalRequestStatus,
  type RentalVehicle,
  type RentalVehicleStatus,
  type WorkspacePaymentMethod,
} from "@/local-db";
import { useWorkspacePermissions } from "@/permissions";
import { useWorkspace } from "@/workspace";
import { PartnerAutocompleteInput } from "@/ui/components/crm/PartnerAutocompleteInput";
import { VehicleAutocompleteInput } from "@/ui/components/crm/VehicleAutocompleteInput";
import { DateRangeFilters } from "@/ui/components/DateRangeFilters";
import { DateRangeBadge } from "@/ui/components/DateRangeBadge";
import { ModulePageFreshness } from "@/ui/components/ModulePageFreshness";
import { PaymentAccountSelector } from "@/ui/components/payments/PaymentAccountSelector";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CurrencySelector,
  DateTimePicker,
  Input,
  Label,
  PaymentMethodSelector,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from "@/ui/components";

type CarRentalTab = "calendar" | "vehicles" | "requests" | "contracts";

type VehicleFormState = {
  plateNumber: string;
  make: string;
  model: string;
  year: string;
  color: string;
  vin: string;
  category: string;
  dailyRate: string;
  currency: CurrencyCode;
  currentOdometer: string;
  currentFuelLevel: string;
  status: RentalVehicleStatus;
  notes: string;
};

type RequestFormState = {
  customerName: string;
  customerPhone: string;
  businessPartnerId: string;
  preferredVehicleId: string;
  preferredVehicleSearch: string;
  requestedStartAt: Date;
  requestedEndAt: Date;
  notes: string;
};

type ContractFormState = {
  vehicleId: string;
  vehicleSearch: string;
  customerName: string;
  customerPhone: string;
  businessPartnerId: string;
  driverLicenseNo: string;
  plannedPickupAt: Date;
  plannedReturnAt: Date;
  dailyRate: string;
  rentalDays: string;
  discountAmount: string;
  depositAmount: string;
  currency: CurrencyCode;
  notes: string;
};

const todayAtNine = () => {
  const date = new Date();
  date.setHours(9, 0, 0, 0);
  return date;
};

const tomorrowAtNine = () => {
  const date = todayAtNine();
  date.setDate(date.getDate() + 1);
  return date;
};

function emptyVehicleForm(currency: CurrencyCode): VehicleFormState {
  return {
    plateNumber: "",
    make: "",
    model: "",
    year: "",
    color: "",
    vin: "",
    category: "",
    dailyRate: "",
    currency,
    currentOdometer: "",
    currentFuelLevel: "",
    status: "available",
    notes: "",
  };
}

function vehicleToForm(vehicle: RentalVehicle): VehicleFormState {
  return {
    plateNumber: vehicle.plateNumber,
    make: vehicle.make || "",
    model: vehicle.model,
    year: vehicle.year ? String(vehicle.year) : "",
    color: vehicle.color || "",
    vin: vehicle.vin || "",
    category: vehicle.category || "",
    dailyRate: formatNumberWithCommas(vehicle.dailyRate),
    currency: vehicle.currency,
    currentOdometer:
      vehicle.currentOdometer === null || vehicle.currentOdometer === undefined
        ? ""
        : formatNumberWithCommas(vehicle.currentOdometer),
    currentFuelLevel: vehicle.currentFuelLevel || "",
    status: vehicle.status,
    notes: vehicle.notes || "",
  };
}

function hasInvalidRentalVehicleYear(value: string) {
  if (!value) return false;
  if (!/^\d{4}$/.test(value)) return true;

  const year = Number(value);
  return year < RENTAL_VEHICLE_YEAR_MIN || year > RENTAL_VEHICLE_YEAR_MAX;
}

function isPositiveRentalAmount(value: string) {
  if (!value.trim()) return false;
  const amount = parseFormattedNumber(value);
  return Number.isFinite(amount) && amount > 0;
}

function isValidRentalPeriod(start: Date, end: Date) {
  return !Number.isNaN(start.getTime())
    && !Number.isNaN(end.getTime())
    && end > start;
}

function emptyRequestForm(): RequestFormState {
  return {
    customerName: "",
    customerPhone: "",
    businessPartnerId: "",
    preferredVehicleId: "",
    preferredVehicleSearch: "",
    requestedStartAt: todayAtNine(),
    requestedEndAt: tomorrowAtNine(),
    notes: "",
  };
}

function emptyContractForm(
  currency: CurrencyCode,
  request?: RentalRequest | null,
): ContractFormState {
  return {
    vehicleId: request?.preferredVehicleId || "",
    vehicleSearch: "",
    customerName: request?.customerName || "",
    customerPhone: request?.customerPhone || "",
    businessPartnerId: request?.businessPartnerId || "",
    driverLicenseNo: "",
    plannedPickupAt: request
      ? new Date(request.requestedStartAt)
      : todayAtNine(),
    plannedReturnAt: request
      ? new Date(request.requestedEndAt)
      : tomorrowAtNine(),
    dailyRate: "",
    rentalDays: "1",
    discountAmount: "",
    depositAmount: "",
    currency,
    notes: request?.notes || "",
  };
}

function startOfDay(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function addDays(date: Date, days: number) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function getRentalDays(start: Date, end: Date) {
  const difference = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(difference / 86_400_000));
}

function contractStatusClass(status: RentalContract["status"]) {
  return status === "active"
    ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    : status === "reserved"
      ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
      : status === "returned"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : status === "closed"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : status === "cancelled"
            ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            : "border-border bg-muted text-muted-foreground";
}

function requestStatusClass(status: RentalRequestStatus) {
  return status === "new"
    ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    : status === "contacted" || status === "offered"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : status === "converted"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        : "border-border bg-muted text-muted-foreground";
}

export function CarRental({
  initialTab = "calendar",
}: {
  initialTab?: CarRentalTab;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { features } = useWorkspace();
  const { hasPermission } = useWorkspacePermissions();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { dateRange, customDates } = useDateRange();
  const workspaceId = user?.workspaceId;
  const canManage = hasPermission("carRental.access");
  const vehicles = useRentalVehicles(workspaceId);
  const requests = useRentalRequests(workspaceId);
  const contracts = useRentalContracts(workspaceId);
  const paymentTransactions = usePaymentTransactions(
    workspaceId,
    { sourceModule: "car_rental", includeReversals: true },
    { hydrateSourceTables: false },
  );
  const partners = useBusinessPartners(workspaceId, { roles: ["customer"] });
  const [tab, setTab] = useState<CarRentalTab>(initialTab);
  const [calendarStart, setCalendarStart] = useState(() =>
    startOfDay(new Date()),
  );
  const [vehicleDialog, setVehicleDialog] = useState<{
    open: boolean;
    vehicle: RentalVehicle | null;
  }>({ open: false, vehicle: null });
  const [requestDialog, setRequestDialog] = useState(false);
  const [contractDialog, setContractDialog] = useState<{
    open: boolean;
    request: RentalRequest | null;
  }>({ open: false, request: null });
  const [handoverTarget, setHandoverTarget] = useState<RentalContract | null>(
    null,
  );
  const [returnTarget, setReturnTarget] = useState<RentalContract | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<RentalContract | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<RentalContract | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);

  const vehicleById = useMemo(
    () => new Map(vehicles.map((vehicle) => [vehicle.id, vehicle])),
    [vehicles],
  );
  const activeContracts = useMemo(
    () =>
      contracts.filter((contract) =>
        ["reserved", "active", "returned"].includes(contract.status),
      ),
    [contracts],
  );
  const filteredRequests = useMemo(
    () =>
      requests.filter((request) =>
        isDateInDateRange(request.createdAt, dateRange, customDates),
      ),
    [customDates, dateRange, requests],
  );
  const filteredContracts = useMemo(
    () =>
      contracts.filter((contract) =>
        isDateInDateRange(contract.createdAt, dateRange, customDates),
      ),
    [contracts, customDates, dateRange],
  );
  const calendarDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => addDays(calendarStart, index)),
    [calendarStart],
  );

  function openTab(nextTab: CarRentalTab) {
    setTab(nextTab);
    navigate(nextTab === "calendar" ? "/car-rental" : `/car-rental/${nextTab}`);
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    setIsSaving(true);
    try {
      await action();
      toast({ title: success });
    } catch (error) {
      toast({
        title: t("common.error"),
        description:
          error instanceof Error &&
          error.message === INVALID_RENTAL_VEHICLE_YEAR_ERROR
            ? t("carRental.syncRecovery.yearInvalid", {
                min: RENTAL_VEHICLE_YEAR_MIN,
                max: RENTAL_VEHICLE_YEAR_MAX,
              })
            : error instanceof Error
            ? error.message
            : t("carRental.messages.saveFailed"),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  if (!workspaceId) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Car className="h-6 w-6 text-primary" />
            {t("carRental.title")}
            {tab === "requests" || tab === "contracts" ? <DateRangeBadge /> : null}
          </h1>
          <p className="text-muted-foreground">
            {t("carRental.subtitle")} <ModulePageFreshness className="ms-2" />
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setRequestDialog(true)}>
              <ClipboardList className="me-2 h-4 w-4" />
              {t("carRental.actions.newRequest")}
            </Button>
            <Button
              onClick={() => setContractDialog({ open: true, request: null })}
            >
              <Plus className="me-2 h-4 w-4" />
              {t("carRental.actions.newContract")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-b pb-3">
        {(
          ["calendar", "vehicles", "requests", "contracts"] as CarRentalTab[]
        ).map((item) => (
          <Button
            key={item}
            type="button"
            variant={tab === item ? "default" : "ghost"}
            onClick={() => openTab(item)}
          >
            {t(`carRental.tabs.${item}`)}
          </Button>
        ))}
      </div>

      {tab === "calendar" ? (
        <RentalCalendar
          t={t}
          vehicles={vehicles}
          contracts={activeContracts}
          start={calendarStart}
          days={calendarDays}
          onPrevious={() => setCalendarStart((value) => addDays(value, -7))}
          onNext={() => setCalendarStart((value) => addDays(value, 7))}
        />
      ) : null}

      {tab === "vehicles" ? (
        <VehiclesTab
          t={t}
          vehicles={vehicles}
          contracts={contracts}
          iqdPreference={features.iqd_display_preference}
          canManage={canManage}
          onNew={() => setVehicleDialog({ open: true, vehicle: null })}
          onEdit={(vehicle) => setVehicleDialog({ open: true, vehicle })}
        />
      ) : null}

      {tab === "requests" ? (
        <section className="space-y-4">
          <DateRangeFilters label={t("carRental.filters.createdDate")} />
          <RequestsTab
            t={t}
            requests={filteredRequests}
            vehicles={vehicleById}
            canManage={canManage}
            onNew={() => setRequestDialog(true)}
            onConvert={(request) => setContractDialog({ open: true, request })}
            onStatus={(request, status) =>
              void runAction(
                () => updateRentalRequestStatus(request.id, status),
                t("carRental.messages.requestUpdated"),
              )
            }
          />
        </section>
      ) : null}

      {tab === "contracts" ? (
        <section className="space-y-4">
          <DateRangeFilters label={t("carRental.filters.createdDate")} />
          <ContractsTab
            t={t}
            contracts={filteredContracts}
            vehicles={vehicleById}
            payments={paymentTransactions}
            iqdPreference={features.iqd_display_preference}
            canManage={canManage}
            onReserve={(contract) =>
              void runAction(
                () => reserveRentalContract(contract.id),
                t("carRental.messages.contractReserved"),
              )
            }
            onCancel={setCancelTarget}
            onHandover={setHandoverTarget}
            onReturn={setReturnTarget}
            onPayment={setPaymentTarget}
            onClose={(contract) =>
              void runAction(
                () => closeRentalContract(contract.id),
                t("carRental.messages.contractClosed"),
              )
            }
          />
        </section>
      ) : null}

      <VehicleDialog
        key={
          vehicleDialog.vehicle?.id ||
          (vehicleDialog.open ? "new-vehicle" : "closed-vehicle")
        }
        open={vehicleDialog.open}
        vehicle={vehicleDialog.vehicle}
        currency={features.default_currency}
        allowedCurrencies={features.allowed_currencies}
        iqdPreference={features.iqd_display_preference}
        isSaving={isSaving}
        onOpenChange={(open) =>
          !isSaving && setVehicleDialog((current) => ({ ...current, open }))
        }
        onSubmit={(input) =>
          void runAction(
            async () => {
              if (vehicleDialog.vehicle)
                await updateRentalVehicle(vehicleDialog.vehicle.id, input);
              else await createRentalVehicle(workspaceId, input);
              setVehicleDialog({ open: false, vehicle: null });
            },
            vehicleDialog.vehicle
              ? t("carRental.messages.vehicleUpdated")
              : t("carRental.messages.vehicleCreated"),
          )
        }
      />
      <RequestDialog
        key={requestDialog ? "open-request" : "closed-request"}
        open={requestDialog}
        workspaceId={workspaceId}
        vehicles={vehicles}
        partners={partners}
        isSaving={isSaving}
        onOpenChange={(open) => !isSaving && setRequestDialog(open)}
        onSubmit={(input) =>
          void runAction(async () => {
            await createRentalRequest(workspaceId, {
              ...input,
              createdBy: user?.id || null,
            });
            setRequestDialog(false);
          }, t("carRental.messages.requestCreated"))
        }
      />
      <ContractDialog
        key={
          contractDialog.request?.id ||
          (contractDialog.open ? "new-contract" : "closed-contract")
        }
        open={contractDialog.open}
        workspaceId={workspaceId}
        request={contractDialog.request}
        vehicles={vehicles}
        partners={partners}
        currency={features.default_currency}
        allowedCurrencies={features.allowed_currencies}
        iqdPreference={features.iqd_display_preference}
        isSaving={isSaving}
        onOpenChange={(open) =>
          !isSaving && setContractDialog((current) => ({ ...current, open }))
        }
        onSubmit={(input) =>
          void runAction(async () => {
            const contract = await createRentalContract(workspaceId, {
              ...input,
              requestId: contractDialog.request?.id || null,
              createdBy: user?.id || null,
            });
            await reserveRentalContract(contract.id);
            setContractDialog({ open: false, request: null });
            setTab("contracts");
          }, t("carRental.messages.contractCreated"))
        }
      />
      <HandoverDialog
        key={handoverTarget?.id || "closed-handover"}
        contract={handoverTarget}
        isSaving={isSaving}
        onOpenChange={(open) => !isSaving && !open && setHandoverTarget(null)}
        onSubmit={(input) =>
          handoverTarget &&
          void runAction(async () => {
            await activateRentalContract(handoverTarget.id, input);
            setHandoverTarget(null);
          }, t("carRental.messages.vehicleHandedOver"))
        }
      />
      <ReturnDialog
        key={returnTarget?.id || "closed-return"}
        contract={returnTarget}
        isSaving={isSaving}
        onOpenChange={(open) => !isSaving && !open && setReturnTarget(null)}
        onSubmit={(input) =>
          returnTarget &&
          void runAction(async () => {
            await returnRentalContract(returnTarget.id, input);
            setReturnTarget(null);
          }, t("carRental.messages.vehicleReturned"))
        }
      />
      <RentalPaymentDialog
        key={paymentTarget?.id || "closed-payment"}
        contract={paymentTarget}
        workspaceId={workspaceId}
        payments={paymentTransactions}
        iqdPreference={features.iqd_display_preference}
        isSaving={isSaving}
        onOpenChange={(open) => !isSaving && !open && setPaymentTarget(null)}
        onSubmit={(input) =>
          paymentTarget &&
          void runAction(async () => {
            await recordRentalContractPayment(workspaceId, {
              contractId: paymentTarget.id,
              ...input,
              createdBy: user?.id || null,
            });
            setPaymentTarget(null);
          }, t("carRental.messages.paymentRecorded"))
        }
      />
      <CancelRentalContractDialog
        contract={cancelTarget}
        isSaving={isSaving}
        onOpenChange={(open) =>
          !isSaving && !open && setCancelTarget(null)
        }
        onConfirm={() =>
          cancelTarget &&
          void runAction(async () => {
            await cancelRentalContract(cancelTarget.id);
            setCancelTarget(null);
          }, t("carRental.messages.contractCancelled"))
        }
      />
    </div>
  );
}

function RentalCalendar({
  t,
  vehicles,
  contracts,
  start,
  days,
  onPrevious,
  onNext,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  vehicles: RentalVehicle[];
  contracts: RentalContract[];
  start: Date;
  days: Date[];
  onPrevious: () => void;
  onNext: () => void;
}) {
  const activeFor = (vehicleId: string, day: Date) =>
    contracts.find(
      (contract) =>
        contract.vehicleId === vehicleId &&
        new Date(contract.plannedPickupAt) < addDays(day, 1) &&
        new Date(contract.plannedReturnAt) > day,
    ) || null;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>{t("carRental.calendar.title")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("carRental.calendar.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onPrevious}
            aria-label={t("carRental.calendar.previousWeek")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void start}
          >
            {formatDate(start)}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onNext}
            aria-label={t("carRental.calendar.nextWeek")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <div className="grid min-w-[940px] grid-cols-[12rem_repeat(7,minmax(7rem,1fr))] border-s border-t">
            <div className="border-b border-e bg-muted/40 p-3 text-sm font-medium">
              {t("carRental.calendar.vehicle")}
            </div>
            {days.map((day) => (
              <div
                key={day.toISOString()}
                className="border-b border-e bg-muted/40 p-3 text-center text-sm font-medium"
              >
                <div>
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                  }).format(day)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Intl.DateTimeFormat(undefined, {
                    weekday: "short",
                  }).format(day)}
                </div>
              </div>
            ))}
            {vehicles.map((vehicle) => (
              <div key={vehicle.id} className="contents">
                <div className="border-b border-e p-3">
                  <div className="font-medium">
                    {vehicle.make || ""} {vehicle.model}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {vehicle.plateNumber}
                  </div>
                </div>
                {days.map((day) => {
                  const contract = activeFor(vehicle.id, day);
                  const maintenance = vehicle.status === "maintenance";
                  return (
                    <div
                      key={`${vehicle.id}-${day.toISOString()}`}
                      className="min-h-14 border-b border-e p-1.5"
                    >
                      {maintenance ? (
                        <div className="h-full min-h-10 rounded bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                          {t("carRental.vehicleStatuses.maintenance")}
                        </div>
                      ) : contract ? (
                        <div
                          className={cn(
                            "h-full min-h-10 rounded px-2 py-1 text-xs font-medium",
                            contract.status === "active"
                              ? "bg-sky-500/15 text-sky-800 dark:text-sky-200"
                              : "bg-violet-500/15 text-violet-800 dark:text-violet-200",
                          )}
                          title={contract.customerName}
                        >
                          {contract.customerName}
                          <br />
                          <span className="opacity-80">
                            {contract.contractNo}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VehiclesTab({
  t,
  vehicles,
  contracts,
  iqdPreference,
  canManage,
  onNew,
  onEdit,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  vehicles: RentalVehicle[];
  contracts: RentalContract[];
  iqdPreference: "IQD" | "د.ع";
  canManage: boolean;
  onNew: () => void;
  onEdit: (vehicle: RentalVehicle) => void;
}) {
  const statusFor = (vehicle: RentalVehicle) =>
    contracts.some(
      (contract) =>
        contract.vehicleId === vehicle.id && contract.status === "active",
    )
      ? "onRent"
      : contracts.some(
            (contract) =>
              contract.vehicleId === vehicle.id &&
              contract.status === "reserved",
          )
        ? "reserved"
        : vehicle.status;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{t("carRental.tabs.vehicles")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("carRental.vehicles.description")}
          </p>
        </div>
        {canManage ? (
          <Button onClick={onNew}>
            <Plus className="me-2 h-4 w-4" />
            {t("carRental.actions.addVehicle")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("carRental.fields.vehicle")}</TableHead>
                <TableHead>{t("carRental.fields.plateNumber")}</TableHead>
                <TableHead>{t("carRental.fields.dailyRate")}</TableHead>
                <TableHead>{t("carRental.fields.odometer")}</TableHead>
                <TableHead>{t("carRental.fields.status")}</TableHead>
                <TableHead className="text-end">
                  {t("common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicles.length === 0 ? (
                <EmptyRow columns={6} label={t("carRental.empty.vehicles")} />
              ) : (
                vehicles.map((vehicle) => (
                  <TableRow key={vehicle.id}>
                    <TableCell>
                      <div className="font-medium">
                        {vehicle.make || ""} {vehicle.model}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {vehicle.category || "—"}
                      </div>
                    </TableCell>
                    <TableCell>{vehicle.plateNumber}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatCurrency(
                        vehicle.dailyRate,
                        vehicle.currency,
                        iqdPreference,
                      )}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {vehicle.currentOdometer?.toLocaleString() || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          statusFor(vehicle) === "onRent"
                            ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                            : statusFor(vehicle) === "reserved"
                              ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                              : vehicle.status === "maintenance"
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                : "border-border bg-muted text-muted-foreground"
                        }
                      >
                        {t(`carRental.vehicleStatuses.${statusFor(vehicle)}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      {canManage ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onEdit(vehicle)}
                        >
                          {t("common.edit")}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RequestsTab({
  t,
  requests,
  vehicles,
  canManage,
  onNew,
  onConvert,
  onStatus,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  requests: RentalRequest[];
  vehicles: ReadonlyMap<string, RentalVehicle>;
  canManage: boolean;
  onNew: () => void;
  onConvert: (request: RentalRequest) => void;
  onStatus: (request: RentalRequest, status: RentalRequestStatus) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{t("carRental.tabs.requests")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("carRental.requests.description")}
          </p>
        </div>
        {canManage ? (
          <Button onClick={onNew}>
            <Plus className="me-2 h-4 w-4" />
            {t("carRental.actions.newRequest")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("carRental.fields.request")}</TableHead>
                <TableHead>{t("carRental.fields.customer")}</TableHead>
                <TableHead>{t("carRental.fields.requestedPeriod")}</TableHead>
                <TableHead>{t("carRental.fields.vehicle")}</TableHead>
                <TableHead>{t("carRental.fields.status")}</TableHead>
                <TableHead className="text-end">
                  {t("common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.length === 0 ? (
                <EmptyRow columns={6} label={t("carRental.empty.requests")} />
              ) : (
                requests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">
                      {request.requestNo}
                    </TableCell>
                    <TableCell>
                      <div>{request.customerName}</div>
                      <div className="text-xs text-muted-foreground">
                        {request.customerPhone}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(request.requestedStartAt)}
                      <br />
                      {formatDateTime(request.requestedEndAt)}
                    </TableCell>
                    <TableCell>
                      {request.preferredVehicleId
                        ? `${vehicles.get(request.preferredVehicleId)?.model || ""} · ${vehicles.get(request.preferredVehicleId)?.plateNumber || ""}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={requestStatusClass(request.status)}
                      >
                        {t(`carRental.requestStatuses.${request.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex flex-wrap justify-end gap-1">
                        {canManage &&
                        ["new", "contacted", "offered"].includes(
                          request.status,
                        ) ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => onConvert(request)}
                          >
                            {t("carRental.actions.createContract")}
                          </Button>
                        ) : null}
                        {canManage && request.status === "new" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onStatus(request, "contacted")}
                          >
                            {t("carRental.actions.markContacted")}
                          </Button>
                        ) : null}
                        {canManage &&
                        ["new", "contacted", "offered"].includes(
                          request.status,
                        ) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onStatus(request, "cancelled")}
                          >
                            {t("common.cancel")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ContractsTab({
  t,
  contracts,
  vehicles,
  payments,
  iqdPreference,
  canManage,
  onReserve,
  onCancel,
  onHandover,
  onReturn,
  onPayment,
  onClose,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  contracts: RentalContract[];
  vehicles: ReadonlyMap<string, RentalVehicle>;
  payments: ReturnType<typeof usePaymentTransactions>;
  iqdPreference: "IQD" | "د.ع";
  canManage: boolean;
  onReserve: (contract: RentalContract) => void;
  onCancel: (contract: RentalContract) => void;
  onHandover: (contract: RentalContract) => void;
  onReturn: (contract: RentalContract) => void;
  onPayment: (contract: RentalContract) => void;
  onClose: (contract: RentalContract) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return !normalized
      ? contracts
      : contracts.filter((contract) =>
          [
            contract.contractNo,
            contract.customerName,
            contract.customerPhone,
            vehicles.get(contract.vehicleId)?.plateNumber,
            vehicles.get(contract.vehicleId)?.model,
          ].some((value) => value?.toLowerCase().includes(normalized)),
        );
  }, [contracts, query, vehicles]);
  return (
    <Card>
      <CardHeader className="gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <CardTitle>{t("carRental.tabs.contracts")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("carRental.contracts.description")}
          </p>
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ps-9"
            placeholder={t("carRental.placeholders.searchContracts")}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("carRental.fields.contract")}</TableHead>
                <TableHead>{t("carRental.fields.customer")}</TableHead>
                <TableHead>{t("carRental.fields.vehicle")}</TableHead>
                <TableHead>{t("carRental.fields.period")}</TableHead>
                <TableHead className="text-end">
                  {t("carRental.fields.total")}
                </TableHead>
                <TableHead className="text-end">
                  {t("carRental.fields.balance")}
                </TableHead>
                <TableHead>{t("carRental.fields.status")}</TableHead>
                <TableHead className="text-end">
                  {t("common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow columns={8} label={t("carRental.empty.contracts")} />
              ) : (
                filtered.map((contract) => {
                  const paymentSummary = getRentalContractPaymentSummary(
                    contract,
                    payments,
                  );
                  const vehicle = vehicles.get(contract.vehicleId);
                  return (
                    <TableRow key={contract.id}>
                      <TableCell className="font-medium">
                        {contract.contractNo}
                      </TableCell>
                      <TableCell>
                        <div>{contract.customerName}</div>
                        <div className="text-xs text-muted-foreground">
                          {contract.customerPhone}
                        </div>
                      </TableCell>
                      <TableCell>
                        {vehicle
                          ? `${vehicle.make || ""} ${vehicle.model} · ${vehicle.plateNumber}`
                          : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(contract.plannedPickupAt)}
                        <br />
                        {formatDateTime(contract.plannedReturnAt)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(
                          contract.finalAmount,
                          contract.currency,
                          iqdPreference,
                        )}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(
                          paymentSummary.rentalBalance,
                          contract.currency,
                          iqdPreference,
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={contractStatusClass(contract.status)}
                        >
                          {t(`carRental.contractStatuses.${contract.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex flex-wrap justify-end gap-1">
                          {canManage && contract.status === "draft" ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => onReserve(contract)}
                            >
                              {t("carRental.actions.reserve")}
                            </Button>
                          ) : null}
                          {canManage && contract.status === "reserved" ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => onHandover(contract)}
                            >
                              {t("carRental.actions.handover")}
                            </Button>
                          ) : null}
                          {canManage && contract.status === "active" ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => onReturn(contract)}
                            >
                              {t("carRental.actions.returnVehicle")}
                            </Button>
                          ) : null}
                          {canManage &&
                          ["reserved", "active", "returned"].includes(
                            contract.status,
                          ) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => onPayment(contract)}
                            >
                              {t("carRental.actions.recordPayment")}
                            </Button>
                          ) : null}
                          {canManage && contract.status === "returned" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => onClose(contract)}
                            >
                              {t("carRental.actions.closeContract")}
                            </Button>
                          ) : null}
                          {canManage &&
                          ["draft", "reserved"].includes(contract.status) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onCancel(contract)}
                            >
                              {t("common.cancel")}
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return (
    <TableRow>
      <TableCell
        colSpan={columns}
        className="py-12 text-center text-muted-foreground"
      >
        {label}
      </TableCell>
    </TableRow>
  );
}

function VehicleDialog({
  open,
  vehicle,
  currency,
  allowedCurrencies,
  iqdPreference,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  vehicle: RentalVehicle | null;
  currency: CurrencyCode;
  allowedCurrencies: CurrencyCode[];
  iqdPreference: "IQD" | "د.ع";
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: Parameters<typeof createRentalVehicle>[1]) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<VehicleFormState>(() =>
    emptyVehicleForm(currency),
  );
  const title = vehicle
    ? t("carRental.dialogs.editVehicle")
    : t("carRental.dialogs.addVehicle");
  const invalidVehicleYear = hasInvalidRentalVehicleYear(form.year);
  const canSubmitVehicle = Boolean(
    form.plateNumber.trim()
    && form.model.trim()
    && isPositiveRentalAmount(form.dailyRate)
    && !invalidVehicleYear,
  );
  useEffect(() => {
    if (!open) return;
    setForm(vehicle ? vehicleToForm(vehicle) : emptyVehicleForm(currency));
  }, [currency, open, vehicle]);
  function reset(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (invalidVehicleYear) return;
    onSubmit({
      ...form,
      year: form.year ? Number(form.year) : null,
      dailyRate: parseFormattedNumber(form.dailyRate),
      currentOdometer: form.currentOdometer
        ? parseFormattedNumber(form.currentOdometer)
        : null,
    });
  }
  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => !isSaving && reset(nextOpen)}
    >
      <AppDialogContent className="max-w-3xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>{title}</AppDialogTitle>
        </AppDialogHeader>
        <form
          id="rental-vehicle-form"
          onSubmit={submit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("carRental.fields.plateNumber")}>
                <Input
                  value={form.plateNumber}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      plateNumber: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label={t("carRental.fields.model")}>
                <Input
                  value={form.model}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label={t("carRental.fields.make")}>
                <Input
                  value={form.make}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      make: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.year")}>
                <div className="space-y-1.5">
                  <Input
                    value={form.year}
                    placeholder="0"
                    inputMode="numeric"
                    maxLength={4}
                    aria-invalid={invalidVehicleYear}
                    className={
                      invalidVehicleYear
                        ? "border-destructive focus-visible:ring-destructive"
                        : undefined
                    }
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        year: sanitizeNumericInput(event.target.value, {
                          allowDecimal: false,
                        }),
                      }))
                    }
                  />
                  {invalidVehicleYear && (
                    <p className="text-sm text-destructive">
                      {t("carRental.syncRecovery.yearInvalid", {
                        min: RENTAL_VEHICLE_YEAR_MIN,
                        max: RENTAL_VEHICLE_YEAR_MAX,
                      })}
                    </p>
                  )}
                </div>
              </Field>
              <Field label={t("carRental.fields.category")}>
                <Input
                  value={form.category}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      category: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.color")}>
                <Input
                  value={form.color}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      color: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.dailyRate")}>
                <Input
                  value={formatNumericInput(form.dailyRate)}
                  placeholder="0"
                  inputMode="decimal"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      dailyRate: formatNumericInput(
                        sanitizeNumericInput(event.target.value),
                      ),
                    }))
                  }
                  required
                />
              </Field>
              <CurrencySelector
                value={form.currency}
                onChange={(value) =>
                  setForm((current) => ({ ...current, currency: value }))
                }
                label={t("carRental.fields.currency")}
                iqdDisplayPreference={iqdPreference}
                allowedCurrencies={allowedCurrencies}
              />
              <Field label={t("carRental.fields.odometer")}>
                <Input
                  value={formatNumericInput(form.currentOdometer)}
                  placeholder="0"
                  inputMode="numeric"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      currentOdometer: formatNumericInput(
                        sanitizeNumericInput(event.target.value, {
                          allowDecimal: false,
                        }),
                      ),
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.fuelLevel")}>
                <Input
                  value={form.currentFuelLevel}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      currentFuelLevel: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.vin")}>
                <Input
                  value={form.vin}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      vin: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.status")}>
                <Select
                  value={form.status}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      status: value as RentalVehicleStatus,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        "available",
                        "maintenance",
                        "inactive",
                      ] as RentalVehicleStatus[]
                    ).map((status) => (
                      <SelectItem key={status} value={status}>
                        {t(`carRental.vehicleStatuses.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label={t("carRental.fields.notes")}>
              <Textarea
                value={form.notes}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving || !canSubmitVehicle}>
              {isSaving ? t("carRental.actions.saving") : t("common.save")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function RequestDialog({
  open,
  workspaceId,
  vehicles,
  partners,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  workspaceId: string;
  vehicles: ReturnType<typeof useRentalVehicles>;
  partners: ReturnType<typeof useBusinessPartners>;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: Omit<Parameters<typeof createRentalRequest>[1], "createdBy">,
  ) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<RequestFormState>(emptyRequestForm);
  const canSubmitRequest = Boolean(
    form.customerName.trim()
    && form.customerPhone.trim()
    && isValidRentalPeriod(form.requestedStartAt, form.requestedEndAt),
  );
  function partnerChanged(partner: BusinessPartner) {
    setForm((current) => ({
      ...current,
      businessPartnerId: partner.id,
      customerName: partner.partnerName,
      customerPhone: partner.phone || current.customerPhone,
    }));
  }
  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isSaving) return;
        if (nextOpen) setForm(emptyRequestForm());
        onOpenChange(nextOpen);
      }}
    >
      <AppDialogContent className="max-w-2xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>{t("carRental.dialogs.newRequest")}</AppDialogTitle>
        </AppDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmitRequest) return;
            onSubmit({
              ...form,
              businessPartnerId: form.businessPartnerId || null,
              preferredVehicleId: form.preferredVehicleId || null,
              requestedStartAt: form.requestedStartAt.toISOString(),
              requestedEndAt: form.requestedEndAt.toISOString(),
            });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <LinkedPartnerField
                label={t("carRental.fields.customer")}
                workspaceId={workspaceId}
                partners={partners}
                partnerId={form.businessPartnerId}
                customerName={form.customerName}
                onCustomerNameChange={(customerName) =>
                  setForm((current) => ({
                    ...current,
                    customerName,
                    businessPartnerId:
                      current.businessPartnerId &&
                      customerName.trim() !==
                        (partners.find(
                          (partner) => partner.id === current.businessPartnerId,
                        )?.partnerName ?? current.customerName)
                        ? ""
                        : current.businessPartnerId,
                  }))
                }
                onSelectPartner={partnerChanged}
                onUnlink={() =>
                  setForm((current) => ({
                    ...current,
                    businessPartnerId: "",
                    customerName: "",
                    customerPhone: "",
                  }))
                }
                disabled={isSaving}
              />
              <Field label={t("carRental.fields.phone")}>
                <Input
                  value={form.customerPhone}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      customerPhone: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label={t("carRental.fields.preferredVehicle")} isLoading={vehicles.isLoading}>
                <VehicleAutocompleteInput
                  workspaceId={workspaceId}
                  value={form.preferredVehicleSearch}
                  hasSelection={Boolean(form.preferredVehicleId)}
                  onChange={(preferredVehicleSearch) =>
                    setForm((current) => ({
                      ...current,
                      preferredVehicleSearch,
                      preferredVehicleId: "",
                    }))
                  }
                  onSelectVehicle={(vehicle) =>
                    setForm((current) => ({
                      ...current,
                      preferredVehicleId: vehicle.id,
                      preferredVehicleSearch:
                        getRentalVehicleDisplayLabel(vehicle),
                    }))
                  }
                  placeholder={t("carRental.placeholders.searchVehicle")}
                  disabled={isSaving}
                  isLoading={vehicles.isLoading}
                />
              </Field>
              <Field label={t("carRental.fields.pickup")}>
                {" "}
                <DateTimePicker
                  date={form.requestedStartAt}
                  setDate={(date) =>
                    date &&
                    setForm((current) => ({
                      ...current,
                      requestedStartAt: date,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.returnDate")}>
                {" "}
                <DateTimePicker
                  date={form.requestedEndAt}
                  setDate={(date) =>
                    date &&
                    setForm((current) => ({ ...current, requestedEndAt: date }))
                  }
                />
              </Field>
            </div>
            <Field label={t("carRental.fields.notes")}>
              <Textarea
                value={form.notes}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving || !canSubmitRequest}>
              {isSaving ? t("carRental.actions.saving") : t("common.save")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function ContractDialog({
  open,
  workspaceId,
  request,
  vehicles,
  partners,
  currency,
  allowedCurrencies,
  iqdPreference,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  workspaceId: string;
  request: RentalRequest | null;
  vehicles: ReturnType<typeof useRentalVehicles>;
  partners: ReturnType<typeof useBusinessPartners>;
  currency: CurrencyCode;
  allowedCurrencies: CurrencyCode[];
  iqdPreference: "IQD" | "د.ع";
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: Omit<
      Parameters<typeof createRentalContract>[1],
      "requestId" | "createdBy"
    >,
  ) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ContractFormState>(() =>
    emptyContractForm(currency),
  );
  const days = getRentalDays(form.plannedPickupAt, form.plannedReturnAt);
  const gross = parseFormattedNumber(form.dailyRate || "0") * days;
  const total = Math.max(
    gross - parseFormattedNumber(form.discountAmount || "0"),
    0,
  );
  const discountAmount = parseFormattedNumber(form.discountAmount || "0");
  const canSubmitContract = Boolean(
    form.vehicleId
    && form.customerName.trim()
    && form.customerPhone.trim()
    && isValidRentalPeriod(form.plannedPickupAt, form.plannedReturnAt)
    && isPositiveRentalAmount(form.dailyRate)
    && discountAmount >= 0
    && discountAmount <= gross,
  );
  function reset(nextOpen: boolean) {
    if (nextOpen) {
      const next = emptyContractForm(currency, request);
      const vehicle = vehicles.find((item) => item.id === next.vehicleId);
      if (vehicle) {
        next.vehicleSearch = getRentalVehicleDisplayLabel(vehicle);
        next.dailyRate = formatNumberWithCommas(vehicle.dailyRate);
        next.currency = vehicle.currency;
      }
      setForm(next);
    }
    onOpenChange(nextOpen);
  }
  function selectVehicle(vehicle: RentalVehicle) {
    setForm((current) => ({
      ...current,
      vehicleId: vehicle.id,
      vehicleSearch: getRentalVehicleDisplayLabel(vehicle),
      dailyRate: formatNumberWithCommas(vehicle.dailyRate),
      currency: vehicle.currency,
    }));
  }
  function selectPartner(partner: BusinessPartner) {
    setForm((current) => ({
      ...current,
      businessPartnerId: partner.id,
      customerName: partner.partnerName,
      customerPhone: partner.phone || current.customerPhone,
    }));
  }
  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => !isSaving && reset(nextOpen)}
    >
      <AppDialogContent className="max-w-3xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>
            {request
              ? t("carRental.dialogs.convertRequest")
              : t("carRental.dialogs.newContract")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmitContract) return;
            onSubmit({
              ...form,
              businessPartnerId: form.businessPartnerId || null,
              driverLicenseNo: form.driverLicenseNo || null,
              plannedPickupAt: form.plannedPickupAt.toISOString(),
              plannedReturnAt: form.plannedReturnAt.toISOString(),
              dailyRate: parseFormattedNumber(form.dailyRate),
              rentalDays: days,
              discountAmount: parseFormattedNumber(form.discountAmount || "0"),
              depositAmount: parseFormattedNumber(form.depositAmount || "0"),
            });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("carRental.fields.vehicle")} isLoading={vehicles.isLoading}>
                <VehicleAutocompleteInput
                  workspaceId={workspaceId}
                  value={form.vehicleSearch}
                  hasSelection={Boolean(form.vehicleId)}
                  onChange={(vehicleSearch) =>
                    setForm((current) => ({
                      ...current,
                      vehicleSearch,
                      vehicleId: "",
                    }))
                  }
                  onSelectVehicle={selectVehicle}
                  placeholder={t("carRental.placeholders.searchVehicle")}
                  statuses={["available"]}
                  disabled={isSaving}
                  isLoading={vehicles.isLoading}
                  required
                />
              </Field>
              <LinkedPartnerField
                label={t("carRental.fields.customer")}
                workspaceId={workspaceId}
                partners={partners}
                partnerId={form.businessPartnerId}
                customerName={form.customerName}
                onCustomerNameChange={(customerName) =>
                  setForm((current) => ({
                    ...current,
                    customerName,
                    businessPartnerId:
                      current.businessPartnerId &&
                      customerName.trim() !==
                        (partners.find(
                          (partner) => partner.id === current.businessPartnerId,
                        )?.partnerName ?? current.customerName)
                        ? ""
                        : current.businessPartnerId,
                  }))
                }
                onSelectPartner={selectPartner}
                onUnlink={() =>
                  setForm((current) => ({
                    ...current,
                    businessPartnerId: "",
                    customerName: "",
                    customerPhone: "",
                  }))
                }
                disabled={isSaving}
              />
              <Field label={t("carRental.fields.phone")}>
                <Input
                  value={form.customerPhone}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      customerPhone: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label={t("carRental.fields.driverLicense")}>
                <Input
                  value={form.driverLicenseNo}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      driverLicenseNo: event.target.value,
                    }))
                  }
                />
              </Field>
              <CurrencySelector
                value={form.currency}
                onChange={(value) =>
                  setForm((current) => ({ ...current, currency: value }))
                }
                label={t("carRental.fields.currency")}
                iqdDisplayPreference={iqdPreference}
                allowedCurrencies={allowedCurrencies}
              />
              <Field label={t("carRental.fields.pickup")}>
                <DateTimePicker
                  date={form.plannedPickupAt}
                  setDate={(date) =>
                    date &&
                    setForm((current) => ({
                      ...current,
                      plannedPickupAt: date,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.returnDate")}>
                <DateTimePicker
                  date={form.plannedReturnAt}
                  setDate={(date) =>
                    date &&
                    setForm((current) => ({
                      ...current,
                      plannedReturnAt: date,
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.dailyRate")}>
                <Input
                  value={formatNumericInput(form.dailyRate)}
                  placeholder="0"
                  inputMode="decimal"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      dailyRate: formatNumericInput(
                        sanitizeNumericInput(event.target.value),
                      ),
                    }))
                  }
                  required
                />
              </Field>
              <Field label={t("carRental.fields.discount")}>
                <Input
                  value={formatNumericInput(form.discountAmount)}
                  placeholder="0"
                  inputMode="decimal"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      discountAmount: formatNumericInput(
                        sanitizeNumericInput(event.target.value),
                      ),
                    }))
                  }
                />
              </Field>
              <Field label={t("carRental.fields.deposit")}>
                <Input
                  value={formatNumericInput(form.depositAmount)}
                  placeholder="0"
                  inputMode="decimal"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      depositAmount: formatNumericInput(
                        sanitizeNumericInput(event.target.value),
                      ),
                    }))
                  }
                />
              </Field>
              <div className="rounded-xl border bg-muted/30 p-3">
                <div className="text-sm text-muted-foreground">
                  {t("carRental.fields.total")}
                </div>
                <div className="mt-1 text-xl font-bold tabular-nums">
                  {formatCurrency(total, form.currency, iqdPreference)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("carRental.contracts.days", { count: days })}
                </div>
              </div>
            </div>
            <Field label={t("carRental.fields.notes")}>
              <Textarea
                value={form.notes}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving || !canSubmitContract}>
              {isSaving
                ? t("carRental.actions.saving")
                : t("carRental.actions.createAndReserve")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function HandoverDialog({
  contract,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  contract: RentalContract | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: Pick<
      RentalContract,
      "handoverOdometer" | "handoverFuelLevel" | "handoverCondition"
    >,
  ) => void;
}) {
  const { t } = useTranslation();
  const [odometer, setOdometer] = useState("");
  const [fuel, setFuel] = useState("");
  const [condition, setCondition] = useState("");
  return (
    <AppDialog
      open={!!contract}
      onOpenChange={(open) => !isSaving && onOpenChange(open)}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>{t("carRental.dialogs.handover")}</AppDialogTitle>
        </AppDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              handoverOdometer: odometer
                ? parseFormattedNumber(odometer)
                : null,
              handoverFuelLevel: fuel,
              handoverCondition: condition,
            });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {contract?.contractNo} · {contract?.customerName}
            </p>
            <Field label={t("carRental.fields.odometer")}>
              <Input
                value={formatNumericInput(odometer)}
                placeholder="0"
                inputMode="numeric"
                onChange={(event) =>
                  setOdometer(
                    formatNumericInput(
                      sanitizeNumericInput(event.target.value, {
                        allowDecimal: false,
                      }),
                    ),
                  )
                }
              />
            </Field>
            <Field label={t("carRental.fields.fuelLevel")}>
              <Input
                value={fuel}
                onChange={(event) => setFuel(event.target.value)}
              />
            </Field>
            <Field label={t("carRental.fields.condition")}>
              <Textarea
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? t("carRental.actions.saving")
                : t("carRental.actions.handover")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function ReturnDialog({
  contract,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  contract: RentalContract | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: Parameters<typeof returnRentalContract>[1]) => void;
}) {
  const { t } = useTranslation();
  const [returnedAt, setReturnedAt] = useState<Date>(() => new Date());
  const [odometer, setOdometer] = useState("");
  const [fuel, setFuel] = useState("");
  const [condition, setCondition] = useState("");
  const [adjustment, setAdjustment] = useState("");
  return (
    <AppDialog
      open={!!contract}
      onOpenChange={(open) => !isSaving && onOpenChange(open)}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>
            {t("carRental.dialogs.returnVehicle")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              actualReturnAt: returnedAt.toISOString(),
              returnOdometer: odometer ? parseFormattedNumber(odometer) : null,
              returnFuelLevel: fuel,
              returnCondition: condition,
              returnAdjustmentAmount: parseFormattedNumber(adjustment || "0"),
            });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {contract?.contractNo} · {contract?.customerName}
            </p>
            <Field label={t("carRental.fields.actualReturn")}>
              <DateTimePicker
                date={returnedAt}
                setDate={(date) => date && setReturnedAt(date)}
              />
            </Field>
            <Field label={t("carRental.fields.odometer")}>
              <Input
                value={formatNumericInput(odometer)}
                placeholder="0"
                inputMode="numeric"
                onChange={(event) =>
                  setOdometer(
                    formatNumericInput(
                      sanitizeNumericInput(event.target.value, {
                        allowDecimal: false,
                      }),
                    ),
                  )
                }
              />
            </Field>
            <Field label={t("carRental.fields.fuelLevel")}>
              <Input
                value={fuel}
                onChange={(event) => setFuel(event.target.value)}
              />
            </Field>
            <Field label={t("carRental.fields.returnAdjustment")}>
              <Input
                value={formatNumericInput(adjustment)}
                placeholder="0"
                inputMode="decimal"
                onChange={(event) =>
                  setAdjustment(
                    formatNumericInput(
                      sanitizeNumericInput(event.target.value),
                    ),
                  )
                }
              />
            </Field>
            <Field label={t("carRental.fields.condition")}>
              <Textarea
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? t("carRental.actions.saving")
                : t("carRental.actions.returnVehicle")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function RentalPaymentDialog({
  contract,
  workspaceId,
  payments,
  iqdPreference,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  contract: RentalContract | null;
  workspaceId: string;
  payments: ReturnType<typeof usePaymentTransactions>;
  iqdPreference: "IQD" | "د.ع";
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: Omit<
      Parameters<typeof recordRentalContractPayment>[1],
      "contractId" | "createdBy"
    >,
  ) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RentalPaymentKind>("rental");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<WorkspacePaymentMethod>("cash");
  const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null);
  const [note, setNote] = useState("");
  const openedContractId = useRef<string | null>(null);
  const summary = contract
    ? getRentalContractPaymentSummary(contract, payments)
    : null;
  const maximum =
    kind === "rental"
      ? summary?.rentalBalance || 0
      : kind === "deposit_refund"
        ? summary?.depositHeld || 0
        : contract?.depositAmount || 0;

  useEffect(() => {
    if (!contract) {
      openedContractId.current = null;
      return;
    }
    const contractId = contract.id;
    if (openedContractId.current === contractId) return;

    openedContractId.current = contractId;
    const paymentSummary = getRentalContractPaymentSummary(contract, payments);
    setKind("rental");
    setAmount(
      paymentSummary.rentalBalance > 0
        ? formatNumberWithCommas(paymentSummary.rentalBalance)
        : "",
    );
    setMethod("cash");
    setPaymentAccount(null);
    setNote("");
  }, [contract, payments]);

  function selectPaymentKind(nextKind: RentalPaymentKind) {
    const nextMaximum =
      nextKind === "rental"
        ? summary?.rentalBalance || 0
        : nextKind === "deposit_refund"
          ? summary?.depositHeld || 0
          : contract?.depositAmount || 0;

    setKind(nextKind);
    setAmount(nextMaximum > 0 ? formatNumberWithCommas(nextMaximum) : "");
  }

  const paymentAmount = parseFormattedNumber(amount);
  const canSubmitPayment = Boolean(
    contract
    && isPositiveRentalAmount(amount)
    && paymentAmount <= maximum + 0.000001
    && STANDARD_PAYMENT_METHODS.includes(
      method as (typeof STANDARD_PAYMENT_METHODS)[number],
    ),
  );
  return (
    <AppDialog
      open={!!contract}
      onOpenChange={(open) => !isSaving && onOpenChange(open)}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle>
            {t("carRental.dialogs.recordPayment")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmitPayment) return;
            onSubmit({
              kind,
              amount: parseFormattedNumber(amount),
              paymentMethod: method,
              note,
              accountId: paymentAccount?.id ?? null,
              accountNameSnapshot: paymentAccount?.name ?? null,
            });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-sm text-muted-foreground">
                {t("carRental.fields.maximumAmount")}
              </div>
              <div className="text-xl font-bold tabular-nums">
                {contract
                  ? formatCurrency(maximum, contract.currency, iqdPreference)
                  : "—"}
              </div>
            </div>
            <Field label={t("carRental.fields.paymentKind")}>
              <Select
                value={kind}
                onValueChange={(value) => {
                  selectPaymentKind(value as RentalPaymentKind);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "rental",
                      "deposit",
                      "deposit_refund",
                    ] as RentalPaymentKind[]
                  ).map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`carRental.paymentKinds.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("common.amount")}>
              <Input
                value={formatNumericInput(amount)}
                placeholder="0"
                inputMode="decimal"
                onChange={(event) =>
                  setAmount(
                    formatNumericInput(
                      sanitizeNumericInput(event.target.value),
                    ),
                  )
                }
                required
              />
            </Field>
            <Field label={t("carRental.fields.paymentMethod")}>
              <PaymentMethodSelector
                value={method}
                onValueChange={(value) =>
                  setMethod(value as WorkspacePaymentMethod)
                }
                onLinkedPaymentAccountSelect={setPaymentAccount}
                workspaceId={workspaceId}
                methods={STANDARD_PAYMENT_METHODS}
              />
            </Field>
            <PaymentAccountSelector
              workspaceId={workspaceId}
              value={paymentAccount?.id}
              onValueChange={setPaymentAccount}
              disabled={isSaving}
            />
            <Field label={t("carRental.fields.notes")}>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving || !canSubmitPayment}>
              {isSaving
                ? t("carRental.actions.saving")
                : t("carRental.actions.recordPayment")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

function CancelRentalContractDialog({
  contract,
  isSaving,
  onOpenChange,
  onConfirm,
}: {
  contract: RentalContract | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={Boolean(contract)}
      onOpenChange={(open) => {
        if (!isSaving) onOpenChange(open);
      }}
    >
      <AppDialogContent
        className="max-w-lg"
        showCloseButton={!isSaving}
        onPointerDownOutside={(event) => {
          if (isSaving) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (isSaving) event.preventDefault();
        }}
      >
        <AppDialogHeader>
          <AppDialogTitle>
            {t("carRental.dialogs.cancelContract")}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("carRental.cancelConfirmation.description", {
              contractNo: contract?.contractNo,
            })}
          </p>
        </AppDialogBody>
        <AppDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isSaving}>
            {isSaving
              ? t("carRental.actions.saving")
              : t("carRental.actions.cancelContract")}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  );
}

function Field({
  label,
  children,
  isLoading = false,
}: {
  label: string;
  children: React.ReactNode;
  isLoading?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <Label isLoading={isLoading}>{label}</Label>
      {children}
    </div>
  );
}

function LinkedPartnerField({
  label,
  workspaceId,
  partners,
  partnerId,
  customerName,
  onCustomerNameChange,
  onSelectPartner,
  onUnlink,
  disabled,
}: {
  label: string;
  workspaceId: string;
  partners: ReturnType<typeof useBusinessPartners>;
  partnerId: string;
  customerName: string;
  onCustomerNameChange: (value: string) => void;
  onSelectPartner: (partner: BusinessPartner) => void;
  onUnlink: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const linkedPartner = partners.find((partner) => partner.id === partnerId);
  return (
    <Field label={label} isLoading={partners.isLoading}>
      <div className="space-y-2">
        <PartnerAutocompleteInput
          workspaceId={workspaceId}
          value={customerName}
          onChange={onCustomerNameChange}
          onSelectPartner={onSelectPartner}
          placeholder={t("carRental.placeholders.searchCustomer")}
          roles={["customer"]}
          disabled={disabled}
          isLoading={partners.isLoading}
          required
        />
        {partnerId ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <Link2 className="h-3 w-3" />
                {t("carRental.partnerLink.linked")}
              </Badge>
              <span className="truncate text-sm font-medium">
                {linkedPartner?.partnerName || customerName}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-destructive hover:text-destructive"
              onClick={onUnlink}
              disabled={disabled}
            >
              <Unlink className="h-3.5 w-3.5" />
              {t("carRental.partnerLink.unlink")}
            </Button>
          </div>
        ) : null}
      </div>
    </Field>
  );
}
