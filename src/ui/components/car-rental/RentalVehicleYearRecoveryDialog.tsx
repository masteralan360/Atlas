import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";

import { getRentalVehicleDisplayLabel } from "@/lib/carRentalPresentation";
import {
  INVALID_RENTAL_VEHICLE_YEAR_ERROR,
  RENTAL_VEHICLE_YEAR_MAX,
  RENTAL_VEHICLE_YEAR_MIN,
  repairQueuedRentalVehicleYear,
} from "@/local-db/carRental";
import { db } from "@/local-db/database";
import { sanitizeNumericInput } from "@/lib/utils";
import { Input } from "@/ui/components/input";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
  useToast,
} from "@/ui/components";

type RentalVehicleYearRecoveryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRepaired: () => void;
  workspaceId?: string;
  vehicleId?: string;
  mutationId?: string;
};

export function RentalVehicleYearRecoveryDialog({
  open,
  onOpenChange,
  onRepaired,
  workspaceId,
  vehicleId,
  mutationId,
}: RentalVehicleYearRecoveryDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const vehicle = useLiveQuery(
    () => (vehicleId ? db.rental_vehicles.get(vehicleId) : undefined),
    [vehicleId],
  );
  const loadedVehicleId = vehicle?.id;
  const loadedVehicleYear = vehicle?.year ?? null;
  const [year, setYear] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const hasInvalidYear = Boolean(year) && (
    !/^\d{4}$/.test(year)
    || Number(year) < RENTAL_VEHICLE_YEAR_MIN
    || Number(year) > RENTAL_VEHICLE_YEAR_MAX
  );
  const canSaveYear = Boolean(vehicle && year && !hasInvalidYear);

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    if (loadedVehicleId) {
      setYear(
        loadedVehicleYear === null
          ? ""
          : String(loadedVehicleYear),
      );
      setError(null);
    }
  }, [loadedVehicleId, loadedVehicleYear, open]);

  async function repair(correctedYear: number | null) {
    if (!workspaceId || !vehicleId || !mutationId) return;

    setIsSaving(true);
    setError(null);
    try {
      await repairQueuedRentalVehicleYear(
        workspaceId,
        vehicleId,
        mutationId,
        correctedYear,
      );
      toast({ title: t("carRental.messages.vehicleYearCorrected") });
      onRepaired();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === INVALID_RENTAL_VEHICLE_YEAR_ERROR
          ? t("carRental.syncRecovery.yearInvalid", {
              min: RENTAL_VEHICLE_YEAR_MIN,
              max: RENTAL_VEHICLE_YEAR_MAX,
            })
          : t("carRental.syncRecovery.couldNotRepair"),
      );
    } finally {
      setIsSaving(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!year || hasInvalidYear) {
      setError(
        !year
          ? t("carRental.syncRecovery.yearRequired")
          : t("carRental.syncRecovery.yearInvalid", {
              min: RENTAL_VEHICLE_YEAR_MIN,
              max: RENTAL_VEHICLE_YEAR_MAX,
            }),
      );
      return;
    }
    void repair(Number(year));
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving) onOpenChange(nextOpen);
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
          <AppDialogTitle>{t("carRental.syncRecovery.title")}</AppDialogTitle>
        </AppDialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <AppDialogBody className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              {t("carRental.syncRecovery.description", {
                min: RENTAL_VEHICLE_YEAR_MIN,
                max: RENTAL_VEHICLE_YEAR_MAX,
              })}
            </p>
            {vehicle ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm font-medium text-foreground">
                {getRentalVehicleDisplayLabel(vehicle)}
              </p>
            ) : (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {t("carRental.syncRecovery.vehicleUnavailable")}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="rental-vehicle-year-recovery">
                {t("carRental.fields.year")}
              </Label>
              <Input
                id="rental-vehicle-year-recovery"
                value={year}
                placeholder="0"
                inputMode="numeric"
                maxLength={4}
                disabled={isSaving || !vehicle}
                aria-invalid={Boolean(error) || hasInvalidYear}
                aria-describedby={error ? "rental-vehicle-year-recovery-error" : undefined}
                className={hasInvalidYear ? "border-destructive focus-visible:ring-destructive" : undefined}
                onChange={(event) => {
                  setYear(
                    sanitizeNumericInput(event.target.value, { allowDecimal: false }),
                  );
                  setError(null);
                }}
              />
              {error && (
                <p id="rental-vehicle-year-recovery-error" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
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
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                onClick={() => void repair(null)}
                disabled={isSaving || !vehicle}
              >
                {t("carRental.syncRecovery.removeYear")}
              </Button>
              <Button type="submit" disabled={isSaving || !canSaveYear}>
                {isSaving
                  ? t("carRental.actions.saving")
                  : t("carRental.syncRecovery.saveAndRetry")}
              </Button>
            </div>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}
