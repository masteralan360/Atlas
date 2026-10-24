import { describe, expect, it } from "vitest";
import {
  availableOperations,
  copyShipment,
  internationalIraqiPhone,
  isIraqiPhone,
  locations,
  parseShipmentQr,
  shipmentQr,
  signedIqd,
  shipmentValidationErrors,
  validShipment,
  type PostalShipment,
} from "./domain";
import { getLedgerCashMovementFromPayment } from "@/lib/ledgerCashMovementEntries";
import type { PaymentTransaction } from "@/local-db/models";
const shipment = {
  id: crypto.randomUUID(),
  qr_id: crypto.randomUUID(),
  state: "received",
  recipient_name: "Recipient",
  primary_phone: "07501234567",
  backup_phone: "07701234567",
  governorate: "erbil",
  area: "ankawa",
  address: null,
  cod_amount: -25000,
  pieces: null,
  fragile: false,
  delivery_notes: null,
} as PostalShipment;
describe("Post Service domain", () => {
  it("uses opaque versioned QR references and rejects unrelated payloads", () => {
    expect(parseShipmentQr(shipmentQr(shipment.qr_id))).toBe(shipment.qr_id);
    expect(parseShipmentQr(shipment.id)).toBeNull();
    expect(parseShipmentQr("https://example.com/private")).toBeNull();
    expect(shipmentQr(shipment.qr_id)).not.toContain(shipment.primary_phone);
  });
  it("copies only editable fields, never identity or current state", () => {
    const copy = copyShipment(shipment);
    expect(copy).not.toHaveProperty("id");
    expect(copy).not.toHaveProperty("qr_id");
    expect(copy).not.toHaveProperty("state");
    expect(copy.cod_amount).toBe(-25000);
    expect(validShipment(copy)).toBe(true);
    expect(validShipment({ ...copy, governorate: "baghdad" })).toBe(false);
    expect(validShipment({ ...copy, pieces: 0 })).toBe(false);
  });
  it("preserves empty monetary inputs and exact signed integer dinars", () => {
    expect(signedIqd("", false)).toBeNull();
    expect(signedIqd("1.5", false)).toBeNull();
    expect(signedIqd("-100", true)).toBeNull();
    expect(signedIqd("100000", true)).toBe(-100000);
    expect(Object.is(signedIqd("0", true), -0)).toBe(false);
    expect(signedIqd("1000000000000", false)).toBeNull();
  });
  it("identifies the exact fields that prevent shipment creation", () => {
    const input = copyShipment(shipment);
    expect(shipmentValidationErrors(input)).toEqual({});
    expect(
      shipmentValidationErrors({ ...input, backup_phone: "0770" }),
    ).toEqual({ backup_phone: "phone" });
    expect(
      shipmentValidationErrors({
        ...input,
        primary_phone: "",
        recipient_name: " ",
      }),
    ).toEqual({ primary_phone: "required", recipient_name: "required" });
    expect(
      shipmentValidationErrors({ ...input, cod_amount: NaN, pieces: 0 }),
    ).toEqual({ cod_amount: "amount", pieces: "pieces" });
    expect(
      shipmentValidationErrors({ ...input, governorate: "baghdad" }),
    ).toEqual({ area: "location" });
  });
  it.each(["07501234567", "7501234567", "9647501234567", "009647501234567"])(
    "normalizes %s without duplicating the country prefix",
    (phone) => {
      expect(isIraqiPhone(phone)).toBe(true);
      expect(internationalIraqiPhone(phone)).toBe("9647501234567");
    },
  );
  it.each(["0750 1234567", "+9647501234567", "abc", "96407501234567", "750"])(
    "rejects invalid phone %s",
    (phone) => expect(internationalIraqiPhone(phone)).toBeNull(),
  );
  it("includes all nineteen governorates and scoped area IDs", () => {
    expect(locations).toHaveLength(19);
    expect(new Set(locations.map((x) => x.id)).size).toBe(19);
    expect(locations.find((x) => x.id === "halabja")).toBeDefined();
  });
  it("supports direct final-mile delivery or administrator-authorized transfers", () => {
    expect(availableOperations(shipment, undefined, "office")).toEqual([
      "out_for_delivery",
    ]);
    expect(availableOperations(shipment, undefined, "merchant")).toEqual([]);
    expect(availableOperations(shipment, undefined, "admin")).toContain(
      "authorize_transfer",
    );
    expect(
      availableOperations(
        shipment,
        { id: "t", origin_id: "a", destination_id: "b", status: "authorized" },
        "office",
      ),
    ).toEqual(["dispatch"]);
    expect(
      availableOperations(
        { ...shipment, state: "arrived" },
        undefined,
        "admin",
      ),
    ).toContain("authorize_transfer");
  });
  it("mirrors recipient and merchant payments as pass-through ledger movements", () => {
    for (const sourceType of ["postal_cod", "postal_settlement"] as const) {
      const entry = getLedgerCashMovementFromPayment({
        sourceType,
        sourceModule: "postal_service",
        direction: "outgoing",
        amount: 25000,
        currency: "iqd",
        paymentMethod: "cash",
        paidAt: "2026-10-24T10:00:00Z",
        isDeleted: false,
      } as PaymentTransaction);
      expect(entry).toMatchObject({
        type: sourceType,
        direction: "outgoing",
        amount: 25000,
        currency: "iqd",
      });
    }
  });
});
