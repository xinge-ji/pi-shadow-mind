import { describe, expect, it } from "vitest";
import { serializeShadow } from "../src/entity-store.js";
import { parseShadowMarkdown } from "../src/registry.js";

describe("parseShadowMarkdown", () => {
  it("applies shadow defaults", () => {
    const shadow = parseShadowMarkdown("---\nname: Fact checker\n---\nCheck claims against the project.", "C:/tmp/facts.md");
    expect(shadow).toMatchObject({
      id: "facts",
      name: "Fact checker",
      enabled: true,
      debug: false,
      activationProbability: 0.3,
      activeForModels: ["*"],
      tools: [],
    });
  });

  it("rejects an empty prompt", () => {
    expect(() => parseShadowMarkdown("---\nid: empty\n---\n", "C:/tmp/empty.md")).toThrow(/empty/);
  });

  it("accepts off as a thinking level", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: quick-check\nthinking_level: off\n---\nCheck once and report.",
      "C:/tmp/quick-check.md",
    );
    expect(shadow.thinkingLevel).toBe("off");
  });

  it("parses fallback model settings", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: resilient\nrun_with_model: openai/primary\nthinking_level: xhigh\nfallback_model: openai/fallback\nfallback_model_thinking_level: high\n---\nRetry with a backup model when needed.",
      "C:/tmp/resilient.md",
    );
    expect(shadow).toMatchObject({
      runWithModel: "openai/primary",
      thinkingLevel: "xhigh",
      fallbackModel: "openai/fallback",
      fallbackModelThinkingLevel: "high",
    });
  });

  it("rejects an invalid fallback thinking level", () => {
    expect(() => parseShadowMarkdown(
      "---\nid: invalid-fallback\nfallback_model_thinking_level: turbo\n---\nCheck once and report.",
      "C:/tmp/invalid-fallback.md",
    )).toThrow(/fallback_model_thinking_level/);
  });

  it("round-trips fallback model settings through serialization", () => {
    const source = serializeShadow({
      id: "resilient",
      fallbackModel: "openai/fallback",
      fallbackModelThinkingLevel: "high",
      prompt: "Retry when the primary model fails.",
    });
    expect(parseShadowMarkdown(source, "C:/tmp/resilient.md")).toMatchObject({
      fallbackModel: "openai/fallback",
      fallbackModelThinkingLevel: "high",
    });
  });
});
