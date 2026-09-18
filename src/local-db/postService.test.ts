import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearWorkspaceModeSnapshot,
  writeWorkspaceModeSnapshot,
} from "@/workspace/workspaceMode";

import { installTestBrowser } from "@/dev/testing/fixtures/browser";
import { db } from "./database";
import type { Agent, BusinessPartner } from "./models";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000909";
let createDeliveryMerchantProfile: typeof import("./postService").createDeliveryMerchantProfile;
let createDeliveryShipment: typeof import("./postService").createDeliveryShipment;
let createAndDispatchDeliveryShipment: typeof import("./postService").createAndDispatchDeliveryShipment;
let createDeliveryRun: typeof import("./postService").createDeliveryRun;
let adminEditReceivedDeliveryShipment: typeof import("./postService").adminEditReceivedDeliveryShipment;
let adminEditAndRedispatchDeliveryShipment: typeof import("./postService").adminEditAndRedispatchDeliveryShipment;
let transferReturnedDeliveryShipment: typeof import("./postService").transferReturnedDeliveryShipment;
let receiveReturnedDeliveryShipment: typeof import("./postService").receiveReturnedDeliveryShipment;
let updateDeliveryShipmentStatus: typeof import("./postService").updateDeliveryShipmentStatus;
let settleDeliveryCourier: typeof import("./postService").settleDeliveryCourier;
let payDeliveryCourierFee: typeof import("./postService").payDeliveryCourierFee;
let payDeliveryCourierReimbursement: typeof import("./postService").payDeliveryCourierReimbursement;
let payDeliveryMerchant: typeof import("./postService").payDeliveryMerchant;
let receiveDeliveryMerchantRepayment: typeof import("./postService").receiveDeliveryMerchantRepayment;
let updateDeliveryMerchantProfile: typeof import("./postService").updateDeliveryMerchantProfile;
let hardDeleteDeliveryMerchantProfile: typeof import("./postService").hardDeleteDeliveryMerchantProfile;
let toUISaleFromDeliveryShipment: typeof import("./postService").toUISaleFromDeliveryShipment;
let requestDeliveryShipmentCodAdjustment: typeof import("./postService").requestDeliveryShipmentCodAdjustment;
let reviewDeliveryShipmentCodAdjustment: typeof import("./postService").reviewDeliveryShipmentCodAdjustment;
let correctDeliveredDeliveryShipmentCod: typeof import("./postService").correctDeliveredDeliveryShipmentCod;
let correctDeliveredDeliveryShipmentRecipientPayout: typeof import("./postService").correctDeliveredDeliveryShipmentRecipientPayout;
let requestDeliveryShipmentRecipientPayoutAdjustment: typeof import("./postService").requestDeliveryShipmentRecipientPayoutAdjustment;
let reviewDeliveryShipmentRecipientPayoutAdjustment: typeof import("./postService").reviewDeliveryShipmentRecipientPayoutAdjustment;

function installBrowserEnvironment() {
  installTestBrowser();
}

function partner(id: string): BusinessPartner {
  const now = new Date().toISOString();
  return {
    id, workspaceId: WORKSPACE_ID, partnerName: "Shop A", role: "customer", defaultCurrency: "iqd",
    creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null,
    customerFacetId: null, supplierFacetId: null, agentFacetId: null,
    totalSalesOrders: 0, totalSalesValue: 0, receivableBalance: 0,
    totalPurchaseOrders: 0, totalPurchaseValue: 0, payableBalance: 0,
    totalLoanCount: 0, loanOutstandingBalance: 0, netExposure: 0,
    mergedIntoBusinessPartnerId: null, createdAt: now, updatedAt: now,
    syncStatus: "synced", lastSyncedAt: now, version: 1, isDeleted: false,
  };
}

function courier(id: string): Agent {
  const now = new Date().toISOString();
  return {
    id, workspaceId: WORKSPACE_ID, businessPartnerId: crypto.randomUUID(), zone: "Baghdad",
    agentType: "courier", carModel: null, plateNumber: null, linkedUserId: null,
    status: "active", createdAt: now, updatedAt: now, syncStatus: "synced",
    lastSyncedAt: now, version: 1, isDeleted: false,
  };
}

