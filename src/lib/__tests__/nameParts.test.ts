import { describe, it, expect } from "vitest";
import { splitDealName } from "../nameParts";

describe("splitDealName", () => {
  it("splits Founders // Company", () => {
    expect(splitDealName("Simon Farr // Interlock")).toEqual({
      founder: "Simon Farr",
      company: "Interlock",
    });
  });
  it("handles multiple founders", () => {
    expect(splitDealName("Ada, Grace // Cobolt")).toEqual({
      founder: "Ada, Grace",
      company: "Cobolt",
    });
  });
  it("treats a name with no // as the company", () => {
    expect(splitDealName("Interlock")).toEqual({ founder: "", company: "Interlock" });
  });
  it("falls back for empty / missing names", () => {
    expect(splitDealName("")).toEqual({ founder: "", company: "Untitled deal" });
    expect(splitDealName("Jane // ")).toEqual({ founder: "Jane", company: "Untitled deal" });
  });
});
