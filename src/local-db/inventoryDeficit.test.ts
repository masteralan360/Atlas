import { describe, expect, it } from "vitest";

import {
  isAllowedInventoryQuantityTransition,
  isFiniteInventoryQuantity,
  isValidNewInventoryQuantity,
} from "./inventoryDeficit";

describe("inventory deficit invariant", () => {
  it("accepts zero and fractional quantities through six-decimal boundaries", () => {
    expect(isValidNewInventoryQuantity(0)).toBe(true);
    expect(isValidNewInventoryQuantity(0.000001)).toBe(true);
    expect(isValidNewInventoryQuantity(12.345678)).toBe(true);
  });

  it("rejects every negative quantity, including a sub-epsilon deficit", () => {
    expect(isValidNewInventoryQuantity(-1)).toBe(false);
    expect(isValidNewInventoryQuantity(-0.000001)).toBe(false);
    expect(isValidNewInventoryQuantity(-0.0000001)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isFiniteInventoryQuantity(Number.NaN)).toBe(false);
    expect(isValidNewInventoryQuantity(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidNewInventoryQuantity(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("allows a legacy deficit to stay unchanged or improve toward zero", () => {
    expect(isAllowedInventoryQuantityTransition(-21, -21)).toBe(true);
    expect(isAllowedInventoryQuantityTransition(-21, -10)).toBe(true);
    expect(isAllowedInventoryQuantityTransition(-21, 0)).toBe(true);
    expect(isAllowedInventoryQuantityTransition(-21, 4)).toBe(true);
  });

  it("rejects a worsened legacy deficit and any new deficit", () => {
    expect(isAllowedInventoryQuantityTransition(-21, -22)).toBe(false);
    expect(isAllowedInventoryQuantityTransition(0, -0.0000001)).toBe(false);
    expect(isAllowedInventoryQuantityTransition(5, -1)).toBe(false);
    expect(isAllowedInventoryQuantityTransition(undefined, -1)).toBe(false);
  });
});
