import { type FormEvent, Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { flushSync } from "react-dom";
import { postServiceErrorMessage as localizedError } from "@/lib/postServiceErrors";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Banknote, CheckCircle2, ChevronDown, CircleDollarSign, ClipboardList, Clock, FilePenLine, HandCoins, History, Inbox, LayoutGrid, List, ListFilter, Loader2, PackageCheck, Pencil, Play, Plus, Route, Search, Send, Store, Trash2, Truck, Undo2, Users, WalletCards, X, XCircle, type LucideIcon } from "lucide-react";

import { useAuth } from "@/auth";
import {
  adminEditAndRedispatchDeliveryShipment, adminEditReceivedDeliveryShipment, closeDeliveryRun, correctDeliveredDeliveryShipmentCod, correctDeliveredDeliveryShipmentRecipientPayout, createAndDispatchDeliveryShipment, createBusinessPartner, createDeliveryMerchantProfile, createDeliveryRun, createDeliveryShipment, hardDeleteDeliveryMerchantProfile, payDeliveryCourierReimbursement, payDeliveryMerchant, receiveDeliveryMerchantRepayment, receiveReturnedDeliveryShipment,
  refreshPostServiceTab, requestDeliveryShipmentCodAdjustment, requestDeliveryShipmentRecipientPayoutAdjustment, reviewDeliveryShipmentCodAdjustment, reviewDeliveryShipmentRecipientPayoutAdjustment, settleDeliveryCourier, summarizeDeliveryBalanceMetrics, updateBusinessPartner, updateDeliveryMerchantProfile, updateDeliveryShipmentStatus, useAgents, useBusinessPartners, useCourierDeliveryBalances,
  useDeliveryMerchantProfiles, useDeliveryRuns, useDeliverySettlements, useDeliveryShipmentCodAdjustmentRequests, useDeliveryShipmentRecipientPayoutAdjustmentRequests, useDeliveryShipmentEvents, useDeliveryShipments, useFleetVehicles,
  transferReturnedDeliveryShipment, useMerchantDeliveryAccountBalances, useMerchantDeliveryBalances, useDeliveryLedgerEntries, type Agent, type BusinessPartner, type CreateDeliveryShipmentInput, type CurrencyCode, type DeliveryCustomerPaymentStatus, type DeliveryMerchantProfile, type DeliveryRecipientPayoutFunding, type DeliveryShipment, type DeliveryShipmentCodAdjustmentRequest, type DeliveryShipmentEvent, type DeliveryShipmentRecipientPayoutAdjustmentRequest, type DeliveryShipmentStatus, type PaymentAccount, type PostServiceTab, type WorkspacePaymentMethod,
} from "@/local-db";
import { cn, formatCurrency, formatDateTime, formatNumericInput, generateId, parseFormattedNumber, sanitizeNumericInput } from "@/lib/utils";
import { STANDARD_PAYMENT_METHODS } from "@/lib/paymentMethods";
import { isDateInDateRange } from "@/lib/dateRangeFilters";
import { getLanguageDirection } from "@/lib/i18nRouting";
import { isShipmentSettlementNetFinalized, settlementNetByShipment, shipmentSettlementNetAmount, type ShipmentSettlementNet } from "@/lib/postServiceSettlementNet";
import { activeDeliveryShipmentSettlementObligationCount, courierHandoverStatusByShipment, courierReimbursementOutstandingByParty, courierReimbursementOutstandingByShipment, courierReimbursementPaidByShipment, courierReimbursementStatusByShipment, courierSettlementBreakdownByParty, isDeliveryShipmentCompleted, isDeliveryShipmentDone, merchantAccountSettlementBreakdownByParty, merchantPayoutStatusByShipment, merchantRepaymentOutstandingByParty, merchantRepaymentOutstandingByShipment, merchantRepaymentStatusByShipment, merchantSettlementBreakdownByParty, type MerchantAccountSettlementBreakdown, type ShipmentSettlementBreakdown, type ShipmentSettlementStatus } from "@/lib/postServiceSettlementStatus";
import { summarizeCourierOutstandingCash, summarizeCourierPayables, summarizeStaffCourierObligationMetrics } from "@/lib/postServiceStaffCourierMetrics";
import { useWorkspacePermissions } from "@/permissions";
import { useDateRange, type DateRangeType } from "@/context/DateRangeContext";
import { ModulePageFreshness } from "@/ui/components/ModulePageFreshness";
import { DateRangeFilters } from "@/ui/components/DateRangeFilters";
import { FilterDropdown } from "@/ui/components/FilterDropdown";
import { AddPartnerButton } from "@/ui/components/crm/AddPartnerButton";
import { PartnerAutocompleteInput } from "@/ui/components/crm/PartnerAutocompleteInput";
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from "@/ui/components/crm/BusinessPartnerFormDialog";
import { DeleteConfirmationModal } from "@/ui/components/DeleteConfirmationModal";
import {
  AppDialog, AppDialogBody, AppDialogContent, AppDialogDescription, AppDialogFooter, AppDialogHeader, AppDialogTitle,
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, CurrencySelector, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Switch, Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList,
  TabsTrigger, Textarea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, useToast,
} from "@/ui/components";
import { PaymentMethodSelector } from "@/ui/components/PaymentMethodSelector";
import { useWorkspace } from "@/workspace";
import { DeliveryVoicePlaybackDialog } from "@/ui/components/post-service/DeliveryVoicePlaybackDialog";
import { PaymentAccountSelector } from "@/ui/components/payments/PaymentAccountSelector";

type ShipmentForm = {
  merchantProfileId: string; recipientPhone: string; recipientAddress: string; description: string; currency: CurrencyCode;
  codAmount: string; customerPaymentStatus: DeliveryCustomerPaymentStatus; recipientPayoutAmount: string; recipientPayoutFunding: DeliveryRecipientPayoutFunding; deliveryFee: string; feePayer: "merchant" | "recipient";
};

type StandardPaymentMethod = typeof STANDARD_PAYMENT_METHODS[number];

type PostStatusFilter = "all" | DeliveryShipmentStatus | "return_history";
type PostSettlementFilter = "all" | ShipmentSettlementStatus;
type PostsViewMode = "details" | "grid";
type PartyPostsTab = "available" | "done";

type PartyPostsDialogTarget = {
  kind: "merchant" | "courier";
  id: string;
  name: string;
};

type PostSettlementDraft = {
  courierAmount: string;
  courierMethod: WorkspacePaymentMethod;
  courierNote: string;
  courierAccount: PaymentAccount | null;
  merchantAmount: string;
  merchantMethod: WorkspacePaymentMethod;
  merchantNote: string;
  merchantAccount: PaymentAccount | null;
};

type SettlementTarget = {
  kind: "courier" | "courier_reimbursement" | "merchant" | "merchant_repayment";
  id: string;
  currency: CurrencyCode;
  amount: number;
  name: string;
  shipmentId?: string | null;
  shipmentLabel?: string;
};

type CourierPayable = {
  agentId: string;
  currency: CurrencyCode;
  shipmentId: string;
  amount: number;
};

type CourierReimbursement = Omit<CourierPayable, "shipmentId">;

type RecipientPayoutAdjustmentRowOperation =
  | { kind: "request"; shipmentId: string }
  | { kind: "review"; shipmentId: string; requestId: string };

type CourierRow = {
  agent: Agent;
  name: string;
  phone: string | null;
  balances: Array<{ currency: CurrencyCode; amount: number }>;
  payables: CourierPayable[];
  reimbursements: CourierReimbursement[];
};

const statusFilterIcons = {
  all: ListFilter,
  received: Inbox,
  assigned: Truck,
  delivered: CheckCircle2,
  postponed: Clock,
  returned: Undo2,
  return_history: History,
  cancelled: XCircle,
} satisfies Record<PostStatusFilter, LucideIcon>;

const ADMIN_STATUS_CARD_STATUSES = ["received", "assigned", "delivered", "postponed", "returned", "cancelled"] as const satisfies readonly DeliveryShipmentStatus[];
const STAFF_STATUS_CARD_STATUSES = ["assigned", "delivered", "postponed", "returned", "cancelled"] as const satisfies readonly DeliveryShipmentStatus[];

const settlementFilterIcons = {
  all: ListFilter,
  settled: CheckCircle2,
  partial: WalletCards,
  outstanding: Clock,
} satisfies Record<PostSettlementFilter, LucideIcon>;

const initialShipmentForm = (currency: CurrencyCode): ShipmentForm => ({
  merchantProfileId: "", recipientPhone: "", recipientAddress: "", description: "", currency, codAmount: "", customerPaymentStatus: "cash_on_delivery", recipientPayoutAmount: "", recipientPayoutFunding: "courier_advance", deliveryFee: "", feePayer: "merchant",
});

const shipmentFormFromShipment = (shipment: DeliveryShipment): ShipmentForm => ({
  merchantProfileId: shipment.merchantProfileId,
  recipientPhone: shipment.recipientPhone,
  recipientAddress: shipment.recipientAddress,
  description: shipment.description ?? "",
  currency: shipment.currency,
  codAmount: shipment.customerPaymentStatus === "cash_on_delivery" ? String(shipment.codAmount) : "",
  customerPaymentStatus: shipment.customerPaymentStatus,
  recipientPayoutAmount: shipment.recipientPayoutAmount > 0 ? String(shipment.recipientPayoutAmount) : "",
  recipientPayoutFunding: shipment.recipientPayoutFunding ?? "courier_advance",
  deliveryFee: String(shipment.deliveryFee),
  feePayer: shipment.feePayer,
});

function shipmentStatusClass(status: DeliveryShipmentStatus) {
  if (status === "delivered") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "returned" || status === "cancelled") return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (status === "postponed") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "assigned") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-border bg-muted text-muted-foreground";
}

function shipmentStatusLabel(t: TFunction, status: DeliveryShipmentStatus) {
  return t(`postService.status.${status}`);
}

function pendingCodAdjustmentLabel(
  t: TFunction,
  request: DeliveryShipmentCodAdjustmentRequest,
  shipment: DeliveryShipment,
  iqdPreference: "IQD" | "د.ع",
) {
  return t("postService.status.requestChangeTo", {
    amount: formatCurrency(request.requestedCodAmount, shipment.currency, iqdPreference),
  });
}

function pendingCodAdjustmentReviewLabel(
  t: TFunction,
  request: DeliveryShipmentCodAdjustmentRequest,
  shipment: DeliveryShipment,
  iqdPreference: "IQD" | "د.ع",
) {
  return t("postService.actions.reviewChangeTo", {
    amount: formatCurrency(request.requestedCodAmount, shipment.currency, iqdPreference),
  });
}

function pendingRecipientPayoutAdjustmentLabel(
  t: TFunction,
  request: DeliveryShipmentRecipientPayoutAdjustmentRequest,
  shipment: DeliveryShipment,
  iqdPreference: "IQD" | "د.ع",
) {
  return t("postService.status.requestPayoutChangeTo", {
    amount: formatCurrency(request.requestedRecipientPayoutAmount, shipment.currency, iqdPreference),
  });
}

function pendingRecipientPayoutAdjustmentReviewLabel(
  t: TFunction,
  request: DeliveryShipmentRecipientPayoutAdjustmentRequest,
  shipment: DeliveryShipment,
  iqdPreference: "IQD" | "د.ع",
) {
  return t("postService.actions.reviewPayoutChangeTo", {
    amount: formatCurrency(request.requestedRecipientPayoutAmount, shipment.currency, iqdPreference),
  });
}

function currencySuffix(currency: CurrencyCode, iqdPreference: "IQD" | "د.ع") {
  return currency === "iqd" ? iqdPreference : currency === "usd" ? "$" : currency.toUpperCase();
}

function numericValue(value: string) {
  const parsed = parseFormattedNumber(value);
  return Number.isFinite(parsed) ? parsed : 0;
}


const DeveloperTestButton = import.meta.env.DEV && __ATLAS_DEV_TESTING__
  ? lazy(() => import("@/dev/testing/DeveloperTestButton")) : null;

