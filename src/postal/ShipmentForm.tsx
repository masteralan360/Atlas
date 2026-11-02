import { usePostalAction } from "./usePostalAccess";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PackagePlus,
  Loader2,
  ShieldCheck,
  Wine,
  Package,
  Link2,
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
} from "@/ui/components";
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
} from "./domain";
import { postalCommand, type PostalScope } from "@/local-db/postal";
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
  reason: ["shipment-reason", "postal.correctionReason"],
} as const;
type ValidationField = keyof typeof validationFields;

export function ShipmentForm({
  scope,
  source,
  editing,
  generatedQrId,
  onClose,
  onSaved,
}: {
  scope: PostalScope;
  source?: PostalShipment;
  editing?: boolean;
  generatedQrId?: string;
  onClose: () => void;
  onSaved: (shipment: PostalShipment) => void;
}) {
  const { t } = useTranslation();
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
    source?.delivery_fee_addon ??
    (source?.shipment_size == null ? source?.delivery_fee ?? 0 : 0);
  const [deliveryFee, setDeliveryFee] = useState(
    initialDeliveryFeeAddon > 0 ? String(initialDeliveryFeeAddon) : "",
  );
  const [negative, setNegative] = useState((source?.cod_amount ?? 0) < 0);
  const [pieces, setPieces] = useState(
    source?.pieces ? String(source.pieces) : "",
  );
  const [reason, setReason] = useState("");
  const needsTariff = !editing || source?.state === "draft";
  const [selectedTariff, setSelectedTariff] = useState<PostalTariffOption | null>(
    () => {
      if (!source) return null;
      return (
        findPostalTariff(
          source.governorate,
          source.area,
          source.shipment_size,
          source.delivery_fee_tariff ?? source.delivery_fee,
        ) ??
        postalTariffOptions(source.governorate, source.area).find(
          (option) => option.size === source.shipment_size,
        ) ??
        null
      );
    },
  );
  const tariff = findPostalTariff(
    form.governorate, form.area, selectedTariff?.size, selectedTariff?.fee,
  );
  const [touched, setTouched] = useState<
    Partial<Record<ValidationField, boolean>>
  >({});
  const action = usePostalAction();
  const signed = signedIqd(amount, negative);
  const payload = {
    ...form,
    recipient_name: form.recipient_name.trim(),
    cod_amount: signed ?? NaN,
    pieces: pieces ? Number(pieces) : null,
  };
  const errors: Partial<Record<ValidationField, ShipmentValidationError>> =
    shipmentValidationErrors(payload);
  if (editing && scope.role === "admin" && !reason.trim())
    errors.reason = "required";
  const deliveryFeeAmount = deliveryFee === "" ? null : Number(deliveryFee);
  const deliveryFeeInvalid =
    deliveryFeeAmount !== null &&
    (!Number.isSafeInteger(deliveryFeeAmount) ||
      deliveryFeeAmount <= 0 ||
      deliveryFeeAmount > 999999999999 ||
      (tariff?.fee ?? 0) + deliveryFeeAmount > 999999999999);
  const tariffRequirementMissing =
    needsTariff && !tariff && deliveryFee === "";
  const invalidFields = Object.keys(validationFields).filter(
    (field) => errors[field as ValidationField],
  ) as ValidationField[];
  const organizationInvalid = requiresOrganization && !selectedOrganization;
  const valid =
    invalidFields.length === 0 &&
    !organizationInvalid &&
    !deliveryFeeInvalid &&
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
  const money = amount ? Number(amount).toLocaleString("en-US") : "";
  const deliveryFeeMoney = deliveryFee
    ? Number(deliveryFee).toLocaleString("en-US")
    : "";
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <AppDialogContent className="max-w-2xl" showCloseButton={!action.busy}>
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
              ...(requiresOrganization
                ? { organization_id: selectedOrganization?.id }
                : {}),
            };
            void action.run(
              JSON.stringify(commandPayload) + reason,
              async (request) => {
                const shipment = await postalCommand<PostalShipment>(
                  scope,
                  editing ? "edit_shipment" : "create_shipment",
                  {
                    ...commandPayload,
                    ...(editing
                      ? {
                          id: source?.id,
                          revision: source?.revision,
                          reason: reason.trim(),
                        }
                      : {}),
                  },
                  request,
                );
                onSaved(shipment);
              },
            );
          }}
        >
          <AppDialogBody className="space-y-5">
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
                  disabled={action.busy}
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
                  <Label htmlFor={`shipment-${key}`}>
                    {t(`postal.${key}`)}
                    {key !== "backup_phone" && " *"}
                  </Label>
                  <Input
                    id={`shipment-${key}`}
                    {...fieldValidation(key)}
                    required={key !== "backup_phone"}
                    value={form[key]}
                    maxLength={key === "recipient_name" ? 160 : 15}
                    inputMode={key === "recipient_name" ? "text" : "tel"}
                    dir={key === "recipient_name" ? undefined : "ltr"}
                    disabled={action.busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (key === "recipient_name" || /^\d*$/.test(v))
                        set(key, v);
                    }}
                  />
                  {fieldError(key)}
                </div>
              ))}
            </div>
            <LocationPicker
              governorate={form.governorate}
              area={form.area}
              disabled={action.busy}
              onChange={(governorate, area) => {
                setForm((f) => ({ ...f, governorate, area }));
                setSelectedTariff((current) =>
                  findPostalTariff(governorate, area, current?.size, current?.fee),
                );
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="shipment-address">{t("postal.address")}</Label>
              <Textarea
                id="shipment-address"
                {...fieldValidation("address")}
                maxLength={2000}
                disabled={action.busy}
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
                      action.busy || (!!editing && source?.state !== "draft")
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
                      action.busy || (!!editing && source?.state !== "draft")
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
                {t("postal.deliveryFee")}
              </Label>
              <Input
                id="shipment-delivery-fee"
                inputMode="numeric"
                placeholder="0"
                dir="ltr"
                value={deliveryFeeMoney}
                disabled={action.busy || (!!editing && !needsTariff)}
                aria-invalid={deliveryFeeInvalid}
                aria-describedby={
                  deliveryFeeInvalid
                    ? "shipment-delivery-fee-error"
                    : "shipment-delivery-fee-hint"
                }
                onChange={(e) => {
                  const digits = e.target.value.replace(/,/g, "");
                  if (/^\d{0,12}$/.test(digits)) setDeliveryFee(digits);
                }}
              />
              {deliveryFeeInvalid ? (
                <p
                  id="shipment-delivery-fee-error"
                  className="text-sm text-destructive"
                >
                  {t("postal.validation.deliveryFee")}
                </p>
              ) : (
                <p
                  id="shipment-delivery-fee-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t("postal.deliveryFeeAddonHint")}
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
                disabled={action.busy}
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
                    disabled={action.busy}
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
                disabled={action.busy}
                value={form.delivery_notes}
                onChange={(e) => set("delivery_notes", e.target.value)}
              />
              {fieldError("delivery_notes")}
            </div>
            {editing && scope.role === "admin" && (
              <div className="space-y-2">
                <Label htmlFor="shipment-reason">
                  {t("postal.correctionReason")} *
                </Label>
                <Textarea
                  id="shipment-reason"
                  {...fieldValidation("reason")}
                  value={reason}
                  disabled={action.busy}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
                {fieldError("reason")}
              </div>
            )}
            {needsTariff && (
              <ShipmentTariffSelector
                id="shipment-tariff"
                governorate={form.governorate}
                options={postalTariffOptions(form.governorate, form.area)}
                value={tariff}
                disabled={action.busy}
                required={false}
                allowDeselect
                onChange={setSelectedTariff}
              />
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
              disabled={action.busy}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || action.busy}>
              {action.busy ? (
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
