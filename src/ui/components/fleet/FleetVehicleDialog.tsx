import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  createFleetVehicle,
  updateFleetVehicle,
  type FleetVehicle,
  type FleetVehicleStatus,
} from "@/local-db";
import { Input } from "@/ui/components/input";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from "@/ui/components";

interface FleetVehicleDialogProps {
  workspaceId: string;
  vehicle?: FleetVehicle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FleetVehicleDialog({
  workspaceId,
  vehicle,
  open,
  onOpenChange,
}: FleetVehicleDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [plateNumber, setPlateNumber] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [vin, setVin] = useState("");
  const [status, setStatus] = useState<FleetVehicleStatus>("active");
  const [notes, setNotes] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPlateNumber(vehicle?.plateNumber ?? "");
    setMake(vehicle?.make ?? "");
    setModel(vehicle?.model ?? "");
    setYear(vehicle?.year ? String(vehicle.year) : "");
    setColor(vehicle?.color ?? "");
    setVin(vehicle?.vin ?? "");
    setStatus(vehicle?.status ?? "active");
    setNotes(vehicle?.notes ?? "");
  }, [open, vehicle]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const payload = {
        plateNumber,
        make,
        model,
        year: year ? Number(year) : null,
        color,
        vin,
        status,
        notes,
      };
      if (vehicle) {
        await updateFleetVehicle(vehicle.id, payload);
      } else {
        await createFleetVehicle(workspaceId, payload);
      }
      toast({
        title: t(vehicle ? "fleet.messages.vehicleUpdated" : "fleet.messages.vehicleCreated"),
      });
      onOpenChange(false);
    } catch {
      toast({
        title: t("fleet.messages.saveVehicleFailed"),
        description: t("fleet.messages.tryAgain"),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(vehicle ? "fleet.vehicles.edit" : "fleet.vehicles.add")}</DialogTitle>
          <DialogDescription>
            {t("fleet.vehicles.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="fleet-plate">{t("fleet.vehicles.plateNumberRequired")}</Label>
            <Input
              id="fleet-plate"
              value={plateNumber}
              onChange={(event) => setPlateNumber(event.target.value)}
              placeholder="22 A 12345"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fleet-model">{t("fleet.vehicles.modelRequired")}</Label>
            <Input
              id="fleet-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Hilux"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fleet-make">{t("fleet.vehicles.make")}</Label>
            <Input
              id="fleet-make"
              value={make}
              onChange={(event) => setMake(event.target.value)}
              placeholder="Toyota"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fleet-year">{t("fleet.vehicles.year")}</Label>
            <Input
              id="fleet-year"
              type="number"
              min={1900}
              max={2200}
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fleet-color">{t("fleet.vehicles.color")}</Label>
            <Input
              id="fleet-color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fleet-vin">{t("fleet.vehicles.vin")}</Label>
            <Input
              id="fleet-vin"
              value={vin}
              onChange={(event) => setVin(event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>{t("fleet.status")}</Label>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as FleetVehicleStatus)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t("fleet.vehicleStatus.active")}</SelectItem>
                <SelectItem value="maintenance">{t("fleet.vehicleStatus.maintenance")}</SelectItem>
                <SelectItem value="inactive">{t("fleet.vehicleStatus.inactive")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="fleet-notes">{t("fleet.notes")}</Label>
            <Textarea
              id="fleet-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !plateNumber.trim() || !model.trim()}
          >
            {isSaving ? t("fleet.vehicles.saving") : t("fleet.vehicles.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
