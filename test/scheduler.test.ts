import { describe, expect, it } from "vitest";
import { decideHeartbeat, shouldEvaluateHeartbeat } from "../src/scheduler.js";
import type { ShadowDefinition } from "../src/types.js";

const shadow = (id: string, probability = 1): ShadowDefinition => ({
  id, name: id, enabled: true, debug: false, activationProbability: probability,
  activeForModels: ["openai/gpt"], tools: [], prompt: id, filePath: `${id}.md`,
});

describe("shouldEvaluateHeartbeat", () => {
  it("suppresses pure conversation turns", () => {
    expect(shouldEvaluateHeartbeat([])).toBe(false);
  });

  it("allows turns that completed Main tool work", () => {
    expect(shouldEvaluateHeartbeat([{ toolName: "read" }])).toBe(true);
  });
});

describe("decideHeartbeat", () => {
  it("rolls independently and caps selected shadows", () => {
    const rolls = [0.1, 0.1, 0.2, 0.3, 0.8, 0.4];
    const result = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b"), shadow("c")],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      random: () => rolls.shift() ?? 0,
    });
    expect(result.activated).toHaveLength(2);
    expect(result.candidates).toHaveLength(3);
  });

  it("does nothing when heartbeat misses", () => {
    const result = decideHeartbeat({ heartbeatProbability: 0.3, availableSlots: 2, shadows: [shadow("a")], activeShadowIds: new Set(), mainModelId: "openai/gpt", random: () => 0.5 });
    expect(result.activated).toEqual([]);
  });

  it("forces a due Shadow despite both probability gates", () => {
    const due = { ...shadow("due", 0), maxRoundsAfterEnd: 3 };
    const result = decideHeartbeat({
      heartbeatProbability: 0,
      availableSlots: 1,
      shadows: [due],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: new Map([["due", { progressSinceEnd: 3, forcedPending: true, disposition: "forced" as const }]]),
      random: () => 0.99,
    });
    expect(result.activated).toEqual([{ shadow: due, forced: true }]);
    expect(result.candidates).toEqual([{ shadowId: "due", selected: true, forced: true }]);
  });

  it("keeps due Shadows pending when all slots are occupied", () => {
    const due = { ...shadow("due", 0), maxRoundsAfterEnd: 3 };
    const states = new Map([["due", { progressSinceEnd: 3, forcedPending: true, disposition: "forced" as const }]]);
    const result = decideHeartbeat({
      heartbeatProbability: 0,
      availableSlots: 0,
      shadows: [due],
      activeShadowIds: new Set(["other"]),
      mainModelId: "openai/gpt",
      scheduleStates: states,
      random: () => 0.99,
    });
    expect(result.activated).toEqual([]);
    expect(result.candidates).toEqual([{ shadowId: "due", selected: false, forced: true }]);
  });

  it("reports running-excluded and model-filtered shadows", () => {
    const result = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b")],
      activeShadowIds: new Set(["a"]),
      mainModelId: "other/model",
      random: () => 0.1,
    });
    expect(result.runningExcluded).toEqual(["a"]);
    expect(result.modelFiltered).toEqual(["b"]);
    expect(result.activated).toEqual([]);
    expect(result.candidates).toEqual([]);
  });
});
