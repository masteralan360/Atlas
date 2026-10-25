import directory from "@/data/iraqPostalLocations.json";

export const postalStates = [
  "draft",
  "received",
  "in_transit",
  "arrived",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;
export type PostalState = (typeof postalStates)[number];
export type PostalRole = "admin" | "office" | "merchant";
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
  area: string;
  address: string | null;
  active: boolean;
}
export interface PostalOrganization {
  id: string;
  workspace_id: string;
  name: string;
  code: string;
  leader_id: string;
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
export const locations = directory.governorates;
export function locationLabel(
  id: string,
  language: string,
  governorate?: string,
) {
  const lang = language.startsWith("ar")
    ? "ar"
    : language.startsWith("ku")
      ? "ku"
      : "en";
  if (!governorate) return locations.find((x) => x.id === id)?.[lang] ?? id;
  return (
    locations
      .find((x) => x.id === governorate)
      ?.areas.find((x) => x[0] === id)?.[
      lang === "ar" ? 2 : lang === "ku" ? 3 : 1
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
export function shipmentValidationErrors(input: ShipmentInput) {
  const errors: Partial<Record<keyof ShipmentInput, ShipmentValidationError>> =
    {};
  if (!input.recipient_name.trim()) errors.recipient_name = "required";
  else if (input.recipient_name.trim().length > 160)
    errors.recipient_name = "recipientName";
  for (const field of ["primary_phone", "backup_phone"] as const) {
    if (!input[field]) errors[field] = "required";
    else if (!isIraqiPhone(input[field])) errors[field] = "phone";
  }
  const governorate = locations.find((x) => x.id === input.governorate);
  if (!governorate)
    errors.governorate = input.governorate ? "location" : "required";
  if (!governorate?.areas.some((x) => x[0] === input.area)) {
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
export function validShipment(input: ShipmentInput) {
  return Object.keys(shipmentValidationErrors(input)).length === 0;
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
  if (s.state === "out_for_delivery") actions.push("deliver");
  if (
    role === "admin" &&
    !["delivered", "cancelled"].includes(s.state) &&
    transfer?.status !== "dispatched"
  )
    actions.push("cancel");
  return actions;
}
