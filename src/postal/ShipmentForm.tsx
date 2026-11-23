import { usePostalAction } from "./usePostalAccess";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleHelp,
  PackagePlus,
  Loader2,
  ShieldCheck,
  Wine,
  Package,
  Link2,
  ImagePlus,
  Images,
  X,
} from "lucide-react";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Button,
  Input,
  Label,
  Textarea,
  Checkbox,
  Progress,
} from "@/ui/components";
import { detectSupportedImageMime } from "@/lib/imageCompression";
import { getImageUploadProfile } from "@/lib/imageUploadProfiles";
import { mediaUploadService, getMediaUploadErrorCode, MediaUploadError } from "@/services/mediaUploadService";
import { savePostalShipmentAttachments, fetchPostalShipmentAttachments } from "@/local-db/postalAttachments";
import { cleanupDeletedShipmentAttachments, deleteShipmentAttachmentUploads } from "./shipmentAttachments";
import {
  copyShipment,
  findPostalTariff,
  postalTariffOptions,
  signedIqd,
  shipmentValidationErrors,
  type ShipmentValidationError,
  type ShipmentInput,
  type PostalShipment,
  type PostalOrganization,
  type PostalTariffOption,
  emptyPostalLocationCatalog,
} from "./domain";
import {
  postalCommand,
  usePostalLocationCatalog,
  type PostalScope,
} from "@/local-db/postal";
import { LocationPicker } from "./shared";
import { OrganizationAutoCompleteInput } from "./OrganizationAutoCompleteInput";
import { ShipmentTariffSelector } from "./ShipmentTariffSelector";

const validationFields = {
  recipient_name: ["shipment-recipient_name", "postal.recipient_name"],
  primary_phone: ["shipment-primary_phone", "postal.primary_phone"],
  backup_phone: ["shipment-backup_phone", "postal.backup_phone"],
  governorate: ["postal-governorate", "postal.governorate"],
  area: ["postal-area", "postal.area"],
  address: ["shipment-address", "postal.address"],
  cod_amount: ["shipment-cod", "postal.codAmount"],
  pieces: ["shipment-pieces", "postal.pieces"],
  delivery_notes: ["shipment-notes", "postal.deliveryNotes"],
} as const;
type ValidationField = keyof typeof validationFields;

const MAX_SHIPMENT_ATTACHMENTS = 5;

interface ShipmentAttachmentDraft {
  id: string;
  file: File;
  previewUrl: string;
  status: "selected" | "uploading" | "uploaded" | "failed";
}