export function PostService() {
  const { t, i18n } = useTranslation();
  const pageDirection = getLanguageDirection(i18n.resolvedLanguage || i18n.language);
  const { dateRange, customDates } = useDateRange();
  const { user } = useAuth();
  const { features } = useWorkspace();
  const { hasPermission } = useWorkspacePermissions();
  const { toast } = useToast();
  const workspaceId = user?.workspaceId;
  const isAdmin = user?.role === "admin";
  const isStaff = user?.role === "staff";
  const isEditor = user?.role === "admin" || user?.role === "staff";
  const canDispatch = isEditor && hasPermission("postService.dispatch");
  const canAdminEditAndRedispatch = isAdmin && hasPermission("postService.dispatch");
  const canSettle = isEditor && hasPermission("postService.settle");
  const currencies = useMemo(() => Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[], [features.allowed_currencies, features.default_currency]);
  const partners = useBusinessPartners(workspaceId, { includeAgentRoles: true });
  const agents = useAgents(workspaceId);
  const vehicles = useFleetVehicles(workspaceId);
  const merchantProfiles = useDeliveryMerchantProfiles(workspaceId);
  const shipments = useDeliveryShipments(workspaceId);
  const codAdjustmentRequests = useDeliveryShipmentCodAdjustmentRequests(workspaceId);
  const recipientPayoutAdjustmentRequests = useDeliveryShipmentRecipientPayoutAdjustmentRequests(workspaceId);
  const shipmentEvents = useDeliveryShipmentEvents(workspaceId);
  const runs = useDeliveryRuns(workspaceId);
  const settlements = useDeliverySettlements(workspaceId);
  const courierBalances = useCourierDeliveryBalances(workspaceId);
  const merchantBalances = useMerchantDeliveryBalances(workspaceId);
  const merchantAccountBalances = useMerchantDeliveryAccountBalances(workspaceId);
  const ledgerEntries = useDeliveryLedgerEntries(workspaceId);
  const courierHandoverStatuses = useMemo(() => courierHandoverStatusByShipment(ledgerEntries), [ledgerEntries]);
  const merchantPayoutStatuses = useMemo(() => merchantPayoutStatusByShipment(ledgerEntries), [ledgerEntries]);
  const courierReimbursementStatuses = useMemo(() => courierReimbursementStatusByShipment(ledgerEntries), [ledgerEntries]);
  const merchantRepaymentStatuses = useMemo(() => merchantRepaymentStatusByShipment(ledgerEntries), [ledgerEntries]);
  const deliveredCodCorrectionShipmentIds = useMemo(() => new Set(
    shipments
      .filter((shipment) => shipment.status === "delivered" && shipment.customerPaymentStatus === "cash_on_delivery")
      .filter((shipment) => (
        (courierHandoverStatuses.get(shipment.id) ?? courierReimbursementStatuses.get(shipment.id)) === "outstanding"
        && (merchantPayoutStatuses.get(shipment.id) ?? merchantRepaymentStatuses.get(shipment.id)) === "outstanding"
      ))
      .map((shipment) => shipment.id),
  ), [shipments, courierHandoverStatuses, merchantPayoutStatuses, courierReimbursementStatuses, merchantRepaymentStatuses]);
  const deliveredRecipientPayoutCorrectionShipmentIds = useMemo(() => new Set(
    shipments
      .filter((shipment) => (
        shipment.status === "delivered"
        && shipment.customerPaymentStatus === "prepaid_electronically"
        && shipment.recipientPayoutFunding === "courier_advance"
      ))
      .filter((shipment) => (
        courierReimbursementStatuses.get(shipment.id) === "outstanding"
        && merchantRepaymentStatuses.get(shipment.id) === "outstanding"
      ))
      .map((shipment) => shipment.id),
  ), [shipments, courierReimbursementStatuses, merchantRepaymentStatuses]);
  const [activeTab, setActiveTab] = useState<PostServiceTab>("posts");
  const postsPanelRef = useRef<HTMLDivElement>(null);
  const [pendingPostsStatusShortcut, setPendingPostsStatusShortcut] = useState(false);
  useEffect(() => {
    if (!isAdmin && activeTab !== "posts") {
      setActiveTab("posts");
    }
  }, [activeTab, isAdmin]);
  const [postsViewMode, setPostsViewMode] = useState<PostsViewMode>("details");
  const [statusFilter, setStatusFilter] = useState<PostStatusFilter>("all");
  const [pendingChangeRequestFilter, setPendingChangeRequestFilter] = useState(false);
  const [handoverFilter, setHandoverFilter] = useState<PostSettlementFilter>("all");
  const [payoutFilter, setPayoutFilter] = useState<PostSettlementFilter>("all");
  const [showCompleted, setShowCompleted] = useState(false);
  const [showReturned, setShowReturned] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [completedOnly, setCompletedOnly] = useState(false);
  // A completed post uses the settlement obligations for its payment model:
  // COD handover/payout, or prepaid reimbursement/repayment.
  const isCompletedShipment = useCallback(
    (shipment: DeliveryShipment) => isDeliveryShipmentCompleted(
      shipment,
      courierHandoverStatuses,
      merchantPayoutStatuses,
      courierReimbursementStatuses,
      merchantRepaymentStatuses,
    ),
    [courierHandoverStatuses, merchantPayoutStatuses, courierReimbursementStatuses, merchantRepaymentStatuses],
  );
  const isDoneShipment = useCallback(
    (shipment: DeliveryShipment) => isDeliveryShipmentDone(
      shipment,
      courierHandoverStatuses,
      merchantPayoutStatuses,
      courierReimbursementStatuses,
      merchantRepaymentStatuses,
    ),
    [courierHandoverStatuses, merchantPayoutStatuses, courierReimbursementStatuses, merchantRepaymentStatuses],
  );
  const [partyPostsDialogTarget, setPartyPostsDialogTarget] = useState<PartyPostsDialogTarget | null>(null);
  const [partyPostsTab, setPartyPostsTab] = useState<PartyPostsTab>("available");
  const [partyPostsDateRange, setPartyPostsDateRange] = useState<DateRangeType>("allTime");
  const [partyPostsCustomDates, setPartyPostsCustomDates] = useState({ start: "", end: "" });
  const [expandedPartyPostStatus, setExpandedPartyPostStatus] = useState<DeliveryShipmentStatus | null>(null);
  const openPartyPostsDialog = useCallback((target: PartyPostsDialogTarget) => {
    setPartyPostsDialogTarget(target);
    setPartyPostsTab("available");
    setPartyPostsDateRange("allTime");
    setPartyPostsCustomDates({ start: "", end: "" });
    setExpandedPartyPostStatus(null);
  }, []);
  const pendingCodAdjustmentByShipment = useMemo(() => {
    const result = new Map<string, DeliveryShipmentCodAdjustmentRequest>();
    for (const request of codAdjustmentRequests) {
      if (request.status === "pending" && !result.has(request.shipmentId)) result.set(request.shipmentId, request);
    }
    return result;
  }, [codAdjustmentRequests]);
  const approvedCodAdjustmentByShipment = useMemo(() => {
    const result = new Map<string, DeliveryShipmentCodAdjustmentRequest>();
    for (const request of codAdjustmentRequests) {
      if (request.status === "approved" && !result.has(request.shipmentId)) result.set(request.shipmentId, request);
    }
    return result;
  }, [codAdjustmentRequests]);
  const pendingRecipientPayoutAdjustmentByShipment = useMemo(() => {
    const result = new Map<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>();
    for (const request of recipientPayoutAdjustmentRequests) {
      if (request.status === "pending" && !result.has(request.shipmentId)) result.set(request.shipmentId, request);
    }
    return result;
  }, [recipientPayoutAdjustmentRequests]);
  const approvedRecipientPayoutAdjustmentByShipment = useMemo(() => {
    const result = new Map<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>();
    for (const request of recipientPayoutAdjustmentRequests) {
      if (request.status === "approved" && !result.has(request.shipmentId)) result.set(request.shipmentId, request);
    }
    return result;
  }, [recipientPayoutAdjustmentRequests]);
  const pendingChangeRequestShipmentIds = useMemo(
    () => new Set([...pendingCodAdjustmentByShipment.keys(), ...pendingRecipientPayoutAdjustmentByShipment.keys()]),
    [pendingCodAdjustmentByShipment, pendingRecipientPayoutAdjustmentByShipment],
  );
  const visibleShipments = useMemo(() => shipments.filter((shipment) => isDateInDateRange(shipment.createdAt, dateRange, customDates) && (completedOnly ? isCompletedShipment(shipment) : showCompleted || !isCompletedShipment(shipment)) && (statusFilter === "return_history" ? shipment.status === "returned" && Boolean(shipment.returnReceivedAt) : shipment.status !== "returned" || !shipment.returnReceivedAt && (isAdmin || showReturned)) && (showCancelled || shipment.status !== "cancelled") && (statusFilter === "all" || statusFilter === "return_history" || shipment.status === statusFilter) && (!pendingChangeRequestFilter || pendingChangeRequestShipmentIds.has(shipment.id)) && (handoverFilter === "all" || (courierHandoverStatuses.get(shipment.id) ?? null) === handoverFilter) && (payoutFilter === "all" || (merchantPayoutStatuses.get(shipment.id) ?? null) === payoutFilter)), [shipments, statusFilter, pendingChangeRequestFilter, pendingChangeRequestShipmentIds, handoverFilter, payoutFilter, showCompleted, showReturned, showCancelled, completedOnly, isAdmin, isCompletedShipment, dateRange, customDates, courierHandoverStatuses, merchantPayoutStatuses]);
  const [shipmentDialogOpen, setShipmentDialogOpen] = useState(false);
  const [shipmentForm, setShipmentForm] = useState<ShipmentForm>(() => initialShipmentForm(features.default_currency));
  const [showRecipientPayout, setShowRecipientPayout] = useState(false);
  const [newPostDispatchEnabled, setNewPostDispatchEnabled] = useState(false);
  const [newPostOperationId, setNewPostOperationId] = useState<string | null>(null);
  const [newPostDispatchAgentId, setNewPostDispatchAgentId] = useState("");
  const [newPostCourierDeliveryFee, setNewPostCourierDeliveryFee] = useState("");
  const [newPostVehicleId, setNewPostVehicleId] = useState("none");
  const [newPostDispatchNotes, setNewPostDispatchNotes] = useState("");
  const [merchantDialogOpen, setMerchantDialogOpen] = useState(false);
  const [supplierPartnerDialogOpen, setSupplierPartnerDialogOpen] = useState(false);
  const [isSavingSupplierPartner, setIsSavingSupplierPartner] = useState(false);
  const [merchantName, setMerchantName] = useState("");
  const [selectedMerchantPartner, setSelectedMerchantPartner] = useState<BusinessPartner | null>(null);
  const [merchantFee, setMerchantFee] = useState("");
  const [merchantPayoutSchedule, setMerchantPayoutSchedule] = useState<"daily" | "weekly" | "on_request">("daily");
  const [merchantFeePayer, setMerchantFeePayer] = useState<"merchant" | "recipient">("merchant");
  const [editingMerchantProfile, setEditingMerchantProfile] = useState<DeliveryMerchantProfile | null>(null);
  const [merchantEditDialogOpen, setMerchantEditDialogOpen] = useState(false);
  const [merchantDeleteTarget, setMerchantDeleteTarget] = useState<DeliveryMerchantProfile | null>(null);
  const [isDeletingMerchant, setIsDeletingMerchant] = useState(false);
  const [expandedMerchantIds, setExpandedMerchantIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(new Set());
  const [dispatchAgentId, setDispatchAgentId] = useState("");
  const [dispatchCourierDeliveryFee, setDispatchCourierDeliveryFee] = useState("");
  const [dispatchVehicleId, setDispatchVehicleId] = useState("none");
  const [dispatchNotes, setDispatchNotes] = useState("");
  const [transferTarget, setTransferTarget] = useState<DeliveryShipment | null>(null);
  const [transferAgentId, setTransferAgentId] = useState("");
  const [transferCourierDeliveryFee, setTransferCourierDeliveryFee] = useState("");
  const [transferVehicleId, setTransferVehicleId] = useState("none");
  const [transferNotes, setTransferNotes] = useState("");
  const [isTransferring, setIsTransferring] = useState(false);
  const [returnReceiptTarget, setReturnReceiptTarget] = useState<DeliveryShipment | null>(null);
  const [returnReceiptNote, setReturnReceiptNote] = useState("");
  const [isReceivingReturn, setIsReceivingReturn] = useState(false);
  const [editRedispatchTarget, setEditRedispatchTarget] = useState<DeliveryShipment | null>(null);
  const [editRedispatchForm, setEditRedispatchForm] = useState<ShipmentForm>(() => initialShipmentForm(features.default_currency));
  const [showEditRecipientPayout, setShowEditRecipientPayout] = useState(false);
  const [editReceivedDispatchEnabled, setEditReceivedDispatchEnabled] = useState(false);
  const [editRedispatchOperationId, setEditRedispatchOperationId] = useState<string | null>(null);
  const [editRedispatchAgentId, setEditRedispatchAgentId] = useState("");
  const [editRedispatchCourierDeliveryFee, setEditRedispatchCourierDeliveryFee] = useState("");
  const [editRedispatchVehicleId, setEditRedispatchVehicleId] = useState("none");
  const [editRedispatchNotes, setEditRedispatchNotes] = useState("");
  const [statusTarget, setStatusTarget] = useState<DeliveryShipment | null>(null);
  const [nextStatus, setNextStatus] = useState<"delivered" | "postponed" | "returned">("delivered");
  const [statusNote, setStatusNote] = useState("");
  const [recipientPayoutMethod, setRecipientPayoutMethod] = useState<StandardPaymentMethod>("cash");
  const [recipientPayoutAccount, setRecipientPayoutAccount] = useState<PaymentAccount | null>(null);
  const [codAdjustmentRequestTarget, setCodAdjustmentRequestTarget] = useState<DeliveryShipment | null>(null);
  const [requestedCodAmount, setRequestedCodAmount] = useState("");
  const [codAdjustmentReason, setCodAdjustmentReason] = useState("");
  const [isRequestingCodAdjustment, setIsRequestingCodAdjustment] = useState(false);
  const [codAdjustmentReviewTarget, setCodAdjustmentReviewTarget] = useState<DeliveryShipmentCodAdjustmentRequest | null>(null);
  const [approvedCodAmount, setApprovedCodAmount] = useState("");
  const [codAdjustmentReviewNote, setCodAdjustmentReviewNote] = useState("");
  const [isReviewingCodAdjustment, setIsReviewingCodAdjustment] = useState(false);
  const [deliveredCodCorrectionTarget, setDeliveredCodCorrectionTarget] = useState<DeliveryShipment | null>(null);
  const [correctedDeliveredCodAmount, setCorrectedDeliveredCodAmount] = useState("");
  const [deliveredCodCorrectionOperationId, setDeliveredCodCorrectionOperationId] = useState("");
  const [isCorrectingDeliveredCod, setIsCorrectingDeliveredCod] = useState(false);
  const [deliveredRecipientPayoutCorrectionTarget, setDeliveredRecipientPayoutCorrectionTarget] = useState<DeliveryShipment | null>(null);
  const [correctedDeliveredRecipientPayoutAmount, setCorrectedDeliveredRecipientPayoutAmount] = useState("");
  const [deliveredRecipientPayoutCorrectionOperationId, setDeliveredRecipientPayoutCorrectionOperationId] = useState("");
  const [isCorrectingDeliveredRecipientPayout, setIsCorrectingDeliveredRecipientPayout] = useState(false);
  const [recipientPayoutAdjustmentRequestTarget, setRecipientPayoutAdjustmentRequestTarget] = useState<DeliveryShipment | null>(null);
  const [requestedRecipientPayoutAmount, setRequestedRecipientPayoutAmount] = useState("");
  const [recipientPayoutAdjustmentReason, setRecipientPayoutAdjustmentReason] = useState("");
  const [isRequestingRecipientPayoutAdjustment, setIsRequestingRecipientPayoutAdjustment] = useState(false);
  const [recipientPayoutAdjustmentReviewTarget, setRecipientPayoutAdjustmentReviewTarget] = useState<DeliveryShipmentRecipientPayoutAdjustmentRequest | null>(null);
  const [approvedRecipientPayoutAmount, setApprovedRecipientPayoutAmount] = useState("");
  const [recipientPayoutAdjustmentReviewNote, setRecipientPayoutAdjustmentReviewNote] = useState("");
  const [isReviewingRecipientPayoutAdjustment, setIsReviewingRecipientPayoutAdjustment] = useState(false);
  const [recipientPayoutAdjustmentRowOperation, setRecipientPayoutAdjustmentRowOperation] = useState<RecipientPayoutAdjustmentRowOperation | null>(null);
  const [voicePlaybackEvent, setVoicePlaybackEvent] = useState<DeliveryShipmentEvent | null>(null);
  const [settlementTarget, setSettlementTarget] = useState<SettlementTarget | null>(null);
  const [settlementAmount, setSettlementAmount] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<WorkspacePaymentMethod>("cash");
  const [settlementAccount, setSettlementAccount] = useState<PaymentAccount | null>(null);
  const [settlementNote, setSettlementNote] = useState("");
  const [postSettlementTarget, setPostSettlementTarget] = useState<DeliveryShipment | null>(null);
  const [postSettlementDraft, setPostSettlementDraft] = useState<PostSettlementDraft>({
    courierAmount: "", courierMethod: "cash", courierNote: "", courierAccount: null,
    merchantAmount: "", merchantMethod: "cash", merchantNote: "", merchantAccount: null,
  });
  const [submittingPostSettlement, setSubmittingPostSettlement] = useState<"courier" | "merchant" | null>(null);
  const [settlementNetTarget, setSettlementNetTarget] = useState<DeliveryShipment | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const recipientPayoutAdjustmentBusyShipmentIds = useMemo(
    () => recipientPayoutAdjustmentRowOperation
      ? new Set([recipientPayoutAdjustmentRowOperation.shipmentId])
      : new Set<string>(),
    [recipientPayoutAdjustmentRowOperation],
  );
  useEffect(() => {
    if (!recipientPayoutAdjustmentRowOperation) return;
    const completed = recipientPayoutAdjustmentRowOperation.kind === "request"
      ? recipientPayoutAdjustmentRequests.some((request) => request.shipmentId === recipientPayoutAdjustmentRowOperation.shipmentId && request.status === "pending")
      : recipientPayoutAdjustmentRequests.some((request) => request.id === recipientPayoutAdjustmentRowOperation.requestId && request.status !== "pending");
    if (completed) setRecipientPayoutAdjustmentRowOperation(null);
  }, [recipientPayoutAdjustmentRequests, recipientPayoutAdjustmentRowOperation]);
  const partnerById = useMemo(() => new Map(partners.map((partner) => [partner.id, partner])), [partners]);
  const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, partnerById.get(agent.businessPartnerId)?.partnerName ?? t("postService.unknownCourier")])), [agents, partnerById, t]);
  const profileById = useMemo(() => new Map(merchantProfiles.map((profile) => [profile.id, profile])), [merchantProfiles]);
  const profileNameById = useMemo(() => new Map(merchantProfiles.map((profile) => [profile.id, partnerById.get(profile.businessPartnerId)?.partnerName ?? t("postService.unknownMerchant")])), [merchantProfiles, partnerById, t]);
  const partyPosts = useMemo(() => {
    if (!partyPostsDialogTarget) return [];

    return shipments
      .filter((shipment) => {
        const belongsToParty = partyPostsDialogTarget.kind === "merchant"
          ? shipment.merchantProfileId === partyPostsDialogTarget.id
          : shipment.assignedAgentId === partyPostsDialogTarget.id;
        const matchesSelectedTab = partyPostsTab === "done"
          ? isDoneShipment(shipment)
          : !isDoneShipment(shipment);

        return belongsToParty
          && matchesSelectedTab
          && isDateInDateRange(shipment.createdAt, partyPostsDateRange, partyPostsCustomDates);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [isDoneShipment, partyPostsCustomDates, partyPostsDateRange, partyPostsDialogTarget, partyPostsTab, shipments]);
  const partyPostStatusGroups = useMemo(() => {
    const shipmentsByStatus = new Map<DeliveryShipmentStatus, DeliveryShipment[]>();
    for (const shipment of partyPosts) {
      const statusShipments = shipmentsByStatus.get(shipment.status) ?? [];
      statusShipments.push(shipment);
      shipmentsByStatus.set(shipment.status, statusShipments);
    }

    return ADMIN_STATUS_CARD_STATUSES
      .map((status) => ({ status, shipments: shipmentsByStatus.get(status) ?? [] }))
      .filter(({ shipments: statusShipments }) => statusShipments.length > 0);
  }, [partyPosts]);
  const togglePartyPostStatus = useCallback((status: DeliveryShipmentStatus) => {
    setExpandedPartyPostStatus((current) => current === status ? null : status);
  }, []);
  const merchantPayablesByProfile = useMemo(() => {
    const result = new Map<string, Array<{ currency: CurrencyCode; amount: number }>>();
    for (const balance of merchantBalances) {
      if (balance.amount <= 0.000001) continue;
      const payables = result.get(balance.id) ?? [];
      payables.push({ currency: balance.currency, amount: balance.amount });
      result.set(balance.id, payables);
    }
    for (const payables of result.values()) {
      payables.sort((left, right) => left.currency.localeCompare(right.currency));
    }
    return result;
  }, [merchantBalances]);
  const merchantAccountBalancesByProfile = useMemo(() => {
    const result = new Map<string, Array<{ currency: CurrencyCode; amount: number }>>();
    for (const balance of merchantAccountBalances) {
      const balances = result.get(balance.id) ?? [];
      balances.push({ currency: balance.currency, amount: balance.amount });
      result.set(balance.id, balances);
    }
    for (const balances of result.values()) {
      balances.sort((left, right) => left.currency.localeCompare(right.currency));
    }
    return result;
  }, [merchantAccountBalances]);
  const merchantRepaymentsByProfile = useMemo(() => {
    const result = new Map<string, Array<{ currency: CurrencyCode; amount: number }>>();
    for (const [partyKey, amount] of merchantRepaymentOutstandingByParty(ledgerEntries)) {
      const separatorIndex = partyKey.lastIndexOf(":");
      if (separatorIndex < 1) continue;
      const profileId = partyKey.slice(0, separatorIndex);
      const currency = partyKey.slice(separatorIndex + 1) as CurrencyCode;
      const repayments = result.get(profileId) ?? [];
      repayments.push({ currency, amount });
      result.set(profileId, repayments);
    }
    for (const repayments of result.values()) {
      repayments.sort((left, right) => left.currency.localeCompare(right.currency));
    }
    return result;
  }, [ledgerEntries]);
  const merchantRepaymentAmountByShipment = useMemo(() => merchantRepaymentOutstandingByShipment(ledgerEntries), [ledgerEntries]);
  const courierReimbursementAmountByShipment = useMemo(() => courierReimbursementOutstandingByShipment(ledgerEntries), [ledgerEntries]);
  const courierReimbursementsPaidByShipment = useMemo(() => courierReimbursementPaidByShipment(ledgerEntries), [ledgerEntries]);
  const shipmentLabelById = useMemo(() => new Map(shipments.map((shipment) => [shipment.id, `${shipment.trackingNumber} · ${shipment.recipientPhone}`])), [shipments]);
  const courierBreakdownByParty = useMemo(() => courierSettlementBreakdownByParty(ledgerEntries), [ledgerEntries]);
  const merchantBreakdownByParty = useMemo(() => merchantSettlementBreakdownByParty(ledgerEntries), [ledgerEntries]);
  const merchantAccountBreakdownByParty = useMemo(() => merchantAccountSettlementBreakdownByParty(ledgerEntries), [ledgerEntries]);
  const merchantSettlementPostsByProfile = useMemo(() => {
    const result = new Map<string, Array<MerchantAccountSettlementBreakdown & { currency: CurrencyCode }>>();
    for (const [partyKey, posts] of merchantAccountBreakdownByParty) {
      const separatorIndex = partyKey.lastIndexOf(":");
      if (separatorIndex < 1) continue;
      const profileId = partyKey.slice(0, separatorIndex);
      const currency = partyKey.slice(separatorIndex + 1) as CurrencyCode;
      result.set(profileId, [
        ...(result.get(profileId) ?? []),
        ...posts.map((post) => ({ ...post, currency })),
      ]);
    }
    return result;
  }, [merchantAccountBreakdownByParty]);
  const perShipmentSettlementNet = useMemo(
    () => settlementNetByShipment(courierBreakdownByParty, merchantBreakdownByParty, merchantAccountBreakdownByParty, courierReimbursementsPaidByShipment),
    [courierBreakdownByParty, merchantBreakdownByParty, merchantAccountBreakdownByParty, courierReimbursementsPaidByShipment],
  );
  const voiceReasonEventByShipment = useMemo(() => {
    const results = new Map<string, DeliveryShipmentEvent>();
    const shipmentById = new Map(shipments.map((shipment) => [shipment.id, shipment]));
    for (const event of shipmentEvents) {
      const shipment = shipmentById.get(event.shipmentId);
      if (
        shipment?.status === event.status
        && (event.status === "postponed" || event.status === "returned")
        && event.voiceReasonPath
        && !results.has(event.shipmentId)
      ) {
        results.set(event.shipmentId, event);
      }
    }
    return results;
  }, [shipmentEvents, shipments]);
  const [searchQuery, setSearchQuery] = useState("");
  const searchedShipments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return visibleShipments;
    return visibleShipments.filter((shipment) => {
      const merchantName = profileNameById.get(shipment.merchantProfileId)?.toLowerCase() ?? "";
      const courierName = shipment.assignedAgentId ? (agentNameById.get(shipment.assignedAgentId)?.toLowerCase() ?? "") : "";
      return [shipment.trackingNumber.toLowerCase(), shipment.recipientPhone.toLowerCase(), shipment.recipientAddress.toLowerCase(), merchantName, courierName].some((value) => value.includes(query));
    });
  }, [visibleShipments, searchQuery, profileNameById, agentNameById]);
  const [merchantSearchQuery, setMerchantSearchQuery] = useState("");
  const searchedMerchants = useMemo(() => {
    const query = merchantSearchQuery.trim().toLowerCase();
    if (!query) return merchantProfiles;
    return merchantProfiles.filter((profile) => (profileNameById.get(profile.id) ?? "").toLowerCase().includes(query));
  }, [merchantProfiles, merchantSearchQuery, profileNameById]);
  const courierAgents = useMemo(() => agents.filter((agent) => agent.agentType === "courier"), [agents]);
  // A courier may retain their fee from collected cash. A recipient payout
  // advanced from the courier's own money also makes their signed account
  // negative, which the workspace must reimburse as a real payment later.
  const courierPayables = useMemo<CourierPayable[]>(() => {
    const amountsByPost = new Map<string, CourierPayable>();
    for (const entry of ledgerEntries) {
      if (!entry.agentId || !entry.shipmentId || entry.isDeleted) continue;
      if (![
        "courier_collection",
        "courier_cod_correction",
        "courier_delivery_fee",
        "courier_recipient_advance",
        "courier_remittance",
        "courier_fee_payout",
        "courier_reimbursement",
      ].includes(entry.kind)) continue;
      const key = `${entry.agentId}:${entry.currency}:${entry.shipmentId}`;
      const payable = amountsByPost.get(key) ?? {
        agentId: entry.agentId,
        currency: entry.currency,
        shipmentId: entry.shipmentId,
        amount: 0,
      };
      payable.amount += Number(entry.amount || 0);
      amountsByPost.set(key, payable);
    }
    return [...amountsByPost.values()]
      .filter((payable) => payable.amount < -0.000001)
      .map((payable) => ({ ...payable, amount: Math.abs(payable.amount) }))
      .sort((left, right) => left.currency.localeCompare(right.currency) || left.shipmentId.localeCompare(right.shipmentId));
  }, [ledgerEntries]);
  const courierPayablesByAgent = useMemo(() => {
    const results = new Map<string, CourierPayable[]>();
    for (const payable of courierPayables) {
      const payables = results.get(payable.agentId) ?? [];
      payables.push(payable);
      results.set(payable.agentId, payables);
    }
    return results;
  }, [courierPayables]);
  const courierReimbursementsByAgent = useMemo(() => {
    const results = new Map<string, CourierReimbursement[]>();
    for (const [partyKey, amount] of courierReimbursementOutstandingByParty(ledgerEntries)) {
      const separatorIndex = partyKey.lastIndexOf(":");
      if (separatorIndex < 1) continue;
      const agentId = partyKey.slice(0, separatorIndex);
      const currency = partyKey.slice(separatorIndex + 1) as CurrencyCode;
      const reimbursements = results.get(agentId) ?? [];
      reimbursements.push({ agentId, currency, amount });
      results.set(agentId, reimbursements);
    }
    for (const reimbursements of results.values()) {
      reimbursements.sort((left, right) => left.currency.localeCompare(right.currency));
    }
    return results;
  }, [ledgerEntries]);
  const courierRows = useMemo<CourierRow[]>(() => courierAgents.map((agent) => {
    const balances = courierBalances
      .filter((balance) => balance.id === agent.id && balance.amount > 0.000001)
      .map((balance) => ({ currency: balance.currency, amount: balance.amount }))
      .sort((left, right) => left.currency.localeCompare(right.currency));
    return {
      agent,
      name: agentNameById.get(agent.id) ?? t("postService.unknownCourier"),
      phone: partnerById.get(agent.businessPartnerId)?.phone ?? null,
      balances,
      payables: courierPayablesByAgent.get(agent.id) ?? [],
      reimbursements: courierReimbursementsByAgent.get(agent.id) ?? [],
    };
  }), [courierAgents, courierBalances, courierPayablesByAgent, courierReimbursementsByAgent, agentNameById, partnerById, t]);
  const [courierSearchQuery, setCourierSearchQuery] = useState("");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [editingAgentPartner, setEditingAgentPartner] = useState<BusinessPartner | null>(null);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const searchedCouriers = useMemo(() => {
    const query = courierSearchQuery.trim().toLowerCase();
    if (!query) return courierRows;
    return courierRows.filter((row) => [row.name.toLowerCase(), row.agent.zone.toLowerCase(), (row.phone ?? "").toLowerCase()].some((value) => value.includes(query)));
  }, [courierRows, courierSearchQuery]);
  // Footer aggregates mirror the Post settlement net dialog: gross courier cash
  // handover (net remitted + retained fee) for posts with a recorded handover,
  // the retained courier delivery fees, FIFO-paid merchant payouts, and
  // merchant repayments received by the workspace.
  const postsFooterTotals = useMemo(() => {
    const totals = new Map<CurrencyCode, { collected: number; courierFees: number; merchantPayouts: number; merchantRepayments: number }>();
    for (const shipment of searchedShipments) {
      const current = totals.get(shipment.currency) ?? { collected: 0, courierFees: 0, merchantPayouts: 0, merchantRepayments: 0 };
      const net = perShipmentSettlementNet.get(shipment.id);
      if (net?.hasCourierHandover) {
        const courierFee = shipment.courierDeliveryFee ?? 0;
        current.collected += net.courierHandover + courierFee;
        current.courierFees += courierFee;
      }
      current.merchantPayouts += Math.max(0, net?.merchantPayout ?? 0);
      current.merchantRepayments += Math.max(0, net?.merchantRepayment ?? 0);
      totals.set(shipment.currency, current);
    }
    return totals;
  }, [searchedShipments, perShipmentSettlementNet]);
  const postsFooterSegments = useMemo(() => {
    const currencies = [...postsFooterTotals.keys()].sort((left, right) => left.localeCompare(right));
    const formatTotal = (pick: (row: { collected: number; courierFees: number; merchantPayouts: number; merchantRepayments: number }) => number) =>
      (currencies.length === 0 ? [features.default_currency] : currencies)
        .map((currency) => formatCurrency(pick(postsFooterTotals.get(currency) ?? { collected: 0, courierFees: 0, merchantPayouts: 0, merchantRepayments: 0 }), currency, features.iqd_display_preference))
        .join(" + ");
    let profitSum = 0;
    for (const row of postsFooterTotals.values()) profitSum += row.collected + row.merchantRepayments - row.courierFees - row.merchantPayouts;
    return [
      { label: t("postService.dialogs.settlementNet.cashHandover"), value: formatTotal((row) => row.collected), tone: "positive" as const },
      { label: t("postService.messages.merchantRepaymentRecorded"), value: formatTotal((row) => row.merchantRepayments), tone: "positive" as const },
      { label: t("postService.form.courierDeliveryFee"), value: formatTotal((row) => row.courierFees), tone: "negative" as const },
      { label: t("postService.dialogs.settlementNet.merchantPayout"), value: formatTotal((row) => row.merchantPayouts), tone: "negative" as const },
      { label: t("postService.dialogs.settlementNet.profit"), value: formatTotal((row) => row.collected + row.merchantRepayments - row.courierFees - row.merchantPayouts), tone: profitSum >= -0.000001 ? ("positive" as const) : ("negative" as const), emphasized: true },
    ];
  }, [postsFooterTotals, t, features.default_currency, features.iqd_display_preference]);
  const postsTotalsFooter = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {postsFooterSegments.map((segment, index) => (
        <Fragment key={segment.label}>
          {index > 0 ? <span aria-hidden className="mx-1 h-4 w-px bg-border" /> : null}
          <span className="whitespace-nowrap text-muted-foreground">{segment.label}:</span>
          <span className={cn("whitespace-nowrap font-semibold tabular-nums", segment.emphasized && "text-base", segment.tone === "positive" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")}>{segment.value}</span>
        </Fragment>
      ))}
    </div>
  );
  const linkedCourier = agents.find((agent) => agent.linkedUserId === user?.id && agent.status === "active" && agent.agentType === "courier");
  const staffCourierObligationMetrics = useMemo(() => {
    const obligations = summarizeStaffCourierObligationMetrics(linkedCourier?.id, courierBalances, courierPayables);
    const formatTotal = (amounts: Array<{ currency: CurrencyCode; amount: number }>) => (
      amounts.length > 0
        ? amounts.map(({ currency, amount }) => formatCurrency(amount, currency, features.iqd_display_preference)).join(" + ")
        : formatCurrency(0, features.default_currency, features.iqd_display_preference)
    );
    return [
      { id: "i-owe-workspace", title: t("postService.cards.iOweWorkspace"), value: formatTotal(obligations.outstandingCash), icon: WalletCards, tone: "sky" as const },
      { id: "workspace-owes-me", title: t("postService.cards.workspaceOwesMe"), value: formatTotal(obligations.courierPayable), icon: HandCoins, tone: "rose" as const },
    ];
  }, [courierBalances, courierPayables, features.default_currency, features.iqd_display_preference, linkedCourier?.id, t]);
  const assignableShipments = shipments.filter((shipment) => ["received", "postponed"].includes(shipment.status));
  const postStatusMetrics = useMemo(() => {
    const counts = new Map<DeliveryShipmentStatus, number>();
    for (const shipment of shipments) {
      if (shipment.status === "returned" && shipment.returnReceivedAt) continue;
      if (shipment.status === "delivered" && isCompletedShipment(shipment)) continue;
      counts.set(shipment.status, (counts.get(shipment.status) ?? 0) + 1);
    }
    const statuses = isAdmin ? ADMIN_STATUS_CARD_STATUSES : STAFF_STATUS_CARD_STATUSES;
    return statuses.map((status) => ({ status, value: counts.get(status) ?? 0 }));
  }, [isAdmin, isCompletedShipment, shipments]);
  const returnHistoryCount = useMemo(() => shipments.filter((shipment) => shipment.status === "returned" && Boolean(shipment.returnReceivedAt)).length, [shipments]);
  const completedPostCount = useMemo(() => shipments.filter(isCompletedShipment).length, [isCompletedShipment, shipments]);
  const pendingChangeRequestCount = pendingChangeRequestShipmentIds.size;
  const deliveryBalanceMetrics = useMemo(() => {
    const merchantTotals = summarizeDeliveryBalanceMetrics(merchantAccountBalances, []);
    const outstandingCourierCash = summarizeCourierOutstandingCash(courierBalances);
    const courierPayablesTotal = summarizeCourierPayables(courierPayables);
    const formatTotal = (amounts: Array<{ currency: CurrencyCode; amount: number }>) => (
      amounts.length > 0
        ? amounts.map(({ currency, amount }) => formatCurrency(amount, currency, features.iqd_display_preference)).join(" + ")
        : formatCurrency(0, features.default_currency, features.iqd_display_preference)
    );
    return [
      { id: "we-owe-merchants", title: t("postService.cards.weOweMerchants"), value: formatTotal(merchantTotals.weOweMerchants), icon: Store, tone: "amber" as const },
      { id: "merchants-owe-us", title: t("postService.cards.merchantsOweUs"), value: formatTotal(merchantTotals.merchantsOweUs), icon: HandCoins, tone: "emerald" as const },
      { id: "couriers-owe-us", title: t("postService.cards.couriersOweUs"), value: formatTotal(outstandingCourierCash), icon: WalletCards, tone: "sky" as const },
      { id: "we-owe-couriers", title: t("postService.cards.weOweCouriers"), value: formatTotal(courierPayablesTotal), icon: CircleDollarSign, tone: "rose" as const },
    ];
  }, [courierBalances, courierPayables, features.default_currency, features.iqd_display_preference, merchantAccountBalances, t]);
  const selectedCount = selectedShipmentIds.size;
  const enabledMerchantPartnerIds = useMemo(() => merchantProfiles.map((profile) => profile.businessPartnerId), [merchantProfiles]);
  const settlementNetSummary = settlementNetTarget ? perShipmentSettlementNet.get(settlementNetTarget.id) : undefined;
  // Courier remittances are stored net of the courier's agreed fee. Display the
  // gross collection and the retained fee separately so the calculation stays
  // transparent without changing the cash amount that was actually handed over.
  const settlementNetCourierFee = settlementNetSummary?.hasCourierHandover
    ? settlementNetTarget?.courierDeliveryFee ?? 0
    : 0;
  const settlementNetCourierAdvance = settlementNetSummary?.hasCourierHandover && settlementNetTarget?.recipientPayoutFunding === "courier_advance"
    ? settlementNetTarget.recipientPayoutAmount
    : 0;
  const settlementNetWorkspaceRecipientPayout = settlementNetSummary?.hasCourierHandover && (settlementNetTarget?.recipientPayoutFunding ?? "workspace_payment") === "workspace_payment"
    ? settlementNetTarget?.recipientPayoutAmount ?? 0
    : 0;
  const settlementNetGrossCourierHandover = (settlementNetSummary?.courierHandover ?? 0) + settlementNetCourierFee + settlementNetCourierAdvance;
  const settlementNetAmount = settlementNetSummary
    ? shipmentSettlementNetAmount(settlementNetSummary, settlementNetWorkspaceRecipientPayout)
    : 0;
  const settlementNetIsProvisional = settlementNetSummary && settlementNetTarget
    ? !isShipmentSettlementNetFinalized(settlementNetTarget, settlementNetSummary)
    : false;
  const postSettlementCourier = postSettlementTarget?.assignedAgentId
    ? courierBreakdownByParty.get(`${postSettlementTarget.assignedAgentId}:${postSettlementTarget.currency}`)?.find((post) => post.shipmentId === postSettlementTarget.id)
    : undefined;
  const postSettlementMerchant = postSettlementTarget
    ? merchantBreakdownByParty.get(`${postSettlementTarget.merchantProfileId}:${postSettlementTarget.currency}`)?.find((post) => post.shipmentId === postSettlementTarget.id)
    : undefined;
  const isPrepaidPostSettlement = postSettlementTarget?.customerPaymentStatus === "prepaid_electronically";
  const postSettlementCourierOutstanding = isPrepaidPostSettlement && postSettlementTarget
    ? courierReimbursementAmountByShipment.get(postSettlementTarget.id) ?? 0
    : postSettlementCourier?.outstanding ?? 0;
  const postSettlementMerchantOutstanding = isPrepaidPostSettlement && postSettlementTarget
    ? merchantRepaymentAmountByShipment.get(postSettlementTarget.id) ?? 0
    : postSettlementMerchant?.outstanding ?? 0;
  const postSettlementNet = postSettlementTarget ? perShipmentSettlementNet.get(postSettlementTarget.id) : undefined;
  const postSettlementCourierFee = postSettlementNet?.hasCourierHandover
    ? postSettlementTarget?.courierDeliveryFee ?? 0
    : 0;
  const postSettlementCourierAdvance = postSettlementNet?.hasCourierHandover && postSettlementTarget?.recipientPayoutFunding === "courier_advance"
    ? postSettlementTarget.recipientPayoutAmount
    : 0;
  const postSettlementWorkspaceRecipientPayout = postSettlementNet?.hasCourierHandover && (postSettlementTarget?.recipientPayoutFunding ?? "workspace_payment") === "workspace_payment"
    ? postSettlementTarget?.recipientPayoutAmount ?? 0
    : 0;
  const postSettlementGrossCourierHandover = (postSettlementNet?.courierHandover ?? 0) + postSettlementCourierFee + postSettlementCourierAdvance;
  const postSettlementNetAmount = postSettlementNet
    ? shipmentSettlementNetAmount(postSettlementNet, postSettlementWorkspaceRecipientPayout)
    : 0;
  const postSettlementCourierAmount = numericValue(postSettlementDraft.courierAmount);
  const postSettlementMerchantAmount = numericValue(postSettlementDraft.merchantAmount);
  const isPostSettlementCourierAmountValid = postSettlementCourierAmount > 0
    && (Math.abs(postSettlementCourierAmount - postSettlementCourierOutstanding) <= 0.000001 || Boolean(postSettlementDraft.courierNote.trim()));
  const isPostSettlementMerchantAmountValid = postSettlementMerchantAmount > 0
    && (Math.abs(postSettlementMerchantAmount - postSettlementMerchantOutstanding) <= 0.000001 || Boolean(postSettlementDraft.merchantNote.trim()));
  const isCodAdjustmentRequestValid = Boolean(
    codAdjustmentRequestTarget
    && numericValue(requestedCodAmount) > 0
    && Math.abs(numericValue(requestedCodAmount) - codAdjustmentRequestTarget.codAmount) > 0.000001,
  );
  const approvedCodAmountValue = numericValue(approvedCodAmount);
  const isCodAdjustmentApprovalValid = Boolean(
    codAdjustmentReviewTarget
    && approvedCodAmountValue > 0
  );
  const isCodAdjustmentRejectionValid = Boolean(codAdjustmentReviewTarget);
  const hasCorrectedDeliveredCodAmount = correctedDeliveredCodAmount.trim() !== "";
  const isDeliveredCodCorrectionValid = Boolean(
    deliveredCodCorrectionTarget
    && hasCorrectedDeliveredCodAmount
    && numericValue(correctedDeliveredCodAmount) > 0
    && Math.abs(numericValue(correctedDeliveredCodAmount) - deliveredCodCorrectionTarget.codAmount) > 0.000001,
  );
  const currentDeliveredRecipientPayoutAmount = deliveredRecipientPayoutCorrectionTarget
    ? deliveredRecipientPayoutCorrectionTarget.recipientPayoutAmount ?? 0
    : 0;
  const hasCorrectedDeliveredRecipientPayoutAmount = correctedDeliveredRecipientPayoutAmount.trim() !== "";
  const isDeliveredRecipientPayoutCorrectionValid = Boolean(
    deliveredRecipientPayoutCorrectionTarget
    && hasCorrectedDeliveredRecipientPayoutAmount
    && numericValue(correctedDeliveredRecipientPayoutAmount) >= 0
    && Math.abs(numericValue(correctedDeliveredRecipientPayoutAmount) - currentDeliveredRecipientPayoutAmount) > 0.000001,
  );
  const hasRequestedRecipientPayoutAmount = requestedRecipientPayoutAmount.trim() !== "";
  const isRecipientPayoutAdjustmentRequestValid = Boolean(
    recipientPayoutAdjustmentRequestTarget
    && hasRequestedRecipientPayoutAmount
    && numericValue(requestedRecipientPayoutAmount) >= 0
    && Math.abs(numericValue(requestedRecipientPayoutAmount) - (recipientPayoutAdjustmentRequestTarget.recipientPayoutAmount ?? 0)) > 0.000001,
  );
  const hasApprovedRecipientPayoutAmount = approvedRecipientPayoutAmount.trim() !== "";
  const isRecipientPayoutAdjustmentApprovalValid = Boolean(
    recipientPayoutAdjustmentReviewTarget
    && hasApprovedRecipientPayoutAmount
    && numericValue(approvedRecipientPayoutAmount) >= 0,
  );
  const isRecipientPayoutAdjustmentRejectionValid = Boolean(recipientPayoutAdjustmentReviewTarget);

  const handleTabChange = useCallback((value: string) => {
    const tab = isAdmin ? value as PostServiceTab : "posts";
    setActiveTab(tab);
    if (workspaceId) {
      void refreshPostServiceTab(workspaceId, tab).catch((error) =>
        console.error(`[Post Service] Failed to refresh ${tab}:`, error),
      );
    }
  }, [isAdmin, workspaceId]);

  const handlePostStatusMetricClick = useCallback((status: DeliveryShipmentStatus) => {
    setPendingChangeRequestFilter(false);
    setCompletedOnly(false);
    setShowCompleted(false);
    setShowReturned(false);
    setShowCancelled(false);
    setStatusFilter((current) => current === status ? "all" : status);
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [handleTabChange]);

  const handleReturnedPostMetricClick = useCallback(() => {
    const nextReturnedOnly = statusFilter !== "returned";
    setPendingChangeRequestFilter(false);
    setCompletedOnly(false);
    setShowCompleted(false);
    setShowCancelled(false);
    setShowReturned(nextReturnedOnly);
    setStatusFilter(nextReturnedOnly ? "returned" : "all");
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [handleTabChange, statusFilter]);

  const handleReturnHistoryMetricClick = useCallback(() => {
    const nextReturnHistoryOnly = statusFilter !== "return_history";
    setPendingChangeRequestFilter(false);
    setCompletedOnly(false);
    setShowCompleted(false);
    setShowReturned(false);
    setShowCancelled(false);
    setStatusFilter(nextReturnHistoryOnly ? "return_history" : "all");
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [handleTabChange, statusFilter]);

  const handleCancelledPostMetricClick = useCallback(() => {
    const nextCancelledOnly = statusFilter !== "cancelled";
    setPendingChangeRequestFilter(false);
    setCompletedOnly(false);
    setShowCompleted(false);
    setShowReturned(false);
    setShowCancelled(nextCancelledOnly);
    setStatusFilter(nextCancelledOnly ? "cancelled" : "all");
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [handleTabChange, statusFilter]);

  const handleCompletedPostMetricClick = useCallback(() => {
    const nextCompletedOnly = !completedOnly;
    setPendingChangeRequestFilter(false);
    setCompletedOnly(nextCompletedOnly);
    setShowCompleted(nextCompletedOnly);
    setShowReturned(false);
    setShowCancelled(false);
    setStatusFilter(nextCompletedOnly ? "delivered" : "all");
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [completedOnly, handleTabChange]);

  const handlePendingChangeRequestMetricClick = useCallback(() => {
    setCompletedOnly(false);
    setShowReturned(false);
    setShowCancelled(false);
    setPendingChangeRequestFilter((current) => !current);
    setStatusFilter("all");
    handleTabChange("posts");
    setPendingPostsStatusShortcut(true);
  }, [handleTabChange]);

  useEffect(() => {
    if (!pendingPostsStatusShortcut || activeTab !== "posts") return;
    const frame = requestAnimationFrame(() => {
      const postsPanel = postsPanelRef.current;
      postsPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      postsPanel?.focus({ preventScroll: true });
      setPendingPostsStatusShortcut(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, pendingPostsStatusShortcut]);

  const isStatusMetricActive = (status: DeliveryShipmentStatus) => (
    (status === "returned" ? isAdmin || showReturned : status === "cancelled" ? showCancelled : true)
    && !pendingChangeRequestFilter
    && !completedOnly
    && statusFilter === status
  );
  const isReturnHistoryMetricActive = !pendingChangeRequestFilter && !completedOnly && statusFilter === "return_history";
  const handleStatusMetricClick = (status: DeliveryShipmentStatus) => {
    if (status === "returned") {
      handleReturnedPostMetricClick();
      return;
    }
    if (status === "cancelled") {
      handleCancelledPostMetricClick();
      return;
    }
    handlePostStatusMetricClick(status);
  };

  function updateShipmentForm<Key extends keyof ShipmentForm>(key: Key, value: ShipmentForm[Key]) {
    setShipmentForm((current) => ({ ...current, [key]: value }));
  }
  const isCodAmountValid = shipmentForm.customerPaymentStatus === "prepaid_electronically"
    || (shipmentForm.codAmount.trim().length > 0 && parseFormattedNumber(shipmentForm.codAmount) > 0);
  const isShipmentFormValid = Boolean(
    shipmentForm.merchantProfileId
    && shipmentForm.recipientPhone.trim()
    && shipmentForm.recipientAddress.trim()
    && isCodAmountValid,
  );
  const isEditRedispatchCodAmountValid = editRedispatchForm.customerPaymentStatus === "prepaid_electronically"
    || (editRedispatchForm.codAmount.trim().length > 0 && parseFormattedNumber(editRedispatchForm.codAmount) > 0);
  const isEditingReceivedPost = editRedispatchTarget?.status === "received";
  const hasPendingCodDetailsForEdit = Boolean(
    editRedispatchTarget && pendingCodAdjustmentByShipment.has(editRedispatchTarget.id),
  );
  const shouldDispatchEditedPost = Boolean(editRedispatchTarget && (editRedispatchTarget.status !== "received" || editReceivedDispatchEnabled));
  const isEditRedispatchFormValid = Boolean(
    editRedispatchForm.merchantProfileId
    && editRedispatchForm.recipientPhone.trim()
    && editRedispatchForm.recipientAddress.trim()
    && (!shouldDispatchEditedPost || editRedispatchAgentId)
    && isEditRedispatchCodAmountValid,
  );
  const isNewPostFormValid = Boolean(isShipmentFormValid && (!newPostDispatchEnabled || newPostDispatchAgentId));
  function resetShipmentForm() {
    setShipmentForm(initialShipmentForm(features.default_currency));
    setShowRecipientPayout(false);
    setNewPostDispatchEnabled(false);
    setNewPostOperationId(null);
    setNewPostDispatchAgentId("");
    setNewPostCourierDeliveryFee("");
    setNewPostVehicleId("none");
    setNewPostDispatchNotes("");
  }
  function closeShipmentFlow(force = false) {
    if (isSubmitting && !force) return;
    setShipmentDialogOpen(false);
    resetShipmentForm();
  }
  function handleNewPostDispatchCourierChange(agentId: string) {
    setNewPostDispatchAgentId(agentId);
    const courier = agents.find((agent) => agent.id === agentId);
    setNewPostCourierDeliveryFee(String(courier?.courierDeliveryFee ?? 0));
  }
  function handleCustomerPaymentStatusChange(value: DeliveryCustomerPaymentStatus) {
    setShipmentForm((current) => ({
      ...current,
      customerPaymentStatus: value,
      codAmount: value === "prepaid_electronically" ? "" : current.codAmount,
      // Avoid submitting a payout the user can no longer see after changing
      // back to a normal cash-on-delivery post.
      recipientPayoutAmount: value === "cash_on_delivery" ? "" : current.recipientPayoutAmount,
    }));
    setShowRecipientPayout(value === "prepaid_electronically");
  }
  function updateEditRedispatchForm<Key extends keyof ShipmentForm>(key: Key, value: ShipmentForm[Key]) {
    setEditRedispatchForm((current) => ({ ...current, [key]: value }));
  }
  function handleEditRedispatchCustomerPaymentStatusChange(value: DeliveryCustomerPaymentStatus) {
    setEditRedispatchForm((current) => ({
      ...current,
      customerPaymentStatus: value,
      codAmount: value === "prepaid_electronically" ? "" : current.codAmount,
      recipientPayoutAmount: value === "cash_on_delivery" ? "" : current.recipientPayoutAmount,
    }));
    setShowEditRecipientPayout(value === "prepaid_electronically");
  }
  function toggleShipment(shipmentId: string, checked: boolean) {
    setSelectedShipmentIds((current) => { const next = new Set(current); if (checked) next.add(shipmentId); else next.delete(shipmentId); return next; });
  }
  function toggleMerchantSettlement(profileId: string) {
    setExpandedMerchantIds((current) => {
      const next = new Set(current);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  }
  function openStatusDialog(shipment: DeliveryShipment, status: "delivered" | "postponed" | "returned") {
    setStatusTarget(shipment);
    setNextStatus(status);
    setStatusNote("");
    setRecipientPayoutMethod("cash");
    setRecipientPayoutAccount(null);
  }
  function openCodAdjustmentRequest(shipment: DeliveryShipment) {
    setCodAdjustmentRequestTarget(shipment);
    setRequestedCodAmount(String(shipment.codAmount));
    setCodAdjustmentReason("");
  }
  function closeCodAdjustmentRequest() {
    if (isRequestingCodAdjustment) return;
    setCodAdjustmentRequestTarget(null);
    setRequestedCodAmount("");
    setCodAdjustmentReason("");
  }
  function openCodAdjustmentReview(request: DeliveryShipmentCodAdjustmentRequest) {
    setCodAdjustmentReviewTarget(request);
    setApprovedCodAmount(String(request.requestedCodAmount));
    setCodAdjustmentReviewNote("");
  }
  function closeCodAdjustmentReview() {
    if (isReviewingCodAdjustment) return;
    setCodAdjustmentReviewTarget(null);
    setApprovedCodAmount("");
    setCodAdjustmentReviewNote("");
  }
  function openDeliveredCodCorrection(shipment: DeliveryShipment) {
    setDeliveredCodCorrectionTarget(shipment);
    setCorrectedDeliveredCodAmount(String(shipment.codAmount));
    setDeliveredCodCorrectionOperationId(generateId());
  }
  function closeDeliveredCodCorrection() {
    if (isCorrectingDeliveredCod) return;
    setDeliveredCodCorrectionTarget(null);
    setCorrectedDeliveredCodAmount("");
    setDeliveredCodCorrectionOperationId("");
  }
  function openDeliveredRecipientPayoutCorrection(shipment: DeliveryShipment) {
    setDeliveredRecipientPayoutCorrectionTarget(shipment);
    setCorrectedDeliveredRecipientPayoutAmount(String(shipment.recipientPayoutAmount ?? 0));
    setDeliveredRecipientPayoutCorrectionOperationId(generateId());
  }
  function closeDeliveredRecipientPayoutCorrection() {
    if (isCorrectingDeliveredRecipientPayout) return;
    setDeliveredRecipientPayoutCorrectionTarget(null);
    setCorrectedDeliveredRecipientPayoutAmount("");
    setDeliveredRecipientPayoutCorrectionOperationId("");
  }
  function openRecipientPayoutAdjustmentRequest(shipment: DeliveryShipment) {
    setRecipientPayoutAdjustmentRequestTarget(shipment);
    setRequestedRecipientPayoutAmount(String(shipment.recipientPayoutAmount ?? 0));
    setRecipientPayoutAdjustmentReason("");
  }
  function closeRecipientPayoutAdjustmentRequest() {
    if (isRequestingRecipientPayoutAdjustment) return;
    setRecipientPayoutAdjustmentRequestTarget(null);
    setRequestedRecipientPayoutAmount("");
    setRecipientPayoutAdjustmentReason("");
  }
  function openRecipientPayoutAdjustmentReview(request: DeliveryShipmentRecipientPayoutAdjustmentRequest) {
    setRecipientPayoutAdjustmentReviewTarget(request);
    setApprovedRecipientPayoutAmount(String(request.requestedRecipientPayoutAmount));
    setRecipientPayoutAdjustmentReviewNote("");
  }
  function closeRecipientPayoutAdjustmentReview() {
    if (isReviewingRecipientPayoutAdjustment) return;
    setRecipientPayoutAdjustmentReviewTarget(null);
    setApprovedRecipientPayoutAmount("");
    setRecipientPayoutAdjustmentReviewNote("");
  }
  function openSettlement(target: SettlementTarget) {
    setSettlementTarget(target); setSettlementAmount(String(target.amount)); setSettlementMethod("cash"); setSettlementAccount(null); setSettlementNote("");
  }
  function openMerchantRepayment(target: Omit<SettlementTarget, "kind">) {
    openSettlement({ ...target, kind: "merchant_repayment" });
  }
  function openCourierReimbursement(payable: CourierPayable) {
    openSettlement({
      kind: "courier_reimbursement",
      id: payable.agentId,
      currency: payable.currency,
      amount: payable.amount,
      name: agentNameById.get(payable.agentId) ?? t("postService.unknownCourier"),
      shipmentId: payable.shipmentId,
      shipmentLabel: shipmentLabelById.get(payable.shipmentId) ?? "",
    });
  }
  function openCollectiveCourierReimbursement(reimbursement: CourierReimbursement) {
    openSettlement({
      kind: "courier_reimbursement",
      id: reimbursement.agentId,
      currency: reimbursement.currency,
      amount: reimbursement.amount,
      name: agentNameById.get(reimbursement.agentId) ?? t("postService.unknownCourier"),
    });
  }
  function openPostSettlement(balance: { kind: "courier" | "merchant"; id: string; currency: CurrencyCode; name: string }, post: ShipmentSettlementBreakdown) {
    setSettlementTarget({ kind: balance.kind, id: balance.id, currency: balance.currency, amount: post.outstanding, name: balance.name, shipmentId: post.shipmentId, shipmentLabel: shipmentLabelById.get(post.shipmentId) ?? "" });
    setSettlementAmount(String(post.outstanding));
    setSettlementMethod("cash");
    setSettlementAccount(null);
    setSettlementNote("");
  }
  function openAddCourier() {
    setEditingAgentPartner(null);
    setAgentDialogOpen(true);
  }
  function openEditCourier(courier: CourierRow) {
    const partner = partnerById.get(courier.agent.businessPartnerId) ?? null;
    setEditingAgentPartner(partner);
    setAgentDialogOpen(true);
  }
  async function handleAgentSubmit(payload: BusinessPartnerFormPayload) {
    if (!workspaceId) return;
    setIsSavingAgent(true);
    try {
      const agentPayload = { ...payload, role: "agent" as const };
      if (editingAgentPartner) {
        await updateBusinessPartner(editingAgentPartner.id, agentPayload, { allowAgentRole: true });
        toast({ title: t("postService.messages.courierUpdated") });
      } else {
        await createBusinessPartner(workspaceId, agentPayload, { allowAgentRole: true });
        toast({ title: t("postService.messages.courierAdded") });
      }
      setAgentDialogOpen(false);
      setEditingAgentPartner(null);
    } catch (error) {
      toast({ title: t("postService.messages.courierSaveFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsSavingAgent(false);
    }
  }
  function openPostSettlementDialog(shipment: DeliveryShipment) {
    const isPrepaidElectronically = shipment.customerPaymentStatus === "prepaid_electronically";
    const courierOutstanding = isPrepaidElectronically
      ? courierReimbursementAmountByShipment.get(shipment.id) ?? 0
      : shipment.assignedAgentId
        ? courierBreakdownByParty.get(`${shipment.assignedAgentId}:${shipment.currency}`)?.find((post) => post.shipmentId === shipment.id)?.outstanding ?? 0
        : 0;
    const merchantOutstanding = isPrepaidElectronically
      ? merchantRepaymentAmountByShipment.get(shipment.id) ?? 0
      : merchantBreakdownByParty.get(`${shipment.merchantProfileId}:${shipment.currency}`)?.find((post) => post.shipmentId === shipment.id)?.outstanding ?? 0;
    setPostSettlementTarget(shipment);
    setPostSettlementDraft({
      courierAmount: courierOutstanding > 0 ? String(courierOutstanding) : "",
      courierMethod: "cash",
      courierNote: "",
      courierAccount: null,
      merchantAmount: merchantOutstanding > 0 ? String(merchantOutstanding) : "",
      merchantMethod: "cash",
      merchantNote: "",
      merchantAccount: null,
    });
  }
  function handleDispatchCourierChange(agentId: string) {
    setDispatchAgentId(agentId);
    const courier = agents.find((agent) => agent.id === agentId);
    setDispatchCourierDeliveryFee(String(courier?.courierDeliveryFee ?? 0));
  }
  function openTransferDialog(shipment: DeliveryShipment) {
    setTransferTarget(shipment);
    setTransferAgentId("");
    setTransferCourierDeliveryFee("");
    setTransferVehicleId("none");
    setTransferNotes("");
  }
  function closeTransferDialog() {
    setTransferTarget(null);
    setTransferAgentId("");
    setTransferCourierDeliveryFee("");
    setTransferVehicleId("none");
    setTransferNotes("");
  }
  function openReturnReceiptDialog(shipment: DeliveryShipment) {
    setReturnReceiptTarget(shipment);
    setReturnReceiptNote("");
  }
  function closeReturnReceiptDialog() {
    if (isReceivingReturn) return;
    setReturnReceiptTarget(null);
    setReturnReceiptNote("");
  }
  async function handleReturnReceipt(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !returnReceiptTarget || !canAdminEditAndRedispatch) return;
    setIsReceivingReturn(true);
    try {
      await receiveReturnedDeliveryShipment(workspaceId, {
        shipmentId: returnReceiptTarget.id,
        expectedVersion: returnReceiptTarget.version,
        actorRole: "admin",
        actorUserId: user?.id ?? null,
        note: returnReceiptNote || null,
      });
      toast({ title: t("postService.messages.returnReceived") });
      setReturnReceiptTarget(null);
      setReturnReceiptNote("");
    } catch (error) {
      toast({ title: t("postService.messages.returnReceiptFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsReceivingReturn(false);
    }
  }
  function openEditAndRedispatchDialog(shipment: DeliveryShipment) {
    const currentRun = shipment.assignedRunId ? runs.find((run) => run.id === shipment.assignedRunId) : null;
    setEditRedispatchTarget(shipment);
    setEditRedispatchForm(shipmentFormFromShipment(shipment));
    setShowEditRecipientPayout(shipment.customerPaymentStatus === "prepaid_electronically" || shipment.recipientPayoutAmount > 0);
    setEditReceivedDispatchEnabled(false);
    setEditRedispatchOperationId(shipment.status !== "received" ? generateId() : null);
    setEditRedispatchAgentId(shipment.status !== "received" ? shipment.assignedAgentId ?? "" : "");
    setEditRedispatchCourierDeliveryFee(String(shipment.courierDeliveryFee ?? (shipment.assignedAgentId ? agents.find((agent) => agent.id === shipment.assignedAgentId)?.courierDeliveryFee ?? 0 : 0)));
    setEditRedispatchVehicleId(currentRun?.vehicleId ?? "none");
    setEditRedispatchNotes("");
  }
  function closeEditAndRedispatchDialog(force = false) {
    if (isSubmitting && !force) return;
    setEditRedispatchTarget(null);
    setEditRedispatchForm(initialShipmentForm(features.default_currency));
    setShowEditRecipientPayout(false);
    setEditReceivedDispatchEnabled(false);
    setEditRedispatchOperationId(null);
    setEditRedispatchAgentId("");
    setEditRedispatchCourierDeliveryFee("");
    setEditRedispatchVehicleId("none");
    setEditRedispatchNotes("");
  }
  function handleEditRedispatchCourierChange(agentId: string) {
    setEditRedispatchAgentId(agentId);
    const courier = agents.find((agent) => agent.id === agentId);
    setEditRedispatchCourierDeliveryFee(String(courier?.courierDeliveryFee ?? 0));
  }
  function handleTransferCourierChange(agentId: string) {
    setTransferAgentId(agentId);
    const courier = agents.find((agent) => agent.id === agentId);
    setTransferCourierDeliveryFee(String(courier?.courierDeliveryFee ?? 0));
  }
  async function handleCreateMerchant(event: FormEvent) {
    event.preventDefault(); if (!workspaceId || !selectedMerchantPartner || !isAdmin) return; setIsSubmitting(true);
    try {
      await createDeliveryMerchantProfile(workspaceId, { businessPartnerId: selectedMerchantPartner.id, defaultFeeAmount: parseFormattedNumber(merchantFee || "0"), defaultFeePayer: merchantFeePayer, payoutSchedule: merchantPayoutSchedule });
      toast({ title: t("postService.messages.merchantEnabled"), description: t("postService.messages.merchantEnabledDescription") });
      setMerchantDialogOpen(false); setSelectedMerchantPartner(null); setMerchantName(""); setMerchantFee("");
    } catch (error) { toast({ title: t("postService.messages.enableMerchantFailed"), description: localizedError(t, error), variant: "destructive" }); } finally { setIsSubmitting(false); }
  }
  function shipmentPayload(): CreateDeliveryShipmentInput {
    return {
      merchantProfileId: shipmentForm.merchantProfileId,
      recipientPhone: shipmentForm.recipientPhone,
      recipientAddress: shipmentForm.recipientAddress,
      description: shipmentForm.description || null,
      currency: shipmentForm.currency,
      codAmount: parseFormattedNumber(shipmentForm.codAmount || "0"),
      customerPaymentStatus: shipmentForm.customerPaymentStatus,
      recipientPayoutAmount: parseFormattedNumber(shipmentForm.recipientPayoutAmount || "0"),
      recipientPayoutFunding: shipmentForm.recipientPayoutFunding,
      deliveryFee: parseFormattedNumber(shipmentForm.deliveryFee || "0"),
      feePayer: shipmentForm.feePayer,
      createdBy: user?.id ?? null,
    };
  }
  async function handleCreatePost(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !isAdmin || (newPostDispatchEnabled && !canDispatch)) return;
    if (!isNewPostFormValid) return;
    setIsSubmitting(true);
    try {
      if (newPostDispatchEnabled) {
        const operationId = newPostOperationId ?? generateId();
        setNewPostOperationId(operationId);
        const { run } = await createAndDispatchDeliveryShipment(workspaceId, {
          operationId,
          shipment: shipmentPayload(),
          agentId: newPostDispatchAgentId,
          courierDeliveryFee: parseFormattedNumber(newPostCourierDeliveryFee || "0"),
          vehicleId: newPostVehicleId === "none" ? null : newPostVehicleId,
          notes: newPostDispatchNotes || null,
          createdBy: user?.id ?? null,
        });
        toast({ title: t("postService.messages.postCreatedAndAssigned"), description: t("postService.messages.postCreatedAndAssignedDescription", { run: run.runNumber }) });
      } else {
        await createDeliveryShipment(workspaceId, shipmentPayload());
        toast({ title: t("postService.messages.postCreated"), description: t("postService.messages.postCreatedDescription") });
      }
      closeShipmentFlow(true);
    } catch (error) {
      const description = localizedError(t, error);
      toast({ title: t(newPostDispatchEnabled ? "postService.messages.createPostAndAssignFailed" : "postService.messages.createPostFailed"), description, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }
  function openMerchantEditor(profile: DeliveryMerchantProfile) {
    setEditingMerchantProfile(profile);
    setMerchantFee(String(profile.defaultFeeAmount));
    setMerchantFeePayer(profile.defaultFeePayer);
    setMerchantPayoutSchedule(profile.payoutSchedule);
    setMerchantEditDialogOpen(true);
  }
  async function handleUpdateMerchant(event: FormEvent) {
    event.preventDefault();
    if (!editingMerchantProfile) return;
    setIsSubmitting(true);
    try {
      await updateDeliveryMerchantProfile(editingMerchantProfile.id, {
        defaultFeeAmount: parseFormattedNumber(merchantFee || "0"),
        defaultFeePayer: merchantFeePayer,
        payoutSchedule: merchantPayoutSchedule,
        isActive: editingMerchantProfile.isActive,
      });
      toast({ title: t("postService.messages.merchantUpdated") });
      setMerchantEditDialogOpen(false);
      setEditingMerchantProfile(null);
    } catch (error) {
      toast({ title: t("postService.messages.updateMerchantFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }
  async function handleDeleteMerchant() {
    if (!merchantDeleteTarget) return;
    setIsDeletingMerchant(true);
    try {
      await hardDeleteDeliveryMerchantProfile(merchantDeleteTarget.id);
      toast({ title: t("postService.messages.merchantDeleted") });
      setMerchantDeleteTarget(null);
    } catch (error) {
      toast({ title: t("postService.messages.deleteMerchantFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsDeletingMerchant(false);
    }
  }
  async function handleCreateSupplierPartner(payload: BusinessPartnerFormPayload) {
    if (!workspaceId) return;
    setIsSavingSupplierPartner(true);
    try {
      const partner = await createBusinessPartner(workspaceId, { ...payload, role: "supplier" });
      toast({ title: t("postService.messages.businessPartnerCreated") });
      setSupplierPartnerDialogOpen(false);
      setSelectedMerchantPartner(partner);
      setMerchantName(partner.partnerName);
    } catch (error) {
      toast({ title: t("postService.messages.businessPartnerSaveFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsSavingSupplierPartner(false);
    }
  }
  async function handleDispatch(event: FormEvent) {
    event.preventDefault(); if (!workspaceId) return; setIsSubmitting(true);
    try {
      const run = await createDeliveryRun(workspaceId, { agentId: dispatchAgentId, shipmentIds: [...selectedShipmentIds], courierDeliveryFee: parseFormattedNumber(dispatchCourierDeliveryFee || "0"), vehicleId: dispatchVehicleId === "none" ? null : dispatchVehicleId, notes: dispatchNotes || null, createdBy: user?.id ?? null });
      toast({ title: t("postService.messages.dispatchCreated"), description: t("postService.messages.dispatchCreatedDescription", { run: run.runNumber }) });
      setSelectedShipmentIds(new Set()); setDispatchAgentId(""); setDispatchCourierDeliveryFee(""); setDispatchVehicleId("none"); setDispatchNotes("");
    } catch (error) { toast({ title: t("postService.messages.dispatchFailed"), description: localizedError(t, error), variant: "destructive" }); } finally { setIsSubmitting(false); }
  }
  async function handleTransferPost(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !transferTarget) return;
    setIsTransferring(true);
    try {
      const run = await transferReturnedDeliveryShipment(workspaceId, {
        agentId: transferAgentId,
        shipmentId: transferTarget.id,
        courierDeliveryFee: parseFormattedNumber(transferCourierDeliveryFee || "0"),
        vehicleId: transferVehicleId === "none" ? null : transferVehicleId,
        notes: transferNotes || null,
        createdBy: user?.id ?? null,
      });
      toast({ title: t("postService.messages.postTransferred"), description: t("postService.messages.postTransferredDescription", { run: run.runNumber }) });
      closeTransferDialog();
    } catch (error) {
      toast({ title: t("postService.messages.transferPostFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsTransferring(false);
    }
  }
  async function handleEditAndRedispatchPost(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !editRedispatchTarget || !canAdminEditAndRedispatch || !isEditRedispatchFormValid) return;
    setIsSubmitting(true);
    try {
      const shipment = {
        merchantProfileId: editRedispatchForm.merchantProfileId,
        recipientPhone: editRedispatchForm.recipientPhone,
        recipientAddress: editRedispatchForm.recipientAddress,
        description: editRedispatchForm.description || null,
        currency: editRedispatchForm.currency,
        codAmount: parseFormattedNumber(editRedispatchForm.codAmount || "0"),
        customerPaymentStatus: editRedispatchForm.customerPaymentStatus,
        recipientPayoutAmount: parseFormattedNumber(editRedispatchForm.recipientPayoutAmount || "0"),
        recipientPayoutFunding: editRedispatchForm.recipientPayoutFunding,
        deliveryFee: parseFormattedNumber(editRedispatchForm.deliveryFee || "0"),
        feePayer: editRedispatchForm.feePayer,
      };
      if (shouldDispatchEditedPost) {
        const operationId = editRedispatchOperationId ?? generateId();
        setEditRedispatchOperationId(operationId);
        const run = await adminEditAndRedispatchDeliveryShipment(workspaceId, {
          operationId,
          shipmentId: editRedispatchTarget.id,
          expectedVersion: editRedispatchTarget.version,
          actorRole: "admin",
          actorUserId: user?.id ?? null,
          shipment,
          agentId: editRedispatchAgentId,
          courierDeliveryFee: parseFormattedNumber(editRedispatchCourierDeliveryFee || "0"),
          vehicleId: editRedispatchVehicleId === "none" ? null : editRedispatchVehicleId,
          notes: editRedispatchNotes || null,
        });
        toast({
          title: t(editRedispatchTarget.status !== "received" ? "postService.messages.postEditedAndRedispatched" : "postService.messages.postEditedAndDispatched"),
          description: t(editRedispatchTarget.status !== "received" ? "postService.messages.postEditedAndRedispatchedDescription" : "postService.messages.postEditedAndDispatchedDescription", { run: run.runNumber }),
        });
      } else {
        await adminEditReceivedDeliveryShipment(workspaceId, {
          shipmentId: editRedispatchTarget.id,
          expectedVersion: editRedispatchTarget.version,
          actorRole: "admin",
          actorUserId: user?.id ?? null,
          shipment,
        });
        toast({ title: t("postService.messages.postUpdated"), description: t("postService.messages.postUpdatedDescription") });
      }
      closeEditAndRedispatchDialog(true);
    } catch (error) {
      const messageKey = shouldDispatchEditedPost
        ? editRedispatchTarget.status !== "received" ? "postService.messages.editAndRedispatchFailed" : "postService.messages.editAndDispatchFailed"
        : "postService.messages.updatePostFailed";
      toast({ title: t(messageKey), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }
  function closeStatusDialog() {
    if (isSubmitting) return;
    setStatusTarget(null);
    setStatusNote("");
    setRecipientPayoutMethod("cash");
    setRecipientPayoutAccount(null);
  }
  async function handleStatusUpdate() {
    if (!statusTarget) return;
    setIsSubmitting(true);
    try {
      await updateDeliveryShipmentStatus(statusTarget.id, {
        status: nextStatus,
        note: nextStatus === "delivered" ? statusNote || null : null,
        recipientPayoutPaymentMethod: nextStatus === "delivered" ? recipientPayoutMethod : undefined,
        recipientPayoutAccountId: nextStatus === "delivered" ? recipientPayoutAccount?.id ?? null : undefined,
        recipientPayoutAccountNameSnapshot: nextStatus === "delivered" ? recipientPayoutAccount?.name ?? null : undefined,
        actorUserId: user?.id ?? null,
        actorAgentId: linkedCourier?.id ?? null,
      });
      toast({ title: t("postService.messages.postMarked", { status: shipmentStatusLabel(t, nextStatus) }) }); setStatusTarget(null);
    } catch (error) { toast({ title: t("postService.messages.updatePostFailed"), description: localizedError(t, error), variant: "destructive" }); } finally { setIsSubmitting(false); }
  }
  async function handleCodAdjustmentRequest(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !codAdjustmentRequestTarget || !linkedCourier || !user?.id) return;
    setIsRequestingCodAdjustment(true);
    try {
      await requestDeliveryShipmentCodAdjustment(workspaceId, {
        shipmentId: codAdjustmentRequestTarget.id,
        requesterUserId: user.id,
        requesterAgentId: linkedCourier.id,
        requestedCodAmount: numericValue(requestedCodAmount),
        reason: codAdjustmentReason,
      });
      toast({ title: t("postService.messages.codChangeRequested") });
      setCodAdjustmentRequestTarget(null);
      setRequestedCodAmount("");
      setCodAdjustmentReason("");
    } catch (error) {
      toast({ title: t("postService.messages.codChangeRequestFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsRequestingCodAdjustment(false);
    }
  }
  async function handleCodAdjustmentReview(decision: "approved" | "rejected") {
    if (!codAdjustmentReviewTarget || !user?.id || !isAdmin) return;
    setIsReviewingCodAdjustment(true);
    try {
      await reviewDeliveryShipmentCodAdjustment(codAdjustmentReviewTarget.id, {
        reviewerUserId: user.id,
        decision,
        approvedCodAmount: decision === "approved" ? numericValue(approvedCodAmount) : null,
        reviewNote: codAdjustmentReviewNote,
      });
      toast({ title: t(decision === "approved" ? "postService.messages.codChangeApproved" : "postService.messages.codChangeRejected") });
      setCodAdjustmentReviewTarget(null);
      setApprovedCodAmount("");
      setCodAdjustmentReviewNote("");
    } catch (error) {
      toast({ title: t("postService.messages.codChangeReviewFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsReviewingCodAdjustment(false);
    }
  }
  async function handleDeliveredCodCorrection(event: FormEvent) {
    event.preventDefault();
    if (
      !workspaceId
      || !user?.id
      || !isAdmin
      || !deliveredCodCorrectionTarget
      || !deliveredCodCorrectionOperationId
      || !isDeliveredCodCorrectionValid
    ) return;
    setIsCorrectingDeliveredCod(true);
    try {
      await correctDeliveredDeliveryShipmentCod(workspaceId, {
        operationId: deliveredCodCorrectionOperationId,
        shipmentId: deliveredCodCorrectionTarget.id,
        expectedVersion: deliveredCodCorrectionTarget.version,
        actorRole: "admin",
        actorUserId: user.id,
        correctedCodAmount: numericValue(correctedDeliveredCodAmount),
      });
      toast({ title: t("postService.messages.deliveredCodCorrected") });
      setDeliveredCodCorrectionTarget(null);
      setCorrectedDeliveredCodAmount("");
      setDeliveredCodCorrectionOperationId("");
    } catch (error) {
      toast({
        title: t("postService.messages.deliveredCodCorrectionFailed"),
        description: localizedError(t, error),
        variant: "destructive",
      });
    } finally {
      setIsCorrectingDeliveredCod(false);
    }
  }
  async function handleDeliveredRecipientPayoutCorrection(event: FormEvent) {
    event.preventDefault();
    if (
      !workspaceId
      || !user?.id
      || !isAdmin
      || !deliveredRecipientPayoutCorrectionTarget
      || !deliveredRecipientPayoutCorrectionOperationId
      || !isDeliveredRecipientPayoutCorrectionValid
    ) return;
    setIsCorrectingDeliveredRecipientPayout(true);
    try {
      await correctDeliveredDeliveryShipmentRecipientPayout(workspaceId, {
        operationId: deliveredRecipientPayoutCorrectionOperationId,
        shipmentId: deliveredRecipientPayoutCorrectionTarget.id,
        expectedVersion: deliveredRecipientPayoutCorrectionTarget.version,
        actorRole: "admin",
        actorUserId: user.id,
        correctedRecipientPayoutAmount: numericValue(correctedDeliveredRecipientPayoutAmount),
      });
      toast({ title: t("postService.messages.deliveredRecipientPayoutCorrected") });
      setDeliveredRecipientPayoutCorrectionTarget(null);
      setCorrectedDeliveredRecipientPayoutAmount("");
      setDeliveredRecipientPayoutCorrectionOperationId("");
    } catch (error) {
      toast({
        title: t("postService.messages.deliveredRecipientPayoutCorrectionFailed"),
        description: localizedError(t, error),
        variant: "destructive",
      });
    } finally {
      setIsCorrectingDeliveredRecipientPayout(false);
    }
  }
  async function handleRecipientPayoutAdjustmentRequest(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || !recipientPayoutAdjustmentRequestTarget || !linkedCourier || !user?.id) return;
    const shipmentId = recipientPayoutAdjustmentRequestTarget.id;
    flushSync(() => {
      setIsRequestingRecipientPayoutAdjustment(true);
      setRecipientPayoutAdjustmentRowOperation({ kind: "request", shipmentId });
    });
    try {
      await requestDeliveryShipmentRecipientPayoutAdjustment(workspaceId, {
        shipmentId,
        requesterUserId: user.id,
        requesterAgentId: linkedCourier.id,
        requestedRecipientPayoutAmount: numericValue(requestedRecipientPayoutAmount),
        reason: recipientPayoutAdjustmentReason,
      });
      toast({ title: t("postService.messages.recipientPayoutChangeRequested") });
      setRecipientPayoutAdjustmentRequestTarget(null);
      setRequestedRecipientPayoutAmount("");
      setRecipientPayoutAdjustmentReason("");
    } catch (error) {
      setRecipientPayoutAdjustmentRowOperation(null);
      toast({ title: t("postService.messages.recipientPayoutChangeRequestFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsRequestingRecipientPayoutAdjustment(false);
    }
  }
  async function handleRecipientPayoutAdjustmentReview(decision: "approved" | "rejected") {
    if (!recipientPayoutAdjustmentReviewTarget || !user?.id || !isAdmin) return;
    const requestId = recipientPayoutAdjustmentReviewTarget.id;
    const shipmentId = recipientPayoutAdjustmentReviewTarget.shipmentId;
    flushSync(() => {
      setIsReviewingRecipientPayoutAdjustment(true);
      setRecipientPayoutAdjustmentRowOperation({ kind: "review", shipmentId, requestId });
    });
    try {
      await reviewDeliveryShipmentRecipientPayoutAdjustment(requestId, {
        reviewerUserId: user.id,
        decision,
        approvedRecipientPayoutAmount: decision === "approved" ? numericValue(approvedRecipientPayoutAmount) : null,
        reviewNote: recipientPayoutAdjustmentReviewNote,
      });
      toast({ title: t(decision === "approved" ? "postService.messages.recipientPayoutChangeApproved" : "postService.messages.recipientPayoutChangeRejected") });
      setRecipientPayoutAdjustmentReviewTarget(null);
      setApprovedRecipientPayoutAmount("");
      setRecipientPayoutAdjustmentReviewNote("");
    } catch (error) {
      setRecipientPayoutAdjustmentRowOperation(null);
      toast({ title: t("postService.messages.recipientPayoutChangeReviewFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setIsReviewingRecipientPayoutAdjustment(false);
    }
  }
  async function handleSettlement(event: FormEvent) {
    event.preventDefault(); if (!workspaceId || !settlementTarget) return; setIsSubmitting(true);
    try {
      const payload = { currency: settlementTarget.currency, actualAmount: numericValue(settlementAmount), paymentMethod: settlementMethod, note: settlementNote || null, varianceNote: numericValue(settlementAmount) === settlementTarget.amount ? null : settlementNote || null, shipmentId: settlementTarget.shipmentId ?? null, createdBy: user?.id ?? null, accountId: settlementAccount?.id ?? null, accountNameSnapshot: settlementAccount?.name ?? null };
      if (settlementTarget.kind === "courier") await settleDeliveryCourier(workspaceId, { ...payload, agentId: settlementTarget.id });
      else if (settlementTarget.kind === "courier_reimbursement") await payDeliveryCourierReimbursement(workspaceId, { ...payload, agentId: settlementTarget.id });
      else if (settlementTarget.kind === "merchant") await payDeliveryMerchant(workspaceId, { ...payload, merchantProfileId: settlementTarget.id });
      else await receiveDeliveryMerchantRepayment(workspaceId, { ...payload, merchantProfileId: settlementTarget.id });
      toast({ title: t(settlementTarget.kind === "courier"
        ? "postService.messages.courierHandoverRecorded"
        : settlementTarget.kind === "courier_reimbursement"
          ? "postService.messages.courierReimbursementRecorded"
        : settlementTarget.kind === "merchant"
          ? "postService.messages.merchantPayoutRecorded"
          : "postService.messages.merchantRepaymentRecorded") }); setSettlementTarget(null); setSettlementAccount(null);
    } catch (error) { toast({ title: t("postService.messages.settlementFailed"), description: localizedError(t, error), variant: "destructive" }); } finally { setIsSubmitting(false); }
  }
  async function handlePostSettlement(kind: "courier" | "merchant") {
    if (!workspaceId || !postSettlementTarget) return;
    const isCourier = kind === "courier";
    const isPrepaid = postSettlementTarget.customerPaymentStatus === "prepaid_electronically";
    if (isCourier && !postSettlementTarget.assignedAgentId) return;
    const amount = numericValue(isCourier ? postSettlementDraft.courierAmount : postSettlementDraft.merchantAmount);
    const expectedAmount = isCourier ? postSettlementCourierOutstanding : postSettlementMerchantOutstanding;
    const note = isCourier ? postSettlementDraft.courierNote : postSettlementDraft.merchantNote;
    const paymentMethod = isCourier ? postSettlementDraft.courierMethod : postSettlementDraft.merchantMethod;
    const account = isCourier ? postSettlementDraft.courierAccount : postSettlementDraft.merchantAccount;
    setSubmittingPostSettlement(kind);
    try {
      const payload = {
        currency: postSettlementTarget.currency,
        actualAmount: amount,
        paymentMethod,
        note: note || null,
        varianceNote: Math.abs(amount - expectedAmount) <= 0.000001 ? null : note || null,
        shipmentId: postSettlementTarget.id,
        createdBy: user?.id ?? null,
        accountId: account?.id ?? null,
        accountNameSnapshot: account?.name ?? null,
      };
      if (isCourier) {
        if (isPrepaid) await payDeliveryCourierReimbursement(workspaceId, { ...payload, agentId: postSettlementTarget.assignedAgentId! });
        else await settleDeliveryCourier(workspaceId, { ...payload, agentId: postSettlementTarget.assignedAgentId! });
      } else if (isPrepaid) {
        await receiveDeliveryMerchantRepayment(workspaceId, { ...payload, merchantProfileId: postSettlementTarget.merchantProfileId });
      } else {
        await payDeliveryMerchant(workspaceId, { ...payload, merchantProfileId: postSettlementTarget.merchantProfileId });
      }
      toast({ title: t(isCourier
        ? isPrepaid ? "postService.messages.courierReimbursementRecorded" : "postService.messages.courierHandoverRecorded"
        : isPrepaid ? "postService.messages.merchantRepaymentRecorded" : "postService.messages.merchantPayoutRecorded") });
      setPostSettlementDraft((current) => isCourier
        ? { ...current, courierAmount: "", courierNote: "", courierAccount: null }
        : { ...current, merchantAmount: "", merchantNote: "", merchantAccount: null });
    } catch (error) {
      toast({ title: t("postService.messages.settlementFailed"), description: localizedError(t, error), variant: "destructive" });
    } finally {
      setSubmittingPostSettlement(null);
    }
  }
  async function handleCloseRun(runId: string) {
    try { await closeDeliveryRun(runId); toast({ title: t("postService.messages.runClosed") }); }
    catch (error) { toast({ title: t("postService.messages.closeRunFailed"), description: localizedError(t, error), variant: "destructive" }); }
  }

  const isStatusDialogBusy = isSubmitting;

  if (!workspaceId) return null;
  return <div className="w-full min-w-0 space-y-6 overflow-x-hidden" dir={pageDirection}>
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><h1 className="flex items-center gap-2 text-2xl font-bold"><PackageCheck className="h-6 w-6 text-primary" />{t("postService.title")}</h1><p className="text-muted-foreground">{t("postService.subtitle")} <ModulePageFreshness className="ms-2" /></p></div><div className="flex flex-wrap items-center gap-2">{DeveloperTestButton && <Suspense fallback={null}><DeveloperTestButton suiteId="post-service" /></Suspense>}{isAdmin && <div className="flex flex-wrap gap-2"><Button variant="outline" className="gap-2" onClick={() => setMerchantDialogOpen(true)}><Store className="h-4 w-4" />{t("postService.actions.enableMerchant")}</Button><Button className="gap-2" onClick={() => setShipmentDialogOpen(true)}><Plus className="h-4 w-4" />{t("postService.actions.newPost")}</Button></div>}</div></div>
    <div className="space-y-3">
      <div className={cn("grid sm:grid-cols-2", isAdmin ? "gap-3 lg:grid-cols-6" : "gap-4 xl:grid-cols-6")}>{postStatusMetrics.filter(({ status }) => !isAdmin ? status !== "cancelled" : !["returned", "cancelled"].includes(status)).map(({ status, value }) => <StatusMetric key={status} compact={isAdmin} icon={statusFilterIcons[status]} title={status === "returned" ? t("postService.status.returnAwaitingReceipt") : shipmentStatusLabel(t, status)} value={value} active={isStatusMetricActive(status)} selectionTone={status === "returned" ? "amber" : status === "cancelled" ? "rose" : "primary"} onClick={() => handleStatusMetricClick(status)} />)}{isAdmin ? <><StatusMetric compact icon={PackageCheck} title={t("postService.status.completed")} value={completedPostCount} active={completedOnly} onClick={handleCompletedPostMetricClick} /><StatusMetric compact icon={FilePenLine} title={t("postService.status.requestChange")} value={pendingChangeRequestCount} active={pendingChangeRequestFilter} selectionTone="amber" onClick={handlePendingChangeRequestMetricClick} /></> : <><StatusMetric icon={PackageCheck} title={t("postService.status.completed")} value={completedPostCount} active={completedOnly} onClick={handleCompletedPostMetricClick} />{postStatusMetrics.filter(({ status }) => status === "cancelled").map(({ status, value }) => <StatusMetric key={status} icon={statusFilterIcons[status]} title={shipmentStatusLabel(t, status)} value={value} active={isStatusMetricActive(status)} selectionTone="rose" onClick={() => handleStatusMetricClick(status)} />)}</>}</div>
      {isAdmin ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <ReturnStatusMetric awaitingValue={postStatusMetrics.find(({ status }) => status === "returned")?.value ?? 0} historyValue={returnHistoryCount} awaitingActive={isStatusMetricActive("returned")} historyActive={isReturnHistoryMetricActive} awaitingTitle={t("postService.status.returnAwaitingReceipt")} historyTitle={t("postService.status.returnHistory")} onAwaitingClick={handleReturnedPostMetricClick} onHistoryClick={handleReturnHistoryMetricClick} />
        {postStatusMetrics.filter(({ status }) => status === "cancelled").map(({ status, value }) => <StatusMetric key={status} compact icon={statusFilterIcons[status]} title={shipmentStatusLabel(t, status)} value={value} active={isStatusMetricActive(status)} selectionTone="rose" onClick={() => handleStatusMetricClick(status)} />)}
        {deliveryBalanceMetrics.map((metric) => <DeliveryBalanceMetric key={metric.id} {...metric} />)}
      </div> : isStaff ? <div className="grid gap-4 sm:grid-cols-2">{staffCourierObligationMetrics.map((metric) => <DeliveryBalanceMetric key={metric.id} {...metric} />)}</div> : null}
    </div>
    <Tabs value={activeTab} onValueChange={handleTabChange} dir={pageDirection} className="min-w-0"><TabsList className="h-auto w-full max-w-full flex-wrap justify-start gap-1 sm:w-auto"><TabsTrigger value="posts"><ClipboardList className="me-2 h-4 w-4" />{t("postService.tabs.posts")}</TabsTrigger>{isAdmin && <><TabsTrigger value="dispatch"><Send className="me-2 h-4 w-4" />{t("postService.tabs.dispatch")}</TabsTrigger><TabsTrigger value="my-deliveries"><Route className="me-2 h-4 w-4" />{t("postService.tabs.myDeliveries")}</TabsTrigger><TabsTrigger value="merchants"><Store className="me-2 h-4 w-4" />{t("postService.tabs.merchants")}</TabsTrigger><TabsTrigger value="courier"><Truck className="me-2 h-4 w-4" />{t("postService.tabs.courier")}</TabsTrigger><TabsTrigger value="settlements"><Banknote className="me-2 h-4 w-4" />{t("postService.tabs.settlements")}</TabsTrigger></>}</TabsList>
      <TabsContent ref={postsPanelRef} value="posts" tabIndex={-1} className="mt-4 min-w-0 scroll-mt-24 outline-none">
        <div className="mb-4 w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:overflow-visible">
          <DateRangeFilters className="w-max min-w-max" showYesterday />
        </div>
        <Card>
          <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle>{t("postService.cards.allPosts")}</CardTitle>
              <PostsViewModeToggle t={t} value={postsViewMode} onChange={setPostsViewMode} />
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <span className="text-sm text-muted-foreground">{t("postService.selectedForDispatch", { count: selectedCount })}</span>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <FilterDropdown dir={pageDirection} value={statusFilter} label={t("common.status")} hasActiveFilter={statusFilter !== "all"} options={statusFilterOptions(t)} onValueChange={(value) => { const nextStatus = value as PostStatusFilter; setPendingChangeRequestFilter(false); setCompletedOnly(false); setShowCompleted(false); setShowReturned(nextStatus === "returned"); setShowCancelled(nextStatus === "cancelled"); setStatusFilter(nextStatus); }} />
                <FilterDropdown dir={pageDirection} value={handoverFilter} label={t("postService.table.cashHandover")} hasActiveFilter={handoverFilter !== "all"} options={settlementFilterOptions(t, t("postService.settlementStatus.handedOver"))} onValueChange={(value) => setHandoverFilter(value as PostSettlementFilter)} />
                <FilterDropdown dir={pageDirection} value={payoutFilter} label={t("postService.table.merchantPayout")} hasActiveFilter={payoutFilter !== "all"} options={settlementFilterOptions(t, t("postService.settlementStatus.paid"))} onValueChange={(value) => setPayoutFilter(value as PostSettlementFilter)} />
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium">
                  <Checkbox className="h-5 w-5 rounded-[6px]" checked={showCompleted} onCheckedChange={(checked) => { const nextShowCompleted = checked === true; setShowCompleted(nextShowCompleted); if (!nextShowCompleted) setCompletedOnly(false); }} />
                  {t("postService.filters.showCompleted")}
                </label>
                {!isAdmin && <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium">
                  <Checkbox className="h-5 w-5 rounded-[6px]" checked={showReturned} onCheckedChange={(checked) => { const nextShowReturned = checked === true; setShowReturned(nextShowReturned); if (!nextShowReturned && statusFilter === "returned") setStatusFilter("all"); }} />
                  {t("postService.filters.showReturned")}
                </label>}
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium">
                  <Checkbox className="h-5 w-5 rounded-[6px]" checked={showCancelled} onCheckedChange={(checked) => { const nextShowCancelled = checked === true; setShowCancelled(nextShowCancelled); if (!nextShowCancelled && statusFilter === "cancelled") setStatusFilter("all"); }} />
                  {t("postService.filters.showCancelled")}
                </label>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="ps-9" placeholder={t("postService.placeholders.searchPosts")} />
            </div>
            <div className={cn("grid grid-cols-1 gap-4", postsViewMode === "grid" ? "md:grid-cols-2 2xl:grid-cols-3" : "md:hidden")}>
              <ShipmentGrid t={t} shipments={searchedShipments} selectedIds={selectedShipmentIds} onToggle={toggleShipment} canSelect={canDispatch} showListNumber profileNameById={profileNameById} agentNameById={agentNameById} onStatus={openStatusDialog} onTransfer={openTransferDialog} onReceiveReturn={openReturnReceiptDialog} onEditAndRedispatch={openEditAndRedispatchDialog} canAdminEditAndRedispatch={canAdminEditAndRedispatch} canReceiveReturn={canAdminEditAndRedispatch} onRequestCodChange={openCodAdjustmentRequest} onReviewCodChange={openCodAdjustmentReview} pendingCodAdjustmentByShipment={pendingCodAdjustmentByShipment} approvedCodAdjustmentByShipment={approvedCodAdjustmentByShipment} onCorrectDeliveredCod={openDeliveredCodCorrection} deliveredCodCorrectionShipmentIds={deliveredCodCorrectionShipmentIds} onCorrectDeliveredRecipientPayout={openDeliveredRecipientPayoutCorrection} deliveredRecipientPayoutCorrectionShipmentIds={deliveredRecipientPayoutCorrectionShipmentIds} canCorrectDeliveredCod={isAdmin} onRequestRecipientPayoutChange={openRecipientPayoutAdjustmentRequest} onReviewRecipientPayoutChange={openRecipientPayoutAdjustmentReview} pendingRecipientPayoutAdjustmentByShipment={pendingRecipientPayoutAdjustmentByShipment} approvedRecipientPayoutAdjustmentByShipment={approvedRecipientPayoutAdjustmentByShipment} canRequestCodChange={user?.role === "staff" && !!linkedCourier} requesterCourierId={linkedCourier?.id ?? null} canReviewCodChange={isAdmin} onOpenSettlementNet={setSettlementNetTarget} onOpenPostSettlements={openPostSettlementDialog} onPlayVoiceReason={setVoicePlaybackEvent} voiceReasonEventByShipment={voiceReasonEventByShipment} canPlayVoiceReason={isAdmin} canSettle={canSettle} canTransfer={canDispatch} canUpdate={isEditor} iqdPreference={features.iqd_display_preference} handoverStatusByShipment={courierHandoverStatuses} payoutStatusByShipment={merchantPayoutStatuses} courierReimbursementStatusByShipment={courierReimbursementStatuses} merchantRepaymentStatusByShipment={merchantRepaymentStatuses} settlementNetByShipment={perShipmentSettlementNet} recipientPayoutAdjustmentBusyShipmentIds={recipientPayoutAdjustmentBusyShipmentIds} />
            </div>
            {postsViewMode === "details" && <div className="hidden overflow-x-auto md:block"><ShipmentTable t={t} shipments={searchedShipments} footer={postsTotalsFooter} selectedIds={selectedShipmentIds} onToggle={toggleShipment} canSelect={canDispatch} showListNumber profileNameById={profileNameById} agentNameById={agentNameById} onStatus={openStatusDialog} onTransfer={openTransferDialog} onReceiveReturn={openReturnReceiptDialog} onEditAndRedispatch={openEditAndRedispatchDialog} canAdminEditAndRedispatch={canAdminEditAndRedispatch} canReceiveReturn={canAdminEditAndRedispatch} onRequestCodChange={openCodAdjustmentRequest} onReviewCodChange={openCodAdjustmentReview} pendingCodAdjustmentByShipment={pendingCodAdjustmentByShipment} approvedCodAdjustmentByShipment={approvedCodAdjustmentByShipment} onCorrectDeliveredCod={openDeliveredCodCorrection} deliveredCodCorrectionShipmentIds={deliveredCodCorrectionShipmentIds} onCorrectDeliveredRecipientPayout={openDeliveredRecipientPayoutCorrection} deliveredRecipientPayoutCorrectionShipmentIds={deliveredRecipientPayoutCorrectionShipmentIds} canCorrectDeliveredCod={isAdmin} onRequestRecipientPayoutChange={openRecipientPayoutAdjustmentRequest} onReviewRecipientPayoutChange={openRecipientPayoutAdjustmentReview} pendingRecipientPayoutAdjustmentByShipment={pendingRecipientPayoutAdjustmentByShipment} approvedRecipientPayoutAdjustmentByShipment={approvedRecipientPayoutAdjustmentByShipment} canRequestCodChange={user?.role === "staff" && !!linkedCourier} requesterCourierId={linkedCourier?.id ?? null} canReviewCodChange={isAdmin} onOpenSettlementNet={setSettlementNetTarget} onOpenPostSettlements={openPostSettlementDialog} onPlayVoiceReason={setVoicePlaybackEvent} voiceReasonEventByShipment={voiceReasonEventByShipment} canPlayVoiceReason={isAdmin} canSettle={canSettle} canTransfer={canDispatch} canUpdate={isEditor} iqdPreference={features.iqd_display_preference} handoverStatusByShipment={courierHandoverStatuses} payoutStatusByShipment={merchantPayoutStatuses} courierReimbursementStatusByShipment={courierReimbursementStatuses} merchantRepaymentStatusByShipment={merchantRepaymentStatuses} settlementNetByShipment={perShipmentSettlementNet} recipientPayoutAdjustmentBusyShipmentIds={recipientPayoutAdjustmentBusyShipmentIds} /></div>}
          </CardContent>
        </Card>
      </TabsContent>
      {isAdmin && <>
      <TabsContent value="dispatch" className="mt-4 space-y-4"><Card><CardHeader><CardTitle>{t("postService.cards.createManifest")}</CardTitle></CardHeader><CardContent>{canDispatch ? <form className="grid gap-4 md:grid-cols-2" onSubmit={handleDispatch}><Field label={t("postService.form.postsSelected")}><div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{t("postService.selectedAndAvailable", { selected: selectedCount, available: assignableShipments.length })}</div></Field><Field label={t("postService.form.courier")}><Select value={dispatchAgentId} onValueChange={handleDispatchCourierChange}><SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectCourier")} /></SelectTrigger><SelectContent>{agents.filter((agent) => agent.status === "active" && agent.agentType === "courier").map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentNameById.get(agent.id)} · {agent.zone}</SelectItem>)}</SelectContent></Select></Field><Field label={t("postService.form.courierDeliveryFee")}><div className="grid gap-1"><div className="relative"><Input className="pe-12" value={formatNumericInput(dispatchCourierDeliveryFee)} onChange={(event) => setDispatchCourierDeliveryFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" disabled={!dispatchAgentId} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(features.default_currency, features.iqd_display_preference)}</span></div><p className="text-xs text-muted-foreground">{t("postService.form.courierDeliveryFeeHint")}</p></div></Field><Field label={t("postService.form.vehicleOptional")}><Select value={dispatchVehicleId} onValueChange={setDispatchVehicleId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("postService.options.noVehicle")}</SelectItem>{vehicles.filter((vehicle) => vehicle.status === "active").map((vehicle) => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.model}</SelectItem>)}</SelectContent></Select></Field><Field label={t("postService.form.manifestNote")}><Input value={dispatchNotes} onChange={(event) => setDispatchNotes(event.target.value)} placeholder={t("postService.placeholders.manifestNote")} /></Field><div className="md:col-span-2"><Button disabled={isSubmitting || !dispatchAgentId || selectedCount === 0} type="submit"><Send className="me-2 h-4 w-4" />{t("postService.actions.assignSelected")}</Button></div></form> : <p className="text-sm text-muted-foreground">{t("postService.permissionRequired.dispatch")}</p>}</CardContent></Card><Card><CardHeader><CardTitle>{t("postService.cards.recentRuns")}</CardTitle></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t("postService.table.run")}</TableHead><TableHead>{t("postService.table.courier")}</TableHead><TableHead>{t("postService.table.courierDeliveryFee")}</TableHead><TableHead>{t("postService.table.dispatched")}</TableHead><TableHead>{t("postService.table.status")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{runs.length === 0 ? <EmptyRow columns={6} label={t("postService.empty.noRuns")} /> : runs.map((run) => <TableRow key={run.id}><TableCell className="font-medium">{run.runNumber}</TableCell><TableCell>{agentNameById.get(run.agentId)}</TableCell><TableCell>{formatCurrency(run.courierDeliveryFee ?? 0, features.default_currency, features.iqd_display_preference)}</TableCell><TableCell>{formatDateTime(run.dispatchedAt)}</TableCell><TableCell><Badge variant="outline">{t(`postService.runStatus.${run.status}`)}</Badge></TableCell><TableCell className="text-end">{canDispatch && run.status === "open" && <Button size="sm" variant="outline" onClick={() => void handleCloseRun(run.id)}>{t("postService.actions.closeRun")}</Button>}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></TabsContent>
      <TabsContent value="my-deliveries" className="mt-4"><Card><CardHeader><CardTitle>{t("postService.cards.myAssignedPosts")}</CardTitle></CardHeader><CardContent className="overflow-x-auto">{linkedCourier ? <ShipmentTable t={t} shipments={shipments.filter((shipment) => shipment.assignedAgentId === linkedCourier.id)} selectedIds={new Set()} onToggle={() => undefined} canSelect={false} profileNameById={profileNameById} agentNameById={agentNameById} onStatus={openStatusDialog} onTransfer={openTransferDialog} onReceiveReturn={openReturnReceiptDialog} onEditAndRedispatch={openEditAndRedispatchDialog} canAdminEditAndRedispatch={canAdminEditAndRedispatch} canReceiveReturn={canAdminEditAndRedispatch} onRequestCodChange={openCodAdjustmentRequest} onReviewCodChange={openCodAdjustmentReview} pendingCodAdjustmentByShipment={pendingCodAdjustmentByShipment} approvedCodAdjustmentByShipment={approvedCodAdjustmentByShipment} onCorrectDeliveredCod={openDeliveredCodCorrection} deliveredCodCorrectionShipmentIds={deliveredCodCorrectionShipmentIds} onCorrectDeliveredRecipientPayout={openDeliveredRecipientPayoutCorrection} deliveredRecipientPayoutCorrectionShipmentIds={deliveredRecipientPayoutCorrectionShipmentIds} canCorrectDeliveredCod={isAdmin} onRequestRecipientPayoutChange={openRecipientPayoutAdjustmentRequest} onReviewRecipientPayoutChange={openRecipientPayoutAdjustmentReview} pendingRecipientPayoutAdjustmentByShipment={pendingRecipientPayoutAdjustmentByShipment} approvedRecipientPayoutAdjustmentByShipment={approvedRecipientPayoutAdjustmentByShipment} canRequestCodChange={user?.role === "staff" && !!linkedCourier} requesterCourierId={linkedCourier.id} canReviewCodChange={isAdmin} onOpenSettlementNet={setSettlementNetTarget} onOpenPostSettlements={openPostSettlementDialog} onPlayVoiceReason={setVoicePlaybackEvent} voiceReasonEventByShipment={voiceReasonEventByShipment} canPlayVoiceReason={isAdmin} canSettle={canSettle} canTransfer={canDispatch} canUpdate={isEditor} iqdPreference={features.iqd_display_preference} handoverStatusByShipment={courierHandoverStatuses} payoutStatusByShipment={merchantPayoutStatuses} courierReimbursementStatusByShipment={courierReimbursementStatuses} merchantRepaymentStatusByShipment={merchantRepaymentStatuses} settlementNetByShipment={perShipmentSettlementNet} recipientPayoutAdjustmentBusyShipmentIds={recipientPayoutAdjustmentBusyShipmentIds} /> : <div className="py-10 text-center text-sm text-muted-foreground">{t("postService.empty.noLinkedCourier")}</div>}</CardContent></Card></TabsContent>
      <TabsContent value="merchants" className="mt-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between"><CardTitle>{t("postService.cards.deliveryMerchants")}</CardTitle>{isAdmin && <Button size="sm" onClick={() => setMerchantDialogOpen(true)}><Plus className="me-2 h-4 w-4" />{t("postService.actions.enableMerchant")}</Button>}</CardHeader>
<CardContent className="overflow-x-auto">
            <div className="relative mb-4"><Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={merchantSearchQuery} onChange={(event) => setMerchantSearchQuery(event.target.value)} className="ps-9" placeholder={t("postService.placeholders.searchMerchants")} /></div>
            <Table>
              <TableHeader><TableRow><TableHead>{t("postService.table.merchant")}</TableHead><TableHead>{t("postService.table.defaultFee")}</TableHead><TableHead>{t("postService.table.feePayer")}</TableHead><TableHead>{t("postService.table.payoutSchedule")}</TableHead><TableHead>{t("postService.table.posts")}</TableHead><TableHead>{t("postService.table.merchantBalance")}</TableHead><TableHead>{t("postService.table.status")}</TableHead><TableHead className="text-end">{t("postService.table.actions")}</TableHead></TableRow></TableHeader>
              <TableBody>
                {merchantProfiles.length === 0 ? <EmptyRow columns={8} label={t("postService.empty.noMerchants")} /> : searchedMerchants.length === 0 ? <EmptyRow columns={8} label={t("postService.empty.noMerchantSearchResults")} /> : searchedMerchants.map((profile) => {
                  const merchantName = profileNameById.get(profile.id) ?? t("postService.unknownMerchant");
                  const merchantPosts = (merchantSettlementPostsByProfile.get(profile.id) ?? []).slice().reverse();
                  const expanded = expandedMerchantIds.has(profile.id);
                  return (
                    <Fragment key={profile.id}>
                      <TableRow>
                        <TableCell>
                          <button type="button" className="flex items-center gap-2 font-medium hover:underline" aria-expanded={expanded} title={t("postService.actions.settlements")} onClick={() => toggleMerchantSettlement(profile.id)}>
                            <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
                            {merchantName}
                          </button>
                        </TableCell>
                        <TableCell>{formatCurrency(profile.defaultFeeAmount, features.default_currency, features.iqd_display_preference)}</TableCell>
                        <TableCell>{t(`postService.feePayer.${profile.defaultFeePayer}`)}</TableCell>
                        <TableCell>{t(`postService.payoutSchedule.${profile.payoutSchedule}`)}</TableCell>
                        <TableCell><Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => openPartyPostsDialog({ kind: "merchant", id: profile.id, name: merchantName })}><ClipboardList className="h-4 w-4" />{t("postService.actions.viewPosts")}</Button></TableCell>
                        <TableCell><MerchantAccountBalanceAmounts t={t} balances={merchantAccountBalancesByProfile.get(profile.id) ?? []} iqdPreference={features.iqd_display_preference} /></TableCell>
                        <TableCell><Badge variant="outline" className={profile.isActive ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : "text-muted-foreground"}>{t(profile.isActive ? "postService.active" : "postService.inactive")}</Badge></TableCell>
                        <TableCell className="text-end">
                          <div className="flex flex-wrap justify-end gap-1">
                            {canSettle && (merchantPayablesByProfile.get(profile.id) ?? []).map((payable) => <Button key={`payout-${payable.currency}`} type="button" size="sm" className="gap-1.5" onClick={() => openSettlement({ kind: "merchant", id: profile.id, currency: payable.currency, amount: payable.amount, name: merchantName })}><Banknote className="h-4 w-4" />{t("postService.actions.payMerchant")}<span className="tabular-nums">{formatCurrency(payable.amount, payable.currency, features.iqd_display_preference)}</span></Button>)}
                            {canSettle && (merchantRepaymentsByProfile.get(profile.id) ?? []).map((repayment) => <Button key={`repayment-${repayment.currency}`} type="button" size="sm" variant="outline" className="gap-1.5 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300" onClick={() => openMerchantRepayment({ id: profile.id, currency: repayment.currency, amount: repayment.amount, name: merchantName })}><HandCoins className="h-4 w-4" />{t("postService.actions.receiveMerchantRepayment")}<span className="tabular-nums">{formatCurrency(repayment.amount, repayment.currency, features.iqd_display_preference)}</span></Button>)}
                            {isEditor && <><Button type="button" size="icon" variant="ghost" title={t("postService.actions.editMerchant")} onClick={() => openMerchantEditor(profile)}><Pencil className="h-4 w-4" /></Button><Button type="button" size="icon" variant="ghost" className="text-destructive hover:text-destructive" title={t("postService.actions.deleteMerchant")} onClick={() => setMerchantDeleteTarget(profile)}><Trash2 className="h-4 w-4" /></Button></>}
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && (merchantPosts.length === 0 ? (
                        <TableRow className="bg-muted/30"><TableCell colSpan={8} className="ps-10 text-xs text-muted-foreground">{t("postService.empty.noBalances")}</TableCell></TableRow>
                      ) : merchantPosts.map((post) => {
                        const isRepayment = post.direction === "repayment";
                        return (
                        <TableRow key={`${post.direction}:${post.currency}:${post.shipmentId}`} className="bg-muted/30">
                          <TableCell className="ps-10 text-xs font-medium">{shipmentLabelById.get(post.shipmentId) ?? "—"}</TableCell>
                          <TableCell colSpan={4} className="text-xs text-muted-foreground">{t(isRepayment ? "postService.form.amountReceived" : "postService.table.paid")}: <span className="font-medium tabular-nums text-foreground">{formatCurrency(post.paid, post.currency, features.iqd_display_preference)}</span></TableCell>
                          <TableCell className="text-xs font-medium tabular-nums">{formatCurrency(post.outstanding, post.currency, features.iqd_display_preference)}</TableCell>
                          <TableCell />
                          <TableCell className="text-end">{canSettle && post.outstanding > 0.000001 && (isRepayment ? <Button type="button" size="sm" variant="outline" className="gap-1.5 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300" onClick={() => openMerchantRepayment({ id: profile.id, currency: post.currency, amount: post.outstanding, name: merchantName, shipmentId: post.shipmentId, shipmentLabel: shipmentLabelById.get(post.shipmentId) ?? "" })}><HandCoins className="h-4 w-4" />{t("postService.actions.receiveMerchantRepayment")}</Button> : <Button type="button" size="sm" variant="outline" onClick={() => openPostSettlement({ kind: "merchant", id: profile.id, currency: post.currency, name: merchantName }, post)}>{t("postService.actions.payMerchant")}</Button>)}</TableCell>
                        </TableRow>
                        );
                      }))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="courier" className="mt-4">
        <CourierRegistry
          t={t}
          couriers={searchedCouriers}
          search={courierSearchQuery}
          onSearchChange={setCourierSearchQuery}
          breakdownByParty={courierBreakdownByParty}
          shipmentLabelById={shipmentLabelById}
          iqdPreference={features.iqd_display_preference}
          canSettle={canSettle}
          canManage={isEditor}
          onAddCourier={openAddCourier}
          onEditCourier={openEditCourier}
          onSettleParty={openSettlement}
          onSettlePost={openPostSettlement}
          onReimburseCourier={openCourierReimbursement}
          onReimburseCourierCollectively={openCollectiveCourierReimbursement}
          onOpenPosts={openPartyPostsDialog}
        />
      </TabsContent>
      <TabsContent value="settlements" className="mt-4 space-y-4"><SettlementBalances t={t} title={t("postService.cards.courierHandovers")} icon={WalletCards} kind="courier" balances={courierBalances} breakdownByParty={courierBreakdownByParty} shipmentLabelById={shipmentLabelById} obligationLabel={t("postService.table.collected")} getName={(id) => agentNameById.get(id) ?? t("postService.unknownCourier")} action={t("postService.actions.recordHandover")} canSettle={canSettle} onSettleParty={openSettlement} onSettlePost={openPostSettlement} iqdPreference={features.iqd_display_preference} /><CourierPayableBalances t={t} payables={courierPayables} shipmentLabelById={shipmentLabelById} getName={(id) => agentNameById.get(id) ?? t("postService.unknownCourier")} canSettle={canSettle} onPay={openCourierReimbursement} iqdPreference={features.iqd_display_preference} /><SettlementBalances t={t} title={t("postService.cards.merchantPayouts")} icon={CircleDollarSign} kind="merchant" balances={merchantBalances} breakdownByParty={merchantBreakdownByParty} shipmentLabelById={shipmentLabelById} obligationLabel={t("postService.table.paid")} getName={(id) => profileNameById.get(id) ?? t("postService.unknownMerchant")} action={t("postService.actions.payMerchant")} canSettle={canSettle} onSettleParty={openSettlement} onSettlePost={openPostSettlement} iqdPreference={features.iqd_display_preference} /><Card><CardHeader><CardTitle>{t("postService.cards.settlementHistory")}</CardTitle></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t("postService.table.reference")}</TableHead><TableHead>{t("postService.table.type")}</TableHead><TableHead>{t("postService.table.amount")}</TableHead><TableHead>{t("postService.table.time")}</TableHead></TableRow></TableHeader><TableBody>{settlements.length === 0 ? <EmptyRow columns={4} label={t("postService.empty.noSettlements")} /> : settlements.slice(0, 20).map((settlement) => <TableRow key={settlement.id}><TableCell className="font-medium">{settlement.settlementNumber}</TableCell><TableCell>{t(`postService.settlementType.${settlement.type === "courier_remittance" ? "courierRemittance" : settlement.type === "courier_fee_payout" ? "courierFeePayout" : settlement.type === "courier_reimbursement" ? "courierReimbursement" : settlement.type === "merchant_repayment" ? "merchantRepayment" : "merchantPayout"}`)}</TableCell><TableCell>{formatCurrency(settlement.actualAmount, settlement.currency, features.iqd_display_preference)}</TableCell><TableCell>{formatDateTime(settlement.settledAt)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></TabsContent>
      </>}
    </Tabs>
    <AppDialog open={!!partyPostsDialogTarget} onOpenChange={(open) => { if (!open) setPartyPostsDialogTarget(null); }}>
      <AppDialogContent className="max-w-5xl lg:w-[calc(100vw-2rem)] lg:max-w-[1440px]">
        <AppDialogHeader>
          <AppDialogTitle>{partyPostsDialogTarget && t("postService.dialogs.partyPosts.title", { name: partyPostsDialogTarget.name })}</AppDialogTitle>
          <AppDialogDescription>{partyPostsDialogTarget && t("postService.dialogs.partyPosts.description", { name: partyPostsDialogTarget.name })}</AppDialogDescription>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <Tabs value={partyPostsTab} onValueChange={(value) => { setPartyPostsTab(value as PartyPostsTab); setExpandedPartyPostStatus(null); }}>
            <TabsList>
              <TabsTrigger value="available"><Inbox className="me-2 h-4 w-4" />{t("postService.dialogs.partyPosts.available")}</TabsTrigger>
              <TabsTrigger value="done"><PackageCheck className="me-2 h-4 w-4" />{t("postService.dialogs.partyPosts.done")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <DateRangeFilters
              className="w-max min-w-max"
              showYesterday
              dateRange={partyPostsDateRange}
              customDates={partyPostsCustomDates}
              onDateRangeChange={setPartyPostsDateRange}
              onCustomDatesChange={setPartyPostsCustomDates}
            />
          </div>
          <div className="space-y-2">
            {partyPostStatusGroups.length === 0 ? <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{t("postService.empty.noPartyPosts", { status: t(`postService.dialogs.partyPosts.${partyPostsTab}`) })}</p> : partyPostStatusGroups.map(({ status, shipments: statusShipments }) => <PartyPostsStatusGroup key={status} t={t} status={status} shipments={statusShipments} partyKind={partyPostsDialogTarget?.kind ?? "merchant"} profileNameById={profileNameById} agentNameById={agentNameById} iqdPreference={features.iqd_display_preference} expanded={expandedPartyPostStatus === status} onToggle={togglePartyPostStatus} />)}
          </div>
        </AppDialogBody>
        <AppDialogFooter><Button type="button" variant="outline" onClick={() => setPartyPostsDialogTarget(null)}>{t("common.close")}</Button></AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!transferTarget} onOpenChange={(open) => { if (!open) closeTransferDialog(); }}>
      <AppDialogContent className="max-w-2xl">
        <form onSubmit={handleTransferPost} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.transferPost.title")}</AppDialogTitle>
            <AppDialogDescription>{transferTarget && t("postService.dialogs.transferPost.description", { trackingNumber: transferTarget.trackingNumber, recipient: transferTarget.recipientPhone })}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="grid gap-4 py-5 md:grid-cols-2">
            <Field label={t("postService.form.courier")}>
              <Select value={transferAgentId} onValueChange={handleTransferCourierChange}>
                <SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectCourier")} /></SelectTrigger>
                <SelectContent>{agents.filter((agent) => agent.status === "active" && agent.agentType === "courier" && agent.id !== transferTarget?.assignedAgentId).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentNameById.get(agent.id) ?? t("postService.unknownCourier")} · {agent.zone}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={t("postService.form.courierDeliveryFee")}>
              <div className="grid gap-1">
                <div className="relative"><Input className="pe-12" value={formatNumericInput(transferCourierDeliveryFee)} onChange={(event) => setTransferCourierDeliveryFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" disabled={!transferAgentId} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(features.default_currency, features.iqd_display_preference)}</span></div>
                <p className="text-xs text-muted-foreground">{t("postService.form.courierDeliveryFeeHint")}</p>
              </div>
            </Field>
            <Field label={t("postService.form.vehicleOptional")}>
              <Select value={transferVehicleId} onValueChange={setTransferVehicleId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">{t("postService.options.noVehicle")}</SelectItem>{vehicles.filter((vehicle) => vehicle.status === "active").map((vehicle) => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.model}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={t("postService.form.manifestNote")}><Input value={transferNotes} onChange={(event) => setTransferNotes(event.target.value)} placeholder={t("postService.placeholders.manifestNote")} /></Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={closeTransferDialog}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isTransferring || !transferAgentId}><Send className="h-4 w-4" />{t("postService.actions.transferPost")}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!returnReceiptTarget} onOpenChange={(open) => { if (!open) closeReturnReceiptDialog(); }}>
      <AppDialogContent
        className="max-w-xl"
        showCloseButton={!isReceivingReturn}
        onPointerDownOutside={(event) => { if (isReceivingReturn) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isReceivingReturn) event.preventDefault(); }}
      >
        <form onSubmit={handleReturnReceipt} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.returnReceipt.title")}</AppDialogTitle>
            <AppDialogDescription>{returnReceiptTarget && t("postService.dialogs.returnReceipt.description", { trackingNumber: returnReceiptTarget.trackingNumber })}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <Field label={t("postService.form.optionalNote")}>
              <Textarea value={returnReceiptNote} onChange={(event) => setReturnReceiptNote(event.target.value)} placeholder={t("postService.placeholders.deliveryNote")} disabled={isReceivingReturn} />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isReceivingReturn} onClick={closeReturnReceiptDialog}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isReceivingReturn} aria-busy={isReceivingReturn}>
              <PackageCheck className="h-4 w-4" />{isReceivingReturn ? t("common.processing") : t("postService.actions.receiveReturn")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <Dialog open={merchantDialogOpen} onOpenChange={setMerchantDialogOpen}>
      <DialogContent layout="structured" className="sm:max-w-lg">
        <DialogHeader layout="structured">
          <DialogTitle>{t("postService.dialogs.enableMerchant.title")}</DialogTitle>
          <DialogDescription>{t("postService.dialogs.enableMerchant.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreateMerchant} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="grid gap-4 py-5">
            <Field label={t("postService.form.businessPartner")} isLoading={partners.isLoading}>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <PartnerAutocompleteInput
                    value={merchantName}
                    onChange={(value) => { setMerchantName(value); setSelectedMerchantPartner((current) => current && value.trim() !== current.partnerName ? null : current); }}
                    onSelectPartner={(partner: BusinessPartner) => { setSelectedMerchantPartner(partner); setMerchantName(partner.partnerName); }}
                    workspaceId={workspaceId}
                    placeholder={t("postService.placeholders.selectMerchantOrShop")}
                    excludePartnerIds={enabledMerchantPartnerIds}
                    isLoading={partners.isLoading}
                    className="flex-1"
                  />
                  <AddPartnerButton onClick={() => setSupplierPartnerDialogOpen(true)} label={t("postService.actions.addBusinessPartner")} />
                </div>
                {selectedMerchantPartner ? <LinkedMerchantBadge t={t} name={selectedMerchantPartner.partnerName} onClear={() => { setSelectedMerchantPartner(null); setMerchantName(""); }} /> : null}
              </div>
            </Field>
            <Field label={t("postService.form.defaultDeliveryFee")}><div className="relative"><Input className="pe-12" value={formatNumericInput(merchantFee)} onChange={(event) => setMerchantFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" required /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(features.default_currency, features.iqd_display_preference)}</span></div></Field>
            <Field label={t("postService.form.feePayer")}>
              <Select value={merchantFeePayer} onValueChange={(value: "merchant" | "recipient") => setMerchantFeePayer(value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="merchant">{t("postService.feePayer.merchantDeducted")}</SelectItem>
                  <SelectItem value="recipient">{t("postService.feePayer.recipientCollected")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("postService.form.payoutSchedule")}>
              <Select value={merchantPayoutSchedule} onValueChange={(value: "daily" | "weekly" | "on_request") => setMerchantPayoutSchedule(value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">{t("postService.payoutSchedule.daily")}</SelectItem>
                  <SelectItem value="weekly">{t("postService.payoutSchedule.weekly")}</SelectItem>
                  <SelectItem value="on_request">{t("postService.payoutSchedule.on_request")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter layout="structured">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setMerchantDialogOpen(false)}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={isSubmitting || !selectedMerchantPartner || !merchantFee}>{t("postService.actions.enableMerchant")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={merchantEditDialogOpen} onOpenChange={(open) => { setMerchantEditDialogOpen(open); if (!open) setEditingMerchantProfile(null); }}>
      <DialogContent layout="structured" className="sm:max-w-lg">
        <DialogHeader layout="structured">
          <DialogTitle>{t("postService.dialogs.editMerchant.title")}</DialogTitle>
          <DialogDescription>{editingMerchantProfile && t("postService.dialogs.editMerchant.description", { name: profileNameById.get(editingMerchantProfile.id) })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleUpdateMerchant} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="grid gap-4 py-5">
            <Field label={t("postService.form.defaultDeliveryFee")}><div className="relative"><Input className="pe-12" value={formatNumericInput(merchantFee)} onChange={(event) => setMerchantFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" required /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(features.default_currency, features.iqd_display_preference)}</span></div></Field>
            <Field label={t("postService.form.feePayer")}><Select value={merchantFeePayer} onValueChange={(value: "merchant" | "recipient") => setMerchantFeePayer(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="merchant">{t("postService.feePayer.merchantDeducted")}</SelectItem><SelectItem value="recipient">{t("postService.feePayer.recipientCollected")}</SelectItem></SelectContent></Select></Field>
            <Field label={t("postService.form.payoutSchedule")}><Select value={merchantPayoutSchedule} onValueChange={(value: "daily" | "weekly" | "on_request") => setMerchantPayoutSchedule(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="daily">{t("postService.payoutSchedule.daily")}</SelectItem><SelectItem value="weekly">{t("postService.payoutSchedule.weekly")}</SelectItem><SelectItem value="on_request">{t("postService.payoutSchedule.on_request")}</SelectItem></SelectContent></Select></Field>
            <Field label={t("postService.form.status")}><Select value={editingMerchantProfile?.isActive ? "active" : "inactive"} onValueChange={(value: "active" | "inactive") => setEditingMerchantProfile((current) => current ? { ...current, isActive: value === "active" } : current)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">{t("postService.active")}</SelectItem><SelectItem value="inactive">{t("postService.inactive")}</SelectItem></SelectContent></Select></Field>
          </DialogBody>
          <DialogFooter layout="structured"><Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setMerchantEditDialogOpen(false)}>{t("postService.actions.cancel")}</Button><Button type="submit" className="w-full sm:w-auto" disabled={isSubmitting || !merchantFee}>{t("postService.actions.saveMerchant")}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <DeleteConfirmationModal
      isOpen={!!merchantDeleteTarget}
      onClose={() => setMerchantDeleteTarget(null)}
      onConfirm={handleDeleteMerchant}
      isLoading={isDeletingMerchant}
      itemName={merchantDeleteTarget ? profileNameById.get(merchantDeleteTarget.id) : ""}
      title={t("postService.dialogs.deleteMerchant.title")}
      description={t("postService.dialogs.deleteMerchant.description")}
    />
    <BusinessPartnerFormDialog
      isOpen={supplierPartnerDialogOpen}
      onOpenChange={setSupplierPartnerDialogOpen}
      defaultCurrency={features.default_currency}
      availableCurrencies={currencies}
      initialRole="supplier"
      workspaceId={workspaceId}
      isSaving={isSavingSupplierPartner}
      title={t("postService.dialogs.addBusinessPartner.title", { defaultValue: "Add Business Partner" })}
      submitLabel={t("postService.actions.addBusinessPartner")}
      onSubmit={handleCreateSupplierPartner}
    />
    <BusinessPartnerFormDialog
      isOpen={agentDialogOpen}
      onOpenChange={(open) => { setAgentDialogOpen(open); if (!open) setEditingAgentPartner(null); }}
      partner={editingAgentPartner}
      defaultCurrency={features.default_currency}
      availableCurrencies={currencies}
      initialRole="agent"
      lockedRole="agent"
      initialAgentType="courier"
      enableAgentRole={true}
      workspaceId={workspaceId}
      isSaving={isSavingAgent}
      title={editingAgentPartner
        ? t("postService.dialogs.editCourier.title", { defaultValue: "Edit Courier" })
        : t("postService.dialogs.addCourier.title", { defaultValue: "Add Courier" })}
      onSubmit={handleAgentSubmit}
    />
    <AppDialog open={shipmentDialogOpen} onOpenChange={(open) => { if (!open) closeShipmentFlow(); else setShipmentDialogOpen(true); }}>
      <AppDialogContent
        className="max-w-3xl"
        showCloseButton={!isSubmitting}
        onPointerDownOutside={(event) => { if (isSubmitting) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { event.preventDefault(); if (!isSubmitting) closeShipmentFlow(); }}
      >
        <form onSubmit={handleCreatePost} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.newPost.title")}</AppDialogTitle>
            <AppDialogDescription>{t("postService.dialogs.newPost.description")}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="grid gap-4 py-5 sm:grid-cols-2">
            <Field label={t("postService.form.merchant")}><Select value={shipmentForm.merchantProfileId} onValueChange={(value) => { const profile = profileById.get(value); updateShipmentForm("merchantProfileId", value); if (profile) { updateShipmentForm("deliveryFee", String(profile.defaultFeeAmount)); updateShipmentForm("feePayer", profile.defaultFeePayer); } }} disabled={isSubmitting}><SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectMerchant")} /></SelectTrigger><SelectContent>{merchantProfiles.filter((profile) => profile.isActive).map((profile) => <SelectItem key={profile.id} value={profile.id}>{profileNameById.get(profile.id)}</SelectItem>)}</SelectContent></Select></Field>
            <Field label={t("postService.form.recipientPhone")}><Input required inputMode="tel" autoComplete="tel" value={shipmentForm.recipientPhone} onChange={(event) => updateShipmentForm("recipientPhone", event.target.value)} disabled={isSubmitting} /></Field>
            <div className="sm:col-span-2"><Field label={t("postService.form.deliveryAddress")}><Textarea required value={shipmentForm.recipientAddress} onChange={(event) => updateShipmentForm("recipientAddress", event.target.value)} disabled={isSubmitting} /></Field></div>
            <Field label={t("postService.form.description")}><Input value={shipmentForm.description} onChange={(event) => updateShipmentForm("description", event.target.value)} placeholder={t("postService.placeholders.parcelDescription")} disabled={isSubmitting} /></Field>
            <CurrencySelector value={shipmentForm.currency} onChange={(value: CurrencyCode) => updateShipmentForm("currency", value)} label={t("postService.form.currency")} iqdDisplayPreference={features.iqd_display_preference} allowedCurrencies={currencies} disabled={isSubmitting} />
            <Field label={t("postService.form.customerPaymentStatus")}><Select value={shipmentForm.customerPaymentStatus} onValueChange={handleCustomerPaymentStatusChange} disabled={isSubmitting}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash_on_delivery">{t("postService.customerPaymentStatus.cash_on_delivery")}</SelectItem><SelectItem value="prepaid_electronically">{t("postService.customerPaymentStatus.prepaid_electronically")}</SelectItem></SelectContent></Select></Field>
            <Field label={t("postService.form.codAmount")}><div className="space-y-1.5"><div className="relative"><Input className="pe-12" value={formatNumericInput(shipmentForm.codAmount)} onChange={(event) => updateShipmentForm("codAmount", sanitizeNumericInput(event.target.value, { allowDecimal: shipmentForm.currency !== "iqd" }))} inputMode={shipmentForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting || shipmentForm.customerPaymentStatus === "prepaid_electronically"} aria-invalid={!isCodAmountValid} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(shipmentForm.currency, features.iqd_display_preference)}</span></div>{shipmentForm.customerPaymentStatus === "cash_on_delivery" && !isCodAmountValid ? <p className="text-xs text-destructive">{t("postService.errors.cashOnDeliveryCodRequired")}</p> : null}</div></Field>
            {showRecipientPayout || shipmentForm.customerPaymentStatus === "prepaid_electronically" ? <div className="space-y-3 sm:col-span-2"><div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><div className="flex items-center justify-between gap-2"><Label>{t("postService.form.recipientPayoutAmount")}</Label>{shipmentForm.customerPaymentStatus === "cash_on_delivery" ? <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground" disabled={isSubmitting} onClick={() => { updateShipmentForm("recipientPayoutAmount", ""); setShowRecipientPayout(false); }}><X className="h-3.5 w-3.5" />{t("common.remove")}</Button> : null}</div><div className="relative"><Input className="pe-12" value={formatNumericInput(shipmentForm.recipientPayoutAmount)} onChange={(event) => updateShipmentForm("recipientPayoutAmount", sanitizeNumericInput(event.target.value, { allowDecimal: shipmentForm.currency !== "iqd" }))} inputMode={shipmentForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(shipmentForm.currency, features.iqd_display_preference)}</span></div></div><Field label={t("postService.form.recipientPayoutFunding")}><Select value={shipmentForm.recipientPayoutFunding} onValueChange={(value: DeliveryRecipientPayoutFunding) => updateShipmentForm("recipientPayoutFunding", value)} disabled={isSubmitting}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="courier_advance">{t("postService.recipientPayoutFunding.courier_advance")}</SelectItem><SelectItem value="workspace_payment">{t("postService.recipientPayoutFunding.workspace_payment")}</SelectItem></SelectContent></Select></Field></div><p className="text-xs text-muted-foreground">{t(`postService.form.recipientPayoutFundingHint.${shipmentForm.recipientPayoutFunding}`)}</p></div> : <Button type="button" variant="outline" className="h-auto min-h-10 justify-start gap-2 border-dashed text-muted-foreground hover:text-foreground" disabled={isSubmitting} onClick={() => setShowRecipientPayout(true)}><HandCoins className="h-4 w-4" />{t("postService.actions.addRecipientPayout")}</Button>}
            <Field label={t("postService.form.deliveryFee")}><div className="relative"><Input className="pe-12" value={formatNumericInput(shipmentForm.deliveryFee)} onChange={(event) => updateShipmentForm("deliveryFee", sanitizeNumericInput(event.target.value, { allowDecimal: shipmentForm.currency !== "iqd" }))} inputMode={shipmentForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(shipmentForm.currency, features.iqd_display_preference)}</span></div></Field>
            <Field label={t("postService.form.feePayer")}><Select value={shipmentForm.feePayer} onValueChange={(value: "merchant" | "recipient") => updateShipmentForm("feePayer", value)} disabled={isSubmitting}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="merchant">{t("postService.feePayer.merchant")}</SelectItem><SelectItem value="recipient">{t("postService.feePayer.recipient")}</SelectItem></SelectContent></Select></Field>
            <div className="sm:col-span-2 rounded-xl border bg-muted/30 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1"><p className="flex items-center gap-2 text-sm font-semibold"><Send className="h-4 w-4" />{t("postService.dialogs.newPost.dispatchDetails")}</p><p className="text-xs text-muted-foreground">{t("postService.dialogs.newPost.dispatchNowDescription")}</p></div>
                <div className="flex shrink-0 items-center gap-2"><Label htmlFor="new-post-dispatch" className="text-sm font-medium">{t("postService.dialogs.newPost.dispatchNow")}</Label><Switch id="new-post-dispatch" checked={newPostDispatchEnabled} onCheckedChange={setNewPostDispatchEnabled} disabled={isSubmitting || !canDispatch} /></div>
              </div>
              <div className={cn("mt-4 grid gap-4 transition-opacity sm:grid-cols-2", !newPostDispatchEnabled && "opacity-50")} aria-disabled={!newPostDispatchEnabled}>
                <Field label={t("postService.form.courier")}><Select value={newPostDispatchAgentId} onValueChange={handleNewPostDispatchCourierChange} disabled={isSubmitting || !newPostDispatchEnabled}><SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectCourier")} /></SelectTrigger><SelectContent>{agents.filter((agent) => agent.status === "active" && agent.agentType === "courier").map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentNameById.get(agent.id) ?? t("postService.unknownCourier")} · {agent.zone}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={t("postService.form.courierDeliveryFee")}><div className="grid gap-1"><div className="relative"><Input className="pe-12" value={formatNumericInput(newPostCourierDeliveryFee)} onChange={(event) => setNewPostCourierDeliveryFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" disabled={isSubmitting || !newPostDispatchEnabled || !newPostDispatchAgentId} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(shipmentForm.currency, features.iqd_display_preference)}</span></div><p className="text-xs text-muted-foreground">{t("postService.form.courierDeliveryFeeHint")}</p></div></Field>
                <Field label={t("postService.form.vehicleOptional")}><Select value={newPostVehicleId} onValueChange={setNewPostVehicleId} disabled={isSubmitting || !newPostDispatchEnabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("postService.options.noVehicle")}</SelectItem>{vehicles.filter((vehicle) => vehicle.status === "active").map((vehicle) => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.model}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={t("postService.form.dispatchNote")}><Input value={newPostDispatchNotes} onChange={(event) => setNewPostDispatchNotes(event.target.value)} placeholder={t("postService.placeholders.manifestNote")} disabled={isSubmitting || !newPostDispatchEnabled} /></Field>
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isSubmitting} onClick={() => closeShipmentFlow()}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isSubmitting || !isNewPostFormValid}>{newPostDispatchEnabled ? <Send className="h-4 w-4" /> : <PackageCheck className="h-4 w-4" />}{isSubmitting ? (newPostDispatchEnabled ? t("postService.actions.creatingAndAssigning") : t("common.processing")) : (newPostDispatchEnabled ? t("postService.actions.createPostAndAssign") : t("postService.actions.createPost"))}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!editRedispatchTarget} onOpenChange={(open) => { if (!open) closeEditAndRedispatchDialog(); }}>
      <AppDialogContent
        className="max-w-3xl"
        showCloseButton={!isSubmitting}
        onPointerDownOutside={(event) => { if (isSubmitting) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { event.preventDefault(); if (!isSubmitting) closeEditAndRedispatchDialog(); }}
      >
        <form onSubmit={handleEditAndRedispatchPost} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t(isEditingReceivedPost ? "postService.dialogs.editAndDispatch.title" : "postService.dialogs.editAndRedispatch.title")}</AppDialogTitle>
            <AppDialogDescription>{t(isEditingReceivedPost ? "postService.dialogs.editAndDispatch.description" : "postService.dialogs.editAndRedispatch.description", { trackingNumber: editRedispatchTarget?.trackingNumber })}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="grid gap-4 py-5 sm:grid-cols-2">
            <Field label={t("postService.form.merchant")}>
              <Select value={editRedispatchForm.merchantProfileId} onValueChange={(value) => { const profile = profileById.get(value); updateEditRedispatchForm("merchantProfileId", value); if (profile) { updateEditRedispatchForm("deliveryFee", String(profile.defaultFeeAmount)); updateEditRedispatchForm("feePayer", profile.defaultFeePayer); } }} disabled={isSubmitting}>
                <SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectMerchant")} /></SelectTrigger>
                <SelectContent>{merchantProfiles.filter((profile) => profile.isActive).map((profile) => <SelectItem key={profile.id} value={profile.id}>{profileNameById.get(profile.id)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={t("postService.form.recipientPhone")}><Input required inputMode="tel" autoComplete="tel" value={editRedispatchForm.recipientPhone} onChange={(event) => updateEditRedispatchForm("recipientPhone", event.target.value)} disabled={isSubmitting} /></Field>
            <div className="sm:col-span-2"><Field label={t("postService.form.deliveryAddress")}><Textarea required value={editRedispatchForm.recipientAddress} onChange={(event) => updateEditRedispatchForm("recipientAddress", event.target.value)} disabled={isSubmitting} /></Field></div>
            <Field label={t("postService.form.description")}><Input value={editRedispatchForm.description} onChange={(event) => updateEditRedispatchForm("description", event.target.value)} placeholder={t("postService.placeholders.parcelDescription")} disabled={isSubmitting} /></Field>
            <CurrencySelector value={editRedispatchForm.currency} onChange={(value: CurrencyCode) => updateEditRedispatchForm("currency", value)} label={t("postService.form.currency")} iqdDisplayPreference={features.iqd_display_preference} allowedCurrencies={currencies} disabled={isSubmitting || hasPendingCodDetailsForEdit} />
            <Field label={t("postService.form.customerPaymentStatus")}>
              <Select value={editRedispatchForm.customerPaymentStatus} onValueChange={handleEditRedispatchCustomerPaymentStatusChange} disabled={isSubmitting || hasPendingCodDetailsForEdit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="cash_on_delivery">{t("postService.customerPaymentStatus.cash_on_delivery")}</SelectItem><SelectItem value="prepaid_electronically">{t("postService.customerPaymentStatus.prepaid_electronically")}</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label={t("postService.form.codAmount")}><div className="space-y-1.5"><div className="relative"><Input className="pe-12" value={formatNumericInput(editRedispatchForm.codAmount)} onChange={(event) => updateEditRedispatchForm("codAmount", sanitizeNumericInput(event.target.value, { allowDecimal: editRedispatchForm.currency !== "iqd" }))} inputMode={editRedispatchForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting || hasPendingCodDetailsForEdit || editRedispatchForm.customerPaymentStatus === "prepaid_electronically"} aria-invalid={!isEditRedispatchCodAmountValid} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(editRedispatchForm.currency, features.iqd_display_preference)}</span></div>{hasPendingCodDetailsForEdit ? <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300"><CircleDollarSign className="h-3.5 w-3.5 shrink-0" />{t("postService.form.codChangePendingLock")}</p> : editRedispatchForm.customerPaymentStatus === "cash_on_delivery" && !isEditRedispatchCodAmountValid ? <p className="text-xs text-destructive">{t("postService.errors.cashOnDeliveryCodRequired")}</p> : null}</div></Field>
            {showEditRecipientPayout || editRedispatchForm.customerPaymentStatus === "prepaid_electronically" ? <div className="space-y-3 sm:col-span-2"><div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><div className="flex items-center justify-between gap-2"><Label>{t("postService.form.recipientPayoutAmount")}</Label>{editRedispatchForm.customerPaymentStatus === "cash_on_delivery" ? <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground" disabled={isSubmitting} onClick={() => { updateEditRedispatchForm("recipientPayoutAmount", ""); setShowEditRecipientPayout(false); }}><X className="h-3.5 w-3.5" />{t("common.remove")}</Button> : null}</div><div className="relative"><Input className="pe-12" value={formatNumericInput(editRedispatchForm.recipientPayoutAmount)} onChange={(event) => updateEditRedispatchForm("recipientPayoutAmount", sanitizeNumericInput(event.target.value, { allowDecimal: editRedispatchForm.currency !== "iqd" }))} inputMode={editRedispatchForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(editRedispatchForm.currency, features.iqd_display_preference)}</span></div></div><Field label={t("postService.form.recipientPayoutFunding")}><Select value={editRedispatchForm.recipientPayoutFunding} onValueChange={(value: DeliveryRecipientPayoutFunding) => updateEditRedispatchForm("recipientPayoutFunding", value)} disabled={isSubmitting}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="courier_advance">{t("postService.recipientPayoutFunding.courier_advance")}</SelectItem><SelectItem value="workspace_payment">{t("postService.recipientPayoutFunding.workspace_payment")}</SelectItem></SelectContent></Select></Field></div><p className="text-xs text-muted-foreground">{t(`postService.form.recipientPayoutFundingHint.${editRedispatchForm.recipientPayoutFunding}`)}</p></div> : <Button type="button" variant="outline" className="h-auto min-h-10 justify-start gap-2 border-dashed text-muted-foreground hover:text-foreground" disabled={isSubmitting} onClick={() => setShowEditRecipientPayout(true)}><HandCoins className="h-4 w-4" />{t("postService.actions.addRecipientPayout")}</Button>}
            <Field label={t("postService.form.deliveryFee")}><div className="relative"><Input className="pe-12" value={formatNumericInput(editRedispatchForm.deliveryFee)} onChange={(event) => updateEditRedispatchForm("deliveryFee", sanitizeNumericInput(event.target.value, { allowDecimal: editRedispatchForm.currency !== "iqd" }))} inputMode={editRedispatchForm.currency === "iqd" ? "numeric" : "decimal"} placeholder="0" disabled={isSubmitting} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(editRedispatchForm.currency, features.iqd_display_preference)}</span></div></Field>
            <Field label={t("postService.form.feePayer")}><Select value={editRedispatchForm.feePayer} onValueChange={(value: "merchant" | "recipient") => updateEditRedispatchForm("feePayer", value)} disabled={isSubmitting}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="merchant">{t("postService.feePayer.merchant")}</SelectItem><SelectItem value="recipient">{t("postService.feePayer.recipient")}</SelectItem></SelectContent></Select></Field>
            <div className={cn("sm:col-span-2", isEditingReceivedPost ? "rounded-xl border bg-muted/30 p-4" : "border-t pt-4")}>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1"><p className="flex items-center gap-2 text-sm font-semibold"><Send className="h-4 w-4" />{t(isEditingReceivedPost ? "postService.dialogs.editAndDispatch.dispatchDetails" : "postService.dialogs.editAndRedispatch.dispatchDetails")}</p>{isEditingReceivedPost ? <p className="text-xs text-muted-foreground">{t("postService.dialogs.editAndDispatch.dispatchNowDescription")}</p> : null}</div>
                {isEditingReceivedPost ? <div className="flex shrink-0 items-center gap-2"><Label htmlFor="edit-received-post-dispatch" className="text-sm font-medium">{t("postService.dialogs.editAndDispatch.dispatchNow")}</Label><Switch id="edit-received-post-dispatch" checked={editReceivedDispatchEnabled} onCheckedChange={setEditReceivedDispatchEnabled} disabled={isSubmitting || !canDispatch} /></div> : null}
              </div>
              <div className={cn("mt-4 grid gap-4 transition-opacity sm:grid-cols-2", isEditingReceivedPost && !editReceivedDispatchEnabled && "opacity-50")} aria-disabled={isEditingReceivedPost && !editReceivedDispatchEnabled}>
                <Field label={t("postService.form.courier")}><Select value={editRedispatchAgentId} onValueChange={handleEditRedispatchCourierChange} disabled={isSubmitting || (isEditingReceivedPost && !editReceivedDispatchEnabled)}><SelectTrigger><SelectValue placeholder={t("postService.placeholders.selectCourier")} /></SelectTrigger><SelectContent>{agents.filter((agent) => agent.status === "active" && agent.agentType === "courier").map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentNameById.get(agent.id) ?? t("postService.unknownCourier")} · {agent.zone}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={t("postService.form.courierDeliveryFee")}><div className="grid gap-1"><div className="relative"><Input className="pe-12" value={formatNumericInput(editRedispatchCourierDeliveryFee)} onChange={(event) => setEditRedispatchCourierDeliveryFee(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} inputMode="decimal" placeholder="0" disabled={isSubmitting || (isEditingReceivedPost && !editReceivedDispatchEnabled) || !editRedispatchAgentId} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(editRedispatchForm.currency, features.iqd_display_preference)}</span></div><p className="text-xs text-muted-foreground">{t("postService.form.courierDeliveryFeeHint")}</p></div></Field>
                <Field label={t("postService.form.vehicleOptional")}><Select value={editRedispatchVehicleId} onValueChange={setEditRedispatchVehicleId} disabled={isSubmitting || (isEditingReceivedPost && !editReceivedDispatchEnabled)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("postService.options.noVehicle")}</SelectItem>{vehicles.filter((vehicle) => vehicle.status === "active").map((vehicle) => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.model}</SelectItem>)}</SelectContent></Select></Field>
                <Field label={t("postService.form.dispatchNote")}><Input value={editRedispatchNotes} onChange={(event) => setEditRedispatchNotes(event.target.value)} placeholder={t("postService.placeholders.manifestNote")} disabled={isSubmitting || (isEditingReceivedPost && !editReceivedDispatchEnabled)} /></Field>
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isSubmitting} onClick={() => closeEditAndRedispatchDialog()}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isSubmitting || !isEditRedispatchFormValid}>{shouldDispatchEditedPost ? <Send className="h-4 w-4" /> : <PackageCheck className="h-4 w-4" />}{isSubmitting ? (shouldDispatchEditedPost ? t(editRedispatchTarget?.status !== "received" ? "postService.actions.redispatching" : "postService.actions.dispatching") : t("common.processing")) : (shouldDispatchEditedPost ? t(editRedispatchTarget?.status !== "received" ? "postService.actions.saveAndRedispatch" : "postService.actions.saveAndDispatch") : t("postService.actions.savePost"))}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!statusTarget} onOpenChange={(open) => { if (!open) closeStatusDialog(); }}>
      <AppDialogContent
        className="max-w-xl"
        showCloseButton={!isStatusDialogBusy}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { event.preventDefault(); if (!isStatusDialogBusy) closeStatusDialog(); }}
      >
        <AppDialogHeader>
          <AppDialogTitle>{t("postService.dialogs.status.title", { status: shipmentStatusLabel(t, nextStatus) })}</AppDialogTitle>
          <AppDialogDescription>{statusTarget?.trackingNumber} · {statusTarget?.recipientPhone}</AppDialogDescription>
        </AppDialogHeader>
        {nextStatus === "delivered" && <AppDialogBody className="space-y-4">
          {(statusTarget?.recipientPayoutAmount ?? 0) > 0.000001 ? <div className="space-y-4 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{t("postService.dialogs.recipientPayout.title")}</p><p className="mt-1 text-sm text-muted-foreground">{(statusTarget?.recipientPayoutFunding ?? "workspace_payment") === "courier_advance" ? t("postService.dialogs.recipientPayout.courierAdvanceDescription") : t("postService.dialogs.recipientPayout.description")}</p></div><Badge variant="outline" className="border-rose-500/30 bg-background text-rose-700 dark:text-rose-300">{formatCurrency(statusTarget!.recipientPayoutAmount, statusTarget!.currency, features.iqd_display_preference)}</Badge></div>
            {(statusTarget?.recipientPayoutFunding ?? "workspace_payment") === "workspace_payment" ? <div className="grid gap-4 sm:grid-cols-2"><Field label={t("postService.form.paymentMethod")}><PaymentMethodSelector value={recipientPayoutMethod} methods={STANDARD_PAYMENT_METHODS} workspaceId={workspaceId} disabled={isStatusDialogBusy} onValueChange={(method) => setRecipientPayoutMethod(method as StandardPaymentMethod)} onLinkedPaymentAccountSelect={setRecipientPayoutAccount} /></Field><PaymentAccountSelector workspaceId={workspaceId} value={recipientPayoutAccount?.id ?? null} onValueChange={setRecipientPayoutAccount} disabled={isStatusDialogBusy} cashDrawerOnly={recipientPayoutMethod === "cash"} /></div> : <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground"><HandCoins className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />{t("postService.dialogs.recipientPayout.courierAdvanceNotice")}</div>}
          </div> : null}
          <Field label={t("postService.form.optionalNote")}><Textarea value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder={t("postService.placeholders.deliveryNote")} /></Field>
        </AppDialogBody>}
        <AppDialogFooter>
          <Button type="button" variant="outline" disabled={isStatusDialogBusy} onClick={closeStatusDialog}>{t("postService.actions.cancel")}</Button>
          <Button type="button" disabled={isStatusDialogBusy} onClick={() => void handleStatusUpdate()}>{t("postService.actions.confirmStatus", { status: shipmentStatusLabel(t, nextStatus) })}</Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!codAdjustmentRequestTarget} onOpenChange={(open) => { if (!open) closeCodAdjustmentRequest(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isRequestingCodAdjustment}
        onPointerDownOutside={(event) => { if (isRequestingCodAdjustment) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isRequestingCodAdjustment) event.preventDefault(); }}
      >
        <form onSubmit={handleCodAdjustmentRequest} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.codChangeRequest.title")}</AppDialogTitle>
            <AppDialogDescription>{codAdjustmentRequestTarget?.trackingNumber} · {codAdjustmentRequestTarget?.recipientPhone}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">{t("postService.dialogs.codChangeRequest.currentCod")}: </span>
              <span className="font-semibold tabular-nums">{codAdjustmentRequestTarget ? formatCurrency(codAdjustmentRequestTarget.codAmount, codAdjustmentRequestTarget.currency, features.iqd_display_preference) : "—"}</span>
            </div>
            <Field label={t("postService.form.requestedCodAmount")}>
              <CurrencyAmountInput value={requestedCodAmount} onChange={setRequestedCodAmount} currency={codAdjustmentRequestTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isRequestingCodAdjustment} />
            </Field>
            <Field label={t("postService.form.reasonOptional")}>
              <Textarea value={codAdjustmentReason} onChange={(event) => setCodAdjustmentReason(event.target.value)} placeholder={t("postService.placeholders.codChangeReason")} disabled={isRequestingCodAdjustment} />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isRequestingCodAdjustment} onClick={closeCodAdjustmentRequest}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isRequestingCodAdjustment || !isCodAdjustmentRequestValid}><FilePenLine className="h-4 w-4" />{t("postService.actions.sendChangeRequest")}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!codAdjustmentReviewTarget} onOpenChange={(open) => { if (!open) closeCodAdjustmentReview(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isReviewingCodAdjustment}
        onPointerDownOutside={(event) => { if (isReviewingCodAdjustment) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isReviewingCodAdjustment) event.preventDefault(); }}
      >
        <AppDialogHeader>
          <AppDialogTitle>{t("postService.dialogs.codChangeReview.title")}</AppDialogTitle>
          <AppDialogDescription>{codAdjustmentReviewTarget && shipmentLabelById.get(codAdjustmentReviewTarget.shipmentId)}</AppDialogDescription>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-3 sm:grid-cols-2">
            <div><p className="text-xs font-medium text-muted-foreground">{t("postService.dialogs.codChangeReview.currentCod")}</p><p className="mt-1 font-semibold tabular-nums">{codAdjustmentReviewTarget && formatCurrency(codAdjustmentReviewTarget.originalCodAmount, codAdjustmentReviewTarget.currency, features.iqd_display_preference)}</p></div>
            <div><p className="text-xs font-medium text-muted-foreground">{t("postService.dialogs.codChangeReview.requestedCod")}</p><p className="mt-1 font-semibold tabular-nums">{codAdjustmentReviewTarget && formatCurrency(codAdjustmentReviewTarget.requestedCodAmount, codAdjustmentReviewTarget.currency, features.iqd_display_preference)}</p></div>
            <div className="sm:col-span-2"><p className="text-xs font-medium text-muted-foreground">{t("postService.form.reasonOptional")}</p><p className="mt-1 whitespace-pre-wrap text-sm">{codAdjustmentReviewTarget?.reason || t("postService.form.reasonNotProvided")}</p></div>
          </div>
          <Field label={t("postService.form.approvedCodAmount")}>
            <CurrencyAmountInput value={approvedCodAmount} onChange={setApprovedCodAmount} currency={codAdjustmentReviewTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isReviewingCodAdjustment} />
          </Field>
          <Field label={t("postService.form.reviewNoteOptional")}>
            <Textarea value={codAdjustmentReviewNote} onChange={(event) => setCodAdjustmentReviewNote(event.target.value)} placeholder={t("postService.placeholders.codChangeReviewNote")} disabled={isReviewingCodAdjustment} />
          </Field>
        </AppDialogBody>
        <AppDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isReviewingCodAdjustment} onClick={closeCodAdjustmentReview}>{t("postService.actions.cancel")}</Button>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button type="button" variant="destructive" className="flex-1 sm:flex-none" disabled={isReviewingCodAdjustment || !isCodAdjustmentRejectionValid} onClick={() => void handleCodAdjustmentReview("rejected")}>{t("postService.actions.rejectChange")}</Button>
            <Button type="button" className="flex-1 gap-2 sm:flex-none" disabled={isReviewingCodAdjustment || !isCodAdjustmentApprovalValid} onClick={() => void handleCodAdjustmentReview("approved")}><CheckCircle2 className="h-4 w-4" />{t("postService.actions.approveChange")}</Button>
          </div>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!deliveredCodCorrectionTarget} onOpenChange={(open) => { if (!open) closeDeliveredCodCorrection(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isCorrectingDeliveredCod}
        onPointerDownOutside={(event) => { if (isCorrectingDeliveredCod) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isCorrectingDeliveredCod) event.preventDefault(); }}
      >
        <form onSubmit={handleDeliveredCodCorrection} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.deliveredCodCorrection.title")}</AppDialogTitle>
            <AppDialogDescription>{t("postService.dialogs.deliveredCodCorrection.description", { trackingNumber: deliveredCodCorrectionTarget?.trackingNumber })}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">{t("postService.dialogs.deliveredCodCorrection.currentCod")}: </span>
              <span className="font-semibold tabular-nums">{deliveredCodCorrectionTarget ? formatCurrency(deliveredCodCorrectionTarget.codAmount, deliveredCodCorrectionTarget.currency, features.iqd_display_preference) : "—"}</span>
            </div>
            <Field label={t("postService.form.correctedDeliveredCodAmountRequired")}>
              <CurrencyAmountInput value={correctedDeliveredCodAmount} onChange={setCorrectedDeliveredCodAmount} currency={deliveredCodCorrectionTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isCorrectingDeliveredCod} />
            </Field>
            <p className="text-sm text-muted-foreground">{t("postService.dialogs.deliveredCodCorrection.settlementRequirement")}</p>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isCorrectingDeliveredCod} onClick={closeDeliveredCodCorrection}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isCorrectingDeliveredCod || !isDeliveredCodCorrectionValid}>{isCorrectingDeliveredCod ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.processing")}</> : <><FilePenLine className="h-4 w-4" />{t("postService.actions.correctDeliveredCod")}</>}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!deliveredRecipientPayoutCorrectionTarget} onOpenChange={(open) => { if (!open) closeDeliveredRecipientPayoutCorrection(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isCorrectingDeliveredRecipientPayout}
        onPointerDownOutside={(event) => { if (isCorrectingDeliveredRecipientPayout) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isCorrectingDeliveredRecipientPayout) event.preventDefault(); }}
      >
        <form onSubmit={handleDeliveredRecipientPayoutCorrection} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.deliveredRecipientPayoutCorrection.title")}</AppDialogTitle>
            <AppDialogDescription>{t("postService.dialogs.deliveredRecipientPayoutCorrection.description", { trackingNumber: deliveredRecipientPayoutCorrectionTarget?.trackingNumber })}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">{t("postService.dialogs.deliveredRecipientPayoutCorrection.currentRecipientPayout")}: </span>
              <span className="font-semibold tabular-nums">{deliveredRecipientPayoutCorrectionTarget ? formatCurrency(currentDeliveredRecipientPayoutAmount, deliveredRecipientPayoutCorrectionTarget.currency, features.iqd_display_preference) : "—"}</span>
            </div>
            <Field label={t("postService.form.correctedDeliveredRecipientPayoutAmountRequired")}>
              <CurrencyAmountInput value={correctedDeliveredRecipientPayoutAmount} onChange={setCorrectedDeliveredRecipientPayoutAmount} currency={deliveredRecipientPayoutCorrectionTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isCorrectingDeliveredRecipientPayout} />
            </Field>
            <p className="text-sm text-muted-foreground">{t("postService.dialogs.deliveredRecipientPayoutCorrection.paymentPreserved")}</p>
            <p className="text-sm text-muted-foreground">{t("postService.dialogs.deliveredRecipientPayoutCorrection.settlementRequirement")}</p>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isCorrectingDeliveredRecipientPayout} onClick={closeDeliveredRecipientPayoutCorrection}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isCorrectingDeliveredRecipientPayout || !isDeliveredRecipientPayoutCorrectionValid}>{isCorrectingDeliveredRecipientPayout ? <><Loader2 className="h-4 w-4 animate-spin" />{t("common.processing")}</> : <><HandCoins className="h-4 w-4" />{t("postService.actions.correctDeliveredRecipientPayout")}</>}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!recipientPayoutAdjustmentRequestTarget} onOpenChange={(open) => { if (!open) closeRecipientPayoutAdjustmentRequest(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isRequestingRecipientPayoutAdjustment}
        onPointerDownOutside={(event) => { if (isRequestingRecipientPayoutAdjustment) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isRequestingRecipientPayoutAdjustment) event.preventDefault(); }}
      >
        <form onSubmit={handleRecipientPayoutAdjustmentRequest} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t("postService.dialogs.recipientPayoutChangeRequest.title")}</AppDialogTitle>
            <AppDialogDescription>{recipientPayoutAdjustmentRequestTarget?.trackingNumber} · {recipientPayoutAdjustmentRequestTarget?.recipientPhone}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">{t("postService.dialogs.recipientPayoutChangeRequest.currentRecipientPayout")}: </span>
              <span className="font-semibold tabular-nums">{recipientPayoutAdjustmentRequestTarget ? formatCurrency(recipientPayoutAdjustmentRequestTarget.recipientPayoutAmount ?? 0, recipientPayoutAdjustmentRequestTarget.currency, features.iqd_display_preference) : "—"}</span>
            </div>
            <Field label={`${t("postService.form.requestedRecipientPayoutAmount")} *`}>
              <CurrencyAmountInput value={requestedRecipientPayoutAmount} onChange={setRequestedRecipientPayoutAmount} currency={recipientPayoutAdjustmentRequestTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isRequestingRecipientPayoutAdjustment} />
            </Field>
            <Field label={t("postService.form.reasonOptional")}>
              <Textarea value={recipientPayoutAdjustmentReason} onChange={(event) => setRecipientPayoutAdjustmentReason(event.target.value)} placeholder={t("postService.placeholders.recipientPayoutChangeReason")} disabled={isRequestingRecipientPayoutAdjustment} />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isRequestingRecipientPayoutAdjustment} onClick={closeRecipientPayoutAdjustmentRequest}>{t("postService.actions.cancel")}</Button>
            <Button type="submit" className="w-full gap-2 sm:w-auto" disabled={isRequestingRecipientPayoutAdjustment || !isRecipientPayoutAdjustmentRequestValid}>{isRequestingRecipientPayoutAdjustment ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePenLine className="h-4 w-4" />}{isRequestingRecipientPayoutAdjustment ? t("common.processing") : t("postService.actions.sendRecipientPayoutChangeRequest")}</Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <AppDialog open={!!recipientPayoutAdjustmentReviewTarget} onOpenChange={(open) => { if (!open) closeRecipientPayoutAdjustmentReview(); }}>
      <AppDialogContent
        className="sm:max-w-lg"
        showCloseButton={!isReviewingRecipientPayoutAdjustment}
        onPointerDownOutside={(event) => { if (isReviewingRecipientPayoutAdjustment) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (isReviewingRecipientPayoutAdjustment) event.preventDefault(); }}
      >
        <AppDialogHeader>
          <AppDialogTitle>{t("postService.dialogs.recipientPayoutChangeReview.title")}</AppDialogTitle>
          <AppDialogDescription>{recipientPayoutAdjustmentReviewTarget && shipmentLabelById.get(recipientPayoutAdjustmentReviewTarget.shipmentId)}</AppDialogDescription>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-3 sm:grid-cols-2">
            <div><p className="text-xs font-medium text-muted-foreground">{t("postService.dialogs.recipientPayoutChangeReview.currentRecipientPayout")}</p><p className="mt-1 font-semibold tabular-nums">{recipientPayoutAdjustmentReviewTarget && formatCurrency(recipientPayoutAdjustmentReviewTarget.originalRecipientPayoutAmount, recipientPayoutAdjustmentReviewTarget.currency, features.iqd_display_preference)}</p></div>
            <div><p className="text-xs font-medium text-muted-foreground">{t("postService.dialogs.recipientPayoutChangeReview.requestedRecipientPayout")}</p><p className="mt-1 font-semibold tabular-nums">{recipientPayoutAdjustmentReviewTarget && formatCurrency(recipientPayoutAdjustmentReviewTarget.requestedRecipientPayoutAmount, recipientPayoutAdjustmentReviewTarget.currency, features.iqd_display_preference)}</p></div>
            <div className="sm:col-span-2"><p className="text-xs font-medium text-muted-foreground">{t("postService.form.reasonOptional")}</p><p className="mt-1 whitespace-pre-wrap text-sm">{recipientPayoutAdjustmentReviewTarget?.reason || t("postService.form.reasonNotProvided")}</p></div>
          </div>
          <Field label={`${t("postService.form.approvedRecipientPayoutAmount")} *`}>
            <CurrencyAmountInput value={approvedRecipientPayoutAmount} onChange={setApprovedRecipientPayoutAmount} currency={recipientPayoutAdjustmentReviewTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} disabled={isReviewingRecipientPayoutAdjustment} />
          </Field>
          <Field label={t("postService.form.reviewNoteOptional")}>
            <Textarea value={recipientPayoutAdjustmentReviewNote} onChange={(event) => setRecipientPayoutAdjustmentReviewNote(event.target.value)} placeholder={t("postService.placeholders.recipientPayoutChangeReviewNote")} disabled={isReviewingRecipientPayoutAdjustment} />
          </Field>
        </AppDialogBody>
        <AppDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isReviewingRecipientPayoutAdjustment} onClick={closeRecipientPayoutAdjustmentReview}>{t("postService.actions.cancel")}</Button>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button type="button" variant="destructive" className="flex-1 gap-2 sm:flex-none" disabled={isReviewingRecipientPayoutAdjustment || !isRecipientPayoutAdjustmentRejectionValid} onClick={() => void handleRecipientPayoutAdjustmentReview("rejected")}>{isReviewingRecipientPayoutAdjustment ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{isReviewingRecipientPayoutAdjustment ? t("common.processing") : t("postService.actions.rejectRecipientPayoutChange")}</Button>
            <Button type="button" className="flex-1 gap-2 sm:flex-none" disabled={isReviewingRecipientPayoutAdjustment || !isRecipientPayoutAdjustmentApprovalValid} onClick={() => void handleRecipientPayoutAdjustmentReview("approved")}>{isReviewingRecipientPayoutAdjustment ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{isReviewingRecipientPayoutAdjustment ? t("common.processing") : t("postService.actions.approveRecipientPayoutChange")}</Button>
          </div>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    <Dialog open={!!postSettlementTarget} onOpenChange={(open) => !open && setPostSettlementTarget(null)}>
      <DialogContent layout="structured" className="sm:max-w-xl">
        <DialogHeader layout="structured">
          <DialogTitle>{t("postService.dialogs.postSettlement.title")}</DialogTitle>
          <DialogDescription>{postSettlementTarget?.trackingNumber} · {postSettlementTarget?.recipientPhone}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5 py-5">
          <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold">{t(isPrepaidPostSettlement ? "postService.actions.reimburseCourier" : "postService.dialogs.postSettlement.courierHandover")}</h3><p className="text-sm text-muted-foreground">{postSettlementTarget?.assignedAgentId ? agentNameById.get(postSettlementTarget.assignedAgentId) : t("postService.dialogs.postSettlement.noCourier")}</p></div>
              <div className="flex flex-col items-end gap-1.5">
                <Badge variant="outline" className={postSettlementCourierOutstanding > 0.000001 ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}>{postSettlementCourierOutstanding > 0.000001 ? formatCurrency(postSettlementCourierOutstanding, postSettlementTarget?.currency ?? features.default_currency, features.iqd_display_preference) : t("postService.dialogs.postSettlement.settled")}</Badge>
                {!isPrepaidPostSettlement && (postSettlementTarget?.courierDeliveryFee ?? 0) > 0.000001 ? <Badge variant="outline" className="border-rose-500/25 bg-rose-500/5 text-[10px] font-medium text-rose-700 dark:text-rose-300">{t("postService.dialogs.postSettlement.courierFeeDeducted", { amount: formatCurrency(postSettlementTarget!.courierDeliveryFee ?? 0, postSettlementTarget!.currency, features.iqd_display_preference) })}</Badge> : null}
              </div>
            </div>
            {postSettlementTarget?.assignedAgentId ? <div className="grid gap-4 sm:grid-cols-2"><Field label={t("postService.form.amountReceivedPaid")}><CurrencyAmountInput value={postSettlementDraft.courierAmount} onChange={(value) => setPostSettlementDraft((current) => ({ ...current, courierAmount: value }))} currency={postSettlementTarget.currency} iqdPreference={features.iqd_display_preference} /></Field><Field label={t("postService.form.paymentMethod")}><SettlementPaymentMethodSelect t={t} value={postSettlementDraft.courierMethod} onChange={(value) => setPostSettlementDraft((current) => ({ ...current, courierMethod: value }))} /></Field><div className="sm:col-span-2"><PaymentAccountSelector workspaceId={workspaceId} value={postSettlementDraft.courierAccount?.id ?? null} onValueChange={(account) => setPostSettlementDraft((current) => ({ ...current, courierAccount: account }))} disabled={submittingPostSettlement !== null} cashDrawerOnly={postSettlementDraft.courierMethod === "cash"} /></div><div className="sm:col-span-2"><Field label={t("postService.form.noteVariance")}><Textarea value={postSettlementDraft.courierNote} onChange={(event) => setPostSettlementDraft((current) => ({ ...current, courierNote: event.target.value }))} placeholder={t("postService.placeholders.varianceNote")} /></Field></div><div className="sm:col-span-2 flex justify-end"><Button type="button" disabled={submittingPostSettlement !== null || postSettlementCourierOutstanding <= 0.000001 || !isPostSettlementCourierAmountValid} onClick={() => void handlePostSettlement("courier")}>{t(isPrepaidPostSettlement ? "postService.actions.reimburseCourier" : "postService.actions.recordHandover")}</Button></div></div> : null}
          </div>
          <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold">{t(isPrepaidPostSettlement ? "postService.actions.receiveMerchantRepayment" : "postService.dialogs.postSettlement.merchantPayout")}</h3><p className="text-sm text-muted-foreground">{postSettlementTarget ? profileNameById.get(postSettlementTarget.merchantProfileId) : "—"}</p></div>
              <Badge variant="outline" className={postSettlementMerchantOutstanding > 0.000001 ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}>{postSettlementMerchantOutstanding > 0.000001 ? formatCurrency(postSettlementMerchantOutstanding, postSettlementTarget?.currency ?? features.default_currency, features.iqd_display_preference) : t("postService.dialogs.postSettlement.settled")}</Badge>
            </div>
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t("postService.form.amountReceivedPaid")}><CurrencyAmountInput value={postSettlementDraft.merchantAmount} onChange={(value) => setPostSettlementDraft((current) => ({ ...current, merchantAmount: value }))} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} /></Field><Field label={t("postService.form.paymentMethod")}><SettlementPaymentMethodSelect t={t} value={postSettlementDraft.merchantMethod} onChange={(value) => setPostSettlementDraft((current) => ({ ...current, merchantMethod: value }))} /></Field><div className="sm:col-span-2"><PaymentAccountSelector workspaceId={workspaceId} value={postSettlementDraft.merchantAccount?.id ?? null} onValueChange={(account) => setPostSettlementDraft((current) => ({ ...current, merchantAccount: account }))} disabled={submittingPostSettlement !== null} cashDrawerOnly={postSettlementDraft.merchantMethod === "cash"} /></div><div className="sm:col-span-2"><Field label={t("postService.form.noteVariance")}><Textarea value={postSettlementDraft.merchantNote} onChange={(event) => setPostSettlementDraft((current) => ({ ...current, merchantNote: event.target.value }))} placeholder={t("postService.placeholders.varianceNote")} /></Field></div><div className="sm:col-span-2 flex justify-end"><Button type="button" disabled={submittingPostSettlement !== null || postSettlementMerchantOutstanding <= 0.000001 || !isPostSettlementMerchantAmountValid} onClick={() => void handlePostSettlement("merchant")}>{t(isPrepaidPostSettlement ? "postService.actions.receiveMerchantRepayment" : "postService.actions.payMerchant")}</Button></div></div>
          </div>
          <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
            <h3 className="font-semibold">{t("postService.dialogs.postSettlement.result")}</h3>
            {!isPrepaidPostSettlement ? <>
              <SettlementCalculationLine label={t("postService.dialogs.settlementNet.cashHandover")} amount={postSettlementGrossCourierHandover} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="+" />
              {postSettlementCourierFee > 0.000001 ? <SettlementCalculationLine label={t("postService.form.courierDeliveryFee")} amount={postSettlementCourierFee} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
              {postSettlementCourierAdvance > 0.000001 ? <SettlementCalculationLine label={t("postService.dialogs.settlementNet.courierRecipientAdvance")} amount={postSettlementCourierAdvance} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
              {postSettlementWorkspaceRecipientPayout > 0.000001 ? <SettlementCalculationLine label={t("postService.table.recipientPayout")} amount={postSettlementWorkspaceRecipientPayout} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
            </> : null}
            {postSettlementNet && postSettlementNet.merchantRepayment > 0.000001 ? <SettlementCalculationLine label={t("postService.messages.merchantRepaymentRecorded")} amount={postSettlementNet.merchantRepayment} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="+" /> : null}
            {postSettlementNet && postSettlementNet.courierReimbursement > 0.000001 ? <SettlementCalculationLine label={t("postService.settlementType.courierReimbursement")} amount={postSettlementNet.courierReimbursement} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
            {!isPrepaidPostSettlement ? <SettlementCalculationLine label={t("postService.dialogs.settlementNet.merchantPayout")} amount={postSettlementNet?.merchantPayout ?? 0} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
            <div className="border-t border-dashed" />
            <SettlementCalculationLine label={t("postService.dialogs.settlementNet.profit")} amount={postSettlementNetAmount} currency={postSettlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="=" emphasized />
          </div>
        </DialogBody>
        <DialogFooter layout="structured"><Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setPostSettlementTarget(null)}>{t("common.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AppDialog open={!!settlementTarget} onOpenChange={(open) => { if (!open && !isSubmitting) setSettlementTarget(null); }}>
      <AppDialogContent
        className="sm:max-w-md"
        showCloseButton={!isSubmitting}
        onEscapeKeyDown={(event) => { if (isSubmitting) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (isSubmitting) event.preventDefault(); }}
      >
        <form onSubmit={handleSettlement} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle>{t(settlementTarget?.kind === "courier"
              ? "postService.dialogs.courierSettlement.title"
              : settlementTarget?.kind === "courier_reimbursement"
                ? "postService.dialogs.courierReimbursement.title"
              : settlementTarget?.kind === "merchant_repayment"
                ? "postService.dialogs.merchantRepayment.title"
                : "postService.dialogs.merchantSettlement.title")}</AppDialogTitle>
            <AppDialogDescription>
              {settlementTarget?.shipmentLabel ? <span className="mb-1 block font-medium text-foreground">{settlementTarget.shipmentLabel}</span> : null}
              {settlementTarget?.kind === "courier_reimbursement"
                ? t("postService.dialogs.courierReimbursement.outstanding", { name: settlementTarget?.name, amount: settlementTarget && formatCurrency(settlementTarget.amount, settlementTarget.currency, features.iqd_display_preference) })
                : settlementTarget?.kind === "merchant_repayment"
                ? t("postService.dialogs.merchantRepayment.outstanding", { name: settlementTarget?.name, amount: settlementTarget && formatCurrency(settlementTarget.amount, settlementTarget.currency, features.iqd_display_preference) })
                : t("postService.dialogs.settlementOutstanding", { name: settlementTarget?.name, amount: settlementTarget && formatCurrency(settlementTarget.amount, settlementTarget.currency, features.iqd_display_preference) })}
            </AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody className="grid gap-4 py-5">
            <Field label={t(settlementTarget?.kind === "merchant_repayment" ? "postService.form.amountReceived" : settlementTarget?.kind === "courier_reimbursement" ? "postService.form.amountPaid" : "postService.form.amountReceivedPaid")}>
              <CurrencyAmountInput value={settlementAmount} onChange={setSettlementAmount} currency={settlementTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} />
            </Field>
            <Field label={t("postService.form.paymentMethod")}><PaymentMethodSelector value={settlementMethod as StandardPaymentMethod} methods={STANDARD_PAYMENT_METHODS} workspaceId={workspaceId} disabled={isSubmitting} onValueChange={(method) => setSettlementMethod(method as WorkspacePaymentMethod)} onLinkedPaymentAccountSelect={setSettlementAccount} /></Field>
            <PaymentAccountSelector workspaceId={workspaceId} value={settlementAccount?.id ?? null} onValueChange={setSettlementAccount} disabled={isSubmitting} cashDrawerOnly={settlementMethod === "cash"} />
            <Field label={t("postService.form.noteVariance")}>
              <Textarea value={settlementNote} onChange={(event) => setSettlementNote(event.target.value)} placeholder={t(settlementTarget?.kind === "merchant_repayment" ? "postService.placeholders.repaymentVarianceNote" : "postService.placeholders.varianceNote")} disabled={isSubmitting} />
            </Field>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isSubmitting} onClick={() => setSettlementTarget(null)}>{t("postService.actions.cancel")}</Button>
            <Button className="w-full sm:w-auto" disabled={isSubmitting || numericValue(settlementAmount) <= 0} type="submit">
              {t(settlementTarget?.kind === "merchant_repayment" ? "postService.actions.receiveMerchantRepayment" : settlementTarget?.kind === "courier_reimbursement" ? "postService.actions.reimburseCourier" : "postService.actions.confirmSettlement")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
    <Dialog open={!!settlementNetTarget} onOpenChange={(open) => !open && setSettlementNetTarget(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("postService.dialogs.settlementNet.title")}</DialogTitle>
          <DialogDescription>{settlementNetTarget?.trackingNumber} · {settlementNetTarget?.recipientPhone}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-5">
          {!settlementNetSummary ? (
            <p className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground">{t("postService.dialogs.settlementNet.noSettlements")}</p>
          ) : (
            <>
              {settlementNetSummary ? <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                {settlementNetTarget?.customerPaymentStatus !== "prepaid_electronically" ? <>
                  <SettlementCalculationLine label={t("postService.dialogs.settlementNet.cashHandover")} amount={settlementNetGrossCourierHandover} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="+" />
                  {settlementNetCourierFee > 0.000001 ? <SettlementCalculationLine label={t("postService.form.courierDeliveryFee")} amount={settlementNetCourierFee} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
                  {settlementNetCourierAdvance > 0.000001 ? <SettlementCalculationLine label={t("postService.dialogs.settlementNet.courierRecipientAdvance")} amount={settlementNetCourierAdvance} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
                  {settlementNetWorkspaceRecipientPayout > 0.000001 ? <SettlementCalculationLine label={t("postService.table.recipientPayout")} amount={settlementNetWorkspaceRecipientPayout} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
                </> : null}
                {settlementNetSummary.merchantRepayment > 0.000001 ? <SettlementCalculationLine label={t("postService.messages.merchantRepaymentRecorded")} amount={settlementNetSummary.merchantRepayment} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="+" /> : null}
                {settlementNetSummary.courierReimbursement > 0.000001 ? <SettlementCalculationLine label={t("postService.settlementType.courierReimbursement")} amount={settlementNetSummary.courierReimbursement} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
                {settlementNetTarget?.customerPaymentStatus !== "prepaid_electronically" ? <SettlementCalculationLine label={t("postService.dialogs.settlementNet.merchantPayout")} amount={settlementNetSummary.merchantPayout} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="−" negative /> : null}
                <div className="border-t border-dashed" />
                <SettlementCalculationLine label={t("postService.dialogs.settlementNet.profit")} amount={settlementNetAmount} currency={settlementNetTarget?.currency ?? features.default_currency} iqdPreference={features.iqd_display_preference} operator="=" emphasized />
              </div> : null}
              {settlementNetIsProvisional ? <p className="text-sm text-amber-700 dark:text-amber-300">{t("postService.dialogs.settlementNet.partial")}</p> : null}
            </>
          )}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setSettlementNetTarget(null)}>{t("common.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <DeliveryVoicePlaybackDialog
      open={!!voicePlaybackEvent}
      onOpenChange={(open) => { if (!open) setVoicePlaybackEvent(null); }}
      path={voicePlaybackEvent?.voiceReasonPath ?? null}
      shipmentLabel={voicePlaybackEvent ? shipmentLabelById.get(voicePlaybackEvent.shipmentId) ?? "—" : ""}
    />
  </div>;
}

function Field({ label, children, isLoading = false }: { label: string; children: React.ReactNode; isLoading?: boolean }) {
  return <div className="grid gap-2"><Label isLoading={isLoading}>{label}</Label>{children}</div>;
}
function CurrencyAmountInput({ value, onChange, currency, iqdPreference, disabled = false }: { value: string; onChange: (value: string) => void; currency: CurrencyCode; iqdPreference: "IQD" | "د.ع"; disabled?: boolean }) {
  return <div className="relative"><Input className="pe-12 tabular-nums" value={formatNumericInput(value)} onChange={(event) => onChange(sanitizeNumericInput(event.target.value, { allowDecimal: currency !== "iqd" }))} inputMode={currency === "iqd" ? "numeric" : "decimal"} placeholder="0" required disabled={disabled} /><span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currencySuffix(currency, iqdPreference)}</span></div>;
}
function SettlementPaymentMethodSelect({ t, value, onChange }: { t: TFunction; value: WorkspacePaymentMethod; onChange: (value: WorkspacePaymentMethod) => void }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">{t("postService.paymentMethods.cash")}</SelectItem><SelectItem value="bank_transfer">{t("postService.paymentMethods.bank_transfer")}</SelectItem><SelectItem value="fib">{t("postService.paymentMethods.fib")}</SelectItem><SelectItem value="qicard">{t("postService.paymentMethods.qicard")}</SelectItem><SelectItem value="zaincash">{t("postService.paymentMethods.zaincash")}</SelectItem><SelectItem value="fastpay">{t("postService.paymentMethods.fastpay")}</SelectItem></SelectContent></Select>;
}
function LinkedMerchantBadge({ t, name, onClear }: { t: TFunction; name: string; onClear: () => void }) {
  return <div className="flex items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm"><div className="flex min-w-0 items-center gap-2"><Users className="h-4 w-4 shrink-0 text-primary" /><div className="min-w-0"><div className="text-[10px] font-bold uppercase tracking-wide text-primary">{t("loans.belongsTo")}</div><div className="truncate font-medium">{name}</div></div></div><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClear} aria-label="Clear linked business partner"><X className="h-4 w-4" /></Button></div>;
}
function StatusMetric({ icon: Icon, title, value, active, compact = false, selectionTone = "primary", onClick }: { icon: LucideIcon; title: string; value: number; active: boolean; compact?: boolean; selectionTone?: "primary" | "amber" | "rose"; onClick: () => void }) {
  const selectionClasses = {
    primary: "border-primary bg-primary/10 ring-primary/20",
    amber: "border-amber-500 bg-amber-500/10 ring-amber-500/20",
    rose: "border-rose-500 bg-rose-500/10 ring-rose-500/20",
  }[selectionTone];
  const selectionIconClasses = {
    primary: "bg-primary text-primary-foreground",
    amber: "bg-amber-500 text-white",
    rose: "bg-rose-500 text-white",
  }[selectionTone];
  return <button type="button" className="group w-full rounded-xl text-start outline-none" aria-pressed={active} onClick={onClick}>
    <Card className={cn("relative h-full overflow-hidden transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/35 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-primary/50 group-focus-visible:ring-offset-2 group-active:translate-y-0", active && cn("shadow-md ring-2", selectionClasses))}>
      {active ? <div className={cn("absolute end-2.5 top-2.5 rounded-full p-0.5 shadow-sm", selectionIconClasses)} aria-hidden="true"><CheckCircle2 className="h-3.5 w-3.5" /></div> : null}
      <CardContent className={cn("flex items-center", compact ? "gap-2.5 p-3" : "gap-3 p-4")}>
        <div className={cn("rounded-xl bg-muted text-muted-foreground transition-colors", compact ? "p-1.5" : "p-2", active && cn("shadow-sm", selectionIconClasses), !active && "group-hover:bg-primary/10 group-hover:text-primary")}><Icon className={compact ? "h-4 w-4" : "h-5 w-5"} /></div>
        <div className="min-w-0"><div className={cn("font-bold tabular-nums", compact ? "text-xl" : "text-2xl")}>{value}</div><div className="truncate text-xs text-muted-foreground">{title}</div></div>
      </CardContent>
    </Card>
  </button>;
}
function ReturnStatusMetric({ awaitingValue, historyValue, awaitingActive, historyActive, awaitingTitle, historyTitle, onAwaitingClick, onHistoryClick }: { awaitingValue: number; historyValue: number; awaitingActive: boolean; historyActive: boolean; awaitingTitle: string; historyTitle: string; onAwaitingClick: () => void; onHistoryClick: () => void }) {
  return <Card className={cn("h-full overflow-hidden", awaitingActive && "border-amber-500 shadow-md ring-2 ring-amber-500/20", historyActive && "border-rose-500 shadow-md ring-2 ring-rose-500/20")}>
    <CardContent className="grid h-full grid-cols-2 divide-x p-0">
      <button type="button" className={cn("group relative flex min-w-0 items-center gap-2 p-3 text-start outline-none transition-colors hover:bg-primary/5 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50", awaitingActive && "bg-amber-500/10")} aria-pressed={awaitingActive} onClick={onAwaitingClick}>
        <div className={cn("rounded-xl bg-muted p-1.5 text-muted-foreground transition-colors", awaitingActive && "bg-amber-500 text-white shadow-sm", !awaitingActive && "group-hover:bg-primary/10 group-hover:text-primary")}><Undo2 className="h-4 w-4" /></div>
        <div className="min-w-0"><div className="text-xl font-bold tabular-nums">{awaitingValue}</div><div className="truncate text-[11px] leading-tight text-muted-foreground" title={awaitingTitle}>{awaitingTitle}</div></div>
      </button>
      <button type="button" className={cn("group relative flex min-w-0 items-center gap-2 p-3 text-start outline-none transition-colors hover:bg-primary/5 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50", historyActive && "bg-rose-500/10")} aria-pressed={historyActive} onClick={onHistoryClick}>
        <div className={cn("rounded-xl bg-muted p-1.5 text-muted-foreground transition-colors", historyActive && "bg-rose-500 text-white shadow-sm", !historyActive && "group-hover:bg-primary/10 group-hover:text-primary")}><History className="h-4 w-4" /></div>
        <div className="min-w-0"><div className="text-xl font-bold tabular-nums">{historyValue}</div><div className="truncate text-[11px] leading-tight text-muted-foreground" title={historyTitle}>{historyTitle}</div></div>
      </button>
    </CardContent>
  </Card>;
}
function DeliveryBalanceMetric({ icon: Icon, title, value, tone }: { icon: LucideIcon; title: string; value: string; tone: "amber" | "emerald" | "sky" | "rose" }) {
  const toneClasses = {
    amber: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    rose: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  }[tone];
  return <Card className="h-full overflow-hidden"><CardContent className="flex items-center gap-2.5 p-3"><div className={cn("rounded-xl p-1.5", toneClasses)}><Icon className="h-4 w-4" /></div><div className="min-w-0"><div className="truncate font-bold tabular-nums text-xl" title={value}>{value}</div><div className="truncate text-xs text-muted-foreground">{title}</div></div></CardContent></Card>;
}
function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return <TableRow><TableCell colSpan={columns} className="py-10 text-center text-muted-foreground">{label}</TableCell></TableRow>;
}
function statusFilterOptions(t: TFunction) {
  return (["all", "received", "assigned", "delivered", "postponed", "returned", "return_history", "cancelled"] as PostStatusFilter[]).map((value) => ({
    value, icon: statusFilterIcons[value], label: value === "all" ? t("common.all") : value === "returned" ? t("postService.status.returnAwaitingReceipt") : value === "return_history" ? t("postService.status.returnHistory") : shipmentStatusLabel(t, value), tone: value === "returned" || value === "cancelled" ? "danger" as const : undefined,
  }));
}
function settlementFilterOptions(t: TFunction, settledLabel: string) {
  return (["all", "settled", "partial", "outstanding"] as PostSettlementFilter[]).map((value) => ({
    value, icon: settlementFilterIcons[value], label: value === "all" ? t("common.all") : value === "settled" ? settledLabel : t(`postService.settlementStatus.${value}`),
  }));
}
function PostsViewModeToggle({ t, value, onChange }: { t: TFunction; value: PostsViewMode; onChange: (value: PostsViewMode) => void }) {
  return <div className="hidden items-center rounded-lg border bg-muted/30 p-1 md:flex" role="group" aria-label={t("postService.cards.allPosts")}>
    <Button type="button" size="sm" variant={value === "details" ? "secondary" : "ghost"} className="gap-1.5" aria-pressed={value === "details"} onClick={() => onChange("details")}><List className="h-4 w-4" />{t("postService.view.details")}</Button>
    <Button type="button" size="sm" variant={value === "grid" ? "secondary" : "ghost"} className="gap-1.5" aria-pressed={value === "grid"} onClick={() => onChange("grid")}><LayoutGrid className="h-4 w-4" />{t("postService.view.grid")}</Button>
  </div>;
}
function ShipmentStatusBadges({ t, shipment }: { t: TFunction; shipment: DeliveryShipment }) {
  const isReturnAwaitingReceipt = shipment.status === "returned" && !shipment.returnReceivedAt;
  return <>
    <Badge variant="outline" className={shipmentStatusClass(shipment.status)}>{shipmentStatusLabel(t, shipment.status)}</Badge>
    {isReturnAwaitingReceipt ? <span className="whitespace-nowrap text-[10px] font-semibold text-amber-700 dark:text-amber-300">{t("postService.status.awaitingReceipt")}</span> : null}
  </>;
}

function PartyPostsStatusGroup({ t, status, shipments, partyKind, profileNameById, agentNameById, iqdPreference, expanded, onToggle }: {
  t: TFunction;
  status: DeliveryShipmentStatus;
  shipments: readonly DeliveryShipment[];
  partyKind: PartyPostsDialogTarget["kind"];
  profileNameById: ReadonlyMap<string, string>;
  agentNameById: ReadonlyMap<string, string>;
  iqdPreference: "IQD" | "د.ع";
  expanded: boolean;
  onToggle: (status: DeliveryShipmentStatus) => void;
}) {
  const StatusIcon = statusFilterIcons[status];
  const statusPanelId = `party-post-status-${status}`;
  const counterpartyLabel = t(partyKind === "merchant" ? "postService.table.courier" : "postService.table.merchant");

  return <section className="overflow-hidden rounded-xl border bg-muted/20">
    <button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" aria-expanded={expanded} aria-controls={statusPanelId} onClick={() => onToggle(status)}>
      <span className="flex min-w-0 items-center gap-2">
        <StatusIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Badge variant="outline" className={shipmentStatusClass(status)}>{shipmentStatusLabel(t, status)}</Badge>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{shipments.length} <span className="text-muted-foreground">{t("postService.table.posts")}</span></span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !expanded && "-rotate-90")} aria-hidden="true" />
      </span>
    </button>
    {expanded ? <div id={statusPanelId} className="border-t bg-background">
      <div className="overflow-x-auto">
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("postService.table.tracking")}</TableHead>
              <TableHead>{counterpartyLabel}</TableHead>
              <TableHead>{t("postService.form.recipientPhone")}</TableHead>
              <TableHead>{t("postService.form.deliveryAddress")}</TableHead>
              <TableHead>{t("postService.table.cod")}</TableHead>
              <TableHead>{t("postService.table.recipientPayout")}</TableHead>
              <TableHead>{t("postService.form.deliveryFee")}</TableHead>
              <TableHead>{t("postService.table.dateTime")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.map((shipment) => {
              const counterparty = partyKind === "merchant"
                ? (shipment.assignedAgentId ? agentNameById.get(shipment.assignedAgentId) ?? t("postService.unknownCourier") : "—")
                : profileNameById.get(shipment.merchantProfileId) ?? t("postService.unknownMerchant");
              const statusDate = shipment.status === "delivered" ? shipment.deliveredAt : shipment.status === "postponed" ? shipment.postponedAt : shipment.status === "returned" ? shipment.returnedAt : null;

              return <TableRow key={shipment.id} className="align-top">
                <TableCell className="min-w-40">
                  <p className="font-medium tabular-nums">{shipment.trackingNumber}</p>
                  {shipment.description ? <p className="mt-1 max-w-52 text-xs text-muted-foreground">{shipment.description}</p> : null}
                  {shipment.statusNote ? <p className="mt-1 max-w-52 text-xs text-muted-foreground"><span className="font-medium">{t("postService.form.reason")}: </span>{shipment.statusNote}</p> : null}
                </TableCell>
                <TableCell className="min-w-36 font-medium">{counterparty}</TableCell>
                <TableCell className="whitespace-nowrap font-medium tabular-nums">{shipment.recipientPhone}</TableCell>
                <TableCell className="min-w-52 max-w-72 whitespace-normal text-sm text-muted-foreground">{shipment.recipientAddress}</TableCell>
                <TableCell className="whitespace-nowrap"><div className="space-y-1"><p className="text-xs text-muted-foreground">{t(`postService.customerPaymentStatus.${shipment.customerPaymentStatus}`)}</p><p className="font-medium tabular-nums">{formatCurrency(shipment.codAmount, shipment.currency, iqdPreference)}</p></div></TableCell>
                <TableCell className="whitespace-nowrap font-medium tabular-nums text-rose-700 dark:text-rose-300">{shipment.recipientPayoutAmount > 0.000001 ? formatCurrency(shipment.recipientPayoutAmount, shipment.currency, iqdPreference) : "—"}</TableCell>
                <TableCell className="whitespace-nowrap"><p className="font-medium tabular-nums">{formatCurrency(shipment.deliveryFee, shipment.currency, iqdPreference)}</p><p className="mt-1 text-xs text-muted-foreground">{t(`postService.feePayer.${shipment.feePayer}`)}</p>{shipment.courierDeliveryFee != null ? <p className="mt-1 text-xs text-muted-foreground">{t("postService.table.courierDeliveryFee")}: <span className="tabular-nums">{formatCurrency(shipment.courierDeliveryFee, shipment.currency, iqdPreference)}</span></p> : null}</TableCell>
                <TableCell className="min-w-40 whitespace-nowrap text-sm text-muted-foreground"><p>{formatDateTime(statusDate ?? shipment.createdAt)}</p>{shipment.status === "returned" ? <p className={cn("mt-1 text-xs font-medium", shipment.returnReceivedAt ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>{shipment.returnReceivedAt ? `${t("postService.status.completed")} · ${formatDateTime(shipment.returnReceivedAt)}` : t("postService.status.awaitingReceipt")}</p> : null}</TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
    </div> : null}
  </section>;
}

function ChangedCodAmount({ t, shipment, approvedAdjustment, iqdPreference }: {
  t: TFunction;
  shipment: DeliveryShipment;
  approvedAdjustment: DeliveryShipmentCodAdjustmentRequest | undefined;
  iqdPreference: "IQD" | "د.ع";
}) {
  const isApprovedChangeCurrent = approvedAdjustment?.reviewedCodAmount != null
    && Math.abs(shipment.codAmount - approvedAdjustment.reviewedCodAmount) <= 0.000001
    && Math.abs(shipment.codAmount - approvedAdjustment.originalCodAmount) > 0.000001;

  if (!isApprovedChangeCurrent) return <>{formatCurrency(shipment.codAmount, shipment.currency, iqdPreference)}</>;

  return <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help font-semibold">
          <span className="text-yellow-500 dark:text-yellow-400">{t("postService.status.changedTo")}</span>{" "}
          <span className="tabular-nums text-black dark:text-white">{formatCurrency(shipment.codAmount, shipment.currency, iqdPreference)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="space-y-3 p-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("postService.status.originalCod")}:</p>
          <p className="font-semibold tabular-nums">{formatCurrency(approvedAdjustment.originalCodAmount, shipment.currency, iqdPreference)}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("postService.status.approvedAt")}:</p>
          <p className="font-semibold tabular-nums">{approvedAdjustment.reviewedAt ? formatDateTime(approvedAdjustment.reviewedAt) : "—"}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
function ChangedRecipientPayoutAmount({ t, shipment, approvedAdjustment, iqdPreference }: {
  t: TFunction;
  shipment: DeliveryShipment;
  approvedAdjustment: DeliveryShipmentRecipientPayoutAdjustmentRequest | undefined;
  iqdPreference: "IQD" | "د.ع";
}) {
  const recipientPayoutAmount = shipment.recipientPayoutAmount ?? 0;
  const isApprovedChangeCurrent = approvedAdjustment?.reviewedRecipientPayoutAmount != null
    && Math.abs(recipientPayoutAmount - approvedAdjustment.reviewedRecipientPayoutAmount) <= 0.000001
    && Math.abs(recipientPayoutAmount - approvedAdjustment.originalRecipientPayoutAmount) > 0.000001;

  if (!isApprovedChangeCurrent) return <>{recipientPayoutAmount > 0.000001 ? formatCurrency(recipientPayoutAmount, shipment.currency, iqdPreference) : "—"}</>;

  return <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help font-semibold">
          <span className="text-yellow-500 dark:text-yellow-400">{t("postService.status.changedTo")}</span>{" "}
          <span className="tabular-nums text-black dark:text-white">{formatCurrency(recipientPayoutAmount, shipment.currency, iqdPreference)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="space-y-3 p-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("postService.status.originalRecipientPayout")}:</p>
          <p className="font-semibold tabular-nums">{formatCurrency(approvedAdjustment.originalRecipientPayoutAmount, shipment.currency, iqdPreference)}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("postService.status.approvedAt")}:</p>
          <p className="font-semibold tabular-nums">{approvedAdjustment.reviewedAt ? formatDateTime(approvedAdjustment.reviewedAt) : "—"}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
function ShipmentTable({ t, shipments, selectedIds, onToggle, canSelect, showListNumber = false, profileNameById, agentNameById, onStatus, onTransfer, onReceiveReturn, onEditAndRedispatch, canAdminEditAndRedispatch, canReceiveReturn, onRequestCodChange, onReviewCodChange, pendingCodAdjustmentByShipment, approvedCodAdjustmentByShipment, onCorrectDeliveredCod, deliveredCodCorrectionShipmentIds, onCorrectDeliveredRecipientPayout, deliveredRecipientPayoutCorrectionShipmentIds, canCorrectDeliveredCod, onRequestRecipientPayoutChange, onReviewRecipientPayoutChange, pendingRecipientPayoutAdjustmentByShipment, approvedRecipientPayoutAdjustmentByShipment, recipientPayoutAdjustmentBusyShipmentIds, canRequestCodChange, requesterCourierId, canReviewCodChange, onOpenSettlementNet, onOpenPostSettlements, onPlayVoiceReason, voiceReasonEventByShipment, canPlayVoiceReason, canSettle, canTransfer, canUpdate, iqdPreference, handoverStatusByShipment, payoutStatusByShipment, courierReimbursementStatusByShipment, merchantRepaymentStatusByShipment, settlementNetByShipment, footer }: {
  t: TFunction;
  shipments: DeliveryShipment[];
  selectedIds: Set<string>;
  onToggle: (shipmentId: string, checked: boolean) => void;
  canSelect: boolean;
  showListNumber?: boolean;
  profileNameById: Map<string, string>;
  agentNameById: Map<string, string>;
  onStatus: (shipment: DeliveryShipment, status: "delivered" | "postponed" | "returned") => void;
  onTransfer: (shipment: DeliveryShipment) => void;
  onReceiveReturn: (shipment: DeliveryShipment) => void;
  onEditAndRedispatch: (shipment: DeliveryShipment) => void;
  canAdminEditAndRedispatch: boolean;
  canReceiveReturn: boolean;
  onRequestCodChange: (shipment: DeliveryShipment) => void;
  onReviewCodChange: (request: DeliveryShipmentCodAdjustmentRequest) => void;
  pendingCodAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentCodAdjustmentRequest>;
  approvedCodAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentCodAdjustmentRequest>;
  onCorrectDeliveredCod: (shipment: DeliveryShipment) => void;
  deliveredCodCorrectionShipmentIds: ReadonlySet<string>;
  onCorrectDeliveredRecipientPayout: (shipment: DeliveryShipment) => void;
  deliveredRecipientPayoutCorrectionShipmentIds: ReadonlySet<string>;
  canCorrectDeliveredCod: boolean;
  onRequestRecipientPayoutChange: (shipment: DeliveryShipment) => void;
  onReviewRecipientPayoutChange: (request: DeliveryShipmentRecipientPayoutAdjustmentRequest) => void;
  pendingRecipientPayoutAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>;
  approvedRecipientPayoutAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>;
  recipientPayoutAdjustmentBusyShipmentIds: ReadonlySet<string>;
  canRequestCodChange: boolean;
  requesterCourierId: string | null;
  canReviewCodChange: boolean;
  onOpenSettlementNet: (shipment: DeliveryShipment) => void;
  onOpenPostSettlements: (shipment: DeliveryShipment) => void;
  onPlayVoiceReason: (event: DeliveryShipmentEvent) => void;
  voiceReasonEventByShipment: ReadonlyMap<string, DeliveryShipmentEvent>;
  canPlayVoiceReason: boolean;
  canSettle: boolean;
  canTransfer: boolean;
  canUpdate: boolean;
  iqdPreference: "IQD" | "د.ع";
  handoverStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  payoutStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  courierReimbursementStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  merchantRepaymentStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  settlementNetByShipment: ReadonlyMap<string, ShipmentSettlementNet>;
  footer?: ReactNode;
}) {
  const hasPrepaidElectronically = shipments.some((shipment) => shipment.customerPaymentStatus === "prepaid_electronically");
  const hasOtherPaymentType = shipments.some((shipment) => shipment.customerPaymentStatus !== "prepaid_electronically");
  const courierSettlementHeader = hasPrepaidElectronically
    ? t(hasOtherPaymentType ? "postService.table.cashHandoverAndCourierReimbursement" : "postService.settlementType.courierReimbursement")
    : t("postService.table.cashHandover");
  const merchantSettlementHeader = hasPrepaidElectronically
    ? t(hasOtherPaymentType ? "postService.table.merchantPayoutAndMerchantRepayment" : "postService.settlementType.merchantRepayment")
    : t("postService.table.merchantPayout");

  return <Table>
    <TableHeader><TableRow>
      {canSelect && <TableHead className="w-10" />}
      {showListNumber && <TableHead className="w-12 text-center">{t("postService.table.number")}</TableHead>}
      <TableHead>{t("postService.table.tracking")}</TableHead><TableHead>{t("postService.table.dateTime")}</TableHead><TableHead>{t("postService.table.merchantRecipient")}</TableHead><TableHead>{t("postService.table.cod")}</TableHead><TableHead>{t("postService.table.recipientPayout")}</TableHead><TableHead>{t("postService.table.settlementNet")}</TableHead><TableHead>{t("postService.table.courier")}</TableHead><TableHead>{t("postService.table.status")}</TableHead><TableHead>{courierSettlementHeader}</TableHead><TableHead>{merchantSettlementHeader}</TableHead><TableHead className="text-end">{t("postService.table.actions")}</TableHead>
    </TableRow></TableHeader>
    <TableBody>{shipments.length === 0 ? <EmptyRow columns={11 + Number(canSelect) + Number(showListNumber)} label={t("postService.empty.noPosts")} /> : shipments.map((shipment, index) => {
      const voiceReasonEvent = voiceReasonEventByShipment.get(shipment.id);
      const pendingCodAdjustment = pendingCodAdjustmentByShipment.get(shipment.id);
      const approvedCodAdjustment = approvedCodAdjustmentByShipment.get(shipment.id);
      const pendingRecipientPayoutAdjustment = pendingRecipientPayoutAdjustmentByShipment.get(shipment.id);
      const approvedRecipientPayoutAdjustment = approvedRecipientPayoutAdjustmentByShipment.get(shipment.id);
      const isRecipientPayoutAdjustmentBusy = recipientPayoutAdjustmentBusyShipmentIds.has(shipment.id);
      const isPrepaidElectronically = shipment.customerPaymentStatus === "prepaid_electronically";
      const courierSettlementStatus = isPrepaidElectronically
        ? courierReimbursementStatusByShipment.get(shipment.id) ?? "none"
        : handoverStatusByShipment.get(shipment.id) ?? "none";
      const merchantSettlementStatus = isPrepaidElectronically
        ? merchantRepaymentStatusByShipment.get(shipment.id) ?? "none"
        : payoutStatusByShipment.get(shipment.id) ?? "none";
      return <TableRow key={shipment.id} className={cn(isRecipientPayoutAdjustmentBusy && "pointer-events-none opacity-50")} aria-busy={isRecipientPayoutAdjustmentBusy}>
        {canSelect && <TableCell><Checkbox className="h-5 w-5 rounded-[6px]" checked={selectedIds.has(shipment.id)} disabled={!['received', 'postponed'].includes(shipment.status)} onCheckedChange={(checked) => onToggle(shipment.id, checked === true)} /></TableCell>}
        {showListNumber && <TableCell className="text-center font-medium tabular-nums text-muted-foreground">#{index + 1}</TableCell>}
        <TableCell><div className="font-medium">{shipment.trackingNumber}</div><div className="max-w-48 truncate text-xs text-muted-foreground">{shipment.recipientAddress}</div></TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatDateTime(shipment.createdAt)}</TableCell>
        <TableCell><div>{profileNameById.get(shipment.merchantProfileId)}</div><div className="text-xs text-muted-foreground">{shipment.recipientPhone}</div></TableCell>
        <TableCell><ChangedCodAmount t={t} shipment={shipment} approvedAdjustment={approvedCodAdjustment} iqdPreference={iqdPreference} /></TableCell>
        <TableCell><span className="font-medium tabular-nums text-rose-700 dark:text-rose-300"><ChangedRecipientPayoutAmount t={t} shipment={shipment} approvedAdjustment={approvedRecipientPayoutAdjustment} iqdPreference={iqdPreference} /></span></TableCell>
        <TableCell><SettlementNetButton t={t} shipment={shipment} settlementNet={settlementNetByShipment.get(shipment.id)} iqdPreference={iqdPreference} onClick={() => onOpenSettlementNet(shipment)} /></TableCell>
        <TableCell>{shipment.assignedAgentId ? agentNameById.get(shipment.assignedAgentId) : "—"}</TableCell>
        <TableCell><div className="flex flex-wrap items-center gap-1.5"><ShipmentStatusBadges t={t} shipment={shipment} />{isRecipientPayoutAdjustmentBusy ? <Badge variant="outline" className="gap-1 border-primary/30 bg-primary/10 text-primary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("common.processing")}</Badge> : null}{pendingCodAdjustment ? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">{pendingCodAdjustmentLabel(t, pendingCodAdjustment, shipment, iqdPreference)}</Badge> : null}{pendingRecipientPayoutAdjustment ? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">{pendingRecipientPayoutAdjustmentLabel(t, pendingRecipientPayoutAdjustment, shipment, iqdPreference)}</Badge> : null}</div></TableCell>
        <TableCell><SettlementStatusBadge t={t} kind={isPrepaidElectronically ? "reimbursement" : "handover"} status={courierSettlementStatus} /></TableCell>
        <TableCell><SettlementStatusBadge t={t} kind={isPrepaidElectronically ? "repayment" : "payout"} status={merchantSettlementStatus} /></TableCell>
        <TableCell className="text-end"><div className="flex justify-end gap-1">
          {canPlayVoiceReason && voiceReasonEvent && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onPlayVoiceReason(voiceReasonEvent)}><Play className="h-4 w-4" />{t("postService.actions.playback")}</Button>}
          {canAdminEditAndRedispatch && ["received", "assigned", "postponed"].includes(shipment.status) && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEditAndRedispatch(shipment)}><Pencil className="h-4 w-4" />{t(shipment.status === "received" ? "postService.actions.editAndDispatch" : "postService.actions.editAndRedispatch")}</Button>}
          {canUpdate && ["assigned", "postponed"].includes(shipment.status) && <>{!pendingCodAdjustment && !pendingRecipientPayoutAdjustment && <Button size="sm" variant="ghost" onClick={() => onStatus(shipment, "delivered")} title={t("postService.actions.markDelivered")}><CheckCircle2 className="h-4 w-4 text-emerald-600" /></Button>}{shipment.status === "assigned" ? <Button size="sm" variant="ghost" onClick={() => onStatus(shipment, "postponed")} title={t("postService.actions.postpone")}><History className="h-4 w-4 text-amber-600" /></Button> : null}<Button size="sm" variant="ghost" onClick={() => onStatus(shipment, "returned")} title={t("postService.actions.return")}><Undo2 className="h-4 w-4 text-rose-600" /></Button></>}
          {canRequestCodChange && !pendingCodAdjustment && requesterCourierId === shipment.assignedAgentId && shipment.customerPaymentStatus === "cash_on_delivery" && ["assigned", "postponed"].includes(shipment.status) && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onRequestCodChange(shipment)}><FilePenLine className="h-4 w-4" />{t("postService.actions.requestChange")}</Button>}
          {canReviewCodChange && pendingCodAdjustment && <Button size="sm" variant="outline" className="gap-1.5 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300" onClick={() => onReviewCodChange(pendingCodAdjustment)}><FilePenLine className="h-4 w-4" />{pendingCodAdjustmentReviewLabel(t, pendingCodAdjustment, shipment, iqdPreference)}</Button>}
          {canCorrectDeliveredCod && deliveredCodCorrectionShipmentIds.has(shipment.id) && <Button size="sm" variant="outline" className="gap-1.5 border-sky-500/30 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300" onClick={() => onCorrectDeliveredCod(shipment)}><FilePenLine className="h-4 w-4" />{t("postService.actions.correctDeliveredCod")}</Button>}
          {canCorrectDeliveredCod && deliveredRecipientPayoutCorrectionShipmentIds.has(shipment.id) && <Button size="sm" variant="outline" className="gap-1.5 border-violet-500/30 text-violet-700 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300" onClick={() => onCorrectDeliveredRecipientPayout(shipment)}><HandCoins className="h-4 w-4" />{t("postService.actions.correctDeliveredRecipientPayout")}</Button>}
          {canRequestCodChange && !pendingRecipientPayoutAdjustment && requesterCourierId === shipment.assignedAgentId && shipment.customerPaymentStatus === "prepaid_electronically" && ["assigned", "postponed"].includes(shipment.status) && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onRequestRecipientPayoutChange(shipment)}><HandCoins className="h-4 w-4" />{t("postService.actions.requestRecipientPayoutChange")}</Button>}
          {canReviewCodChange && pendingRecipientPayoutAdjustment && <Button size="sm" variant="outline" className="gap-1.5 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300" onClick={() => onReviewRecipientPayoutChange(pendingRecipientPayoutAdjustment)}><HandCoins className="h-4 w-4" />{pendingRecipientPayoutAdjustmentReviewLabel(t, pendingRecipientPayoutAdjustment, shipment, iqdPreference)}</Button>}
          {canReceiveReturn && shipment.status === "returned" && !shipment.returnReceivedAt && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300" onClick={() => onReceiveReturn(shipment)}><PackageCheck className="h-4 w-4" />{t("postService.actions.receiveReturn")}</Button>}
          {canTransfer && shipment.status === "returned" && !shipment.returnReceivedAt && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onTransfer(shipment)}><Send className="h-4 w-4" />{t("postService.actions.transferPost")}</Button>}
          {canSettle && shipment.status === "delivered" && <PostSettlementsButton t={t} activeObligationCount={activeDeliveryShipmentSettlementObligationCount(shipment, handoverStatusByShipment, payoutStatusByShipment, courierReimbursementStatusByShipment, merchantRepaymentStatusByShipment)} onClick={() => onOpenPostSettlements(shipment)} />}
        </div></TableCell>
      </TableRow>;
    })}</TableBody>
    {footer ? <TableFooter><TableRow className="hover:bg-transparent"><TableCell colSpan={11 + Number(canSelect) + Number(showListNumber)} className="bg-muted/40 py-3">{footer}</TableCell></TableRow></TableFooter> : null}
  </Table>;
}
function ShipmentGrid({ t, shipments, selectedIds, onToggle, canSelect, showListNumber = false, profileNameById, agentNameById, onStatus, onTransfer, onReceiveReturn, onEditAndRedispatch, canAdminEditAndRedispatch, canReceiveReturn, onRequestCodChange, onReviewCodChange, pendingCodAdjustmentByShipment, approvedCodAdjustmentByShipment, onCorrectDeliveredCod, deliveredCodCorrectionShipmentIds, onCorrectDeliveredRecipientPayout, deliveredRecipientPayoutCorrectionShipmentIds, canCorrectDeliveredCod, onRequestRecipientPayoutChange, onReviewRecipientPayoutChange, pendingRecipientPayoutAdjustmentByShipment, approvedRecipientPayoutAdjustmentByShipment, recipientPayoutAdjustmentBusyShipmentIds, canRequestCodChange, requesterCourierId, canReviewCodChange, onOpenSettlementNet, onOpenPostSettlements, onPlayVoiceReason, voiceReasonEventByShipment, canPlayVoiceReason, canSettle, canTransfer, canUpdate, iqdPreference, handoverStatusByShipment, payoutStatusByShipment, courierReimbursementStatusByShipment, merchantRepaymentStatusByShipment, settlementNetByShipment }: {
  t: TFunction;
  shipments: DeliveryShipment[];
  selectedIds: Set<string>;
  onToggle: (shipmentId: string, checked: boolean) => void;
  canSelect: boolean;
  showListNumber?: boolean;
  profileNameById: Map<string, string>;
  agentNameById: Map<string, string>;
  onStatus: (shipment: DeliveryShipment, status: "delivered" | "postponed" | "returned") => void;
  onTransfer: (shipment: DeliveryShipment) => void;
  onReceiveReturn: (shipment: DeliveryShipment) => void;
  onEditAndRedispatch: (shipment: DeliveryShipment) => void;
  canAdminEditAndRedispatch: boolean;
  canReceiveReturn: boolean;
  onRequestCodChange: (shipment: DeliveryShipment) => void;
  onReviewCodChange: (request: DeliveryShipmentCodAdjustmentRequest) => void;
  pendingCodAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentCodAdjustmentRequest>;
  approvedCodAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentCodAdjustmentRequest>;
  onCorrectDeliveredCod: (shipment: DeliveryShipment) => void;
  deliveredCodCorrectionShipmentIds: ReadonlySet<string>;
  onCorrectDeliveredRecipientPayout: (shipment: DeliveryShipment) => void;
  deliveredRecipientPayoutCorrectionShipmentIds: ReadonlySet<string>;
  canCorrectDeliveredCod: boolean;
  onRequestRecipientPayoutChange: (shipment: DeliveryShipment) => void;
  onReviewRecipientPayoutChange: (request: DeliveryShipmentRecipientPayoutAdjustmentRequest) => void;
  pendingRecipientPayoutAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>;
  approvedRecipientPayoutAdjustmentByShipment: ReadonlyMap<string, DeliveryShipmentRecipientPayoutAdjustmentRequest>;
  recipientPayoutAdjustmentBusyShipmentIds: ReadonlySet<string>;
  canRequestCodChange: boolean;
  requesterCourierId: string | null;
  canReviewCodChange: boolean;
  onOpenSettlementNet: (shipment: DeliveryShipment) => void;
  onOpenPostSettlements: (shipment: DeliveryShipment) => void;
  onPlayVoiceReason: (event: DeliveryShipmentEvent) => void;
  voiceReasonEventByShipment: ReadonlyMap<string, DeliveryShipmentEvent>;
  canPlayVoiceReason: boolean;
  canSettle: boolean;
  canTransfer: boolean;
  canUpdate: boolean;
  iqdPreference: "IQD" | "د.ع";
  handoverStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  payoutStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  courierReimbursementStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  merchantRepaymentStatusByShipment: ReadonlyMap<string, ShipmentSettlementStatus>;
  settlementNetByShipment: ReadonlyMap<string, ShipmentSettlementNet>;
}) {
  if (shipments.length === 0) return <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">{t("postService.empty.noPosts")}</div>;

  return <>
    {shipments.map((shipment, index) => {
      const isDispatchable = ["received", "postponed"].includes(shipment.status);
      const merchantName = profileNameById.get(shipment.merchantProfileId) ?? t("postService.unknownMerchant");
      const courierName = shipment.assignedAgentId ? agentNameById.get(shipment.assignedAgentId) ?? t("postService.unknownCourier") : "—";
      const voiceReasonEvent = voiceReasonEventByShipment.get(shipment.id);
      const pendingCodAdjustment = pendingCodAdjustmentByShipment.get(shipment.id);
      const approvedCodAdjustment = approvedCodAdjustmentByShipment.get(shipment.id);
      const pendingRecipientPayoutAdjustment = pendingRecipientPayoutAdjustmentByShipment.get(shipment.id);
      const approvedRecipientPayoutAdjustment = approvedRecipientPayoutAdjustmentByShipment.get(shipment.id);
      const isRecipientPayoutAdjustmentBusy = recipientPayoutAdjustmentBusyShipmentIds.has(shipment.id);
      const isPrepaidElectronically = shipment.customerPaymentStatus === "prepaid_electronically";
      const courierSettlementStatus = isPrepaidElectronically
        ? courierReimbursementStatusByShipment.get(shipment.id) ?? "none"
        : handoverStatusByShipment.get(shipment.id) ?? "none";
      const merchantSettlementStatus = isPrepaidElectronically
        ? merchantRepaymentStatusByShipment.get(shipment.id) ?? "none"
        : payoutStatusByShipment.get(shipment.id) ?? "none";

      return <article key={shipment.id} className={cn("group rounded-2xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md", isRecipientPayoutAdjustmentBusy && "pointer-events-none opacity-50")} aria-busy={isRecipientPayoutAdjustmentBusy}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {canSelect && <Checkbox className="mt-0.5 h-5 w-5 rounded-[6px]" checked={selectedIds.has(shipment.id)} disabled={!isDispatchable} aria-label={`${t("postService.table.tracking")}: ${shipment.trackingNumber}`} onCheckedChange={(checked) => onToggle(shipment.id, checked === true)} />}
            {showListNumber && <span className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">#{index + 1}</span>}
            <div className="min-w-0">
              <p className="truncate font-semibold tracking-tight">{shipment.trackingNumber}</p>
              <p className="mt-1 text-xs text-muted-foreground"><span className="tabular-nums">{formatDateTime(shipment.createdAt)}</span></p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1"><div className="flex flex-wrap justify-end gap-1.5"><ShipmentStatusBadges t={t} shipment={shipment} /></div>{isRecipientPayoutAdjustmentBusy ? <Badge variant="outline" className="gap-1 border-primary/30 bg-primary/10 text-primary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("common.processing")}</Badge> : null}{pendingCodAdjustment ? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">{pendingCodAdjustmentLabel(t, pendingCodAdjustment, shipment, iqdPreference)}</Badge> : null}{pendingRecipientPayoutAdjustment ? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">{pendingRecipientPayoutAdjustmentLabel(t, pendingRecipientPayoutAdjustment, shipment, iqdPreference)}</Badge> : null}</div>
        </div>

        <div className="mt-4 grid gap-3 rounded-xl border bg-muted/25 p-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t("postService.table.merchant")}</p>
            <p className="mt-1 truncate text-sm font-medium">{merchantName}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t("postService.form.recipientPhone")}</p>
            <p className="mt-1 truncate text-sm font-medium">{shipment.recipientPhone}</p>
          </div>
        </div>

        {(shipment.recipientAddress || shipment.description) && <div className="mt-3 space-y-1 text-sm text-muted-foreground">
          {shipment.recipientAddress && <p className="line-clamp-2"><span className="font-medium text-foreground">{t("postService.form.deliveryAddress")}: </span>{shipment.recipientAddress}</p>}
          {shipment.description && <p className="line-clamp-2"><span className="font-medium text-foreground">{t("postService.form.description")}: </span>{shipment.description}</p>}
        </div>}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("postService.table.cod")}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums"><ChangedCodAmount t={t} shipment={shipment} approvedAdjustment={approvedCodAdjustment} iqdPreference={iqdPreference} /></p>
          </div>
          <div className="rounded-xl bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("postService.table.settlementNet")}</p>
            <SettlementNetButton t={t} shipment={shipment} settlementNet={settlementNetByShipment.get(shipment.id)} iqdPreference={iqdPreference} className="mt-1 w-full min-w-0" onClick={() => onOpenSettlementNet(shipment)} />
          </div>
        </div>
        {(shipment.recipientPayoutAmount ?? 0) > 0.000001 || approvedRecipientPayoutAdjustment ? <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 px-3 py-2.5"><span className="text-xs font-medium text-muted-foreground">{t("postService.table.recipientPayout")}</span><span className="font-semibold tabular-nums text-rose-700 dark:text-rose-300"><ChangedRecipientPayoutAmount t={t} shipment={shipment} approvedAdjustment={approvedRecipientPayoutAdjustment} iqdPreference={iqdPreference} /></span></div> : null}

        <div className="mt-4 flex items-center gap-2 border-t pt-3">
          <Truck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{t("postService.table.courier")}</p><p className="truncate text-sm font-medium">{courierName}</p></div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-2"><span className="text-xs text-muted-foreground">{t(isPrepaidElectronically ? "postService.settlementType.courierReimbursement" : "postService.table.cashHandover")}</span><SettlementStatusBadge t={t} kind={isPrepaidElectronically ? "reimbursement" : "handover"} status={courierSettlementStatus} /></div>
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-2"><span className="text-xs text-muted-foreground">{t(isPrepaidElectronically ? "postService.settlementType.merchantRepayment" : "postService.table.merchantPayout")}</span><SettlementStatusBadge t={t} kind={isPrepaidElectronically ? "repayment" : "payout"} status={merchantSettlementStatus} /></div>
        </div>

        {(canPlayVoiceReason && voiceReasonEvent || canAdminEditAndRedispatch && ["received", "assigned", "postponed"].includes(shipment.status) || canUpdate && ["assigned", "postponed"].includes(shipment.status) || canRequestCodChange && requesterCourierId === shipment.assignedAgentId && ["cash_on_delivery", "prepaid_electronically"].includes(shipment.customerPaymentStatus) && ["assigned", "postponed"].includes(shipment.status) || canReviewCodChange && (pendingCodAdjustment || pendingRecipientPayoutAdjustment) || canCorrectDeliveredCod && (deliveredCodCorrectionShipmentIds.has(shipment.id) || deliveredRecipientPayoutCorrectionShipmentIds.has(shipment.id)) || canReceiveReturn && shipment.status === "returned" && !shipment.returnReceivedAt || canTransfer && shipment.status === "returned" && !shipment.returnReceivedAt || canSettle && shipment.status === "delivered") && <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
          {canPlayVoiceReason && voiceReasonEvent && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onPlayVoiceReason(voiceReasonEvent)}><Play className="h-4 w-4" />{t("postService.actions.playback")}</Button>}
          {canAdminEditAndRedispatch && ["received", "assigned", "postponed"].includes(shipment.status) && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onEditAndRedispatch(shipment)}><Pencil className="h-4 w-4" />{t(shipment.status === "received" ? "postService.actions.editAndDispatch" : "postService.actions.editAndRedispatch")}</Button>}
          {canUpdate && ["assigned", "postponed"].includes(shipment.status) && <>
            {!pendingCodAdjustment && !pendingRecipientPayoutAdjustment && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300" onClick={() => onStatus(shipment, "delivered")}><CheckCircle2 className="h-4 w-4" />{t("postService.actions.markDelivered")}</Button>}
            {shipment.status === "assigned" ? <Button type="button" size="sm" variant="outline" className="gap-1.5 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300" onClick={() => onStatus(shipment, "postponed")}><History className="h-4 w-4" />{t("postService.actions.postpone")}</Button> : null}
            <Button type="button" size="sm" variant="outline" className="gap-1.5 border-rose-500/30 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300" onClick={() => onStatus(shipment, "returned")}><Undo2 className="h-4 w-4" />{t("postService.actions.return")}</Button>
          </>}
          {canRequestCodChange && !pendingCodAdjustment && requesterCourierId === shipment.assignedAgentId && shipment.customerPaymentStatus === "cash_on_delivery" && ["assigned", "postponed"].includes(shipment.status) && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onRequestCodChange(shipment)}><FilePenLine className="h-4 w-4" />{t("postService.actions.requestChange")}</Button>}
          {canReviewCodChange && pendingCodAdjustment && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300" onClick={() => onReviewCodChange(pendingCodAdjustment)}><FilePenLine className="h-4 w-4" />{pendingCodAdjustmentReviewLabel(t, pendingCodAdjustment, shipment, iqdPreference)}</Button>}
          {canCorrectDeliveredCod && deliveredCodCorrectionShipmentIds.has(shipment.id) && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-sky-500/30 text-sky-700 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300" onClick={() => onCorrectDeliveredCod(shipment)}><FilePenLine className="h-4 w-4" />{t("postService.actions.correctDeliveredCod")}</Button>}
          {canCorrectDeliveredCod && deliveredRecipientPayoutCorrectionShipmentIds.has(shipment.id) && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-violet-500/30 text-violet-700 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300" onClick={() => onCorrectDeliveredRecipientPayout(shipment)}><HandCoins className="h-4 w-4" />{t("postService.actions.correctDeliveredRecipientPayout")}</Button>}
          {canRequestCodChange && !pendingRecipientPayoutAdjustment && requesterCourierId === shipment.assignedAgentId && shipment.customerPaymentStatus === "prepaid_electronically" && ["assigned", "postponed"].includes(shipment.status) && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onRequestRecipientPayoutChange(shipment)}><HandCoins className="h-4 w-4" />{t("postService.actions.requestRecipientPayoutChange")}</Button>}
          {canReviewCodChange && pendingRecipientPayoutAdjustment && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300" onClick={() => onReviewRecipientPayoutChange(pendingRecipientPayoutAdjustment)}><HandCoins className="h-4 w-4" />{pendingRecipientPayoutAdjustmentReviewLabel(t, pendingRecipientPayoutAdjustment, shipment, iqdPreference)}</Button>}
          {canReceiveReturn && shipment.status === "returned" && !shipment.returnReceivedAt && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300" onClick={() => onReceiveReturn(shipment)}><PackageCheck className="h-4 w-4" />{t("postService.actions.receiveReturn")}</Button>}
          {canTransfer && shipment.status === "returned" && !shipment.returnReceivedAt && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onTransfer(shipment)}><Send className="h-4 w-4" />{t("postService.actions.transferPost")}</Button>}
          {canSettle && shipment.status === "delivered" && <PostSettlementsButton t={t} activeObligationCount={activeDeliveryShipmentSettlementObligationCount(shipment, handoverStatusByShipment, payoutStatusByShipment, courierReimbursementStatusByShipment, merchantRepaymentStatusByShipment)} onClick={() => onOpenPostSettlements(shipment)} />}
        </div>}
      </article>;
    })}
  </>;
}
function CourierRegistry({ t, couriers, search, onSearchChange, breakdownByParty, shipmentLabelById, iqdPreference, canSettle, canManage, onAddCourier, onEditCourier, onSettleParty, onSettlePost, onReimburseCourier, onReimburseCourierCollectively, onOpenPosts }: {
  t: TFunction;
  couriers: CourierRow[];
  search: string;
  onSearchChange: (value: string) => void;
  breakdownByParty: ReadonlyMap<string, readonly ShipmentSettlementBreakdown[]>;
  shipmentLabelById: ReadonlyMap<string, string>;
  iqdPreference: "IQD" | "د.ع";
  canSettle: boolean;
  canManage: boolean;
  onAddCourier: () => void;
  onEditCourier: (courier: CourierRow) => void;
  onSettleParty: (balance: { kind: "courier"; id: string; currency: CurrencyCode; amount: number; name: string }) => void;
  onSettlePost: (balance: { kind: "courier"; id: string; currency: CurrencyCode; name: string }, post: ShipmentSettlementBreakdown) => void;
  onReimburseCourier: (payable: CourierPayable) => void;
  onReimburseCourierCollectively: (reimbursement: CourierReimbursement) => void;
  onOpenPosts: (target: PartyPostsDialogTarget) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (id: string) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t("postService.cards.couriers")}</CardTitle>
        {canManage && <Button size="sm" onClick={onAddCourier}><Plus className="me-2 h-4 w-4" />{t("postService.actions.addCourier")}</Button>}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="relative mb-4"><Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => onSearchChange(event.target.value)} className="ps-9" placeholder={t("postService.placeholders.searchCouriers")} /></div>
        <Table>
          <TableHeader><TableRow><TableHead>{t("postService.table.courier")}</TableHead><TableHead>{t("postService.table.zone")}</TableHead><TableHead>{t("postService.table.contact")}</TableHead><TableHead>{t("postService.table.posts")}</TableHead><TableHead>{t("postService.table.outstandingCash")}</TableHead><TableHead>{t("postService.table.courierPayable")}</TableHead><TableHead>{t("postService.table.status")}</TableHead><TableHead className="text-end">{t("postService.table.actions")}</TableHead></TableRow></TableHeader>
          <TableBody>
            {couriers.length === 0 ? <EmptyRow columns={8} label={t("postService.empty.noCouriers")} /> : couriers.map((courier) => {
              const courierPostsByShipment = new Map<string, { post: ShipmentSettlementBreakdown; currency: CurrencyCode }>();
              for (const balance of courier.balances) {
                for (const post of breakdownByParty.get(`${courier.agent.id}:${balance.currency}`) ?? []) {
                  courierPostsByShipment.set(post.shipmentId, { post, currency: balance.currency });
                }
              }
              for (const payable of courier.payables) {
                if (!courierPostsByShipment.has(payable.shipmentId)) {
                  courierPostsByShipment.set(payable.shipmentId, {
                    post: { shipmentId: payable.shipmentId, amount: 0, paid: 0, outstanding: 0 },
                    currency: payable.currency,
                  });
                }
              }
              const courierPosts = [...courierPostsByShipment.values()].reverse();
              const expanded = expandedIds.has(courier.agent.id);
              return (
                <Fragment key={courier.agent.id}>
                  <TableRow>
                    <TableCell>
                      <button type="button" className="flex items-center gap-2 font-medium hover:underline" onClick={() => toggleExpanded(courier.agent.id)}>
                        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
                        {courier.name}
                      </button>
                    </TableCell>
                    <TableCell>{courier.agent.zone || <span className="text-muted-foreground">{t("postService.table.noZone")}</span>}</TableCell>
                    <TableCell>{courier.phone ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell><Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onOpenPosts({ kind: "courier", id: courier.agent.id, name: courier.name })}><ClipboardList className="h-4 w-4" />{t("postService.actions.viewPosts")}</Button></TableCell>
                    <TableCell><MerchantPayableAmounts payables={courier.balances} iqdPreference={iqdPreference} /></TableCell>
                    <TableCell><CourierPayableAmounts payables={courier.payables} iqdPreference={iqdPreference} /></TableCell>
                    <TableCell><Badge variant="outline" className={courier.agent.status === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : "text-muted-foreground"}>{t(courier.agent.status === "active" ? "postService.active" : "postService.inactive")}</Badge></TableCell>
                    <TableCell className="text-end"><div className="flex flex-wrap justify-end gap-1">{canSettle && courier.balances.map((balance) => <Button key={balance.currency} type="button" size="sm" className="gap-1.5" onClick={() => onSettleParty({ kind: "courier", id: courier.agent.id, currency: balance.currency, amount: balance.amount, name: courier.name })}><Banknote className="h-4 w-4" />{t("postService.actions.recordHandover")}<span className="tabular-nums">{formatCurrency(balance.amount, balance.currency, iqdPreference)}</span></Button>)}{canSettle && courier.reimbursements.map((reimbursement) => <Button key={`reimbursement-${reimbursement.currency}`} type="button" size="sm" variant="outline" className="gap-1.5 border-rose-500/30 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300" onClick={() => onReimburseCourierCollectively(reimbursement)}><HandCoins className="h-4 w-4" />{t("postService.actions.reimburseCourier")}<span className="tabular-nums">{formatCurrency(reimbursement.amount, reimbursement.currency, iqdPreference)}</span></Button>)}{canManage && <Button type="button" size="icon" variant="ghost" title={t("postService.actions.editCourier")} onClick={() => onEditCourier(courier)}><Pencil className="h-4 w-4" /></Button>}</div></TableCell>
                  </TableRow>
                  {expanded && (courierPosts.length === 0 ? (
                    <TableRow className="bg-muted/30"><TableCell colSpan={8} className="ps-10 text-xs text-muted-foreground">{t("postService.empty.noCourierPosts")}</TableCell></TableRow>
                  ) : courierPosts.map(({ post, currency }) => {
                    const reimbursement = courier.payables.find((payable) => payable.shipmentId === post.shipmentId && payable.currency === currency);
                    return (
                      <TableRow key={`${currency}:${post.shipmentId}`} className="bg-muted/30">
                        <TableCell className="ps-10 text-xs font-medium">{shipmentLabelById.get(post.shipmentId) ?? "—"}</TableCell>
                        <TableCell colSpan={3} className="text-xs text-muted-foreground">{t("postService.table.collected")}: <span className="font-medium tabular-nums text-foreground">{formatCurrency(post.paid, currency, iqdPreference)}</span></TableCell>
                        <TableCell className="text-xs font-medium tabular-nums">{formatCurrency(post.outstanding, currency, iqdPreference)}</TableCell>
                        <TableCell className="text-xs font-medium tabular-nums text-rose-700 dark:text-rose-300">{reimbursement ? formatCurrency(reimbursement.amount, currency, iqdPreference) : "—"}</TableCell>
                        <TableCell />
                        <TableCell className="text-end"><div className="flex flex-wrap justify-end gap-1">{canSettle && post.outstanding > 0.000001 && <Button type="button" size="sm" variant="outline" onClick={() => onSettlePost({ kind: "courier", id: courier.agent.id, currency, name: courier.name }, post)}>{t("postService.actions.recordHandover")}</Button>}{canSettle && reimbursement && <Button type="button" size="sm" variant="outline" className="gap-1.5 border-rose-500/30 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300" onClick={() => onReimburseCourier(reimbursement)}><HandCoins className="h-4 w-4" />{t("postService.actions.reimburseCourier")}</Button>}</div></TableCell>
                      </TableRow>
                    );
                  }))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SettlementCalculationLine({ label, amount, currency, iqdPreference, operator, negative = false, emphasized = false }: { label: string; amount: number; currency: CurrencyCode; iqdPreference: "IQD" | "د.ع"; operator: "+" | "−" | "="; negative?: boolean; emphasized?: boolean }) {
  const amountClass = negative ? "text-rose-700 dark:text-rose-300" : amount < -0.000001 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300";
  return <div className={cn("grid grid-cols-[1fr_auto_auto] items-baseline gap-3", emphasized && "pt-1 text-base font-bold")}><span>{label}</span><span className={amountClass}>{formatCurrency(amount, currency, iqdPreference)}</span><span className={cn("font-bold", operator === "=" ? "text-foreground" : negative ? "text-rose-600" : "text-emerald-600")}>{operator}</span></div>;
}
function MerchantPayableAmounts({ payables, iqdPreference }: { payables: Array<{ currency: CurrencyCode; amount: number }>; iqdPreference: "IQD" | "د.ع" }) {
  if (payables.length === 0) return <span className="text-muted-foreground">—</span>;
  return <div className="flex min-w-28 flex-col items-start gap-1 whitespace-nowrap font-medium tabular-nums text-amber-700 dark:text-amber-300">{payables.map(({ currency, amount }) => <span key={currency}>{formatCurrency(amount, currency, iqdPreference)}</span>)}</div>;
}
function CourierPayableAmounts({ payables, iqdPreference }: { payables: CourierPayable[]; iqdPreference: "IQD" | "د.ع" }) {
  if (payables.length === 0) return <span className="text-muted-foreground">—</span>;
  const totals = new Map<CurrencyCode, number>();
  for (const payable of payables) totals.set(payable.currency, (totals.get(payable.currency) ?? 0) + payable.amount);
  return <div className="flex min-w-28 flex-col items-start gap-1 whitespace-nowrap font-medium tabular-nums text-rose-700 dark:text-rose-300">{[...totals.entries()].map(([currency, amount]) => <span key={currency}>{formatCurrency(amount, currency, iqdPreference)}</span>)}</div>;
}
function MerchantAccountBalanceAmounts({ t, balances, iqdPreference }: { t: TFunction; balances: Array<{ currency: CurrencyCode; amount: number }>; iqdPreference: "IQD" | "د.ع" }) {
  if (balances.length === 0) return <span className="text-muted-foreground">—</span>;
  return <div className="flex min-w-32 flex-col items-start gap-1.5 whitespace-nowrap tabular-nums">{balances.map(({ currency, amount }) => {
    const merchantIsOwed = amount > 0.000001;
    return <div key={currency} className={cn("flex items-center gap-1.5 font-medium", merchantIsOwed ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300")}><span>{formatCurrency(Math.abs(amount), currency, iqdPreference)}</span><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t(merchantIsOwed ? "postService.merchantBalance.owedToMerchant" : "postService.merchantBalance.owedByMerchant")}</span></div>;
  })}</div>;
}
function PostSettlementsButton({ t, activeObligationCount, onClick }: { t: TFunction; activeObligationCount: number; onClick: () => void }) {
  return <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={onClick}>
    <Banknote className="h-4 w-4" />
    {t("postService.actions.settlements")}
    <Badge variant="secondary" className="min-w-5 justify-center rounded-full px-1 py-0 text-[10px] tabular-nums">{activeObligationCount}</Badge>
  </Button>;
}

function SettlementNetButton({ t, shipment, settlementNet, iqdPreference, onClick, className }: { t: TFunction; shipment: DeliveryShipment; settlementNet?: ShipmentSettlementNet; iqdPreference: "IQD" | "د.ع"; onClick: () => void; className?: string }) {
  if (!settlementNet) {
    return <Button type="button" variant="outline" size="sm" className={cn("min-w-20 border-dashed text-muted-foreground", className)} onClick={onClick}>---</Button>;
  }
  const workspaceRecipientPayout = settlementNet.hasCourierHandover && (shipment.recipientPayoutFunding ?? "workspace_payment") === "workspace_payment"
    ? shipment.recipientPayoutAmount
    : 0;
  const net = shipmentSettlementNetAmount(settlementNet, workspaceRecipientPayout);
  const isComplete = isShipmentSettlementNetFinalized(shipment, settlementNet);
  const settlementClass = !isComplete
    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
    : net > 0.000001
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
      : net < -0.000001
        ? "border-rose-500/30 bg-rose-500/10 text-rose-700 hover:bg-rose-500/15 dark:text-rose-300"
        : "border-border bg-muted text-muted-foreground";
  return <Button type="button" variant="outline" size="sm" className={cn("min-w-28 justify-center font-semibold", settlementClass, className)} onClick={onClick} title={t("postService.table.settlementNet")}>{formatCurrency(net, shipment.currency, iqdPreference)}</Button>;
}
function SettlementStatusBadge({ t, kind, status }: { t: TFunction; kind: "handover" | "payout" | "reimbursement" | "repayment"; status: ShipmentSettlementStatus | "none" }) {
  if (status === "none") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const settledLabel = kind === "handover"
    ? "handedOver"
    : kind === "payout"
      ? "paid"
      : kind === "reimbursement"
        ? "reimbursed"
        : "received";
  const label = t(`postService.settlementStatus.${status === "settled" ? settledLabel : status}`);
  const className = status === "settled"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "partial"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-border bg-muted text-muted-foreground";
  return <Badge variant="outline" className={className}>{label}</Badge>;
}
function SettlementBalances({ t, title, icon: Icon, kind, balances, breakdownByParty, shipmentLabelById, obligationLabel, getName, action, canSettle, onSettleParty, onSettlePost, iqdPreference }: {
  t: TFunction;
  title: string;
  icon: typeof WalletCards;
  kind: "courier" | "merchant";
  balances: Array<{ id: string; currency: CurrencyCode; amount: number; paid: number }>;
  breakdownByParty: ReadonlyMap<string, readonly ShipmentSettlementBreakdown[]>;
  shipmentLabelById: ReadonlyMap<string, string>;
  obligationLabel: string;
  getName: (id: string) => string;
  action: string;
  canSettle: boolean;
  onSettleParty: (balance: { kind: "courier" | "merchant"; id: string; currency: CurrencyCode; amount: number; name: string }) => void;
  onSettlePost: (balance: { kind: "courier" | "merchant"; id: string; currency: CurrencyCode; name: string }, post: ShipmentSettlementBreakdown) => void;
  iqdPreference: "IQD" | "د.ع";
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <Icon className="h-5 w-5 text-primary" />
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("postService.table.party")}</TableHead>
              <TableHead className="text-end">{t("postService.table.principal")}</TableHead>
              <TableHead className="text-end">{obligationLabel}</TableHead>
              <TableHead className="text-end">{t("postService.table.outstanding")}</TableHead>
              <TableHead className="w-40 text-end" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.length === 0 ? (
              <EmptyRow columns={5} label={t("postService.empty.noBalances")} />
            ) : (
              balances.map((balance) => {
                const posts = [...(breakdownByParty.get(`${balance.id}:${balance.currency}`) ?? [])].reverse();
                return (
                  <Fragment key={`${balance.id}-${balance.currency}`}>
                    <TableRow>
                      <TableCell className="font-medium">{getName(balance.id)}</TableCell>
                      <TableCell className="text-end">{formatCurrency(balance.paid + balance.amount, balance.currency, iqdPreference)}</TableCell>
                      <TableCell className="text-end">{balance.paid > 0.000001 ? formatCurrency(balance.paid, balance.currency, iqdPreference) : "—"}</TableCell>
                      <TableCell className="text-end">{formatCurrency(balance.amount, balance.currency, iqdPreference)}</TableCell>
                      <TableCell className="text-end">
                        {canSettle && (
                          <Button size="sm" onClick={() => onSettleParty({ kind, id: balance.id, currency: balance.currency, amount: balance.amount, name: getName(balance.id) })}>
                            {action}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {posts.map((post) => (
                      <TableRow key={post.shipmentId} className="bg-muted/30">
                        <TableCell className="ps-8 text-xs font-medium">{shipmentLabelById.get(post.shipmentId) ?? "—"}</TableCell>
                        <TableCell className="text-end text-xs">{formatCurrency(post.amount, balance.currency, iqdPreference)}</TableCell>
                        <TableCell className="text-end text-xs">{formatCurrency(post.paid, balance.currency, iqdPreference)}</TableCell>
                        <TableCell className="text-end text-xs">{formatCurrency(post.outstanding, balance.currency, iqdPreference)}</TableCell>
                        <TableCell className="text-end">
                          {canSettle && post.outstanding > 0.000001 && (
                            <Button size="sm" variant="outline" onClick={() => onSettlePost({ kind, id: balance.id, currency: balance.currency, name: getName(balance.id) }, post)}>
                              {action}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CourierPayableBalances({ t, payables, shipmentLabelById, getName, canSettle, onPay, iqdPreference }: {
  t: TFunction;
  payables: CourierPayable[];
  shipmentLabelById: ReadonlyMap<string, string>;
  getName: (id: string) => string;
  canSettle: boolean;
  onPay: (payable: CourierPayable) => void;
  iqdPreference: "IQD" | "د.ع";
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <HandCoins className="h-5 w-5 text-rose-600 dark:text-rose-300" />
        <CardTitle>{t("postService.cards.courierPayables")}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("postService.table.courier")}</TableHead>
              <TableHead>{t("postService.table.tracking")}</TableHead>
              <TableHead className="text-end">{t("postService.table.courierPayable")}</TableHead>
              <TableHead className="w-40 text-end">{t("postService.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payables.length === 0 ? (
              <EmptyRow columns={4} label={t("postService.empty.noCourierPayables")} />
            ) : payables.map((payable) => (
              <TableRow key={`${payable.agentId}:${payable.currency}:${payable.shipmentId}`}>
                <TableCell className="font-medium">{getName(payable.agentId)}</TableCell>
                <TableCell>{shipmentLabelById.get(payable.shipmentId) ?? "—"}</TableCell>
                <TableCell className="text-end font-medium tabular-nums text-rose-700 dark:text-rose-300">{formatCurrency(payable.amount, payable.currency, iqdPreference)}</TableCell>
                <TableCell className="text-end">
                  {canSettle && <Button size="sm" variant="outline" className="gap-1.5 border-rose-500/30 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300" onClick={() => onPay(payable)}><HandCoins className="h-4 w-4" />{t("postService.actions.reimburseCourier")}</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
