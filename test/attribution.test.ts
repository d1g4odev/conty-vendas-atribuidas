import { describe, expect, it } from "vitest";
import { CreatorDirectory, resolveAttribution } from "../src/attribution.ts";
import { creators } from "./fixtures.ts";

const directory = new CreatorDirectory(creators);

describe("resolveAttribution", () => {
  it("prefers the coupon over the UTM when they point to different creators", () => {
    expect(resolveAttribution({ coupon: "ANA10", utm: { campaign: "bruno-lima" } }, directory)).toEqual({
      creatorId: "ana",
      source: "coupon",
      matched: "ana10",
    });
  });

  it("falls back to the UTM campaign when there is no coupon", () => {
    expect(resolveAttribution({ coupon: null, utm: { campaign: "bruno-lima" } }, directory)).toEqual({
      creatorId: "bruno",
      source: "utm",
      matched: "bruno-lima",
    });
  });

  it("falls back to the UTM campaign when the coupon belongs to no creator", () => {
    expect(resolveAttribution({ coupon: "BLACKFRIDAY", utm: { campaign: "ana-souza" } }, directory)?.creatorId).toBe(
      "ana",
    );
  });

  it("matches coupons and campaigns case-insensitively and ignores surrounding spaces", () => {
    expect(resolveAttribution({ coupon: "  ana10 ", utm: {} }, directory)?.creatorId).toBe("ana");
    expect(resolveAttribution({ coupon: null, utm: { campaign: "BRUNO-LIMA" } }, directory)?.creatorId).toBe("bruno");
  });

  it("only looks at utm_campaign, not at other UTM fields", () => {
    expect(resolveAttribution({ coupon: null, utm: { source: "ana-souza", content: "bruno-lima" } }, directory)).toBe(
      null,
    );
  });

  it("returns null when nothing matches", () => {
    expect(resolveAttribution({ coupon: "OTHER", utm: { campaign: "newsletter" } }, directory)).toBeNull();
  });
});

describe("CreatorDirectory", () => {
  it("rejects a coupon shared by two creators so attribution can never be ambiguous", () => {
    expect(
      () =>
        new CreatorDirectory([
          { id: "a", name: "A", coupons: ["SAME"], utmCampaigns: [] },
          { id: "b", name: "B", coupons: ["same"], utmCampaigns: [] },
        ]),
    ).toThrow(/belongs to both a and b/);
  });

  it("rejects a UTM campaign shared by two creators", () => {
    expect(
      () =>
        new CreatorDirectory([
          { id: "a", name: "A", coupons: [], utmCampaigns: ["camp"] },
          { id: "b", name: "B", coupons: [], utmCampaigns: ["CAMP"] },
        ]),
    ).toThrow(/belongs to both/);
  });

  it("rejects duplicate creator ids", () => {
    expect(() => new CreatorDirectory([creators[0]!, creators[0]!])).toThrow(/Duplicate creator id/);
  });
});
