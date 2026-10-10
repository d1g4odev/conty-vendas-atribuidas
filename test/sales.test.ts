import { beforeEach, describe, expect, it } from "vitest";
import { CreatorDirectory } from "../src/attribution.ts";
import { ManualClock } from "../src/clock.ts";
import { ConflictError, NotFoundError } from "../src/errors.ts";
import { SalesService } from "../src/sales.ts";
import { creators, order } from "./fixtures.ts";

let clock: ManualClock;
let sales: SalesService;

beforeEach(() => {
  clock = new ManualClock("2026-03-01T12:00:00.000Z");
  sales = new SalesService(new CreatorDirectory(creators), clock);
});

const ledgerSum = (creatorId: string) =>
  sales.creatorSummary(creatorId).ledger.reduce((sum, entry) => sum + entry.deltaCents, 0);

describe("orders", () => {
  it("attributes a paid order to exactly one creator and credits its total", () => {
    const { outcome, order: view } = sales.receiveOrder(order({ coupon: "ANA10", utm: { campaign: "bruno-lima" } }));

    expect(outcome).toBe("created");
    expect(view.attribution).toEqual({ creatorId: "ana", source: "coupon", matched: "ana10" });
    expect(sales.creatorSummary("ana").netCents).toBe(10_000);
    expect(sales.creatorSummary("bruno").netCents).toBe(0);
    expect(sales.creatorSummary("bruno").orders).toEqual([]);
  });

  it("keeps unattributed orders without crediting anyone", () => {
    const view = sales.receiveOrder(order({ coupon: null, utm: { campaign: "newsletter" } })).order;
    expect(view.attribution).toBeNull();
    expect(view.ledger).toEqual([]);
    expect(sales.creatorSummary("ana").netCents).toBe(0);
  });

  it("only credits a pending order once it becomes paid", () => {
    sales.receiveOrder(order({ status: "pending" }));
    expect(sales.creatorSummary("ana").netCents).toBe(0);

    clock.advance(60_000);
    const { outcome } = sales.receiveOrder(order({ status: "paid" }));

    expect(outcome).toBe("updated");
    const summary = sales.creatorSummary("ana");
    expect(summary.netCents).toBe(10_000);
    expect(summary.ledger).toMatchObject([
      { deltaCents: 10_000, reason: "order_paid", at: "2026-03-01T12:01:00.000Z" },
    ]);
  });

  it("does not double count the same order payload delivered twice", () => {
    sales.receiveOrder(order());
    const again = sales.receiveOrder(order());

    expect(again.outcome).toBe("unchanged");
    expect(sales.creatorSummary("ana").netCents).toBe(10_000);
    expect(sales.creatorSummary("ana").ledger).toHaveLength(1);
  });

  it("short-circuits a repeated delivery id", () => {
    sales.receiveOrder(order(), "delivery-1");
    const again = sales.receiveOrder(order(), "delivery-1");

    expect(again.outcome).toBe("duplicate_delivery");
    expect(again.order.history).toHaveLength(1);
    expect(sales.creatorSummary("ana").netCents).toBe(10_000);
  });

  it("reverts the credit on cancellation without deleting history", () => {
    sales.receiveOrder(order());
    clock.advance(1_000);
    sales.receiveOrder(order({ status: "cancelled" }));

    const view = sales.getOrder("1001");
    expect(view.status).toBe("cancelled");
    expect(view.netCents).toBe(0);
    expect(view.attribution?.creatorId).toBe("ana");
    expect(view.ledger.map((entry) => [entry.reason, entry.deltaCents])).toEqual([
      ["order_paid", 10_000],
      ["order_cancelled", -10_000],
    ]);
    expect(view.history.map((entry) => entry.event)).toEqual(["order_received", "status_changed"]);
    expect(sales.creatorSummary("ana")).toMatchObject({ netCents: 0, salesCents: 0, refundedCents: 0 });
    expect(sales.creatorSummary("ana").orders).toHaveLength(1);
  });

  it("ignores out-of-order status regressions and records them", () => {
    sales.receiveOrder(order({ status: "cancelled" }));
    const late = sales.receiveOrder(order({ status: "paid" }));

    expect(late.outcome).toBe("ignored");
    expect(late.order.status).toBe("cancelled");
    expect(late.order.history.at(-1)).toMatchObject({
      event: "status_regression_ignored",
      detail: { current: "cancelled", received: "paid" },
    });
    expect(sales.creatorSummary("ana").netCents).toBe(0);
  });

  it("freezes total, coupon and UTMs so attribution can never move to another creator", () => {
    sales.receiveOrder(order({ coupon: "ANA10" }));

    expect(() => sales.receiveOrder(order({ coupon: "BRUNO15" }))).toThrow(ConflictError);
    expect(() => sales.receiveOrder(order({ totalCents: 20_000 }))).toThrow(/cannot change total/);
    expect(() => sales.receiveOrder(order({ utm: { campaign: "bruno-lima" } }))).toThrow(/cannot change utm/);
    expect(sales.getOrder("1001").attribution?.creatorId).toBe("ana");
    expect(sales.creatorSummary("bruno").netCents).toBe(0);
  });

  it("treats coupon whitespace as the same coupon", () => {
    sales.receiveOrder(order({ coupon: "ANA10" }));
    expect(sales.receiveOrder(order({ coupon: " ANA10 " })).outcome).toBe("unchanged");
  });
});

