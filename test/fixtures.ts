import type { Creator } from "../src/attribution.ts";
import type { OrderInput } from "../src/sales.ts";

export const creators: Creator[] = [
  { id: "ana", name: "Ana Souza", coupons: ["ANA10"], utmCampaigns: ["ana-souza"] },
  { id: "bruno", name: "Bruno Lima", coupons: ["BRUNO15"], utmCampaigns: ["bruno-lima"] },
];

export const order = (overrides: Partial<OrderInput> = {}): OrderInput => ({
  id: "1001",
  totalCents: 10_000,
  coupon: "ANA10",
  utm: {},
  status: "paid",
  ...overrides,
});
