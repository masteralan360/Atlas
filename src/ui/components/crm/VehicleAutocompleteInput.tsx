import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Car, Check, Loader2 } from "lucide-react";

import { searchRentalVehicleAutocompleteSuggestions } from "@/local-db/carRental";
import type { RentalVehicle, RentalVehicleStatus } from "@/local-db/models";
import { getRentalVehicleDisplayLabel } from "@/lib/carRentalPresentation";
import { cn } from "@/lib/utils";
import { Input } from "@/ui/components";
import { AutocompletePopover } from "@/ui/components/AutocompletePopover";
import { useDebouncedAutocompleteSearch } from "@/ui/components/useDebouncedAutocompleteSearch";

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
}: VehicleAutocompleteInputProps) {
  const { t } = useTranslation();
  const [isFocused, setIsFocused] = useState(false);
  const [justSelected, setJustSelected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = value.trim();
  const normalizedQuery = query.toLocaleLowerCase();
  const excludedIdsKey = [...new Set(excludeVehicleIds.filter(Boolean))].sort().join("|");
  const normalizedExcludedIds = useMemo(
    () => excludedIdsKey ? excludedIdsKey.split("|") : [],
    [excludedIdsKey],
  );
  const statusesKey = statuses?.join("|") ?? "";
  const normalizedStatuses = useMemo(
    () => statusesKey ? statusesKey.split("|") as RentalVehicleStatus[] : undefined,
    [statusesKey],
  );
  const searchVehicles = useCallback((search: string) => (
    searchRentalVehicleAutocompleteSuggestions(workspaceId, search, {
      statuses: normalizedStatuses,
      excludeVehicleIds: normalizedExcludedIds,
    })
  ), [normalizedExcludedIds, normalizedStatuses, workspaceId]);
  const search = useDebouncedAutocompleteSearch(
    query,
    isFocused && !justSelected && Boolean(workspaceId),
    searchVehicles,
  );
  const isSearchLoading = search.isLoading;
  const filtered = useMemo(() => search.items.slice(0, 8), [search.items]);
  const showDropdown = isFocused && !justSelected && Boolean(workspaceId) && (
    isSearchLoading
    || Boolean(search.error)
    || filtered.length > 0
    || normalizedQuery.length >= 2
  );
  const shouldShowLinkedIndicator = hasSelection && showLinkedIndicator;
  const resolvedLinkedLabel = linkedLabel || t("carRental.partnerLink.linked");

  const handleSelect = useCallback(
    (vehicle: RentalVehicle) => {
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
      onOpenChange={setIsFocused}
      anchor={(
        <div data-autocomplete-popover-anchor className={cn("relative w-full", className)}>
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setJustSelected(false);
              onChange(event.target.value);
            }}
            onFocus={() => setIsFocused(true)}
            placeholder={placeholder}
            disabled={disabled}
            aria-busy={isSearchLoading || undefined}
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
        {isSearchLoading ? (
          <div role="status" className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.autocomplete.searching")}
          </div>
        ) : search.error ? (
          <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">
            {t("common.autocomplete.searchFailed")}
          </div>
        ) : null}
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
        {!isSearchLoading && !search.error && filtered.length === 0 && normalizedQuery.length >= 2 ? (
          <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">
            {t("common.autocomplete.noResults")}
          </div>
        ) : null}
      </div>
    </AutocompletePopover>
  );
}