describe("Post Service COD accounting", () => {
  beforeAll(async () => {
    installBrowserEnvironment();
    const postService = await import("./postService");
    ({ createDeliveryMerchantProfile, createDeliveryShipment, createAndDispatchDeliveryShipment, createDeliveryRun, adminEditReceivedDeliveryShipment, adminEditAndRedispatchDeliveryShipment, transferReturnedDeliveryShipment, receiveReturnedDeliveryShipment, updateDeliveryShipmentStatus, settleDeliveryCourier, payDeliveryCourierFee, payDeliveryCourierReimbursement, payDeliveryMerchant, receiveDeliveryMerchantRepayment, updateDeliveryMerchantProfile, hardDeleteDeliveryMerchantProfile, toUISaleFromDeliveryShipment, requestDeliveryShipmentCodAdjustment, reviewDeliveryShipmentCodAdjustment, correctDeliveredDeliveryShipmentCod, correctDeliveredDeliveryShipmentRecipientPayout, requestDeliveryShipmentRecipientPayoutAdjustment, reviewDeliveryShipmentRecipientPayoutAdjustment } = postService);
  });

  beforeEach(async () => {
    await db.delete();
    await db.open();
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "local" });
  });

  afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID));
  afterAll(async () => { await db.delete(); });

  it("keeps courier custody and merchant payout as separate balances", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });

    const deliveryEntries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(deliveryEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_collection", amount: 100, agentId: deliveryCourier.id }),
      expect.objectContaining({ kind: "merchant_cod_payable", amount: 100, merchantProfileId: profile.id }),
      expect.objectContaining({ kind: "merchant_fee", amount: -10, merchantProfileId: profile.id }),
    ]));

    await settleDeliveryCourier(WORKSPACE_ID, {
      agentId: deliveryCourier.id, currency: "iqd", actualAmount: 100, paymentMethod: "cash",
    });
    await payDeliveryMerchant(WORKSPACE_ID, {
      merchantProfileId: profile.id, currency: "iqd", actualAmount: 90, paymentMethod: "cash",
    });

    const finalEntries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    const courierBalance = finalEntries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0);
    const merchantBalance = finalEntries.filter((entry) => entry.merchantProfileId === profile.id).reduce((sum, entry) => sum + entry.amount, 0);
    expect(courierBalance).toBe(0);
    expect(merchantBalance).toBe(0);

    const payments = await db.payment_transactions.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(payments).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "delivery_courier_remittance", direction: "incoming", amount: 100 }),
      expect.objectContaining({ sourceType: "delivery_merchant_payout", direction: "outgoing", amount: 90 }),
    ]));
  });

  it("corrects an outstanding delivered COD atomically with matching signed ledger deltas and no payment", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    const adminUserId = crypto.randomUUID();
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const delivered = await db.delivery_shipments.get(shipment.id);
    const initialEvents = await db.delivery_shipment_events.where("shipmentId").equals(shipment.id).count();
    const operationId = crypto.randomUUID();

    const corrected = await correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      operationId,
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: adminUserId,
      correctedCodAmount: 125.5,
    });

    expect(corrected).toMatchObject({ codAmount: 125.5, version: delivered!.version + 1 });
    const correction = await db.delivery_shipment_cod_corrections.get(operationId);
    expect(correction).toMatchObject({
      shipmentId: shipment.id,
      originalCodAmount: 100,
      correctedCodAmount: 125.5,
      correctedBy: adminUserId,
    });
    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: correction?.courierLedgerEntryId,
        kind: "courier_cod_correction",
        codCorrectionId: operationId,
        shipmentId: shipment.id,
        amount: 25.5,
        agentId: deliveryCourier.id,
        createdBy: adminUserId,
      }),
      expect.objectContaining({
        id: correction?.merchantLedgerEntryId,
        kind: "merchant_cod_correction",
        codCorrectionId: operationId,
        shipmentId: shipment.id,
        amount: 25.5,
        merchantProfileId: profile.id,
        createdBy: adminUserId,
      }),
    ]));
    expect(entries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(125.5);
    expect(entries.filter((entry) => entry.merchantProfileId === profile.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(115.5);
    expect(await db.payment_transactions.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);
    expect(await db.delivery_shipment_events.where("shipmentId").equals(shipment.id).count()).toBe(initialEvents);

    await correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      operationId,
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: adminUserId,
      correctedCodAmount: 125.5,
    });
    expect(await db.delivery_shipment_cod_corrections.count()).toBe(1);
    expect((await db.delivery_ledger_entries.filter((entry) => entry.codCorrectionId === operationId).toArray())).toHaveLength(2);
  });

  it("supports a downward decimal delivered-COD correction before settlement starts", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 200.25,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const delivered = await db.delivery_shipments.get(shipment.id);

    await correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      operationId: crypto.randomUUID(),
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: crypto.randomUUID(),
      correctedCodAmount: 175,
    });

    const entries = await db.delivery_ledger_entries.where("shipmentId").equals(shipment.id).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_cod_correction", amount: -25.25 }),
      expect.objectContaining({ kind: "merchant_cod_correction", amount: -25.25 }),
    ]));
    expect((await db.delivery_shipments.get(shipment.id))?.codAmount).toBe(175);
    expect(await db.payment_transactions.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);
  });

  it("rejects delivered-COD corrections for non-admins, invalid values, and any post whose settlement has begun", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const delivered = await db.delivery_shipments.get(shipment.id);
    const correctionInput = {
      operationId: crypto.randomUUID(),
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorUserId: crypto.randomUUID(),
      correctedCodAmount: 125,
    };

    await expect(correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "staff" as unknown as "admin",
    })).rejects.toThrow("Only an administrator");
    await expect(correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "admin",
      correctedCodAmount: 0,
    })).rejects.toThrow("greater than zero");
    await expect(correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "admin",
      correctedCodAmount: 100,
    })).rejects.toThrow("must differ");

    await settleDeliveryCourier(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      currency: "iqd",
      actualAmount: 50,
      paymentMethod: "cash",
      varianceNote: "Half handed over",
    });
    await expect(correctDeliveredDeliveryShipmentCod(WORKSPACE_ID, {
      ...correctionInput,
      operationId: crypto.randomUUID(),
      actorRole: "admin",
    })).rejects.toThrow("fully outstanding");
    expect((await db.delivery_shipments.get(shipment.id))?.codAmount).toBe(100);
    expect(await db.delivery_shipment_cod_corrections.count()).toBe(0);
  });

  it("corrects an outstanding courier-funded delivered recipient payout without recording a payment", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    const adminUserId = crypto.randomUUID();
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 0,
      customerPaymentStatus: "prepaid_electronically",
      recipientPayoutAmount: 100.25,
      recipientPayoutFunding: "courier_advance",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });
    const delivered = await db.delivery_shipments.get(shipment.id);
    const operationId = crypto.randomUUID();

    const corrected = await correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      operationId,
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: adminUserId,
      correctedRecipientPayoutAmount: 125.5,
    });

    expect(corrected).toMatchObject({
      recipientPayoutAmount: 125.5,
      version: delivered!.version + 1,
    });
    const correction = await db.delivery_shipment_recipient_payout_corrections.get(operationId);
    expect(correction).toMatchObject({
      shipmentId: shipment.id,
      originalRecipientPayoutAmount: 100.25,
      correctedRecipientPayoutAmount: 125.5,
      correctedBy: adminUserId,
    });
    const entries = await db.delivery_ledger_entries.where("shipmentId").equals(shipment.id).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: correction?.courierLedgerEntryId,
        kind: "courier_recipient_payout_correction",
        recipientPayoutCorrectionId: operationId,
        amount: -25.25,
        agentId: deliveryCourier.id,
        createdBy: adminUserId,
      }),
      expect.objectContaining({
        id: correction?.merchantLedgerEntryId,
        kind: "merchant_recipient_payout_correction",
        recipientPayoutCorrectionId: operationId,
        amount: -25.25,
        merchantProfileId: profile.id,
        createdBy: adminUserId,
      }),
    ]));
    expect((await db.business_partners.get(merchant.id))?.receivableBalance).toBe(125.5);
    const recipientPayments = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((payment) => payment.sourceRecordId === shipment.id && payment.sourceType === "delivery_recipient_payout")
      .toArray();
    expect(recipientPayments).toHaveLength(0);

    await correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      operationId,
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: adminUserId,
      correctedRecipientPayoutAmount: 125.5,
    });
    expect(await db.delivery_shipment_recipient_payout_corrections.count()).toBe(1);
    expect((await db.delivery_ledger_entries.filter((entry) => entry.recipientPayoutCorrectionId === operationId).toArray())).toHaveLength(2);

    const afterFirstCorrection = await db.delivery_shipments.get(shipment.id);
    const zeroOperationId = crypto.randomUUID();
    await correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      operationId: zeroOperationId,
      shipmentId: shipment.id,
      expectedVersion: afterFirstCorrection!.version,
      actorRole: "admin",
      actorUserId: adminUserId,
      correctedRecipientPayoutAmount: 0,
    });
    expect(await db.delivery_shipment_recipient_payout_corrections.count()).toBe(2);
    expect(await db.delivery_ledger_entries
      .filter((entry) => entry.recipientPayoutCorrectionId === zeroOperationId && entry.amount === 125.5)
      .count()).toBe(2);
    expect((await db.business_partners.get(merchant.id))?.receivableBalance).toBe(0);
  });

  it("rejects recipient-payout corrections for non-admins, invalid values, and settlement already started", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 0,
      customerPaymentStatus: "prepaid_electronically",
      recipientPayoutAmount: 100,
      recipientPayoutFunding: "courier_advance",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const delivered = await db.delivery_shipments.get(shipment.id);
    const correctionInput = {
      operationId: crypto.randomUUID(),
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorUserId: crypto.randomUUID(),
      correctedRecipientPayoutAmount: 75,
    };

    await expect(correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "staff" as unknown as "admin",
    })).rejects.toThrow("Only an administrator");
    await expect(correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "admin",
      correctedRecipientPayoutAmount: -0.01,
    })).rejects.toThrow("zero or greater");
    await expect(correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      ...correctionInput,
      actorRole: "admin",
      correctedRecipientPayoutAmount: 100,
    })).rejects.toThrow("must differ");

    await receiveDeliveryMerchantRepayment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      currency: "iqd",
      actualAmount: 50,
      paymentMethod: "cash",
      varianceNote: "Partial collection",
    });
    await expect(correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      ...correctionInput,
      operationId: crypto.randomUUID(),
      actorRole: "admin",
    })).rejects.toThrow("fully outstanding");
    expect(await db.delivery_shipment_recipient_payout_corrections.count()).toBe(0);
  });

  it("does not one-click correct a workspace-funded recipient payout", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 0,
      customerPaymentStatus: "prepaid_electronically",
      recipientPayoutAmount: 100,
      recipientPayoutFunding: "workspace_payment",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
      recipientPayoutPaymentMethod: "cash",
    });
    const delivered = await db.delivery_shipments.get(shipment.id);

    await expect(correctDeliveredDeliveryShipmentRecipientPayout(WORKSPACE_ID, {
      operationId: crypto.randomUUID(),
      shipmentId: shipment.id,
      expectedVersion: delivered!.version,
      actorRole: "admin",
      actorUserId: crypto.randomUUID(),
      correctedRecipientPayoutAmount: 75,
    })).rejects.toThrow("courier-funded");
    expect(await db.delivery_shipment_recipient_payout_corrections.count()).toBe(0);
    expect(await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((payment) => payment.sourceRecordId === shipment.id && payment.sourceType === "delivery_recipient_payout")
      .count()).toBe(1);
  });

  it("allocates a merchant-wide payout to its delivered posts", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const firstShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000001",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    const secondShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000002",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 200,
    });
    await createDeliveryRun(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentIds: [firstShipment.id, secondShipment.id],
    });
    await updateDeliveryShipmentStatus(firstShipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    await updateDeliveryShipmentStatus(secondShipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    const settlement = await payDeliveryMerchant(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      currency: "iqd",
      actualAmount: 270,
      paymentMethod: "cash",
      varianceNote: "Partial payout allocation",
    });

    const payoutEntries = (await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray())
      .filter((entry) => entry.settlementId === settlement.id && entry.kind === "merchant_payout");
    expect(payoutEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ shipmentId: firstShipment.id, amount: -90 }),
      expect.objectContaining({ shipmentId: secondShipment.id, amount: -180 }),
    ]));
    expect(payoutEntries).toHaveLength(2);
    expect(payoutEntries.every((entry) => entry.shipmentId !== null)).toBe(true);
    expect(payoutEntries.reduce((total, entry) => total + entry.amount, 0)).toBe(-270);
  });

  it("retries create and dispatch without creating a duplicate post or manifest", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = { ...courier(crypto.randomUUID()), courierDeliveryFee: 15 };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const input = {
      operationId: crypto.randomUUID(),
      shipment: {
        merchantProfileId: profile.id,
        recipientPhone: "07500000000",
        recipientAddress: "Baghdad",
        currency: "iqd" as const,
        codAmount: 100,
      },
      agentId: deliveryCourier.id,
      courierDeliveryFee: 12,
      notes: "Same-day route",
    };

    const first = await createAndDispatchDeliveryShipment(WORKSPACE_ID, input);
    const retry = await createAndDispatchDeliveryShipment(WORKSPACE_ID, input);

    expect(retry.shipment.id).toBe(first.shipment.id);
    expect(retry.run.id).toBe(first.run.id);
    expect((await db.delivery_shipments.where("workspaceId").equals(WORKSPACE_ID).toArray())
      .filter((shipment) => !shipment.isDeleted)).toHaveLength(1);
    expect((await db.delivery_runs.where("workspaceId").equals(WORKSPACE_ID).toArray())
      .filter((run) => !run.isDeleted)).toHaveLength(1);

    const assignedShipment = await db.delivery_shipments.get(first.shipment.id);
    expect(assignedShipment).toEqual(expect.objectContaining({
      status: "assigned",
      assignedAgentId: deliveryCourier.id,
      assignedRunId: first.run.id,
      courierDeliveryFee: 12,
    }));
  });

  it("snapshots the manifest courier fee and deducts it from the courier handover", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = { ...courier(crypto.randomUUID()), courierDeliveryFee: 15 };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 30,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });

    const run = await createDeliveryRun(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentIds: [shipment.id],
      courierDeliveryFee: 12,
    });
    const dispatchedShipment = await db.delivery_shipments.get(shipment.id);
    expect(run.courierDeliveryFee).toBe(12);
    expect(dispatchedShipment?.courierDeliveryFee).toBe(12);

    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_collection", amount: 100, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "courier_delivery_fee", amount: -12, shipmentId: shipment.id }),
    ]));
    const expectedHandover = entries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0);
    expect(expectedHandover).toBe(88);

    const courierSettlement = await settleDeliveryCourier(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      currency: "iqd",
      actualAmount: 88,
      paymentMethod: "cash",
      shipmentId: shipment.id,
    });
    expect(courierSettlement.courierDeliveryFee).toBe(12);
    const courierPayment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((payment) => payment.sourceRecordId === courierSettlement.id)
      .first();
    expect(courierPayment).toMatchObject({
      sourceType: "delivery_courier_remittance",
      direction: "incoming",
      // The fee is already retained by the courier, so the Ledger receives
      // only the net handover. Recording a second outflow would deduct it twice.
      amount: 88,
    });
    const merchantSettlement = await payDeliveryMerchant(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      currency: "iqd",
      actualAmount: 70,
      paymentMethod: "cash",
      shipmentId: shipment.id,
    });
    expect(merchantSettlement.courierDeliveryFee).toBe(12);
    const finalBalance = (await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray())
      .filter((entry) => entry.agentId === deliveryCourier.id)
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(finalBalance).toBe(0);
  });

  it("does not write zero-amount ledger entries when a prepaid post with a recipient-paid fee is delivered", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 5000,
      defaultFeePayer: "recipient",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", customerPaymentStatus: "prepaid_electronically", codAmount: 0,
      deliveryFee: 5000,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual([expect.objectContaining({
      kind: "courier_collection",
      shipmentId: shipment.id,
      amount: 5000,
    })]);
    expect(entries.some((entry) => entry.amount === 0)).toBe(false);
  });

  it("requires a positive COD amount for cash-on-delivery posts", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });

    await expect(createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 0,
    })).rejects.toThrow("COD amount must be greater than zero");
  });

  it("records an electronic-prepaid delivery with a recipient payout as merchant debt", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 3000,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      // The recipient already paid electronically, so the courier must not
      // receive any cash custody despite the merchant-side charges below.
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 35000,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "workspace_payment",
    });
    expect(shipment.codAmount).toBe(0);
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    const assignedSnapshot = await db.delivery_shipments.get(shipment.id);
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
      recipientPayoutPaymentMethod: "fib",
    });
    // The operation can be replayed by an offline client that still has the
    // assigned record. The payment must use the same deterministic ID.
    await db.delivery_shipments.put(assignedSnapshot!);
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
      recipientPayoutPaymentMethod: "fib",
    });

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merchant_fee", amount: -3000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "merchant_recipient_payout", amount: -10000, shipmentId: shipment.id }),
    ]));
    expect(entries.some((entry) => entry.kind === "courier_collection" && entry.shipmentId === shipment.id)).toBe(false);
    expect(entries.filter((entry) => entry.merchantProfileId === profile.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(-13000);
    expect(await db.business_partners.get(merchant.id)).toMatchObject({
      receivableBalance: 13000,
      payableBalance: 0,
    });

    const payment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === shipment.id && item.sourceType === "delivery_recipient_payout")
      .first();
    expect((await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === shipment.id && item.sourceType === "delivery_recipient_payout")
      .count())).toBe(1);
    expect(payment).toMatchObject({
      direction: "outgoing",
      amount: 10000,
      currency: "iqd",
      paymentMethod: "fib",
    });
    expect((await db.delivery_shipments.get(shipment.id))?.recipientPayoutPaymentTransactionId).toBe(payment?.id);
  });

  it("pays an uncovered courier delivery fee as an outgoing payment", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = { ...courier(crypto.randomUUID()), courierDeliveryFee: 2000 };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 3000,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "workspace_payment",
      deliveryFee: 3000,
      feePayer: "merchant",
    });
    await createDeliveryRun(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentIds: [shipment.id],
      courierDeliveryFee: 2000,
    });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });

    const beforePayout = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(beforePayout).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_delivery_fee", amount: -2000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "merchant_fee", amount: -3000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "merchant_recipient_payout", amount: -10000, shipmentId: shipment.id }),
    ]));
    expect(beforePayout.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(-2000);

    const settlement = await payDeliveryCourierFee(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentId: shipment.id,
      currency: "iqd",
      actualAmount: 2000,
      paymentMethod: "fib",
    });
    expect(settlement).toMatchObject({ type: "courier_fee_payout", expectedAmount: 2000, actualAmount: 2000 });

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_fee_payout", amount: 2000, shipmentId: shipment.id, settlementId: settlement.id }),
    ]));
    expect(entries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);

    const payment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === settlement.id)
      .first();
    expect(payment).toMatchObject({
      sourceType: "delivery_courier_fee_payout",
      direction: "outgoing",
      amount: 2000,
      currency: "iqd",
      paymentMethod: "fib",
      metadata: expect.objectContaining({
        deliverySettlementType: "courier_fee_payout",
        deliveryShipmentId: shipment.id,
        deliveryAgentId: deliveryCourier.id,
      }),
    });
  });

  it("records a courier-funded recipient payout as a collective courier reimbursement, not an immediate workspace payment", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = { ...courier(crypto.randomUUID()), courierDeliveryFee: 2000 };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 3000,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "courier_advance",
      deliveryFee: 3000,
      feePayer: "merchant",
    });
    const secondShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000001",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "courier_advance",
      deliveryFee: 3000,
      feePayer: "merchant",
    });
    await createDeliveryRun(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentIds: [shipment.id, secondShipment.id],
      courierDeliveryFee: 2000,
    });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });
    await updateDeliveryShipmentStatus(secondShipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });

    const entriesBeforeReimbursement = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entriesBeforeReimbursement).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_recipient_advance", amount: -10000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "courier_delivery_fee", amount: -2000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "merchant_fee", amount: -3000, shipmentId: shipment.id }),
      expect.objectContaining({ kind: "merchant_recipient_payout", amount: -10000, shipmentId: shipment.id }),
    ]));
    expect(entriesBeforeReimbursement.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(-24000);
    expect(entriesBeforeReimbursement.filter((entry) => entry.merchantProfileId === profile.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(-26000);
    expect(await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === shipment.id && item.sourceType === "delivery_recipient_payout")
      .count()).toBe(0);

    const settlement = await payDeliveryCourierReimbursement(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      currency: "iqd",
      actualAmount: 24000,
      paymentMethod: "fib",
    });
    expect(settlement).toMatchObject({ type: "courier_reimbursement", expectedAmount: 24000, actualAmount: 24000, shipmentId: null });

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_reimbursement", amount: 12000, shipmentId: shipment.id, settlementId: settlement.id }),
      expect.objectContaining({ kind: "courier_reimbursement", amount: 12000, shipmentId: secondShipment.id, settlementId: settlement.id }),
    ]));
    expect(entries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);

    const payment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === settlement.id && item.sourceType === "delivery_courier_reimbursement")
      .first();
    expect(payment).toMatchObject({
      direction: "outgoing",
      amount: 24000,
      currency: "iqd",
      paymentMethod: "fib",
      metadata: expect.objectContaining({
        deliverySettlementType: "courier_reimbursement",
        deliveryShipmentId: null,
        deliveryAgentId: deliveryCourier.id,
      }),
    });

    await expect(payDeliveryCourierReimbursement(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      currency: "iqd",
      actualAmount: 24000,
      paymentMethod: "fib",
    })).rejects.toThrow("Settlement amount cannot exceed the outstanding balance");
    expect(await db.delivery_settlements.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(1);
  });

  it("records merchant repayment as an incoming payment and clears the post debt", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 3000,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      deliveryFee: 3000,
      feePayer: "merchant",
    });
    const payoutShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000001",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 50000,
      deliveryFee: 3000,
      feePayer: "merchant",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id, payoutShipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });
    await updateDeliveryShipmentStatus(payoutShipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    });

    const settlement = await receiveDeliveryMerchantRepayment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      currency: "iqd",
      actualAmount: 13000,
      paymentMethod: "fib",
    });
    expect(settlement).toMatchObject({ type: "merchant_repayment", expectedAmount: 13000, actualAmount: 13000, shipmentId: null });

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merchant_repayment", amount: 13000, shipmentId: shipment.id, settlementId: settlement.id }),
    ]));
    expect(entries.filter((entry) => entry.merchantProfileId === profile.id).reduce((sum, entry) => sum + entry.amount, 0)).toBe(47000);

    const payment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === settlement.id)
      .first();
    expect(payment).toMatchObject({
      sourceType: "delivery_merchant_repayment",
      direction: "incoming",
      amount: 13000,
      currency: "iqd",
      paymentMethod: "fib",
      metadata: expect.objectContaining({
        deliverySettlementType: "merchant_repayment",
        deliveryShipmentId: null,
        businessPartnerId: merchant.id,
      }),
    });
    expect(await db.business_partners.get(merchant.id)).toMatchObject({ receivableBalance: 0, payableBalance: 47000 });

    await expect(receiveDeliveryMerchantRepayment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      shipmentId: shipment.id,
      currency: "iqd",
      actualAmount: 1,
      paymentMethod: "fib",
    })).rejects.toThrow("no outstanding amount to settle");
    expect(await db.delivery_settlements.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(1);
  });

  it("does not duplicate a delivered post's event or ledger obligations when a stale client replays it", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, {
      agentId: deliveryCourier.id,
      shipmentIds: [shipment.id],
      courierDeliveryFee: 5,
    });
    const assignedSnapshot = await db.delivery_shipments.get(shipment.id);
    expect(assignedSnapshot?.status).toBe("assigned");

    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    // A second device that was already open still has the assigned version of
    // the post. Replay that exact state to prove its operation IDs are stable.
    await db.delivery_shipments.put(assignedSnapshot!);
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    const events = await db.delivery_shipment_events
      .where("[workspaceId+shipmentId]")
      .equals([WORKSPACE_ID, shipment.id])
      .toArray();
    const obligations = (await db.delivery_ledger_entries
      .where("[workspaceId+shipmentId]")
      .equals([WORKSPACE_ID, shipment.id])
      .toArray())
      .filter((entry) => ["courier_collection", "courier_delivery_fee", "merchant_cod_payable", "merchant_fee"].includes(entry.kind));

    expect(events.filter((event) => event.status === "delivered")).toHaveLength(1);
    expect(obligations).toHaveLength(4);
    expect(obligations.map((entry) => entry.kind).sort()).toEqual([
      "courier_collection",
      "courier_delivery_fee",
      "merchant_cod_payable",
      "merchant_fee",
    ]);
  });

  it("includes unpaid merchant payout posts and courier custody in partner balances", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    const courierPartner: BusinessPartner = { ...partner(deliveryCourier.businessPartnerId), agentFacetId: deliveryCourier.id }
    await db.business_partners.put(merchant);
    await db.business_partners.put(courierPartner);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
      deliveryFee: 10,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    const { recalculateBusinessPartnerSummary } = await import("./businessPartners");

    const merchantWithOutstanding = await recalculateBusinessPartnerSummary(WORKSPACE_ID, merchant.id);
    expect(merchantWithOutstanding?.payableBalance).toBe(90);

    const courierWithCustody = await recalculateBusinessPartnerSummary(WORKSPACE_ID, deliveryCourier.businessPartnerId);
    expect(courierWithCustody?.receivableBalance).toBe(100);

    await payDeliveryMerchant(WORKSPACE_ID, {
      merchantProfileId: profile.id, currency: "iqd", actualAmount: 90, paymentMethod: "cash",
    });
    const settledMerchant = await recalculateBusinessPartnerSummary(WORKSPACE_ID, merchant.id);
    expect(settledMerchant?.payableBalance).toBe(0);
  });

  it.each(["postponed", "returned"] as const)("allows a courier to mark a post %s without a reason", async (status) => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 1,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await expect(updateDeliveryShipmentStatus(shipment.id, { status, actorAgentId: deliveryCourier.id })).resolves.toBeDefined();
  });

  it("allows the assigned courier to resolve a postponed post as delivered", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id, defaultFeeAmount: 10 });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
      deliveryFee: 10, feePayer: "merchant",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id], courierDeliveryFee: 5 });
    await updateDeliveryShipmentStatus(shipment.id, { status: "postponed", actorAgentId: deliveryCourier.id });

    await expect(updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: crypto.randomUUID() })).rejects.toThrow("assigned to them");
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: "delivered", assignedAgentId: deliveryCourier.id });
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ previousStatus: "postponed", status: "delivered", actorAgentId: deliveryCourier.id })]));
    const entries = await db.delivery_ledger_entries.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();
    expect(entries.map((entry) => entry.kind).sort()).toEqual(["courier_collection", "courier_delivery_fee", "merchant_cod_payable", "merchant_fee"]);
  });

  it("allows the assigned courier to resolve a postponed post as returned without accounting entries", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, { status: "postponed", actorAgentId: deliveryCourier.id });
    await updateDeliveryShipmentStatus(shipment.id, { status: "returned", actorAgentId: deliveryCourier.id });

    expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: "returned", assignedAgentId: deliveryCourier.id });
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ previousStatus: "postponed", status: "returned", actorAgentId: deliveryCourier.id })]));
    expect(await db.delivery_ledger_entries.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray()).toHaveLength(0);
  });

  it("accepts and persists a voice-only returned or postponed reason", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 1,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    const recordingId = crypto.randomUUID();
    const voiceReasonPath = `${WORKSPACE_ID}/${shipment.id}/postponed/${recordingId}.flac`;

    await updateDeliveryShipmentStatus(shipment.id, {
      status: "postponed",
      voiceReasonPath,
      voiceReasonDurationMs: 4_200,
      actorAgentId: deliveryCourier.id,
    });

    const events = await db.delivery_shipment_events
      .where("[workspaceId+shipmentId]")
      .equals([WORKSPACE_ID, shipment.id])
      .toArray();
    const event = events.find((row) => row.status === "postponed");
    expect(event).toMatchObject({
      status: "postponed",
      note: null,
      voiceReasonPath,
      voiceReasonDurationMs: 4_200,
    });
  });

  it("does not retain a local-only cleanup field when a postponed voice reason is redispatched", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 1,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    const voiceReasonPath = `${WORKSPACE_ID}/${shipment.id}/postponed/${crypto.randomUUID()}.flac`;
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "postponed",
      voiceReasonPath,
      voiceReasonDurationMs: 4_200,
      actorAgentId: deliveryCourier.id,
    });

    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });

    const redispatched = await db.delivery_shipments.get(shipment.id);
    expect(redispatched?.status).toBe("assigned");
    expect(redispatched).not.toHaveProperty("voiceReasonCleanupPaths");
  });

  it("transfers a returned post to a new courier in a fresh manifest", async () => {
    const merchant = partner(crypto.randomUUID());
    const originalCourier = courier(crypto.randomUUID());
    const replacementCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.bulkPut([originalCourier, replacementCourier]);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    const originalRun = await createDeliveryRun(WORKSPACE_ID, { agentId: originalCourier.id, shipmentIds: [shipment.id], courierDeliveryFee: 5 });
    await updateDeliveryShipmentStatus(shipment.id, { status: "returned", note: "Customer was unavailable", actorAgentId: originalCourier.id });

    const transferRun = await transferReturnedDeliveryShipment(WORKSPACE_ID, {
      agentId: replacementCourier.id,
      shipmentId: shipment.id,
      courierDeliveryFee: 7,
      notes: "Transfer after return",
    });

    const transferred = await db.delivery_shipments.get(shipment.id);
    const originalRunItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([originalRun.id, shipment.id]).first();
    const transferRunItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([transferRun.id, shipment.id]).first();
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();

    expect(transferred).toMatchObject({ status: "assigned", assignedAgentId: replacementCourier.id, assignedRunId: transferRun.id, courierDeliveryFee: 7, statusNote: null });
    expect(originalRunItem?.returnedAt).toBeTruthy();
    expect(transferRunItem).toMatchObject({ runId: transferRun.id, shipmentId: shipment.id, returnedAt: null });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ previousStatus: "returned", status: "assigned", actorAgentId: replacementCourier.id, note: "Transfer after return" })]));
  });

  it("records physical return receipt without creating settlement or payment records", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    await updateDeliveryShipmentStatus(shipment.id, {
      status: "returned", note: "Recipient unavailable", actorAgentId: deliveryCourier.id,
    });
    const returned = await db.delivery_shipments.get(shipment.id);
    expect(returned).toBeDefined();

    await expect(receiveReturnedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      expectedVersion: returned!.version - 1,
      actorRole: "admin",
    })).rejects.toThrow("This post has changed. Refresh it before receiving its return");

    const received = await receiveReturnedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      expectedVersion: returned!.version,
      actorRole: "admin",
      actorUserId: "00000000-0000-4000-8000-000000000111",
      note: "Package received at the branch",
    });
    const events = await db.delivery_shipment_events
      .where("[workspaceId+shipmentId]")
      .equals([WORKSPACE_ID, shipment.id])
      .toArray();

    expect(received).toMatchObject({
      status: "returned",
      returnReceivedAt: expect.any(String),
      version: returned!.version + 1,
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        previousStatus: "returned",
        status: "returned",
        action: "return_received",
        note: "Package received at the branch",
        actorUserId: "00000000-0000-4000-8000-000000000111",
        actorAgentId: deliveryCourier.id,
      }),
    ]));
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray()).toHaveLength(0);
    expect(await db.payment_transactions.where("workspaceId").equals(WORKSPACE_ID).toArray()).toHaveLength(0);

    await expect(receiveReturnedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      expectedVersion: received.version,
      actorRole: "admin",
    })).rejects.toThrow("This returned post has already been received");
    await expect(transferReturnedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      agentId: courier(crypto.randomUUID()).id,
    })).rejects.toThrow("A received return cannot be transferred");
  });

  it("allows an admin to edit a received post and dispatch it in one operation", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id, defaultFeeAmount: 5 });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });

    const run = await adminEditAndRedispatchDeliveryShipment(WORKSPACE_ID, {
      operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: shipment.version, actorRole: "admin",
      shipment: {
        merchantProfileId: profile.id, recipientPhone: "07511111111", recipientAddress: "Erbil", description: "Updated parcel",
        currency: "iqd", codAmount: 125, deliveryFee: 10, feePayer: "recipient", customerPaymentStatus: "cash_on_delivery",
      },
      agentId: deliveryCourier.id, courierDeliveryFee: 7, notes: "Corrected address",
    });

    const updated = await db.delivery_shipments.get(shipment.id);
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();
    expect(updated).toMatchObject({
      status: "assigned", assignedAgentId: deliveryCourier.id, assignedRunId: run.id, recipientPhone: "07511111111",
      recipientAddress: "Erbil", description: "Updated parcel", codAmount: 125, deliveryFee: 10, feePayer: "recipient", courierDeliveryFee: 7,
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ previousStatus: "received", status: "assigned", note: expect.stringContaining("recipient phone") }),
    ]));
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray()).toHaveLength(0);
  });

  it("allows an admin to edit a received post without dispatching it", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id, defaultFeeAmount: 5 });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });

    const updated = await adminEditReceivedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id, expectedVersion: shipment.version, actorRole: "admin",
      shipment: {
        merchantProfileId: profile.id, recipientPhone: "07511111111", recipientAddress: "Erbil", description: "Corrected parcel",
        currency: "iqd", codAmount: 125, deliveryFee: 10, feePayer: "recipient", customerPaymentStatus: "cash_on_delivery",
      },
    });

    expect(updated).toMatchObject({
      status: "received", assignedAgentId: null, assignedRunId: null, recipientPhone: "07511111111", recipientAddress: "Erbil",
      description: "Corrected parcel", codAmount: 125, deliveryFee: 10, feePayer: "recipient", version: shipment.version + 1,
    });
    expect(await db.delivery_runs.where("workspaceId").equals(WORKSPACE_ID).toArray()).toHaveLength(0);
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ previousStatus: "received", status: "received", note: expect.stringContaining("recipient phone") }),
    ]));
    await expect(adminEditReceivedDeliveryShipment(WORKSPACE_ID, {
      shipmentId: shipment.id, expectedVersion: updated.version, actorRole: "staff" as "admin",
      shipment: { merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 1 },
    })).rejects.toThrow("Only an administrator");
  });

  it("retires the prior manifest when an admin edits and redispatches an assigned post", async () => {
    const merchant = partner(crypto.randomUUID());
    const originalCourier = courier(crypto.randomUUID());
    const replacementCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.bulkPut([originalCourier, replacementCourier]);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    const originalRun = await createDeliveryRun(WORKSPACE_ID, { agentId: originalCourier.id, shipmentIds: [shipment.id], courierDeliveryFee: 5 });
    const assigned = await db.delivery_shipments.get(shipment.id);

    const replacementRun = await adminEditAndRedispatchDeliveryShipment(WORKSPACE_ID, {
      operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: assigned!.version, actorRole: "admin",
      shipment: {
        merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "New Baghdad", currency: "iqd", codAmount: 150,
        customerPaymentStatus: "cash_on_delivery", deliveryFee: 0, feePayer: "merchant",
      },
      agentId: replacementCourier.id, courierDeliveryFee: 8,
    });

    const redispatched = await db.delivery_shipments.get(shipment.id);
    const originalItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([originalRun.id, shipment.id]).first();
    const replacementItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([replacementRun.id, shipment.id]).first();
    expect(redispatched).toMatchObject({ status: "assigned", assignedAgentId: replacementCourier.id, assignedRunId: replacementRun.id, recipientAddress: "New Baghdad", codAmount: 150, courierDeliveryFee: 8 });
    expect(originalItem?.returnedAt).toBeTruthy();
    expect(replacementItem).toMatchObject({ returnedAt: null });

    await expect(adminEditAndRedispatchDeliveryShipment(WORKSPACE_ID, {
      operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: redispatched!.version, actorRole: "staff" as "admin",
      shipment: { merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 1 },
      agentId: replacementCourier.id,
    })).rejects.toThrow("Only an administrator");
  });

  it("retires the prior manifest when an admin edits and redispatches a postponed post", async () => {
    const merchant = partner(crypto.randomUUID());
    const originalCourier = courier(crypto.randomUUID());
    const replacementCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.bulkPut([originalCourier, replacementCourier]);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    const originalRun = await createDeliveryRun(WORKSPACE_ID, { agentId: originalCourier.id, shipmentIds: [shipment.id], courierDeliveryFee: 5 });
    await updateDeliveryShipmentStatus(shipment.id, { status: "postponed", actorAgentId: originalCourier.id });
    const postponed = await db.delivery_shipments.get(shipment.id);

    const replacementRun = await adminEditAndRedispatchDeliveryShipment(WORKSPACE_ID, {
      operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: postponed!.version, actorRole: "admin",
      shipment: {
        merchantProfileId: profile.id, recipientPhone: "07500000000", recipientAddress: "Corrected Baghdad", currency: "iqd", codAmount: 150,
        customerPaymentStatus: "cash_on_delivery", deliveryFee: 0, feePayer: "merchant",
      },
      agentId: replacementCourier.id, courierDeliveryFee: 8,
    });

    const redispatched = await db.delivery_shipments.get(shipment.id);
    const originalItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([originalRun.id, shipment.id]).first();
    const replacementItem = await db.delivery_run_items.where("[runId+shipmentId]").equals([replacementRun.id, shipment.id]).first();
    const events = await db.delivery_shipment_events.where("[workspaceId+shipmentId]").equals([WORKSPACE_ID, shipment.id]).toArray();

    expect(redispatched).toMatchObject({ status: "assigned", assignedAgentId: replacementCourier.id, assignedRunId: replacementRun.id, recipientAddress: "Corrected Baghdad", codAmount: 150, courierDeliveryFee: 8 });
    expect(originalItem?.returnedAt).toBeTruthy();
    expect(replacementItem).toMatchObject({ returnedAt: null });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ previousStatus: "postponed", status: "assigned", note: expect.stringContaining("redispatched") }),
    ]));
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray()).toHaveLength(0);
  });

  it("uses a daily PST tracking sequence in local workspaces", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const input = {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd" as const,
      codAmount: 1,
    };

    const first = await createDeliveryShipment(WORKSPACE_ID, input);
    const second = await createDeliveryShipment(WORKSPACE_ID, input);

    expect(first.trackingNumber).toMatch(/^PST-\d{8}-00001$/);
    expect(second.trackingNumber).toBe(
      first.trackingNumber.replace(/00001$/, "00002"),
    );
  });

  it("holds an assigned courier COD request for review and uses only the approved amount at delivery", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 10,
      defaultFeePayer: "merchant",
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });

    const request = await requestDeliveryShipmentCodAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedCodAmount: 70,
      reason: "Partial parcel return",
    });

    expect(request).toMatchObject({
      shipmentId: shipment.id,
      originalCodAmount: 100,
      requestedCodAmount: 70,
      status: "pending",
    });
    expect((await db.delivery_shipments.get(shipment.id))?.codAmount).toBe(100);
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);
    await expect(updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    })).rejects.toThrow("pending COD change");
    const assignedShipment = await db.delivery_shipments.get(shipment.id);
    await expect(adminEditAndRedispatchDeliveryShipment(WORKSPACE_ID, {
      operationId: crypto.randomUUID(),
      shipmentId: shipment.id,
      expectedVersion: assignedShipment!.version,
      actorRole: "admin",
      shipment: {
        merchantProfileId: profile.id,
        recipientPhone: "07500000000",
        recipientAddress: "Baghdad",
        currency: "iqd",
        codAmount: 70,
        customerPaymentStatus: "cash_on_delivery",
        deliveryFee: 10,
        feePayer: "merchant",
      },
      agentId: deliveryCourier.id,
    })).rejects.toThrow("Review the pending COD change before changing the post COD details");
    expect((await db.delivery_shipments.get(shipment.id))?.codAmount).toBe(100);

    const reviewed = await reviewDeliveryShipmentCodAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedCodAmount: 65,
      reviewNote: "",
    });

    expect(reviewed.request).toMatchObject({
      status: "approved",
      reviewedCodAmount: 65,
      reviewNote: null,
    });
    expect(reviewed.shipment?.codAmount).toBe(65);
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);

    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "courier_collection", shipmentId: shipment.id, amount: 65 }),
      expect.objectContaining({ kind: "merchant_cod_payable", shipmentId: shipment.id, amount: 65 }),
    ]));
  });

  it("finalizes a legacy COD request when the post already has the approved COD", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id, defaultFeeAmount: 10 });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    const request = await requestDeliveryShipmentCodAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedCodAmount: 70,
      reason: "Legacy admin correction",
    });
    const assignedShipment = await db.delivery_shipments.get(shipment.id);
    const alreadyAppliedAt = new Date().toISOString();
    await db.delivery_shipments.put({
      ...assignedShipment!,
      codAmount: 70,
      updatedAt: alreadyAppliedAt,
      version: assignedShipment!.version + 1,
    });

    const reviewed = await reviewDeliveryShipmentCodAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedCodAmount: 70,
      reviewNote: "Confirmed after the correction was applied.",
    });

    expect(reviewed.request).toMatchObject({ status: "approved", reviewedCodAmount: 70 });
    expect(reviewed.shipment).toBeNull();
    expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ codAmount: 70, version: assignedShipment!.version + 1 });
  });

  it("allows a courier to submit a COD change request without a written reason", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });

    const request = await requestDeliveryShipmentCodAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedCodAmount: 70,
      reason: "",
    });

    expect(request).toMatchObject({ status: "pending", reason: null });
  });

  it("allows an admin to reject a COD request without a review note", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 100,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });

    await expect(requestDeliveryShipmentCodAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedCodAmount: 100,
      reason: "No actual correction",
    })).rejects.toThrow("must differ");

    const request = await requestDeliveryShipmentCodAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedCodAmount: 70,
      reason: "Partial parcel return",
    });
    const reviewed = await reviewDeliveryShipmentCodAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "rejected",
      reviewNote: "",
    });
    expect(reviewed.request).toMatchObject({ status: "rejected", reviewNote: null });
    expect(reviewed.shipment).toBeNull();
    expect((await db.delivery_shipments.get(shipment.id))?.codAmount).toBe(100);
  });

  it("approves a prepaid recipient payout change before delivery and records the approved payout", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "workspace_payment",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });

    const request = await requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 15000,
      reason: "Recipient payout was revised",
    });

    expect(request).toMatchObject({
      shipmentId: shipment.id,
      originalRecipientPayoutAmount: 10000,
      requestedRecipientPayoutAmount: 15000,
      status: "pending",
    });
    await expect(updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
    })).rejects.toThrow("pending recipient payout change");

    const reviewed = await reviewDeliveryShipmentRecipientPayoutAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedRecipientPayoutAmount: 12000,
      reviewNote: "Verified with merchant.",
    });
    expect(reviewed.request).toMatchObject({
      status: "approved",
      reviewedRecipientPayoutAmount: 12000,
    });
    expect(reviewed.shipment).toMatchObject({ recipientPayoutAmount: 12000, recipientPayoutFunding: "workspace_payment" });
    expect(await db.payment_transactions.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).count()).toBe(0);

    await updateDeliveryShipmentStatus(shipment.id, {
      status: "delivered",
      actorAgentId: deliveryCourier.id,
      recipientPayoutPaymentMethod: "fib",
    });
    const payment = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === shipment.id && item.sourceType === "delivery_recipient_payout")
      .first();
    expect(payment).toMatchObject({ direction: "outgoing", amount: 12000, currency: "iqd", paymentMethod: "fib" });
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merchant_recipient_payout", shipmentId: shipment.id, amount: -12000 }),
    ]));
  });

  it("uses an approved courier-funded recipient payout in delivery accounting", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 10000,
      recipientPayoutFunding: "courier_advance",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [shipment.id] });
    const request = await requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: shipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 12500,
      reason: "Recipient payout was revised",
    });

    const reviewed = await reviewDeliveryShipmentRecipientPayoutAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedRecipientPayoutAmount: 12500,
    });
    expect(reviewed.shipment).toMatchObject({ recipientPayoutAmount: 12500, recipientPayoutFunding: "courier_advance" });
    await updateDeliveryShipmentStatus(shipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    expect(await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "merchant_recipient_payout", shipmentId: shipment.id, amount: -12500 }),
      expect.objectContaining({ kind: "courier_recipient_advance", shipmentId: shipment.id, amount: -12500, agentId: deliveryCourier.id }),
    ]));
  });

  it("allows a prepaid recipient payout to be changed to zero and rejects ineligible requests", async () => {
    const merchant = partner(crypto.randomUUID());
    const requesterUserId = crypto.randomUUID();
    const deliveryCourier = { ...courier(crypto.randomUUID()), linkedUserId: requesterUserId };
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    const prepaidShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      customerPaymentStatus: "prepaid_electronically",
      codAmount: 0,
      recipientPayoutAmount: 8000,
      recipientPayoutFunding: "workspace_payment",
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [prepaidShipment.id] });

    await expect(requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: prepaidShipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 8000,
      reason: "No adjustment",
    })).rejects.toThrow("must differ");

    const initialRequest = await requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: prepaidShipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 9000,
      reason: "Corrected before the payout was removed",
    });
    await reviewDeliveryShipmentRecipientPayoutAdjustment(initialRequest.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedRecipientPayoutAmount: 9000,
    });
    const request = await requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: prepaidShipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 0,
      reason: "No payout is needed",
    });
    await reviewDeliveryShipmentRecipientPayoutAdjustment(request.id, {
      reviewerUserId: crypto.randomUUID(),
      decision: "approved",
      approvedRecipientPayoutAmount: 0,
    });
    expect((await db.delivery_shipments.get(prepaidShipment.id))?.recipientPayoutAmount).toBe(0);
    await updateDeliveryShipmentStatus(prepaidShipment.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    expect(await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .and((item) => item.sourceRecordId === prepaidShipment.id && item.sourceType === "delivery_recipient_payout")
      .count()).toBe(0);

    const codShipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000001",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 10000,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [codShipment.id] });
    await expect(requestDeliveryShipmentRecipientPayoutAdjustment(WORKSPACE_ID, {
      shipmentId: codShipment.id,
      requesterUserId,
      requesterAgentId: deliveryCourier.id,
      requestedRecipientPayoutAmount: 5000,
      reason: "Wrong payment model",
    })).rejects.toThrow("Only electronically prepaid posts");
  });

  it("projects only the delivery fee, never the merchant COD, into sales reporting", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 5,
    });
    const shipment = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id,
      recipientPhone: "07500000000",
      recipientAddress: "Baghdad",
      currency: "iqd",
      codAmount: 25000,
      deliveryFee: 5000,
    });

    const sale = toUISaleFromDeliveryShipment({
      ...shipment,
      status: "delivered",
      deliveredAt: "2026-08-15T12:00:00.000Z",
    }, { merchantName: merchant.partnerName, merchantBusinessPartnerId: merchant.id });

    expect(sale).toMatchObject({
      origin: "post_service",
      total_amount: 5000,
      partyName: merchant.partnerName,
      business_partner_id: merchant.id,
      _trackingNumber: shipment.trackingNumber,
    });
    expect(sale.items).toEqual([expect.objectContaining({
      product_id: "delivery_service_fee",
      unit_price: 5000,
      cost_price: 0,
    })]);
    expect(JSON.stringify(sale)).not.toContain("25000");
  });

  it("updates an unused merchant profile and permanently deletes it", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id, defaultFeeAmount: 5 });

    const updated = await updateDeliveryMerchantProfile(profile.id, {
      defaultFeeAmount: 15,
      defaultFeePayer: "recipient",
      payoutSchedule: "weekly",
      isActive: false,
    });
    expect(updated).toMatchObject({ defaultFeeAmount: 15, defaultFeePayer: "recipient", payoutSchedule: "weekly", isActive: false });

    await hardDeleteDeliveryMerchantProfile(profile.id);
    expect(await db.delivery_merchant_profiles.get(profile.id)).toBeUndefined();
    expect(await db.business_partners.get(merchant.id)).toBeDefined();
  });

  it("settles a single post when shipmentId is provided", async () => {
    const merchant = partner(crypto.randomUUID());
    const deliveryCourier = courier(crypto.randomUUID());
    await db.business_partners.put(merchant);
    await db.agents.put(deliveryCourier);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, {
      businessPartnerId: merchant.id,
      defaultFeeAmount: 0,
      defaultFeePayer: "recipient",
    });
    const first = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 100,
    });
    const second = await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 50,
    });
    await createDeliveryRun(WORKSPACE_ID, { agentId: deliveryCourier.id, shipmentIds: [first.id, second.id] });
    await updateDeliveryShipmentStatus(first.id, { status: "delivered", actorAgentId: deliveryCourier.id });
    await updateDeliveryShipmentStatus(second.id, { status: "delivered", actorAgentId: deliveryCourier.id });

    const settlement = await settleDeliveryCourier(WORKSPACE_ID, {
      agentId: deliveryCourier.id, currency: "iqd", actualAmount: 50, paymentMethod: "cash",
      shipmentId: second.id,
    });
    expect(settlement.shipmentId).toBe(second.id);
    expect(settlement.expectedAmount).toBe(50);

    const entries = await db.delivery_ledger_entries.where("workspaceId").equals(WORKSPACE_ID).toArray();
    const remittances = entries.filter((entry) => entry.kind === "courier_remittance");
    expect(remittances).toEqual([expect.objectContaining({ shipmentId: second.id, amount: -50 })]);

    const courierBalance = entries.filter((entry) => entry.agentId === deliveryCourier.id).reduce((sum, entry) => sum + entry.amount, 0);
    expect(courierBalance).toBe(100);

    await expect(settleDeliveryCourier(WORKSPACE_ID, {
      agentId: deliveryCourier.id, currency: "iqd", actualAmount: 50, paymentMethod: "cash",
      shipmentId: second.id,
    })).rejects.toThrow("no outstanding amount");
  });

  it("does not permanently delete a merchant profile with delivery history", async () => {
    const merchant = partner(crypto.randomUUID());
    await db.business_partners.put(merchant);
    const profile = await createDeliveryMerchantProfile(WORKSPACE_ID, { businessPartnerId: merchant.id });
    await createDeliveryShipment(WORKSPACE_ID, {
      merchantProfileId: profile.id, recipientPhone: "07500000000",
      recipientAddress: "Baghdad", currency: "iqd", codAmount: 1,
    });

    await expect(hardDeleteDeliveryMerchantProfile(profile.id)).rejects.toThrow("delivery history");
    expect(await db.delivery_merchant_profiles.get(profile.id)).toBeDefined();
  });
});
