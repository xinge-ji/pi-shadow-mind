import { describe, expect, it } from "vitest";
import { decideHeartbeat, selectForcedPending } from "../src/scheduler.js";
import { ShadowSchedule } from "../src/shadow-schedule.js";
import type { ShadowDefinition } from "../src/types.js";

function shadow(id: string, schedule: Partial<Pick<ShadowDefinition, "minRoundsAfterEnd" | "maxRoundsAfterEnd">> = {}): ShadowDefinition {
  return {
    id,
    name: id,
    enabled: true,
    debug: false,
    activationProbability: 1,
    activeForModels: ["openai/gpt"],
    tools: [],
    prompt: id,
    filePath: `${id}.md`,
    ...schedule,
  };
}

describe("ShadowSchedule", () => {
  it("applies weighted min/max settings from the start of a session", () => {
    const scheduled = shadow("scheduled", { minRoundsAfterEnd: 2, maxRoundsAfterEnd: 4 });
    const schedule = new ShadowSchedule();
    schedule.sync([scheduled]);

    schedule.advance([scheduled], new Set(), 1);
    expect(schedule.get("scheduled")).toEqual({ progressSinceEnd: 1, forcedPending: false, disposition: "cooldown" });
    schedule.advance([scheduled], new Set(), 1);
    expect(schedule.get("scheduled")).toEqual({ progressSinceEnd: 2, forcedPending: false, disposition: "cooldown" });

    const cooldown = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 1,
      shadows: [scheduled],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
      random: () => 0,
    });
    expect(cooldown.activated).toEqual([]);
    expect(cooldown.cooldownExcluded).toEqual(["scheduled"]);

    schedule.advance([scheduled], new Set(), 0.25);
    expect(schedule.get("scheduled")?.progressSinceEnd).toBe(2.25);
    const normal = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 1,
      shadows: [scheduled],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
      random: () => 0,
    });
    expect(normal.activated.map(({ shadow }) => shadow.id)).toEqual(["scheduled"]);

    schedule.advance([scheduled], new Set(), 1.75);
    expect(schedule.get("scheduled")).toEqual({ progressSinceEnd: 4, forcedPending: true, disposition: "forced" });
    const forced = decideHeartbeat({
      heartbeatProbability: 0,
      availableSlots: 1,
      shadows: [scheduled],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
      random: () => 0.99,
    });
    expect(forced.activated.map(({ shadow }) => shadow.id)).toEqual(["scheduled"]);
    expect(forced.activated[0]?.forced).toBe(true);

    schedule.markStarted("scheduled");
    expect(schedule.get("scheduled")).toEqual({ progressSinceEnd: 4, forcedPending: false, disposition: "normal" });
  });

  it("keeps a zero-weight eligible turn in cooldown without advancing progress", () => {
    const scheduled = shadow("zero", { minRoundsAfterEnd: 2 });
    const schedule = new ShadowSchedule();
    schedule.sync([scheduled]);
    schedule.advance([scheduled], new Set(), 0);

    expect(schedule.get("zero")).toEqual({ progressSinceEnd: 0, forcedPending: false, disposition: "cooldown" });
    const decision = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 1,
      shadows: [scheduled],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
      random: () => 0,
    });
    expect(decision.activated).toEqual([]);
    expect(decision.cooldownExcluded).toEqual(["zero"]);
  });

  it("does not advance an active Shadow and resets after it ends", () => {
    const scheduled = shadow("active", { minRoundsAfterEnd: 1, maxRoundsAfterEnd: 3 });
    const schedule = new ShadowSchedule();
    schedule.sync([scheduled]);
    schedule.advance([scheduled], new Set(), 1);
    schedule.advance([scheduled], new Set(["active"]), 5);
    expect(schedule.get("active")).toEqual({ progressSinceEnd: 1, forcedPending: false, disposition: "cooldown" });

    schedule.finish("active");
    expect(schedule.get("active")).toBeUndefined();
  });

  it("clears forced pending when the optional max setting is removed", () => {
    const scheduled = shadow("scheduled", { minRoundsAfterEnd: 1, maxRoundsAfterEnd: 2 });
    const schedule = new ShadowSchedule();
    schedule.sync([scheduled]);
    schedule.advance([scheduled], new Set(), 1);
    schedule.advance([scheduled], new Set(), 1);
    expect(schedule.get("scheduled")?.forcedPending).toBe(true);

    const minOnly = shadow("scheduled", { minRoundsAfterEnd: 1 });
    schedule.sync([minOnly]);
    expect(schedule.get("scheduled")).toEqual({ progressSinceEnd: 2, forcedPending: false, disposition: "normal" });
  });

  it("does not accumulate progress while disabled", () => {
    const scheduled = shadow("disabled", { maxRoundsAfterEnd: 2 });
    scheduled.enabled = false;
    const schedule = new ShadowSchedule();
    schedule.sync([scheduled]);
    schedule.advance([scheduled], new Set(), 1);
    expect(schedule.get("disabled")).toBeUndefined();

    scheduled.enabled = true;
    schedule.sync([scheduled]);
    schedule.advance([scheduled], new Set(), 1);
    expect(schedule.get("disabled")).toEqual({ progressSinceEnd: 1, forcedPending: false, disposition: "normal" });
  });

  it("keeps pending forced Shadows until a slot is available without wait-time ranking", () => {
    const first = shadow("first", { maxRoundsAfterEnd: 2 });
    const second = shadow("second", { maxRoundsAfterEnd: 2 });
    const schedule = new ShadowSchedule();
    schedule.sync([first, second]);
    schedule.advance([first, second], new Set(), 1);
    schedule.advance([first, second], new Set(), 1);

    expect(selectForcedPending({
      availableSlots: 0,
      shadows: [second, first],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
    })).toEqual([]);
    expect(schedule.get("first")?.forcedPending).toBe(true);
    expect(schedule.get("second")?.forcedPending).toBe(true);

    expect(selectForcedPending({
      availableSlots: 1,
      shadows: [second, first],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      scheduleStates: schedule.snapshot(),
    }).map(({ id }) => id)).toEqual(["second"]);
  });
});
