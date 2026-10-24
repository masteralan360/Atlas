import { usePostalAction } from "./usePostalAccess";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  PackagePlus,
  Loader2,
  ShieldCheck,
  Wine,
  Package,
} from "lucide-react";
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
  Textarea,
  Checkbox,
} from "@/ui/components";
import {
  copyShipment,
  signedIqd,
  shipmentValidationErrors,
  type ShipmentValidationError,
  type ShipmentInput,
  type PostalShipment,
} from "./domain";
import { postalCommand, type PostalScope } from "@/local-db/postal";
import { LocationPicker } from "./shared";

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
  onClose,
  onSaved,
}: {
  scope: PostalScope;
  source?: PostalShipment;
  editing?: boolean;
  onClose: () => void;
  onSaved: (shipment: PostalShipment) => void;
}) {
  const { t } = useTranslation();
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
  const [negative, setNegative] = useState((source?.cod_amount ?? 0) < 0);
  const [pieces, setPieces] = useState(
    source?.pieces ? String(source.pieces) : "",
  );
  const [reason, setReason] = useState("");
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
  const invalidFields = Object.keys(validationFields).filter(
    (field) => errors[field as ValidationField],
  ) as ValidationField[];
  const valid = invalidFields.length === 0;
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
            {t(editing ? "postal.editShipment" : "postal.createShipment")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            void action.run(
              JSON.stringify(payload) + reason,
              async (request) => {
                const shipment = await postalCommand<PostalShipment>(
                  scope,
                  editing ? "edit_shipment" : "create_shipment",
                  {
                    ...payload,
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
                    {t(`postal.${key}`)} *
                  </Label>
                  <Input
                    id={`shipment-${key}`}
                    {...fieldValidation(key)}
                    required
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
              onChange={(governorate, area) =>
                setForm((f) => ({ ...f, governorate, area }))
              }
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
                <Input
                  className="min-w-0 flex-1"
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
                {t("postal.negativeHint")}
              </p>
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
            {!valid && (
              <div
                data-testid="shipment-validation"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
                aria-labelledby="shipment-validation-title"
                role="region"
              >
                <p
                  id="shipment-validation-title"
                  className="mb-2 flex items-center gap-2 font-medium"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                  {t("postal.validation.checkFields")}
                </p>
                <ul className="space-y-2">
                  {invalidFields.map((field) => (
                    <li key={field}>
                      <button
                        type="button"
                        className="text-start underline underline-offset-2 hover:text-primary focus-visible:outline focus-visible:outline-2"
                        onClick={() => {
                          setTouched((current) => ({
                            ...current,
                            [field]: true,
                          }));
                          let target = document.getElementById(
                            validationFields[field][0],
                          );
                          if (target?.matches(":disabled"))
                            target =
                              document.getElementById("postal-governorate");
                          target?.focus({ preventScroll: true });
                          target?.scrollIntoView({ block: "center" });
                        }}
                      >
                        {t(validationFields[field][1])}:{" "}
                        {t(`postal.validation.${errors[field]}`)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
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
