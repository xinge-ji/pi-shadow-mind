import { describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowReport } from "../src/types.js";

type EventHandler = (event: any, ctx: any) => unknown;

type RuntimeInternals = {
  registerEvents(): void;
  deliverReports(reports: ShadowReport[]): void;
  sessionLifetime: { activate(): void };
  latestContext?: { isIdle(): boolean };
};

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const pi = {
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    sendMessage,
    appendEntry,
  };
  const runtime = new ShadowMindRuntime(pi as never);
  const internals = runtime as unknown as RuntimeInternals;
  const ctx = { isIdle: () => true };
  internals.registerEvents();
  internals.sessionLifetime.activate();
  internals.latestContext = ctx;
  return { handlers, sendMessage, internals, ctx };
}

function report(runId: string): ShadowReport {
  return {
    shadowId: `shadow-${runId}`,
    shadowName: `Shadow ${runId}`,
    content: `Report ${runId}`,
    epoch: 0,
    runId,
  };
}

async function nextImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ShadowMindRuntime compaction report buffering", () => {
  it("delivers reports only after successful compaction has finished", async () => {
    const { handlers, sendMessage, internals, ctx } = createHarness();
    const controller = new AbortController();

    handlers.get("session_before_compact")!({ signal: controller.signal }, ctx);
    internals.deliverReports([report("one")]);
    internals.deliverReports([report("two")]);

    expect(sendMessage).not.toHaveBeenCalled();

    handlers.get("session_compact")!({}, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
    await nextImmediate();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "shadow-report",
        content: expect.stringContaining("Report one"),
        details: {
          reports: [
            { shadowId: "shadow-one", runId: "one" },
            { shadowId: "shadow-two", runId: "two" },
          ],
        },
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(sendMessage.mock.calls[0]![0].content).toContain("Report two");
  });

  it("releases buffered reports after compaction is aborted", async () => {
    const { handlers, sendMessage, internals, ctx } = createHarness();
    const controller = new AbortController();

    handlers.get("session_before_compact")!({ signal: controller.signal }, ctx);
    internals.deliverReports([report("aborted")]);
    controller.abort();

    expect(sendMessage).not.toHaveBeenCalled();
    await nextImmediate();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("releases buffered reports on Pi versions that report compaction failure", async () => {
    const { handlers, sendMessage, internals, ctx } = createHarness();

    handlers.get("session_before_compact")!({ signal: new AbortController().signal }, ctx);
    internals.deliverReports([report("failed")]);
    handlers.get("session_compact_failed")!({}, ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    await nextImmediate();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
