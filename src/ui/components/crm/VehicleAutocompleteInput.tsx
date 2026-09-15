import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Car, Check } from "lucide-react";

import {
  type RentalVehicle,
  type RentalVehicleStatus,
  useRentalVehicles,
} from "@/local-db";
import { getRentalVehicleDisplayLabel } from "@/lib/carRentalPresentation";
import { cn } from "@/lib/utils";
import { Input } from "@/ui/components";
import { AutocompletePopover } from "@/ui/components/AutocompletePopover";

interface VehicleAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelectVehicle: (vehicle: RentalVehicle) => void;
  workspaceId: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  required?: boolean;
  hasSelection?: boolean;
  linkedLabel?: string;
  showLinkedIndicator?: boolean;
  excludeVehicleIds?: string[];
  statuses?: RentalVehicleStatus[];
  isLoading?: boolean;
}

export function VehicleAutocompleteInput({
  value,
  onChange,
  onSelectVehicle,
  workspaceId,
  placeholder,
  className,
  inputClassName,
  disabled,
  required,
  hasSelection = false,
  linkedLabel,
  showLinkedIndicator = true,
  excludeVehicleIds = [],
  statuses,
  isLoading: isLoadingOverride,
}: VehicleAutocompleteInputProps) {
  const { t } = useTranslation();
  const vehicles = useRentalVehicles(workspaceId);
  const [isFocused, setIsFocused] = useState(false);
  const [justSelected, setJustSelected] = useState(false);
  const [showInitialSuggestions, setShowInitialSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingOpenRef = useRef(false);
  const hadFocusRef = useRef(false);
  const isLoading = isLoadingOverride ?? vehicles.isLoading;
  const wasLoadingRef = useRef(isLoading);
  const isDisabled = Boolean(disabled || isLoading);

  const query = value.trim().toLowerCase();
  const excludedVehicleIds = useMemo(
    () => new Set(excludeVehicleIds.filter(Boolean)),
    [excludeVehicleIds],
  );

  const filtered = useMemo(() => {
    const eligibleVehicles = vehicles
      .filter((vehicle) => !excludedVehicleIds.has(vehicle.id))
      .filter((vehicle) => !statuses || statuses.includes(vehicle.status))
    if (!query || query.length < 1) {
      return showInitialSuggestions ? eligibleVehicles.slice(0, 8) : [];
    }

    return eligibleVehicles
      .filter((vehicle) =>
        [vehicle.make, vehicle.model, vehicle.plateNumber, vehicle.category]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
      .slice(0, 8);
  }, [excludedVehicleIds, query, showInitialSuggestions, statuses, vehicles]);

  const showDropdown = isFocused && !justSelected && filtered.length > 0;
  const shouldShowLinkedIndicator = hasSelection && showLinkedIndicator;
  const resolvedLinkedLabel = linkedLabel || t("carRental.partnerLink.linked");

  const handleSelect = useCallback(
    (vehicle: RentalVehicle) => {
      hadFocusRef.current = false;
      setJustSelected(true);
      setIsFocused(false);
      onChange(getRentalVehicleDisplayLabel(vehicle));
      onSelectVehicle(vehicle);
    },
    [onChange, onSelectVehicle],
  );

  useEffect(() => {
    if (!justSelected) return;

    const timeout = setTimeout(() => setJustSelected(false), 200);
    return () => clearTimeout(timeout);
  }, [justSelected]);

  useEffect(() => {
    if (isLoading && !wasLoadingRef.current && hadFocusRef.current) {
      pendingOpenRef.current = true;
      setIsFocused(false);
    }

    if (!isLoading && wasLoadingRef.current && pendingOpenRef.current) {
      pendingOpenRef.current = false;
      if (!disabled) {
        setShowInitialSuggestions(true);
        setIsFocused(true);
        inputRef.current?.focus();
      }
    }

    wasLoadingRef.current = isLoading;
  }, [disabled, isLoading]);

  const linkedIndicator = (
    <div
      aria-label={resolvedLinkedLabel}
      className="absolute right-2 top-1/2 -translate-y-1/2"
    >
      <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
        <Check className="h-3 w-3 shrink-0" />
        {resolvedLinkedLabel}
      </span>
    </div>
  );

  return (
    <AutocompletePopover
      open={showDropdown}
      onOpenChange={(open) => {
        if (!open && !isLoading) hadFocusRef.current = false;
        setIsFocused(open);
      }}
      anchor={(
        <div data-autocomplete-popover-anchor className={cn("relative w-full", className)}>
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setJustSelected(false);
              setShowInitialSuggestions(false);
              onChange(event.target.value);
            }}
            onFocus={() => {
              hadFocusRef.current = true;
              setIsFocused(true);
            }}
            onBlur={() => {
              if (!isLoading) hadFocusRef.current = false;
            }}
            placeholder={placeholder}
            disabled={isDisabled}
            aria-busy={isLoading || undefined}
            required={required}
            className={cn(
              "flex-1",
              inputClassName,
              shouldShowLinkedIndicator && "pr-28",
              hasSelection && "border-green-500/50 bg-green-50/30 dark:bg-green-950/10",
            )}
          />
          {shouldShowLinkedIndicator ? linkedIndicator : null}
        </div>
      )}
    >
      <div className="rounded-xl border bg-popover shadow-lg">
          {filtered.map((vehicle) => (
            <button
              key={vehicle.id}
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
              onMouseDown={(event) => {
                event.preventDefault();
                handleSelect(vehicle);
              }}
            >
              <Car className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {getRentalVehicleDisplayLabel(vehicle)}
                </div>
                {vehicle.category ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {vehicle.category}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                {t(`carRental.vehicleStatuses.${vehicle.status}`)}
              </span>
            </button>
          ))}
        </div>
    </AutocompletePopover>
  );
}
