export const postalStates = [
  "draft",
  "received",
  "in_transit",
  "arrived",
  "out_for_delivery",
  "postponed",
  "delivered",
  "cancelled",
] as const;
export type PostalState = (typeof postalStates)[number];
export type PostalRole = "admin" | "office" | "merchant";
export type PostalShipmentSize = "carton" | "ship" | "small_package";
export type PostalTariffZone = "center" | "outside";
export interface PostalShipment {
  id: string;
  shipment_number: number;
  workspace_id: string;
  organization_id: string;
  qr_id: string;
  recipient_name: string;
  primary_phone: string;
  backup_phone: string;
  governorate: string;
  area: string;
  address: string | null;
  cod_amount: number;
  shipment_size?: PostalShipmentSize | null;
  tariff_zone?: PostalTariffZone | null;
  delivery_fee?: number | null;
  delivery_fee_tariff?: number | null;
  delivery_fee_addon?: number | null;
  tariff_assigned_by?: string | null;
  tariff_assigned_at?: string | null;
  pieces: number | null;
  fragile: boolean;
  delivery_notes: string | null;
  state: PostalState;
  current_branch_id: string | null;
  revision: number;
  driver_id?: string | null;
  driver_name?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export function formatPostalShipmentId(
  shipment: Pick<PostalShipment, 'shipment_number' | 'created_at'>,
) {
  const year = new Date(shipment.created_at).getUTCFullYear()
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new Error('postal_invalid_result')
  }
  return `PS-${year}-${String(shipment.shipment_number).padStart(6, '0')}`
}
export function parsePostalShipmentId(value: string) {
  const match = /^PS-(\d{4})-(\d{6,})$/i.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const shipmentNumber = Number(match[2])
  if (
    !Number.isInteger(year) ||
    year < 1 ||
    year > 9999 ||
    !Number.isSafeInteger(shipmentNumber) ||
    shipmentNumber <= 0
  )
    return null
  return { year, shipmentNumber }
}
export interface PostalBranch {
  id: string;
  workspace_id: string;
  name: string;
  governorate: string;
  address: string | null;
  active: boolean;
  is_primary: boolean;
}
export interface PostalOrganization {
  id: string;
  workspace_id: string;
  name: string;
  phone: string | null;
  code: string;
  leader_id: string | null;
}
export function normalizePostalOrganizationName(value: string) {
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}
export function normalizePostalOrganizationCode(code: string) {
  return code.replace(/[^a-z\d]/gi, '').slice(0, 8).toUpperCase();
}
export function formatPostalOrganizationCode(code: string) {
  const normalizedCode = normalizePostalOrganizationCode(code);
  return normalizedCode.length >= 4
    ? `${normalizedCode.slice(0, 4)}-${normalizedCode.slice(4)}`
    : normalizedCode;
}
export interface PostalMember {
  user_id: string;
  organization_id: string;
}
export interface PostalEvent {
  id: string;
  sequence: number;
  event_type: string;
  previous_state: PostalState | null;
  resulting_state: PostalState;
  actor_name: string;
  created_at: string;
  notes: string | null;
  metadata: Record<string, unknown>;
}
export interface PostalTransfer {
  id: string;
  origin_id: string;
  destination_id: string;
  destination_name?: string;
  status: "authorized" | "dispatched" | "arrived" | "cancelled";
}
export interface PostalCodRecord {
  id: string;
  shipment_id: string;
  organization_id: string;
  kind: "collection" | "settlement";
  signed_amount: number;
  created_at: string;
  payment_transaction_id: string;
  notes: string | null;
  postal_shipments?: {
    shipment_number: number;
    created_at: string;
    recipient_name?: string;
    primary_phone?: string;
  } | null;
  organization_name?: string;
  payment_direction?: "incoming" | "outgoing" | null;
  payment_method?: string | null;
  account_name_snapshot?: string | null;
  reference_label?: string | null;
}
export interface PostalDeliveryFeeRecord {
  id: string;
  shipment_id: string;
  organization_id: string;
  signed_amount: number;
  payment_transaction_id: string;
  actor_id: string;
  notes: string | null;
  created_at: string;
}
export interface ShipmentInput {
  recipient_name: string;
  primary_phone: string;
  backup_phone: string;
  governorate: string;
  area: string;
  address: string;
  cod_amount: number;
  pieces: number | null;
  fragile: boolean;
  delivery_notes: string;
}
export type PostalTariffProfile = "standard" | "northern";
export interface PostalArea {
  id: string;
  en: string;
  ar: string;
  ku: string;
  sortOrder: number;
  isActive: boolean;
  tariffZone: PostalTariffZone | null;
}
export interface PostalGovernorate {
  id: string;
  en: string;
  ar: string;
  ku: string;
  sortOrder: number;
  isActive: boolean;
  tariffProfile: PostalTariffProfile;
  areas: PostalArea[];
}
export interface PostalShipmentTariff {
  profile: PostalTariffProfile;
  size: PostalShipmentSize;
  zone: "standard" | PostalTariffZone;
  fee: number;
  labelKey: string;
  sortOrder: number;
  isActive: boolean;
}
export interface PostalLocationCatalog {
  governorates: PostalGovernorate[];
  tariffs: PostalShipmentTariff[];
}
export const emptyPostalLocationCatalog: PostalLocationCatalog = {
  governorates: [],
  tariffs: [],
};
export interface PostalTariffOption {
  size: PostalShipmentSize;
  fee: number;
  zone: PostalTariffZone | null;
  labelKey: string;
}
export function normalizePostalLocationCatalog(
  governorateRows: unknown,
  areaRows: unknown,
  tariffRows: unknown,
): PostalLocationCatalog {
  if (!Array.isArray(governorateRows) || !Array.isArray(areaRows) || !Array.isArray(tariffRows))
    throw new Error("postal_invalid_result");

  const governorates = governorateRows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("postal_invalid_result");
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" || !row.id ||
      typeof row.label_en !== "string" || !row.label_en.trim() ||
      typeof row.label_ar !== "string" || !row.label_ar.trim() ||
      typeof row.label_ku !== "string" || !row.label_ku.trim() ||
      !Number.isSafeInteger(Number(row.display_order)) || Number(row.display_order) < 0 ||
      typeof row.is_active !== "boolean" ||
      (row.tariff_profile !== "standard" && row.tariff_profile !== "northern")
    ) throw new Error("postal_invalid_result");
    return {
      id: row.id,
      en: row.label_en,
      ar: row.label_ar,
      ku: row.label_ku,
      sortOrder: Number(row.display_order),
      isActive: row.is_active,
      tariffProfile: row.tariff_profile,
      areas: [] as PostalArea[],
    } satisfies PostalGovernorate;
  });
  const governoratesById = new Map(governorates.map((governorate) => [governorate.id, governorate]));
  for (const value of areaRows) {
    if (!value || typeof value !== "object") throw new Error("postal_invalid_result");
    const row = value as Record<string, unknown>;
    const governorate = typeof row.governorate === "string" ? governoratesById.get(row.governorate) : undefined;
    if (
      !governorate || typeof row.area !== "string" || !row.area ||
      typeof row.label_en !== "string" || !row.label_en.trim() ||
      typeof row.label_ar !== "string" || !row.label_ar.trim() ||
      typeof row.label_ku !== "string" || !row.label_ku.trim() ||
      !Number.isSafeInteger(Number(row.display_order)) || Number(row.display_order) < 0 ||
      typeof row.is_active !== "boolean" ||
      (row.tariff_zone !== null && row.tariff_zone !== "center" && row.tariff_zone !== "outside") ||
      (governorate.tariffProfile === "northern" && row.tariff_zone === null) ||
      (governorate.tariffProfile === "standard" && row.tariff_zone !== null)
    ) throw new Error("postal_invalid_result");
    governorate.areas.push({
      id: row.area,
      en: row.label_en,
      ar: row.label_ar,
      ku: row.label_ku,
      sortOrder: Number(row.display_order),
      isActive: row.is_active,
      tariffZone: row.tariff_zone,
    });
  }
  for (const governorate of governorates) {
    governorate.areas.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  }

  const tariffs = tariffRows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("postal_invalid_result");
    const row = value as Record<string, unknown>;
    if (
      (row.tariff_profile !== "standard" && row.tariff_profile !== "northern") ||
      (row.shipment_size !== "carton" && row.shipment_size !== "ship" && row.shipment_size !== "small_package") ||
      (row.tariff_zone !== "standard" && row.tariff_zone !== "center" && row.tariff_zone !== "outside") ||
      !Number.isSafeInteger(Number(row.fee)) || Number(row.fee) <= 0 ||
      typeof row.label_key !== "string" || !/^[a-z0-9_]+$/.test(row.label_key) ||
      !Number.isSafeInteger(Number(row.display_order)) || Number(row.display_order) < 0 ||
      typeof row.is_active !== "boolean"
    ) throw new Error("postal_invalid_result");
    return {
      profile: row.tariff_profile,
      size: row.shipment_size,
      zone: row.tariff_zone,
      fee: Number(row.fee),
      labelKey: row.label_key,
      sortOrder: Number(row.display_order),
      isActive: row.is_active,
    } satisfies PostalShipmentTariff;
  });
  governorates.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  tariffs.sort((left, right) => left.sortOrder - right.sortOrder || left.size.localeCompare(right.size) || left.fee - right.fee);
  return { governorates, tariffs };
}
export function postalShipmentSizeTranslationKey(
  governorate: string,
  size: PostalShipmentSize,
  fee: number | null | undefined,
  zone: PostalTariffZone | null | undefined,
  catalog: PostalLocationCatalog,
) {
  if (fee == null) return `postal.shipmentSizes.${size}`;
  const profile = catalog.governorates.find((entry) => entry.id === governorate)?.tariffProfile;
  const tariffZone = profile === "northern" ? zone : profile === "standard" ? "standard" : null;
  const tariff = tariffZone
    ? catalog.tariffs.find((entry) =>
        entry.profile === profile && entry.size === size && entry.zone === tariffZone && entry.fee === fee,
      )
    : undefined;
  return `postal.shipmentSizes.${tariff?.labelKey ?? size}`;
}
export function postalTariffOptions(
  governorate: string,
  area: string,
  catalog: PostalLocationCatalog,
  includeInactive = false,
): PostalTariffOption[] {
  const destination = catalog.governorates.find((location) => location.id === governorate);
  const destinationArea = destination?.areas.find((entry) => entry.id === area);
  if (!destination || !destinationArea) return [];
  if (!includeInactive && (!destination.isActive || !destinationArea.isActive)) return [];
  const zone = destination.tariffProfile === "northern" ? destinationArea.tariffZone : "standard";
  return catalog.tariffs
    .filter((tariff) =>
      tariff.profile === destination.tariffProfile &&
      tariff.zone === zone &&
      (includeInactive || tariff.isActive),
    )
    .map((tariff) => ({
      size: tariff.size,
      fee: tariff.fee,
      zone: tariff.zone === "standard" ? null : tariff.zone,
      labelKey: tariff.labelKey,
    }));
}
export function findPostalTariff(
  governorate: string,
  area: string,
  size: PostalShipmentSize | null | undefined,
  fee: number | null | undefined,
  catalog: PostalLocationCatalog,
  includeInactive = false,
): PostalTariffOption | null {
  return (
    postalTariffOptions(governorate, area, catalog, includeInactive).find(
      (option) => option.size === size && option.fee === fee,
    ) ?? null
  );
}
export function locationLabel(
  id: string,
  language: string,
  governorate?: string,
  catalog: PostalLocationCatalog = emptyPostalLocationCatalog,
) {
  const lang = language.startsWith("ar")
    ? "ar"
    : language.startsWith("ku")
      ? "ku"
      : "en";
  if (!governorate) return catalog.governorates.find((x) => x.id === id)?.[lang] ?? id;
  return (
    catalog.governorates
      .find((x) => x.id === governorate)
      ?.areas.find((x) => x.id === id)?.[
      lang
    ] ?? id
  );
}
export const isIraqiPhone = (phone: string) =>
  /^(07\d{9}|7\d{9}|9647\d{9}|009647\d{9})$/.test(phone);
