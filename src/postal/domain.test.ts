import { describe, expect, it } from "vitest";
import {
  availableOperations,
  copyShipment,
  findPostalTariff,
  internationalIraqiPhone,
  isIraqiPhone,
  normalizePostalLocationCatalog,
  parseShipmentQr,
  postalTariffOptions,
  shipmentQr,
  signedIqd,
  shipmentValidationErrors,
  validShipment,
  type PostalShipment,
} from "./domain";
import { getLedgerCashMovementFromPayment } from "@/lib/ledgerCashMovementEntries";
import type { PaymentTransaction } from "@/local-db/models";
import postalLocations from "@/data/iraqPostalLocations.json";

const governorateRows = postalLocations.governorates.map((governorate, index) => ({
  id: governorate.id,
  label_en: governorate.en,
  label_ar: governorate.ar,
  label_ku: governorate.ku,
  display_order: index + 1,
  tariff_profile: ["erbil", "sulaymaniyah", "duhok"].includes(governorate.id) ? "northern" : "standard",
  is_active: true,
}));
const areaRows = postalLocations.governorates.flatMap((governorate) => governorate.areas.map((area, index) => {
  const isNorthern = ["erbil", "sulaymaniyah", "duhok"].includes(governorate.id);
  return {
    governorate: governorate.id,
    area: area[0],
    label_en: area[1],
    label_ar: area[2],
    label_ku: area[3],
    display_order: index + 1,
    tariff_zone: isNorthern ? (/center|centre/i.test(area[0]) ? "center" : "outside") : null,
    is_active: true,
  };
}));
const tariffRows = [
  ["northern", "small_package", "center", 5000, "small_package"],
  ["northern", "small_package", "outside", 6000, "small_package"],
  ...[8000, 12000, 15000, 20000].map((fee) => ["standard", "carton", "standard", fee, `carton_${fee}`]),
  ...[15000, 24000, 35000, 55000].map((fee) => ["standard", "ship", "standard", fee, `ship_${fee}`]),
].map(([tariff_profile, shipment_size, tariff_zone, fee, label_key], index) => ({
  tariff_profile,
  shipment_size,
  tariff_zone,
  fee,
  label_key,
  display_order: index + 1,
  is_active: true,
}));
const locationCatalog = normalizePostalLocationCatalog(governorateRows, areaRows, tariffRows);
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
    expect(validShipment(copy, locationCatalog)).toBe(true);
    expect(validShipment({ ...copy, governorate: "baghdad" }, locationCatalog)).toBe(false);
    expect(validShipment({ ...copy, pieces: 0 }, locationCatalog)).toBe(false);
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
    expect(shipmentValidationErrors(input, locationCatalog)).toEqual({});
    expect(
      shipmentValidationErrors({ ...input, backup_phone: "0770" }, locationCatalog),
    ).toEqual({ backup_phone: "phone" });
    expect(
      shipmentValidationErrors({
        ...input,
        primary_phone: "",
        recipient_name: " ",
      }, locationCatalog),
    ).toEqual({ primary_phone: "required", recipient_name: "required" });
    expect(
      shipmentValidationErrors({ ...input, cod_amount: NaN, pieces: 0 }, locationCatalog),
    ).toEqual({ cod_amount: "amount", pieces: "pieces" });
    expect(
      shipmentValidationErrors({ ...input, governorate: "baghdad" }, locationCatalog),
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
    expect(locationCatalog.governorates).toHaveLength(19);
    expect(new Set(locationCatalog.governorates.map((x) => x.id)).size).toBe(19);
    expect(locationCatalog.governorates.find((x) => x.id === "halabja")).toBeDefined();
  });
  it("offers tariffs only for a complete valid destination and preserves the existing location rules", () => {
    expect(postalTariffOptions("", "", locationCatalog)).toEqual([]);
    expect(postalTariffOptions("erbil", "", locationCatalog)).toEqual([]);
    expect(postalTariffOptions("baghdad", "ankawa", locationCatalog)).toEqual([]);
    for (const governorate of locationCatalog.governorates) {
      for (const { id: area } of governorate.areas) {
        const options = postalTariffOptions(governorate.id, area, locationCatalog);
        if (["erbil", "sulaymaniyah", "duhok"].includes(governorate.id)) {
          const center = /center|centre/i.test(area);
          expect(options.map(({ size, fee, zone }) => ({ size, fee, zone }))).toEqual([{
            size: "small_package", fee: center ? 5000 : 6000,
            zone: center ? "center" : "outside",
          }]);
        } else {
          expect(options).toHaveLength(8);
          expect(options.map((option) => option.size)).toEqual([
            "carton", "carton", "carton", "carton", "ship", "ship", "ship", "ship",
          ]);
        }
      }
    }
  });
  it("matches the size and fee together when restoring or reevaluating a selection", () => {
    expect(findPostalTariff("baghdad", "karrada", "carton", 8000, locationCatalog)).toMatchObject({ size: "carton", fee: 8000 });
    expect(findPostalTariff("erbil", "ankawa", "carton", 8000, locationCatalog)).toBeNull();
    expect(findPostalTariff("erbil", "ankawa", "small_package", 6000, locationCatalog)).toMatchObject({ zone: "outside" });
    expect(findPostalTariff("erbil", "erbil-centre", "small_package", 6000, locationCatalog)).toBeNull();
    expect(findPostalTariff("erbil", "erbil-centre", "small_package", 5000, locationCatalog)).toMatchObject({ zone: "center" });
    expect(findPostalTariff("baghdad", "karrada", "ship", 8000, locationCatalog)).toBeNull();
    expect(findPostalTariff("erbil", "ankawa", null, null, locationCatalog)).toBeNull();
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
