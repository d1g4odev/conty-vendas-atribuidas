import { resolveAttribution, type Attribution, type CreatorDirectory, type Utm } from "./attribution.ts";
import type { Clock } from "./clock.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

export const ORDER_STATUSES = ["pending", "paid", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const STATUS_RANK: Record<OrderStatus, number> = { pending: 0, paid: 1, cancelled: 2 };

export interface OrderInput {
  id: string;
  totalCents: number;
  coupon: string | null;
  utm: Utm;
  status: OrderStatus;
}

export interface RefundInput {
  id: string;
  orderId: string;
  amountCents: number;
}

export type HistoryEvent =
  | "order_received"
  | "status_changed"
  | "status_regression_ignored"
  | "refund_applied";

export interface HistoryEntry {
  at: string;
  event: HistoryEvent;
  detail: Record<string, unknown>;
}

export type LedgerReason = "order_paid" | "order_cancelled" | "refund_applied";

export interface LedgerEntry {
  seq: number;
  at: string;
  creatorId: string;
  orderId: string;
  deltaCents: number;
  reason: LedgerReason;
  ref: string;
}

export interface Refund {
  id: string;
  orderId: string;
  requestedCents: number;
  appliedCents: number | null;
  state: "pending" | "applied";
  receivedAt: string;
  appliedAt: string | null;
}

interface Order {
  id: string;
  totalCents: number;
  coupon: string | null;
  utm: Utm;
  status: OrderStatus;
  attribution: Attribution | null;
  refundedCents: number;
  refundIds: string[];
  receivedAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export interface OrderView {
  id: string;
  totalCents: number;
  coupon: string | null;
  utm: Utm;
  status: OrderStatus;
  attribution: Attribution | null;
  refundedCents: number;
  netCents: number;
  receivedAt: string;
  updatedAt: string;
  refunds: Refund[];
  history: HistoryEntry[];
  ledger: LedgerEntry[];
}

export type OrderOutcome = "created" | "updated" | "unchanged" | "ignored" | "duplicate_delivery";
export type RefundOutcome = "applied" | "pending" | "duplicate" | "duplicate_delivery";

export interface CreatorOrderLine {
  orderId: string;
  status: OrderStatus;
  source: Attribution["source"];
  totalCents: number;
  refundedCents: number;
  netCents: number;
}

export interface CreatorSummary {
  creator: { id: string; name: string };
  netCents: number;
  salesCents: number;
  refundedCents: number;
  orders: CreatorOrderLine[];
  ledger: LedgerEntry[];
}

const netOf = (order: Order): number => (order.status === "paid" ? order.totalCents - order.refundedCents : 0);

const utmKey = (utm: Utm): string =>
  JSON.stringify(
    (["source", "medium", "campaign", "content", "term"] as const).map((key) => utm[key]?.trim() || null),
  );

const couponKey = (coupon: string | null): string | null => coupon?.trim() || null;

export class SalesService {
  readonly #orders = new Map<string, Order>();
  readonly #refunds = new Map<string, Refund>();
  readonly #pendingRefunds = new Map<string, string[]>();
  readonly #deliveries = new Set<string>();
  readonly #ledger: LedgerEntry[] = [];

  constructor(
    private readonly creators: CreatorDirectory,
    private readonly clock: Clock,
  ) {}

  receiveOrder(input: OrderInput, deliveryId?: string): { outcome: OrderOutcome; order: OrderView } {
    const deliveryKey = deliveryId ? `order:${deliveryId}` : null;
    const known = this.#orders.get(input.id);
    if (deliveryKey && this.#deliveries.has(deliveryKey) && known) {
      return { outcome: "duplicate_delivery", order: this.#view(known) };
    }

    const outcome = known ? this.#updateOrder(known, input) : this.#createOrder(input);
    if (deliveryKey) this.#deliveries.add(deliveryKey);
    return { outcome, order: this.getOrder(input.id) };
  }

  receiveRefund(input: RefundInput, deliveryId?: string): { outcome: RefundOutcome; refund: Refund } {
    const deliveryKey = deliveryId ? `refund:${deliveryId}` : null;
    const known = this.#refunds.get(input.id);
    if (deliveryKey && this.#deliveries.has(deliveryKey) && known) {
      return { outcome: "duplicate_delivery", refund: { ...known } };
    }

    if (known) {
      if (known.orderId !== input.orderId || known.requestedCents !== input.amountCents) {
        throw new ConflictError(`Refund ${input.id} was already received with different data`, {
          refundId: input.id,
          known: { orderId: known.orderId, amountCents: known.requestedCents },
          received: { orderId: input.orderId, amountCents: input.amountCents },
        });
      }
      if (deliveryKey) this.#deliveries.add(deliveryKey);
      return { outcome: "duplicate", refund: { ...known } };
    }

    const refund: Refund = {
      id: input.id,
      orderId: input.orderId,
      requestedCents: input.amountCents,
      appliedCents: null,
      state: "pending",
      receivedAt: this.#now(),
      appliedAt: null,
    };
    this.#refunds.set(refund.id, refund);

    const order = this.#orders.get(input.orderId);
    if (order) {
      this.#applyRefund(order, refund);
    } else {
      this.#pendingRefunds.set(input.orderId, [...(this.#pendingRefunds.get(input.orderId) ?? []), refund.id]);
    }
    if (deliveryKey) this.#deliveries.add(deliveryKey);
    return { outcome: refund.state === "applied" ? "applied" : "pending", refund: { ...refund } };
  }

  getOrder(id: string): OrderView {
    const order = this.#orders.get(id);
    if (!order) throw new NotFoundError(`Order ${id} not found`);
    return this.#view(order);
  }

  pendingRefunds(): Refund[] {
    return [...this.#pendingRefunds.values()].flat().map((id) => ({ ...this.#refund(id) }));
  }

  creatorSummary(creatorId: string): CreatorSummary {
    const creator = this.creators.get(creatorId);
    if (!creator) throw new NotFoundError(`Creator ${creatorId} not found`);

    const orders = [...this.#orders.values()].flatMap((order) =>
      order.attribution?.creatorId === creatorId ? [{ order, source: order.attribution.source }] : [],
    );
    const paid = orders.map(({ order }) => order).filter((order) => order.status === "paid");
    const ledger = this.#ledger.filter((entry) => entry.creatorId === creatorId);

    return {
      creator: { id: creator.id, name: creator.name },
      netCents: ledger.reduce((sum, entry) => sum + entry.deltaCents, 0),
      salesCents: paid.reduce((sum, order) => sum + order.totalCents, 0),
      refundedCents: paid.reduce((sum, order) => sum + order.refundedCents, 0),
      orders: orders.map(({ order, source }) => ({
        orderId: order.id,
        status: order.status,
        source,
        totalCents: order.totalCents,
        refundedCents: order.refundedCents,
        netCents: netOf(order),
      })),
      ledger: ledger.map((entry) => ({ ...entry })),
    };
  }

  #createOrder(input: OrderInput): OrderOutcome {
    const at = this.#now();
    const order: Order = {
      id: input.id,
      totalCents: input.totalCents,
      coupon: couponKey(input.coupon),
      utm: { ...input.utm },
      status: "pending",
      attribution: resolveAttribution({ coupon: input.coupon, utm: input.utm }, this.creators),
      refundedCents: 0,
      refundIds: [],
      receivedAt: at,
      updatedAt: at,
      history: [],
    };
    this.#orders.set(order.id, order);
    this.#withLedger(order, "order_paid", "order_received", () => {
      order.status = input.status;
    });
    this.#record(order, "order_received", { status: input.status, attribution: order.attribution });

    for (const refundId of this.#pendingRefunds.get(order.id) ?? []) {
      this.#applyRefund(order, this.#refund(refundId));
    }
    this.#pendingRefunds.delete(order.id);
    return "created";
  }

  #updateOrder(order: Order, input: OrderInput): OrderOutcome {
    const changed = [
      order.totalCents !== input.totalCents && "total",
      order.coupon !== couponKey(input.coupon) && "coupon",
      utmKey(order.utm) !== utmKey(input.utm) && "utm",
    ].filter((field): field is string => field !== false);
    if (changed.length > 0) {
      throw new ConflictError(`Order ${order.id} cannot change ${changed.join(", ")} after it was received`, {
        orderId: order.id,
        fields: changed,
      });
    }

    if (input.status === order.status) return "unchanged";
    if (STATUS_RANK[input.status] < STATUS_RANK[order.status]) {
      this.#record(order, "status_regression_ignored", { current: order.status, received: input.status });
      return "ignored";
    }
    const from = order.status;
    this.#withLedger(order, input.status === "cancelled" ? "order_cancelled" : "order_paid", "status_changed", () => {
      order.status = input.status;
    });
    this.#record(order, "status_changed", { from, to: input.status });
    return "updated";
  }

  #applyRefund(order: Order, refund: Refund): void {
    const applied = Math.min(refund.requestedCents, order.totalCents - order.refundedCents);
    this.#withLedger(order, "refund_applied", refund.id, () => {
      order.refundedCents += applied;
      order.refundIds.push(refund.id);
      refund.appliedCents = applied;
      refund.state = "applied";
      refund.appliedAt = this.#now();
    });
    this.#record(order, "refund_applied", {
      refundId: refund.id,
      requestedCents: refund.requestedCents,
      appliedCents: applied,
      capped: applied < refund.requestedCents,
    });
  }

  #withLedger(order: Order, reason: LedgerReason, ref: string, mutate: () => void): void {
    const before = netOf(order);
    mutate();
    const delta = netOf(order) - before;
    if (delta === 0 || !order.attribution) return;
    this.#ledger.push({
      seq: this.#ledger.length + 1,
      at: this.#now(),
      creatorId: order.attribution.creatorId,
      orderId: order.id,
      deltaCents: delta,
      reason,
      ref,
    });
  }

  #record(order: Order, event: HistoryEvent, detail: Record<string, unknown>): void {
    const at = this.#now();
    order.history.push({ at, event, detail });
    order.updatedAt = at;
  }

  #refund(id: string): Refund {
    const refund = this.#refunds.get(id);
    if (!refund) throw new NotFoundError(`Refund ${id} not found`);
    return refund;
  }

  #view(order: Order): OrderView {
    return structuredClone({
      id: order.id,
      totalCents: order.totalCents,
      coupon: order.coupon,
      utm: order.utm,
      status: order.status,
      attribution: order.attribution,
      refundedCents: order.refundedCents,
      netCents: netOf(order),
      receivedAt: order.receivedAt,
      updatedAt: order.updatedAt,
      refunds: order.refundIds.map((id) => this.#refund(id)),
      history: order.history,
      ledger: this.#ledger.filter((entry) => entry.orderId === order.id),
    });
  }

  #now(): string {
    return this.clock.now().toISOString();
  }
}
