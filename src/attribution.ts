export interface Creator {
  id: string;
  name: string;
  coupons: readonly string[];
  utmCampaigns: readonly string[];
}

export interface Utm {
  source?: string | undefined;
  medium?: string | undefined;
  campaign?: string | undefined;
  content?: string | undefined;
  term?: string | undefined;
}

export interface AttributionSignals {
  coupon: string | null;
  utm: Utm;
}

export type AttributionSource = "coupon" | "utm";

export interface Attribution {
  creatorId: string;
  source: AttributionSource;
  matched: string;
}

const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

export class CreatorDirectory {
  readonly #byCoupon = new Map<string, Creator>();
  readonly #byCampaign = new Map<string, Creator>();
  readonly #byId = new Map<string, Creator>();

  constructor(creators: readonly Creator[]) {
    for (const creator of creators) {
      if (this.#byId.has(creator.id)) throw new Error(`Duplicate creator id: ${creator.id}`);
      this.#byId.set(creator.id, creator);
      this.#register(this.#byCoupon, creator.coupons, creator, "coupon");
      this.#register(this.#byCampaign, creator.utmCampaigns, creator, "utm_campaign");
    }
  }

  #register(index: Map<string, Creator>, keys: readonly string[], creator: Creator, kind: string): void {
    for (const key of keys) {
      const normalized = normalize(key);
      if (!normalized) continue;
      const owner = index.get(normalized);
      if (owner && owner.id !== creator.id) {
        throw new Error(`${kind} "${key}" belongs to both ${owner.id} and ${creator.id}`);
      }
      index.set(normalized, creator);
    }
  }

  get(id: string): Creator | undefined {
    return this.#byId.get(id);
  }

  list(): Creator[] {
    return [...this.#byId.values()];
  }

  byCoupon(coupon: string | null): Creator | undefined {
    const key = normalize(coupon);
    return key ? this.#byCoupon.get(key) : undefined;
  }

  byUtm(utm: Utm): Creator | undefined {
    const key = normalize(utm.campaign);
    return key ? this.#byCampaign.get(key) : undefined;
  }
}

export function resolveAttribution(signals: AttributionSignals, directory: CreatorDirectory): Attribution | null {
  const byCoupon = directory.byCoupon(signals.coupon);
  if (byCoupon) return { creatorId: byCoupon.id, source: "coupon", matched: normalize(signals.coupon) ?? "" };

  const byUtm = directory.byUtm(signals.utm);
  if (byUtm) return { creatorId: byUtm.id, source: "utm", matched: normalize(signals.utm.campaign) ?? "" };

  return null;
}