describe("refunds", () => {
  it("applies a partial refund", () => {
    sales.receiveOrder(order());
    const { outcome, refund } = sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 });

    expect(outcome).toBe("applied");
    expect(refund).toMatchObject({ requestedCents: 2_500, appliedCents: 2_500, state: "applied" });
    expect(sales.getOrder("1001")).toMatchObject({ refundedCents: 2_500, netCents: 7_500 });
    expect(sales.creatorSummary("ana")).toMatchObject({ netCents: 7_500, salesCents: 10_000, refundedCents: 2_500 });
  });

  it("accumulates several partial refunds", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 });
    sales.receiveRefund({ id: "r2", orderId: "1001", amountCents: 3_000 });

    const view = sales.getOrder("1001");
    expect(view.refunds.map((refund) => refund.id)).toEqual(["r1", "r2"]);
    expect(view.netCents).toBe(4_500);
    expect(ledgerSum("ana")).toBe(4_500);
  });

  it("a full refund zeroes the creator's sale but keeps the order and its history", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 10_000 });

    const view = sales.getOrder("1001");
    expect(view).toMatchObject({ status: "paid", refundedCents: 10_000, netCents: 0 });
    expect(view.attribution?.creatorId).toBe("ana");
    expect(view.ledger.map((entry) => entry.deltaCents)).toEqual([10_000, -10_000]);
    expect(sales.creatorSummary("ana").netCents).toBe(0);
  });

  it("does not apply the same refund twice", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 });
    const again = sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 });

    expect(again.outcome).toBe("duplicate");
    expect(sales.getOrder("1001").refundedCents).toBe(2_500);
    expect(sales.creatorSummary("ana").ledger).toHaveLength(2);
  });

  it("short-circuits a repeated refund delivery id", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 }, "d-1");
    expect(sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 }, "d-1").outcome).toBe(
      "duplicate_delivery",
    );
    expect(sales.getOrder("1001").refundedCents).toBe(2_500);
  });

  it("rejects a refund id reused with a different amount or order", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 2_500 });

    expect(() => sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 3_000 })).toThrow(ConflictError);
    expect(() => sales.receiveRefund({ id: "r1", orderId: "9999", amountCents: 2_500 })).toThrow(ConflictError);
    expect(sales.getOrder("1001").refundedCents).toBe(2_500);
  });

  it("never lets the sum of refunds exceed the sale", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 7_000 });
    const capped = sales.receiveRefund({ id: "r2", orderId: "1001", amountCents: 5_000 });
    const beyond = sales.receiveRefund({ id: "r3", orderId: "1001", amountCents: 1_000 });

    expect(capped.refund).toMatchObject({ requestedCents: 5_000, appliedCents: 3_000 });
    expect(beyond.refund).toMatchObject({ requestedCents: 1_000, appliedCents: 0 });
    const view = sales.getOrder("1001");
    expect(view).toMatchObject({ refundedCents: 10_000, netCents: 0 });
    expect(view.history.filter((entry) => entry.event === "refund_applied").map((entry) => entry.detail.capped)).toEqual(
      [false, true, true],
    );
    expect(ledgerSum("ana")).toBe(0);
  });

  it("caps a single refund larger than the order", () => {
    sales.receiveOrder(order());
    expect(sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 50_000 }).refund.appliedCents).toBe(10_000);
    expect(sales.creatorSummary("ana").netCents).toBe(0);
  });

  it("keeps a refund that arrives before its order pending and applies it when the order arrives", () => {
    const early = sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 4_000 });
    expect(early.outcome).toBe("pending");
    expect(early.refund).toMatchObject({ state: "pending", appliedCents: null, appliedAt: null });
    expect(sales.pendingRefunds().map((refund) => refund.id)).toEqual(["r1"]);
    expect(() => sales.getOrder("1001")).toThrow(NotFoundError);

    clock.advance(5_000);
    sales.receiveOrder(order());

    const view = sales.getOrder("1001");
    expect(view.refunds).toMatchObject([
      {
        id: "r1",
        state: "applied",
        appliedCents: 4_000,
        receivedAt: "2026-03-01T12:00:00.000Z",
        appliedAt: "2026-03-01T12:00:05.000Z",
      },
    ]);
    expect(view.netCents).toBe(6_000);
    expect(view.ledger.map((entry) => [entry.reason, entry.deltaCents])).toEqual([
      ["order_paid", 10_000],
      ["refund_applied", -4_000],
    ]);
    expect(sales.pendingRefunds()).toEqual([]);
    expect(sales.creatorSummary("ana").netCents).toBe(6_000);
  });

  it("caps pending refunds against the order total once it arrives", () => {
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 8_000 });
    sales.receiveRefund({ id: "r2", orderId: "1001", amountCents: 8_000 });
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 8_000 });
    sales.receiveOrder(order());

    expect(sales.getOrder("1001").refunds.map((refund) => refund.appliedCents)).toEqual([8_000, 2_000]);
    expect(sales.getOrder("1001").netCents).toBe(0);
  });

  it("applies refunds on a pending order and credits only the remainder once paid", () => {
    sales.receiveOrder(order({ status: "pending" }));
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 1_000 });
    expect(sales.creatorSummary("ana").netCents).toBe(0);

    sales.receiveOrder(order({ status: "paid" }));
    expect(sales.creatorSummary("ana").netCents).toBe(9_000);
    expect(sales.creatorSummary("ana").ledger.map((entry) => entry.deltaCents)).toEqual([9_000]);
  });

  it("cancelling a partially refunded order reverts only what was still credited", () => {
    sales.receiveOrder(order());
    sales.receiveRefund({ id: "r1", orderId: "1001", amountCents: 3_000 });
    sales.receiveOrder(order({ status: "cancelled" }));
    sales.receiveRefund({ id: "r2", orderId: "1001", amountCents: 3_000 });

    expect(sales.getOrder("1001").ledger.map((entry) => [entry.reason, entry.deltaCents])).toEqual([
      ["order_paid", 10_000],
      ["refund_applied", -3_000],
      ["order_cancelled", -7_000],
    ]);
    expect(sales.getOrder("1001").refundedCents).toBe(6_000);
    expect(ledgerSum("ana")).toBe(0);
  });

  it("keeps the creator balance equal to the sum of order nets across a mixed sequence", () => {
    sales.receiveRefund({ id: "early", orderId: "3", amountCents: 500 });
    sales.receiveOrder(order({ id: "1", totalCents: 10_000, coupon: "ANA10" }));
    sales.receiveOrder(order({ id: "2", totalCents: 4_000, coupon: null, utm: { campaign: "ana-souza" } }));
    sales.receiveOrder(order({ id: "3", totalCents: 2_000, coupon: "ANA10", status: "pending" }));
    sales.receiveRefund({ id: "a", orderId: "1", amountCents: 1_000 });
    sales.receiveRefund({ id: "a", orderId: "1", amountCents: 1_000 });
    sales.receiveOrder(order({ id: "2", totalCents: 4_000, coupon: null, utm: { campaign: "ana-souza" }, status: "cancelled" }));
    sales.receiveOrder(order({ id: "3", totalCents: 2_000, coupon: "ANA10", status: "paid" }));

    const summary = sales.creatorSummary("ana");
    const orderNets = summary.orders.reduce((sum, line) => sum + line.netCents, 0);
    expect(summary.netCents).toBe(9_000 + 0 + 1_500);
    expect(orderNets).toBe(summary.netCents);
    expect(summary.salesCents - summary.refundedCents).toBe(summary.netCents);
  });
});

describe("lookups", () => {
  it("throws NotFoundError for unknown orders and creators", () => {
    expect(() => sales.getOrder("nope")).toThrow(NotFoundError);
    expect(() => sales.creatorSummary("nope")).toThrow(NotFoundError);
  });

  it("returns copies that cannot mutate internal state", () => {
    sales.receiveOrder(order());
    const view = sales.getOrder("1001");
    view.history.length = 0;
    view.ledger.length = 0;
    expect(sales.getOrder("1001").history).toHaveLength(1);
    expect(sales.creatorSummary("ana").netCents).toBe(10_000);
  });
});