export function internationalIraqiPhone(phone: string) {
  if (!isIraqiPhone(phone)) return null;
  if (phone.startsWith("00964")) return phone.slice(2);
  if (phone.startsWith("964")) return phone;
  return `964${phone.startsWith("0") ? phone.slice(1) : phone}`;
}
const QR_PREFIX = "atlas:postal:v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function shipmentQr(qrId: string) {
  return `${QR_PREFIX}${qrId}`;
}
export function parseShipmentQr(raw: string) {
  const value = raw.startsWith(QR_PREFIX) ? raw.slice(QR_PREFIX.length) : "";
  return UUID.test(value) ? value.toLowerCase() : null;
}
export function signedIqd(digits: string, negative: boolean) {
  if (!/^\d+$/.test(digits)) return null;
  const amount = Number(digits);
  if (!Number.isSafeInteger(amount) || amount > 999999999999) return null;
  return negative && amount !== 0 ? -amount : amount;
}
export type ShipmentValidationError =
  | "required"
  | "phone"
  | "recipientName"
  | "location"
  | "amount"
  | "pieces"
  | "textLength";
export function shipmentValidationErrors(
  input: ShipmentInput,
  catalog: PostalLocationCatalog,
  allowInactiveLocation = false,
) {
  const errors: Partial<Record<keyof ShipmentInput, ShipmentValidationError>> =
    {};
  if (!input.recipient_name.trim()) errors.recipient_name = "required";
  else if (input.recipient_name.trim().length > 160)
    errors.recipient_name = "recipientName";
  if (!input.primary_phone) errors.primary_phone = "required";
  else if (!isIraqiPhone(input.primary_phone)) errors.primary_phone = "phone";
  if (input.backup_phone && !isIraqiPhone(input.backup_phone))
    errors.backup_phone = "phone";
  const governorate = catalog.governorates.find((x) => x.id === input.governorate);
  if (!governorate || (!allowInactiveLocation && !governorate.isActive))
    errors.governorate = input.governorate ? "location" : "required";
  if (
    !governorate?.areas.some((x) => x.id === input.area && (allowInactiveLocation || x.isActive))
  ) {
    errors.area = input.area ? "location" : "required";
  }
  if (
    !Number.isSafeInteger(input.cod_amount) ||
    Math.abs(input.cod_amount) > 999999999999
  ) {
    errors.cod_amount = "amount";
  }
  if (
    input.pieces !== null &&
    (!Number.isSafeInteger(input.pieces) ||
      input.pieces <= 0 ||
      input.pieces > 2147483647)
  ) {
    errors.pieces = "pieces";
  }
  if (input.address.length > 2000) errors.address = "textLength";
  if (input.delivery_notes.length > 2000) errors.delivery_notes = "textLength";
  return errors;
}
export function validShipment(
  input: ShipmentInput,
  catalog: PostalLocationCatalog,
  allowInactiveLocation = false,
) {
  return Object.keys(shipmentValidationErrors(input, catalog, allowInactiveLocation)).length === 0;
}
export function copyShipment(s: PostalShipment): ShipmentInput {
  return {
    recipient_name: s.recipient_name,
    primary_phone: s.primary_phone,
    backup_phone: s.backup_phone,
    governorate: s.governorate,
    area: s.area,
    address: s.address ?? "",
    cod_amount: s.cod_amount,
    pieces: s.pieces,
    fragile: s.fragile,
    delivery_notes: s.delivery_notes ?? "",
  };
}
export function availableOperations(
  s: PostalShipment,
  transfer: PostalTransfer | undefined,
  role: PostalRole,
) {
  if (role === "merchant") return [];
  const actions: string[] = [];
  if (s.state === "draft") actions.push("receive");
  if (s.state === "received" || s.state === "arrived") {
    if (transfer?.status === "authorized")
      actions.push(
        "dispatch",
        ...(role === "admin" ? ["cancel_transfer"] : []),
      );
    else if (!transfer)
      actions.push(
        "out_for_delivery",
        ...(role === "admin" ? ["authorize_transfer"] : []),
      );
  }
  if (s.state === "in_transit" && transfer?.status === "dispatched")
    actions.push("arrive");
  if (s.state === "out_for_delivery")
    actions.push("deliver", "postpone_delivery");
  if (s.state === "postponed") {
    if (transfer?.status === "authorized") actions.push("dispatch");
    else if (!transfer)
      actions.push("out_for_delivery", "authorize_transfer");
  }
  if (
    (role === "admin" || (role === "office" && s.state === "postponed")) &&
    !["delivered", "cancelled"].includes(s.state) &&
    transfer?.status !== "dispatched"
  )
    actions.push("cancel");
  return actions;
}
