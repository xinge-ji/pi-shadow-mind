import { describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";
import { ShadowDispatchCoordinator, type ShadowDispatchEnvironment } from "../src/shadow-dispatch-coordinator.js";
import type { ShadowDefinition } from "../src/types.js";

function shadow(id: string, maxRoundsAfterEnd: number): ShadowDefinition {
  return {
    id,
    name: id,
    enabled: true,
    debug: false,
    activationProbability: 0,
    activeForModels: ["test/model"],
    maxRoundsAfterEnd,
    tools: [],
    prompt: id,
    filePath: `${id}.md`,
  };
}

function environment(shadows: readonly ShadowDefinition[], active: Map<string, { shadow: ShadowDefinition; epoch: number }>): ShadowDispatchEnvironment {
  return {
    epoch: 0,
    ctx: {
      sessionManager: { getEntries: () => [], getLeafId: () => undefined },
    } as never,
    config: {
      heartbeatProbability: 0,
      maxParallelShadows: 1,
      defaultShadowTimeoutSeconds: 60,
      headlessDrainTimeoutSeconds: 120,
      resultBatchWindowMs: 400,
      defaultThinkingLevel: "low",
      turnWeights: { default: 1 },
    },
    shadows,
    active,
    mainModel: { provider: "test", id: "model" } as never,
    fullModelId: "test/model",
    getAvailableTools: () => new Set(),
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ShadowDispatchCoordinator scheduling lifecycle", () => {
  it("keeps a due Shadow pending and starts it after a slot-release finish", async () => {
    const due = shadow("due", 1);
    const busy = shadow("busy", 10);
    const active = new Map([["busy-run", { shadow: busy, epoch: 0 }]]);
    const launches: string[] = [];
    let current = environment([due, busy], active);
    const coordinator = new ShadowDispatchCoordinator({
      getCurrentEpoch: () => current.epoch,
      loadEnvironment: async () => current,
      launch: ({ shadow: launched }) => launches.push(launched.id),
    });

    coordinator.decideAndDispatch(current, 1, () => 0.99);
    expect(launches).toEqual([]);

    active.delete("busy-run");
    current = environment([due, busy], active);
    coordinator.onRunFinished("busy", 0);
    await drain();

    expect(launches).toEqual(["due"]);
  });

  it("shows Shadow names and scheduling progress in the status panel", () => {
    const runtime = new ShadowMindRuntime({ appendEntry: vi.fn() } as never);
    const internals = runtime as unknown as {
      recentEvents: Array<{ at: string; kind: string; epoch: number; data?: Record<string, unknown> }>;
      shadowCount: number;
      statusLines(): string[];
    };
    internals.shadowCount = 2;
    internals.recentEvents.push(
      { at: "2026-01-01T22:39:12.000Z", kind: "run-start", epoch: 0, data: { shadowName: "Architecture" } },
      { at: "2026-01-01T22:39:13.000Z", kind: "run-end", epoch: 0, data: { shadowName: "Architecture" } },
      {
        at: "2026-01-01T22:39:14.000Z",
        kind: "heartbeat",
        epoch: 0,
        data: { shadowProgress: [{ name: "Architecture", progress: 1.256 }, { name: "Completion", progress: 2 }] },
      },
    );

    const lines = internals.statusLines();
    expect(lines.some((line) => line.endsWith("run-start: Architecture"))).toBe(true);
    expect(lines.some((line) => line.endsWith("run-end: Architecture"))).toBe(true);
    expect(lines.some((line) => line.endsWith("heartbeat [Architecture: 1.26; Completion: 2]"))).toBe(true);
  });

  it("routes a runner rejection through the runtime finish lifecycle", async () => {
    const appendEntry = vi.fn();
    const run = vi.fn(() => Promise.reject(new Error("runner rejected")));
    const runner = { run, abortAll: vi.fn() } as never;
    const runtime = new ShadowMindRuntime({ appendEntry } as never, runner);
    const internals = runtime as unknown as {
      active: Map<string, unknown>;
      launchShadow(request: unknown): void;
      sessionLifetime: { activate(): void };
    };
    internals.sessionLifetime.activate();
    const scheduled = shadow("runtime", 1);
    const ctx = {
      cwd: process.cwd(),
      sessionManager: { getEntries: () => [], getLeafId: () => undefined },
      getSystemPrompt: () => "system",
      modelRegistry: { hasConfiguredAuth: () => true, isUsingOAuth: () => false },
      thinkingLevel: "low",
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
    };

    internals.launchShadow({
      ctx,
      shadow: scheduled,
      mainModel: { provider: "test", id: "model" },
      fullModelId: "test/model",
      context: { messages: [] },
      availableTools: new Set(),
    });
    await drain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(internals.active.size).toBe(0);
    expect(appendEntry).toHaveBeenCalledWith(
      "shadow-mind-event",
      expect.objectContaining({
        kind: "run-end",
        data: expect.objectContaining({ reason: "error", error: "runner rejected" }),
      }),
    );
  });
});
