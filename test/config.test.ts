import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_TURN_WEIGHTS, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses v1 defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.defaultShadowTimeoutSeconds).toBe(300);
    expect(DEFAULT_CONFIG.turnWeights).toEqual(DEFAULT_TURN_WEIGHTS);
  });

  it("rejects invalid probability", () => {
    expect(() => parseConfig({ heartbeat_probability: 2 })).toThrow(/heartbeat_probability/);
  });

  it("accepts a deterministic benchmark seed", () => {
    expect(parseConfig({ random_seed: 42 }).randomSeed).toBe(42);
    expect(() => parseConfig({ random_seed: -1 })).toThrow(/random_seed/);
    expect(() => parseConfig({ random_seed: 1.5 })).toThrow(/random_seed/);
  });

  it("merges custom turn weights with defaults and round-trips them", () => {
    const config = parseConfig({ turn_weights: { read: 0, edit: 2 } });
    expect(config.turnWeights).toMatchObject({ read: 0, edit: 2, default: 1, bash: 0.5 });
    expect(parseConfig(JSON.parse(serializeConfig(config)))).toEqual(config);
  });

  it("rejects invalid turn weights", () => {
    expect(() => parseConfig({ turn_weights: [] })).toThrow(/turn_weights/);
    expect(() => parseConfig({ turn_weights: { read: -1 } })).toThrow(/turn_weights/);
    expect(() => parseConfig({ turn_weights: { read: Number.NaN } })).toThrow(/turn_weights/);
  });
});
