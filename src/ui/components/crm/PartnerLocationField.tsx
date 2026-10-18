import { useEffect, useState } from "react"
import type * as MapLibreGL from "maplibre-gl"
import { Loader2, MapPin, Search } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Input } from "@/ui/components/input"
import {
  Button,
  Dialog,
  DialogContent,
  Label,
  Map,
  MapControls,
  MapMarker,
  MarkerContent,
  useMap,
} from "@/ui/components"
import { cn } from "@/lib/utils"

type Coordinates = { latitude: number; longitude: number }

const DEFAULT_CENTER: [number, number] = [44.3661, 33.3152]
const DEFAULT_ZOOM = 5

interface GeocodeResult {
    latitude: number
    longitude: number
    label: string
}

async function geocode(query: string): Promise<GeocodeResult[]> {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`
    const response = await fetch(url, { headers: { Accept: "application/json" } })
    if (!response.ok) {
        throw new Error("geocode_failed")
    }
    const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>
    return data.map((entry) => ({
        latitude: parseFloat(entry.lat),
        longitude: parseFloat(entry.lon),
        label: entry.display_name
    }))
}

function MapClickCapture({ onPick }: { onPick: (coordinates: Coordinates) => void }) {
    const { map } = useMap()

    useEffect(() => {
        if (!map) {
            return
        }

        const handler = (event: MapLibreGL.MapMouseEvent) => {
            onPick({ latitude: event.lngLat.lat, longitude: event.lngLat.lng })
        }

        map.on("click", handler)
        return () => {
            map.off("click", handler)
        }
    }, [map, onPick])

    return null
}

function MapRecenter({ coordinates }: { coordinates: Coordinates | null }) {
    const { map } = useMap()

    useEffect(() => {
        if (!map || !coordinates) {
            return
        }

        map.flyTo({
            center: [coordinates.longitude, coordinates.latitude],
            zoom: 14
        })
    }, [map, coordinates])

    return null
}

interface PartnerLocationFieldProps {
    latitude?: number | null
    longitude?: number | null
    onChange: (latitude: number | null, longitude: number | null) => void
}

export function PartnerLocationField({ latitude, longitude, onChange }: PartnerLocationFieldProps) {
    const { t } = useTranslation()
    const [modalOpen, setModalOpen] = useState(false)
    const hasLocation = typeof latitude === "number" && typeof longitude === "number"

    return (
        <div className="space-y-2 md:col-span-2">
            <Label>{t("businessPartners.location", { defaultValue: "Location" })}</Label>
            <div className="overflow-hidden rounded-2xl border border-border/60">
                <div
                    className="relative h-44 w-full cursor-pointer"
                    onClick={() => setModalOpen(true)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setModalOpen(true)
                        }
                    }}
                >
                    <Map
                        center={hasLocation ? [longitude as number, latitude as number] : DEFAULT_CENTER}
                        zoom={hasLocation ? 13 : DEFAULT_ZOOM}
                        className="h-full w-full"
                        attributionControl={false}
                        dragPan={false}
                        scrollZoom={false}
                        doubleClickZoom={false}
                        dragRotate={false}
                        touchZoomRotate={false}
                        keyboard={false}
                    >
                        {hasLocation ? (
                            <MapMarker longitude={longitude as number} latitude={latitude as number}>
                                <MarkerContent>
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-primary text-white shadow-lg">
                                        <MapPin className="h-4 w-4" />
                                    </div>
                                </MarkerContent>
                            </MapMarker>
                        ) : null}
                    </Map>
                    <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
                        {t("businessPartners.clickToOpenMap", { defaultValue: "Click to open map" })}
                    </div>
                    {!hasLocation ? (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40 text-sm text-muted-foreground">
                            {t("businessPartners.noLocation", { defaultValue: "No location set" })}
                        </div>
                    ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-3 py-2">
                    <div className="truncate text-xs text-muted-foreground">
                        {hasLocation
                            ? `${latitude?.toFixed(6)}, ${longitude?.toFixed(6)}`
                            : t("businessPartners.locationHint", { defaultValue: "Set the partner's location on the map" })}
                    </div>
                    <div className="flex shrink-0 gap-2">
                        {hasLocation ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => onChange(null, null)}
                            >
                                {t("common.clear", { defaultValue: "Clear" })}
                            </Button>
                        ) : null}
                        <Button type="button" variant="outline" size="sm" onClick={() => setModalOpen(true)}>
                            {hasLocation
                                ? (t("common.update", { defaultValue: "Update" }) || "Update")
                                : (t("businessPartners.setLocation", { defaultValue: "Set location" }))}
                        </Button>
                    </div>
                </div>
            </div>

            <PartnerLocationModal
                open={modalOpen}
                initialLatitude={typeof latitude === "number" ? latitude : null}
                initialLongitude={typeof longitude === "number" ? longitude : null}
                onClose={() => setModalOpen(false)}
                onDesignate={(next) => {
                    onChange(next.latitude, next.longitude)
                    setModalOpen(false)
                }}
            />
        </div>
    )
}

interface PartnerLocationModalProps {
    open: boolean
    initialLatitude: number | null
    initialLongitude: number | null
    onClose: () => void
    onDesignate: (coordinates: Coordinates) => void
}

function PartnerLocationModal({
    open,
    initialLatitude,
    initialLongitude,
    onClose,
    onDesignate
}: PartnerLocationModalProps) {
    const { t } = useTranslation()
    const [coordinates, setCoordinates] = useState<Coordinates | null>(null)
    const [query, setQuery] = useState("")
    const [results, setResults] = useState<GeocodeResult[]>([])
    const [isSearching, setIsSearching] = useState(false)
    const [searchError, setSearchError] = useState(false)

    useEffect(() => {
        if (!open) {
            return
        }

        const hasInitial = typeof initialLatitude === "number" && typeof initialLongitude === "number"
        setCoordinates(hasInitial ? { latitude: initialLatitude, longitude: initialLongitude } : null)
        setQuery("")
        setResults([])
        setSearchError(false)
        setIsSearching(false)
    }, [open, initialLatitude, initialLongitude])

    async function handleSearch() {
        const trimmed = query.trim()
        if (!trimmed) {
            return
        }

        setIsSearching(true)
        setSearchError(false)
        try {
            const found = await geocode(trimmed)
            setResults(found)
        } catch {
            setSearchError(true)
            setResults([])
        } finally {
            setIsSearching(false)
        }
    }

    const hasLocation = coordinates !== null

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
            <DialogContent showCloseButton={false} className="flex h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] w-[97vw] max-w-[1600px] flex-col overflow-hidden rounded-3xl border-border/60 p-0 shadow-2xl top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)]">
                <div className="relative flex items-center gap-3 border-b bg-muted/30 px-4 py-3">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault()
                                    void handleSearch()
                                }
                            }}
                            placeholder={t("businessPartners.searchLocation", { defaultValue: "Search for an address or place" })}
                            className="pl-9"
                        />
                        {results.length > 0 ? (
                            <div className="absolute left-0 right-0 top-full z-10 mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border/60 bg-background shadow-lg">
                                {results.map((result) => (
                                    <button
                                        key={`${result.latitude},${result.longitude}`}
                                        type="button"
                                        onClick={() => {
                                            setCoordinates({ latitude: result.latitude, longitude: result.longitude })
                                            setResults([])
                                            setQuery(result.label)
                                        }}
                                        className={cn(
                                            "flex w-full items-start gap-2 px-3 py-2 text-start text-sm transition-colors hover:bg-primary/5",
                                            coordinates?.latitude === result.latitude && coordinates?.longitude === result.longitude
                                                ? "bg-primary/10 text-primary"
                                                : "text-foreground"
                                        )}
                                    >
                                        <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                                        <span className="line-clamp-2">{result.label}</span>
                                    </button>
                                ))}
                            </div>
                        ) : searchError ? (
                            <div className="absolute left-0 right-0 top-full z-10 mt-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive shadow-lg">
                                {t("businessPartners.searchFailed", { defaultValue: "Could not complete the search. Please try again." })}
                            </div>
                        ) : null}
                    </div>
                    <Button type="button" onClick={() => void handleSearch()} disabled={isSearching} className="shrink-0">
                        {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                        {t("common.search", { defaultValue: "Search" })}
                    </Button>
                </div>

                <div className="relative min-h-0 flex-1">
                    <Map
                        center={hasLocation ? [coordinates.longitude, coordinates.latitude] : DEFAULT_CENTER}
                        zoom={hasLocation ? 14 : DEFAULT_ZOOM}
                        className="absolute inset-0 h-full w-full"
                    >
                        <MapControls
                            showCompass
                            showZoom
                            showFullscreen
                            showLocate
                            onLocate={(coords) =>
                                setCoordinates({ latitude: coords.latitude, longitude: coords.longitude })
                            }
                        />
                        <MapClickCapture onPick={setCoordinates} />
                        <MapRecenter coordinates={coordinates} />
                        {hasLocation ? (
                            <MapMarker longitude={coordinates.longitude} latitude={coordinates.latitude}>
                                <MarkerContent>
                                    <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-primary text-white shadow-lg">
                                        <MapPin className="h-4 w-4" />
                                    </div>
                                </MarkerContent>
                            </MapMarker>
                        ) : null}
                    </Map>
                    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
                        <div className="rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
                            {hasLocation
                                ? `${t("businessPartners.coordinates", { defaultValue: "Coordinates" })}: ${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}`
                                : t("businessPartners.clickToPlace", { defaultValue: "Click the map to place the pin" })}
                        </div>
                    </div>
                </div>

                <div className="relative flex items-center justify-center border-t bg-muted/20 px-4 py-3">
                    <Button type="button" variant="outline" onClick={onClose} className="absolute left-4">
                        {t("common.cancel", { defaultValue: "Cancel" })}
                    </Button>
                    <Button type="button" disabled={!hasLocation} onClick={() => hasLocation && onDesignate(coordinates)}>
                        {t("businessPartners.designate", { defaultValue: "Designate" })}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
