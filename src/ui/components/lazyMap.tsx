import { lazy } from "react";

const loadMapModule = () => import("./map");

export const Map = lazy(() =>
  loadMapModule().then((module) => ({ default: module.Map })),
);
export const MapMarker = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MapMarker })),
);
export const MarkerContent = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MarkerContent })),
);
export const MarkerPopup = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MarkerPopup })),
);
export const MarkerTooltip = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MarkerTooltip })),
);
export const MarkerLabel = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MarkerLabel })),
);
export const MapPopup = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MapPopup })),
);
export const MapControls = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MapControls })),
);
export const MapRoute = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MapRoute })),
);
export const MapClusterLayer = lazy(() =>
  loadMapModule().then((module) => ({ default: module.MapClusterLayer })),
);

export { useMap } from "./mapContext";
export type { MapRef, MapViewport } from "./map";
