import { describe, expect, it } from "vitest";
import { calculateTurnWeight } from "../src/turn-weight.js";

describe("calculateTurnWeight", () => {
  const weights = {
    read: 0.25,
    grep: 0.25,
    edit: 1,
    bash: 0.5,
    default: 1,
  };

  it("uses the highest weight within one turn", () => {
    expect(calculateTurnWeight([{ toolName: "read" }, { toolName: "edit" }, { toolName: "bash" }], weights)).toBe(1);
    expect(calculateTurnWeight([{ toolName: "read" }, { toolName: "grep" }], weights)).toBe(0.25);
  });

  it("uses default for unknown tools", () => {
    expect(calculateTurnWeight([{ toolName: "custom_tool" }], weights)).toBe(1);
  });

  it("allows a zero weight without making the turn ineligible", () => {
    expect(calculateTurnWeight([{ toolName: "read" }], { read: 0, default: 1 })).toBe(0);
  });
});
