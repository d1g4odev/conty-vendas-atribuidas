import { describe, expect, it } from "vitest";
import { toCents } from "../src/money.ts";

describe("toCents", () => {
  it.each([
    ["100", 10_000],
    ["100.5", 10_050],
    ["100.05", 10_005],
    ["0.10", 10],
    [" 19.99 ", 1_999],
    [19.99, 1_999],
    [0.1, 10],
  ])("parses %j as %i cents", (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it.each(["-1", "1.234", "abc", "", "1e3", -5, Number.NaN])("rejects %j", (input) => {
    expect(toCents(input)).toBeNull();
  });
});