export function ShipmentForm({
  scope,
  source,
  editing,
  financialAmountsLocked = false,
  generatedQrId,
  onClose,
  onSaved,
}: {
  scope: PostalScope;
  source?: PostalShipment;
  editing?: boolean;
  financialAmountsLocked?: boolean;
  generatedQrId?: string;
  onClose: () => void;
  onSaved: (shipment: PostalShipment) => void;
}) {
  const { t } = useTranslation();
  const locationCatalogQuery = usePostalLocationCatalog(scope);
  const locationCatalog = locationCatalogQuery.data ?? emptyPostalLocationCatalog;
  const requiresOrganization = !editing && scope.role !== "merchant";
  const [organizationQuery, setOrganizationQuery] = useState("");
  const [selectedOrganization, setSelectedOrganization] =
    useState<PostalOrganization | null>(null);
  const [form, setForm] = useState<ShipmentInput>(() =>
    source
      ? copyShipment(source)
      : {
          recipient_name: "",
          primary_phone: "",
          backup_phone: "",
          governorate: "",
          area: "",
          address: "",
          cod_amount: 0,
          pieces: null,
          fragile: false,
          delivery_notes: "",
        },
  );
  const [amount, setAmount] = useState(
    source ? String(Math.abs(source.cod_amount)) : "",
  );
  const initialDeliveryFeeAddon =
    editing && source && source.state !== "draft"
      ? source.delivery_fee ?? 0
      : source?.delivery_fee_addon ??
        (source?.shipment_size == null ? source?.delivery_fee ?? 0 : 0);
  const [deliveryFee, setDeliveryFee] = useState(
    initialDeliveryFeeAddon > 0 ? String(initialDeliveryFeeAddon) : "",
  );
  const [negative, setNegative] = useState((source?.cod_amount ?? 0) < 0);
  const [pieces, setPieces] = useState(
    source?.pieces ? String(source.pieces) : "",
  );
  const needsTariff = !editing || source?.state === "draft";
  const showFullDeliveryFee = Boolean(
    editing && scope.role === "admin" && source && source.state !== "draft",
  );
  const lateAdminEdit = Boolean(showFullDeliveryFee && !financialAmountsLocked);
  const canEditFinancialAmounts = Boolean(
    !financialAmountsLocked &&
      (!editing || source?.state === "draft" || scope.role === "admin"),
  );
  const [selectedTariff, setSelectedTariff] = useState<PostalTariffOption | null>(null);
  const tariffInitialized = useRef(false);
  const persistedTariff = source && locationCatalogQuery.data
    ? findPostalTariff(
        source.governorate,
        source.area,
        source.shipment_size,
        source.delivery_fee_tariff ?? source.delivery_fee,
        locationCatalogQuery.data,
        true,
      )
    : null;
  const isOriginalDestination = Boolean(
    source && form.governorate === source.governorate && form.area === source.area,
  );
  useEffect(() => {
    if (!locationCatalogQuery.data || tariffInitialized.current) return;
    tariffInitialized.current = true;
    if (!source) return;
    setSelectedTariff(
      findPostalTariff(
        source.governorate,
        source.area,
        source.shipment_size,
        source.delivery_fee_tariff ?? source.delivery_fee,
        locationCatalogQuery.data,
        true,
      ) ??
        postalTariffOptions(
          source.governorate,
          source.area,
          locationCatalogQuery.data,
        ).find((option) => option.size === source.shipment_size) ??
        null,
    );
  }, [editing, locationCatalogQuery.data, source]);
  const tariff = findPostalTariff(
    form.governorate,
    form.area,
    selectedTariff?.size,
    selectedTariff?.fee,
    locationCatalog,
  ) ?? (
    isOriginalDestination && persistedTariff &&
      selectedTariff?.size === persistedTariff.size &&
      selectedTariff?.fee === persistedTariff.fee
      ? persistedTariff
      : null
  );
  const shipmentTariffOptions = postalTariffOptions(
    form.governorate,
    form.area,
    locationCatalog,
  );
  if (
    isOriginalDestination && persistedTariff &&
    !shipmentTariffOptions.some((option) => option.size === persistedTariff.size && option.fee === persistedTariff.fee)
  ) shipmentTariffOptions.push(persistedTariff);
  const [touched, setTouched] = useState<
    Partial<Record<ValidationField, boolean>>
  >({});
  const action = usePostalAction();
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef(new Set<string>());
  const createdShipment = useRef<PostalShipment>();
  const [attachments, setAttachments] = useState<ShipmentAttachmentDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentStage, setAttachmentStage] = useState<"idle" | "uploading" | "saving">("idle");
  const [attachmentAttempt, setAttachmentAttempt] = useState(0);
  const [closingProvisional, setClosingProvisional] = useState(false);
  const isProcessing = action.busy || closingProvisional;
  const completedAttachmentUploads = attachments.filter((item) => item.status === "uploaded").length;
  const attachmentProfile = getImageUploadProfile("shipment-attachment");
  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  const closeForm = async () => {
    if (isProcessing) return;
    const pendingShipment = createdShipment.current;
    if (!pendingShipment) {
      onClose();
      return;
    }
    setClosingProvisional(true);
    try {
      const objectsCleaned = await deleteShipmentAttachmentUploads(
        scope.workspaceId,
        pendingShipment.id,
      );
      if (!objectsCleaned) {
        setAttachmentError("cleanupFailed");
        return;
      }
      await postalCommand(
        scope,
        "delete_draft",
        { id: pendingShipment.id, revision: pendingShipment.revision },
        crypto.randomUUID(),
      );
      await cleanupDeletedShipmentAttachments(scope.workspaceId, pendingShipment.id);
      createdShipment.current = undefined;
      onClose();
    } catch {
      setAttachmentError("cleanupFailed");
    } finally {
      setClosingProvisional(false);
    }
  };

  const handleAttachmentSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    setAttachmentError(null);
    if (selectedFiles.length === 0) return;
    const remaining = MAX_SHIPMENT_ATTACHMENTS - attachments.length;
    if (selectedFiles.length > remaining) setAttachmentError("limit");
    const next: ShipmentAttachmentDraft[] = [];
    for (const file of selectedFiles.slice(0, Math.max(0, remaining))) {
      if (file.size > attachmentProfile.maxInputBytes) {
        setAttachmentError("fileTooLarge");
        continue;
      }
      const mime = detectSupportedImageMime(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
      if (!mime) {
        setAttachmentError("invalidType");
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      next.push({ id: crypto.randomUUID(), file, previewUrl, status: "selected" });
    }
    if (next.length) setAttachments((current) => [...current, ...next]);
  };

  const removeAttachment = (id: string) => {
    const removed = attachments.find((item) => item.id === id);
    if (removed && previewUrls.current.delete(removed.previewUrl)) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentError(null);
  };
  const signed = signedIqd(amount, negative);
  const payload = {
    ...form,
    recipient_name: form.recipient_name.trim(),
    cod_amount: signed ?? NaN,
    pieces: pieces ? Number(pieces) : null,
  };
  const errors: Partial<Record<ValidationField, ShipmentValidationError>> =
    shipmentValidationErrors(payload, locationCatalog, Boolean(editing));
  const deliveryFeeAmount = deliveryFee === "" ? null : Number(deliveryFee);
  const deliveryFeeInvalid =
    deliveryFeeAmount !== null &&
    (!Number.isSafeInteger(deliveryFeeAmount) ||
      deliveryFeeAmount <= 0 ||
      deliveryFeeAmount > 999999999999 ||
      (!lateAdminEdit &&
        (tariff?.fee ?? 0) + deliveryFeeAmount > 999999999999));
  const tariffRequirementMissing =
    needsTariff && !tariff && deliveryFee === "";
  const deliveryFeeRequired = lateAdminEdit && deliveryFeeAmount === null;
  const invalidFields = Object.keys(validationFields).filter(
    (field) => errors[field as ValidationField],
  ) as ValidationField[];
  const organizationInvalid = requiresOrganization && !selectedOrganization;
  const valid =
    Boolean(locationCatalogQuery.data) &&
    invalidFields.length === 0 &&
    !organizationInvalid &&
    !deliveryFeeInvalid &&
    !deliveryFeeRequired &&
    !tariffRequirementMissing;
  const showNegativePrefix = negative && amount.length > 0;
  const fieldError = (field: ValidationField) => {
    if (!touched[field] || !errors[field]) return null;
    return (
      <p
        id={`${validationFields[field][0]}-error`}
        className="text-sm text-destructive"
      >
        {t(`postal.validation.${errors[field]}`)}
      </p>
    );
  };
  const fieldValidation = (field: ValidationField) => ({
    "aria-invalid": Boolean(touched[field] && errors[field]),
    "aria-describedby":
      touched[field] && errors[field]
        ? `${validationFields[field][0]}-error`
        : undefined,
    onBlur: () => setTouched((current) => ({ ...current, [field]: true })),
  });
  const set = (key: keyof ShipmentInput, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));
  const unknownRecipientButton = (
    className: string,
    iconClassName = "h-4 w-4",
  ) => (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={`h-7 w-7 ${className}`}
      aria-label={t("postal.fillUnknownRecipient")}
      title={t("postal.fillUnknownRecipient")}
      disabled={isProcessing}
      onClick={() => set("recipient_name", t("postal.unknownRecipient"))}
    >
      <CircleHelp className={iconClassName} aria-hidden="true" />
    </Button>
  );
  const money = amount ? Number(amount).toLocaleString("en-US") : "";
  const deliveryFeeMoney = deliveryFee
    ? Number(deliveryFee).toLocaleString("en-US")
    : "";
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !isProcessing) void closeForm();
      }}
    >
      <AppDialogContent className="max-w-2xl" showCloseButton={!isProcessing}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary" />
            {t(
              editing
                ? "postal.editShipment"
                : requiresOrganization
                  ? "postal.createShipmentForOrganization"
                  : "postal.createShipment",
            )}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const commandPayload = {
              ...payload,
              ...(!editing && generatedQrId ? { generated_qr_id: generatedQrId } : {}),
              ...(needsTariff
                ? {
                    tariff_size: tariff?.size ?? null,
                    delivery_fee: tariff?.fee ?? null,
                    delivery_fee_addon: deliveryFeeAmount ?? 0,
                  }
                : {}),
              ...(lateAdminEdit && deliveryFeeAmount !== source?.delivery_fee
                ? { delivery_fee_override: deliveryFeeAmount }
                : {}),
              ...(requiresOrganization
                ? { organization_id: selectedOrganization?.id }
                : {}),
            };
            const signature = JSON.stringify({
              payload: commandPayload,
              attachmentAttempt,
            });
            void action.run(signature, async (request) => {
              setAttachmentError(null);
              if (editing) {
                const shipment = await postalCommand<PostalShipment>(
                  scope,
                  "edit_shipment",
                  { ...commandPayload, id: source?.id, revision: source?.revision },
                  request,
                );
                onSaved(shipment);
                return;
              }

              let shipment = createdShipment.current;
              if (!shipment) {
                shipment = await postalCommand<PostalShipment>(
                  scope,
                  "create_shipment",
                  commandPayload,
                  request,
                );
                createdShipment.current = shipment;
              }
              if (attachments.length === 0) {
                createdShipment.current = undefined;
                onSaved(shipment);
                return;
              }

              const uploadedKeys: string[] = [];
              let activeAttachmentId: string | undefined;
              try {
                const existing = await fetchPostalShipmentAttachments(
                  scope.workspaceId,
                  shipment.id,
                );
                if (existing.length > 0) {
                  if (existing.length === attachments.length) {
                    createdShipment.current = undefined;
                    onSaved(shipment);
                    return;
                  }
                  throw new Error("postal_attachment_conflict");
                }

                const clearedPreviousUploads = await deleteShipmentAttachmentUploads(
                  scope.workspaceId,
                  shipment.id,
                );
                if (!clearedPreviousUploads) throw new Error("postal_attachment_cleanup_failed");

                setAttachmentError(null);
                setAttachmentStage("uploading");
                const metadata = [] as Array<{
                  object_key: string;
                  content_type: "image/webp";
                  size_bytes: number;
                  width: number;
                  height: number;
                }>;
                for (const item of attachments) {
                  activeAttachmentId = item.id;
                  setAttachments((current) => current.map((draft) =>
                    draft.id === item.id ? { ...draft, status: "uploading" } : draft,
                  ));
                  const stored = await mediaUploadService.storeImageFile(
                    item.file,
                    scope.workspaceId,
                    `shipment-attachments/${shipment.id}`,
                    "shipment-attachment",
                  );
                  if (!stored.r2Key) throw new MediaUploadError("cloud_required");
                  uploadedKeys.push(stored.r2Key);
                  metadata.push({
                    object_key: stored.r2Key,
                    content_type: "image/webp",
                    size_bytes: stored.artifact.outputBytes,
                    width: stored.artifact.width,
                    height: stored.artifact.height,
                  });
                  setAttachments((current) => current.map((draft) =>
                    draft.id === item.id ? { ...draft, status: "uploaded" } : draft,
                  ));
                }

                setAttachmentStage("saving");
                await savePostalShipmentAttachments(scope, shipment.id, metadata);
                createdShipment.current = undefined;
                setAttachmentStage("idle");
                onSaved(shipment);
              } catch (error) {
                setAttachmentStage("idle");
                if (activeAttachmentId) {
                  setAttachments((current) => current.map((draft) =>
                    draft.id === activeAttachmentId ? { ...draft, status: "failed" } : draft,
                  ));
                }

                let existing: Awaited<ReturnType<typeof fetchPostalShipmentAttachments>> | null = null;
                try {
                  existing = await fetchPostalShipmentAttachments(scope.workspaceId, shipment.id);
                } catch {
                  // Preserve the provisional shipment and its objects when the server state is unknown.
                }
                const uploadedKeySet = [...uploadedKeys].sort().join("|");
                const existingKeySet = existing?.map((item) => item.object_key).sort().join("|");
                if (existing && existing.length === attachments.length && uploadedKeySet === existingKeySet) {
                  createdShipment.current = undefined;
                  onSaved(shipment);
                  return;
                }
                if (existing === null) {
                  setAttachmentError("saveFailed");
                  throw error;
                }

                let draftDeleted = false;
                try {
                  await postalCommand(
                    scope,
                    "delete_draft",
                    { id: shipment.id, revision: shipment.revision },
                    crypto.randomUUID(),
                  );
                  draftDeleted = true;
                } catch {
                  // Keep this shipment as the retry target; the next submit reuses its ID.
                }

                const failedUploadKey = error instanceof MediaUploadError ? error.objectKey : undefined;
                const objectsCleaned = await deleteShipmentAttachmentUploads(
                  scope.workspaceId,
                  shipment.id,
                  failedUploadKey ? [...uploadedKeys, failedUploadKey] : uploadedKeys,
                );
                let cleanupFailed = !objectsCleaned;
                if (draftDeleted) {
                  const queuedObjectsCleaned = await cleanupDeletedShipmentAttachments(
                    scope.workspaceId,
                    shipment.id,
                  );
                  createdShipment.current = undefined;
                  setAttachmentAttempt((current) => current + 1);
                  cleanupFailed = cleanupFailed || !queuedObjectsCleaned;
                }
                const code = getMediaUploadErrorCode(error);
                setAttachmentError(cleanupFailed ? "cleanupFailed"
                  : code === "image_too_large" ? "fileTooLarge"
                    : code === "unsupported_image" || code === "animated_image" ? "invalidType"
                      : String(error).includes("attachment_limit") ? "limit"
                        : String(error).includes("cleanup") ? "cleanupFailed"
                          : uploadedKeys.length > 0 ? "saveFailed" : "uploadFailed");
                throw error;
              }
            });
          }}
        >
          <AppDialogBody className="space-y-5">
            {locationCatalogQuery.isPending && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </p>
            )}
            {locationCatalogQuery.error && !locationCatalogQuery.data && (
              <p className="text-sm text-destructive" role="alert">
                {t("postal.errors.locationsUnavailable")}
              </p>
            )}
            {generatedQrId && !editing && <p className="break-all rounded-lg border bg-muted/30 p-3 text-sm">
              {t('postal.qr.pendingClaim')} <bdi dir="ltr" className="font-mono">{generatedQrId}</bdi>
            </p>}
            {requiresOrganization && (
              <div className="space-y-2">
                <Label htmlFor="shipment-organization">
                  {t("postal.organizationName")} *
                </Label>
                <OrganizationAutoCompleteInput
                  id="shipment-organization"
                  scope={scope}
                  value={organizationQuery}
                  required
                  aria-invalid={organizationInvalid}
                  aria-describedby={
                    organizationInvalid
                      ? "shipment-organization-error"
                      : undefined
                  }
                  disabled={isProcessing}
                  onChange={(value) => {
                    setOrganizationQuery(value);
                    setSelectedOrganization(null);
                  }}
                  onSelectOrganization={(organization) => {
                    setOrganizationQuery(organization.name);
                    setSelectedOrganization(organization);
                  }}
                />
                {selectedOrganization && (
                  <Badge variant="secondary" className="w-fit gap-1">
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("postal.linked")}
                  </Badge>
                )}
                {organizationInvalid && (
                  <p
                    id="shipment-organization-error"
                    className="text-sm text-destructive"
                  >
                    {t("postal.validation.required")}
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                ["primary_phone", "backup_phone", "recipient_name"] as const
              ).map((key) => (
                <div
                  className={
                    key === "recipient_name"
                      ? "space-y-2 sm:col-span-2"
                      : "space-y-2"
                  }
                  key={key}
                >
                  <div className="flex w-fit items-center gap-2">
                    <Label htmlFor={`shipment-${key}`}>
                      {t(`postal.${key}`)}
                      {key !== "backup_phone" && " *"}
                    </Label>
                    {key === "recipient_name" && !editing &&
                      unknownRecipientButton("hidden sm:inline-flex")}
                  </div>
                  <div
                    className={
                      key === "recipient_name" && !editing
                        ? "flex items-center gap-2"
                        : undefined
                    }
                  >
                    <Input
                      id={`shipment-${key}`}
                      {...fieldValidation(key)}
                      required={key !== "backup_phone"}
                      value={form[key]}
                      maxLength={key === "recipient_name" ? 160 : 15}
                      inputMode={key === "recipient_name" ? "text" : "tel"}
                      dir={key === "recipient_name" ? undefined : "ltr"}
                      disabled={isProcessing}
                      className={
                        key === "recipient_name" && !editing
                          ? "min-w-0 flex-1"
                          : undefined
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (key === "recipient_name" || /^\d*$/.test(v))
                          set(key, v);
                      }}
                    />
                    {key === "recipient_name" && !editing &&
                      unknownRecipientButton(
                        "h-11 w-11 shrink-0 sm:hidden",
                        "h-5 w-5",
                      )}
                  </div>
                  {fieldError(key)}
                </div>
              ))}
            </div>
            <LocationPicker
              governorate={form.governorate}
              area={form.area}
              catalog={locationCatalog}
              disabled={isProcessing || locationCatalogQuery.isPending || !locationCatalogQuery.data}
              onChange={(governorate, area) => {
                setForm((f) => ({ ...f, governorate, area }));
                setSelectedTariff((current) =>
                  findPostalTariff(
                    governorate,
                    area,
                    current?.size,
                    current?.fee,
                    locationCatalog,
                    Boolean(source && governorate === source.governorate && area === source.area),
                  ),
                );
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="shipment-address">{t("postal.address")}</Label>
              <Textarea
                id="shipment-address"
                {...fieldValidation("address")}
                maxLength={2000}
                disabled={isProcessing}
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
              {fieldError("address")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="shipment-cod">{t("postal.codAmount")} *</Label>
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-0 flex-1" dir="ltr">
                  {showNegativePrefix && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute start-4 top-1/2 z-10 -translate-y-1/2 select-none font-medium text-foreground"
                    >
                      -
                    </span>
                  )}
                  <Input
                    className={showNegativePrefix ? "w-full ps-6" : "w-full"}
                    id="shipment-cod"
                    {...fieldValidation("cod_amount")}
                    inputMode="numeric"
                    placeholder="0"
                    dir="ltr"
                    required
                    value={money}
                    disabled={
                      isProcessing || !canEditFinancialAmounts
                    }
                    onChange={(e) => {
                      const digits = e.target.value.replace(/,/g, "");
                      if (/^\d{0,12}$/.test(digits)) setAmount(digits);
                    }}
                  />
                </div>
                <Label className="flex items-center gap-2">
                  <Checkbox
                    checked={negative}
                    disabled={
                      isProcessing || !canEditFinancialAmounts
                    }
                    onCheckedChange={setNegative}
                  />
                  {t("postal.negativeAmount")}
                </Label>
              </div>
              {fieldError("cod_amount")}
              <p className="text-xs text-muted-foreground">
                {t("postal.codAmountHint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("postal.negativeHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="shipment-delivery-fee">
                {t("postal.deliveryFee")}{lateAdminEdit && " *"}
              </Label>
              <Input
                id="shipment-delivery-fee"
                inputMode="numeric"
                placeholder="0"
                dir="ltr"
                value={deliveryFeeMoney}
                required={lateAdminEdit}
                disabled={
                  isProcessing ||
                    (!needsTariff && !lateAdminEdit) ||
                    (lateAdminEdit && !canEditFinancialAmounts)
                }
                aria-invalid={deliveryFeeInvalid || deliveryFeeRequired}
                aria-describedby={
                  deliveryFeeInvalid || deliveryFeeRequired
                    ? "shipment-delivery-fee-error"
                    : "shipment-delivery-fee-hint"
                }
                onChange={(e) => {
                  const digits = e.target.value.replace(/,/g, "");
                  if (/^\d{0,12}$/.test(digits)) setDeliveryFee(digits);
                }}
              />
              {deliveryFeeInvalid || deliveryFeeRequired ? (
                <p
                  id="shipment-delivery-fee-error"
                  className="text-sm text-destructive"
                >
                  {t(
                    deliveryFeeInvalid
                      ? "postal.validation.deliveryFee"
                      : "postal.validation.required",
                  )}
                </p>
              ) : (
                <p
                  id="shipment-delivery-fee-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t(
                    showFullDeliveryFee
                      ? "postal.deliveryFeeFullAmountHint"
                      : "postal.deliveryFeeAddonHint",
                  )}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="shipment-pieces">{t("postal.pieces")}</Label>
              <Input
                id="shipment-pieces"
                {...fieldValidation("pieces")}
                inputMode="numeric"
                placeholder="0"
                value={pieces ? Number(pieces).toLocaleString("en-US") : ""}
                disabled={isProcessing}
                onChange={(e) => {
                  const digits = e.target.value.replace(/,/g, "");
                  if (/^\d{0,10}$/.test(digits)) setPieces(digits);
                }}
              />
              {fieldError("pieces")}
            </div>
            <div className="space-y-2">
              <Label>{t("postal.fragility")} *</Label>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label={t("postal.fragility")}
              >
                {[false, true].map((value) => (
                  <Button
                    key={String(value)}
                    type="button"
                    variant={form.fragile === value ? "default" : "outline"}
                    aria-pressed={form.fragile === value}
                    disabled={isProcessing}
                    onClick={() => set("fragile", value)}
                  >
                    {value ? (
                      <Wine className="me-2 h-4 w-4" />
                    ) : (
                      <Package className="me-2 h-4 w-4" />
                    )}
                    {t(value ? "postal.fragile" : "postal.nonFragile")}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="shipment-notes">
                {t("postal.deliveryNotes")}
              </Label>
              <Textarea
                id="shipment-notes"
                {...fieldValidation("delivery_notes")}
                maxLength={2000}
                disabled={isProcessing}
                value={form.delivery_notes}
                onChange={(e) => set("delivery_notes", e.target.value)}
              />
              {fieldError("delivery_notes")}
            </div>
            {needsTariff && (
              <ShipmentTariffSelector
                id="shipment-tariff"
                options={shipmentTariffOptions}
                value={tariff}
                disabled={isProcessing || !locationCatalogQuery.data}
                required={false}
                allowDeselect
                onChange={setSelectedTariff}
              />
            )}
            {!editing && (
              <section aria-labelledby="shipment-attachments-heading" className="space-y-3 rounded-xl border bg-muted/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="shipment-attachments-heading" className="flex items-center gap-2 font-semibold">
                    <Images className="h-4 w-4 text-primary" aria-hidden="true" />
                    {t("postal.attachments.title")}
                  </h3>
                  <Badge variant="secondary" className="tabular-nums">
                    {t("postal.attachments.counter", { count: attachments.length, max: MAX_SHIPMENT_ATTACHMENTS })}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t("postal.attachments.hint")}</p>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                  className="sr-only"
                  disabled={isProcessing || attachments.length >= MAX_SHIPMENT_ATTACHMENTS}
                  onChange={(event) => void handleAttachmentSelection(event)}
                  aria-label={t("postal.attachments.select")}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  disabled={isProcessing || attachments.length >= MAX_SHIPMENT_ATTACHMENTS}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" aria-hidden="true" />
                  {t("postal.attachments.select")}
                </Button>
                {attachments.length > 0 && (
                  <div className="space-y-3">
                    {attachmentStage !== "idle" && (
                      <div className="space-y-2" aria-live="polite">
                        <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                          <span>{t(attachmentStage === "uploading" ? "postal.attachments.uploading" : "postal.attachments.saving")}</span>
                          <span dir="ltr" className="tabular-nums">
                            {completedAttachmentUploads}/{attachments.length}
                          </span>
                        </div>
                        <Progress
                          value={completedAttachmentUploads / attachments.length * 100}
                          indeterminate={attachmentStage === "saving" || completedAttachmentUploads < attachments.length}
                          aria-label={t("postal.attachments.uploadProgress")}
                        />
                      </div>
                    )}
                    <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("postal.attachments.selectedPhotos")}>
                      {attachments.map((item) => (
                        <li key={item.id} className="flex min-w-0 items-center gap-3 rounded-lg border bg-background p-2">
                          <img
                            src={item.previewUrl}
                            alt={t("postal.attachments.photoPreview", { name: item.file.name })}
                            className="h-16 w-16 shrink-0 rounded-md bg-muted object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={item.file.name}>{item.file.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {item.status === "uploading" ? (
                                <span className="inline-flex items-center gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  {t("postal.attachments.uploading")}
                                </span>
                              ) : t(item.status === "uploaded" ? "postal.attachments.uploaded" : item.status === "failed" ? "postal.attachments.failed" : "postal.attachments.ready")}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            disabled={isProcessing}
                            aria-label={t("postal.attachments.remove", { name: item.file.name })}
                            onClick={() => removeAttachment(item.id)}
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {attachmentError && (
                  <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
                    <CircleHelp className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t(`postal.attachments.errors.${attachmentError}`)}
                  </p>
                )}
              </section>
            )}
            {tariffRequirementMissing && (
              <p className="text-sm text-destructive" role="alert">
                {t("postal.validation.deliveryFeeOrSizeRequired")}
              </p>
            )}
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isProcessing}
              onClick={() => void closeForm()}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || isProcessing}>
              {isProcessing ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="me-2 h-4 w-4" />
              )}
              {t(editing ? "common.save" : "postal.createShipment")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}
