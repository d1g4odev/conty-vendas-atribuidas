import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import { creators } from "./fixtures.ts";

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({ creators, clock: new ManualClock("2026-03-01T12:00:00.000Z") });
});

afterEach(async () => {
  await app.close();
});

const shopifyOrder = {
  id: 450789469,
  total: "199.90",
  coupon: "ANA10",
  utm: { source: "instagram", medium: "social", campaign: "bruno-lima" },
  status: "paid",
};

const postOrder = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/webhooks/orders", payload: payload as object, headers });

const postRefund = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/webhooks/refunds", payload: payload as object, headers });

describe("POST /webhooks/orders", () => {
  it("creates the order and attributes it by coupon over UTM", async () => {
    const response = await postOrder(shopifyOrder);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "created",
      order: {
        id: "450789469",
        totalCents: 19_990,
        status: "paid",
        attribution: { creatorId: "ana", source: "coupon" },
        netCents: 19_990,
      },
    });
  });

  it("ignores a repeated Shopify webhook id", async () => {
    await postOrder(shopifyOrder, { "x-shopify-webhook-id": "wh-1" });
    const response = await postOrder(shopifyOrder, { "x-shopify-webhook-id": "wh-1" });

    expect(response.json().outcome).toBe("duplicate_delivery");
    const summary = await app.inject({ method: "GET", url: "/creators/ana/sales" });
    expect(summary.json().netCents).toBe(19_990);
  });

  it("returns 400 with issues for an invalid payload", async () => {
    const response = await postOrder({ id: "", total: "12.345", status: "shipped" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_payload");
    expect(response.json().issues.map((issue: { path: string[] }) => issue.path[0])).toEqual(
      expect.arrayContaining(["id", "total", "status"]),
    );
  });

  it("returns 409 when a known order tries to change its coupon", async () => {
    await postOrder(shopifyOrder);
    const response = await postOrder({ ...shopifyOrder, coupon: "BRUNO15" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "conflict", details: { fields: ["coupon"] } });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/orders",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /webhooks/refunds", () => {
  it("returns 202 for a refund that arrives before its order and applies it later", async () => {
    const early = await postRefund({ id: 1, order_id: 450789469, amount: "50.00" });
    expect(early.statusCode).toBe(202);
    expect(early.json()).toMatchObject({ outcome: "pending", refund: { orderId: "450789469", state: "pending" } });

    const pending = await app.inject({ method: "GET", url: "/refunds/pending" });
    expect(pending.json().refunds).toHaveLength(1);

    await postOrder(shopifyOrder);
    const order = await app.inject({ method: "GET", url: "/orders/450789469" });
    expect(order.json()).toMatchObject({ refundedCents: 5_000, netCents: 14_990 });
  });

  it("applies partial refunds and never refunds more than the sale", async () => {
    await postOrder(shopifyOrder);
    await postRefund({ id: "r1", order_id: shopifyOrder.id, amount: "150.00" });
    const capped = await postRefund({ id: "r2", order_id: shopifyOrder.id, amount: 100 });

    expect(capped.statusCode).toBe(200);
    expect(capped.json().refund).toMatchObject({ requestedCents: 10_000, appliedCents: 4_990 });
    const summary = await app.inject({ method: "GET", url: "/creators/ana/sales" });
    expect(summary.json()).toMatchObject({ netCents: 0, salesCents: 19_990, refundedCents: 19_990 });
  });

  it("does not apply the same refund twice", async () => {
    await postOrder(shopifyOrder);
    await postRefund({ id: "r1", order_id: shopifyOrder.id, amount: "10.00" });
    const again = await postRefund({ id: "r1", order_id: shopifyOrder.id, amount: "10.00" });

    expect(again.json().outcome).toBe("duplicate");
    const order = await app.inject({ method: "GET", url: "/orders/450789469" });
    expect(order.json().refundedCents).toBe(1_000);
  });

  it("rejects non-positive refund amounts", async () => {
    const response = await postRefund({ id: "r1", order_id: "1", amount: "0" });
    expect(response.statusCode).toBe(400);
  });
});

describe("reads", () => {
  it("lists creators", async () => {
    const response = await app.inject({ method: "GET", url: "/creators" });
    expect(response.json().creators.map((creator: { id: string }) => creator.id)).toEqual(["ana", "bruno"]);
  });

  it("returns 404 for unknown order or creator", async () => {
    expect((await app.inject({ method: "GET", url: "/orders/404" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/creators/nobody/sales" })).statusCode).toBe(404);
  });
});
