import { createContext, useContext } from "react";
import type * as MapLibreGL from "maplibre-gl";

export type MapContextValue = {
  map: MapLibreGL.Map | null;
  isLoaded: boolean;
};

export const MapContext = createContext<MapContextValue | null>(null);

export function useMap() {
  const context = useContext(MapContext);
  if (!context) {
    throw new Error("useMap must be used within a Map component");
  }
  return context;
}
