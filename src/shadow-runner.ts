import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { Type } from "typebox";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ShadowConfig, ShadowDefinition, ShadowReport } from "./types.js";
import { DEFAULT_READ_TOOLS } from "./types.js";

/**
 * Resolve the final tool allowlist for a Shadow run against the main session's
 * tool registry, per the design contract:
 *
 * - the final set is `readOnlyTools defaults + whitelist + report_to_main`;
 * - names that do not exist in the main session are dropped (ignored) and
 *   returned as `missing`, while the rest are provided normally;
 * - the built-in `report_to_main` is always kept.
 */
export function resolveShadowTools(
  whitelist: readonly string[],
  available: ReadonlySet<string>,
  defaults: readonly string[] = DEFAULT_READ_TOOLS,
): { tools: string[]; missing: string[] } {
  const builtin = new Set(["report_to_main"]);
  const requested = [...new Set([...defaults, ...whitelist, ...builtin])];
  const tools: string[] = [];
  const missing: string[] = [];
  for (const name of requested) {
    (builtin.has(name) || available.has(name) ? tools : missing).push(name);
  }
  return { tools, missing };
}

import { buildShadowRequest, buildShadowSystemPrompt } from "./protocol.js";
import { serializeTrajectory } from "./trajectory.js";

const SELF_PATH = normalize(resolve(fileURLToPath(import.meta.url)));

export interface ShadowRunRequest {
  shadow: ShadowDefinition;
  config: ShadowConfig;
  epoch: number;
  runId: string;
  cwd: string;
  agentDir: string;
  mainSystemPrompt: string;
  messages: readonly Record<string, unknown>[];
  mainModel: Model<any>;
  /** Final tool allowlist, already resolved against the main session registry. */
  tools: string[];
  resolveModel(fullModelId: string): Model<any> | undefined;
  /** Optional auth check for explicitly configured shadow models (runtime supplies it). */
  modelAuthOk?(model: Model<any>): boolean;
  /** The main session's effective thinking level at activation, used as the final fallback. */
  mainThinkingLevel?: ThinkingLevel;
  onReport(report: ShadowReport): void;
}

export interface ToolStat {
  tool: string;
  calls: number;
  failures: number;
}

export interface ShadowRunResult {
  reason: "report" | "silent" | "timeout" | "aborted" | "error";
  error?: string;
  durationMs: number;
  toolNames: string[];
  /** Requested tools that did not materialize in the shadow session. */
  missingTools: string[];
  toolCalls: number;
  toolFailures: number;
  /** Per-tool usage summary (called tools only). */
  toolStats: ToolStat[];
  /** The thinking level actually used for this run (after fallback resolution). */
  thinkingLevel?: string;
  sessionFile?: string;
}

type ShadowSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface RunState {
  reported: boolean;
  session?: ShadowSession;
}

interface RunBudget {
  timeoutMs: number;
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface RunCandidate {
  resolveModel(): Model<any>;
  thinkingLevel?: ThinkingLevel;
}

interface PreparedAttempt {
  session: ShadowSession;
  missingTools: string[];
  baseMessageCount: number;
  thinkingLevel: string;
  abortHandler?: () => void;
}

interface AttemptContext {
  request: ShadowRunRequest;
  controller: AbortController;
  trajectory: string;
  candidate: RunCandidate;
  budget: RunBudget;
  attemptIndex: number;
  started: number;
  state: RunState;
  model?: Model<any>;
  sessionManager?: SessionManager;
  prepared?: PreparedAttempt;
}

function runReason(timedOut: boolean, reported: boolean, aborted: boolean, failed = false): ShadowRunResult["reason"] {
  if (timedOut) return "timeout";
  if (reported) return "report";
  if (aborted) return "aborted";
  return failed ? "error" : "silent";
}

/** Unify the three run() return paths so result shape changes touch one place. */
export function buildRunResult(options: {
  reason: ShadowRunResult["reason"];
  error?: string;
  durationMs: number;
  session?: ShadowSession;
  /** Message count before the shadow's own run started; only later tool results are counted. */
  baseMessageCount: number;
  missingTools: string[];
  thinkingLevel?: string;
}): ShadowRunResult {
  const { reason, error, durationMs, session, baseMessageCount, missingTools, thinkingLevel } = options;
  const ownMessages = session ? session.messages.slice(baseMessageCount) : [];
  const metrics = toolMetrics(ownMessages);
  return {
    reason,
    ...(error !== undefined ? { error } : {}),
    durationMs,
    toolNames: session?.getActiveToolNames() ?? [],
    missingTools,
    ...metrics,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    sessionFile: session?.sessionFile,
  };
}

export class ShadowRunner {
  private readonly controllers = new Map<string, { controller: AbortController; session?: ShadowSession }>();

  async run(request: ShadowRunRequest): Promise<ShadowRunResult> {
    const started = Date.now();
    const controller = new AbortController();
    const budget: RunBudget = {
      timeoutMs: (request.shadow.timeoutSeconds ?? request.config.defaultShadowTimeoutSeconds) * 1000,
      timedOut: false,
    };
    this.controllers.set(request.runId, { controller });
    let finalReason: ShadowRunResult["reason"] = "error";
    try {
      const trajectory = serializeTrajectory(request.messages);
      const candidates: RunCandidate[] = [{
        resolveModel: () => resolveRunModel(request),
        thinkingLevel: request.shadow.thinkingLevel,
      }];
      if (request.shadow.fallbackModel) {
        candidates.push({
          resolveModel: () => resolveFallbackModel(request),
          thinkingLevel: request.shadow.fallbackModelThinkingLevel ?? request.shadow.thinkingLevel,
        });
      }

      let result: ShadowRunResult | undefined;
      for (let index = 0; index < candidates.length; index += 1) {
        result = await this.runAttempt({
          request,
          controller,
          trajectory,
          candidate: candidates[index],
          budget,
          attemptIndex: index,
          started: Date.now(),
          state: { reported: false },
        });
        if (result.reason !== "error" || index === candidates.length - 1 || controller.signal.aborted) break;
      }
      if (!result) throw new Error("shadow run produced no result");
      finalReason = result.reason;
      return { ...result, durationMs: Date.now() - started };
    } catch (error) {
      finalReason = budget.timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "error";
      return buildRunResult({
        reason: finalReason,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        baseMessageCount: 0,
        missingTools: [],
      });
    } finally {
      if (budget.timer) clearTimeout(budget.timer);
      this.controllers.delete(request.runId);
    }
  }

  private async runAttempt(context: AttemptContext): Promise<ShadowRunResult> {
    const { request, controller, trajectory, candidate, budget } = context;
    let finalReason: ShadowRunResult["reason"] = "error";
    try {
      if (controller.signal.aborted) {
        finalReason = budget.timedOut ? "timeout" : "aborted";
        return buildRunResult({ reason: finalReason, durationMs: Date.now() - context.started, baseMessageCount: 0, missingTools: [] });
      }
      const model = candidate.resolveModel();
      context.model = model;
      assertShadowModelAuth(model, request);
      assertTrajectoryFits(model, [trajectory]);
      context.sessionManager = await createShadowSessionManager(request, context.attemptIndex, model);
      context.prepared = await this.prepareAttempt(context);
      if (controller.signal.aborted) {
        finalReason = budget.timedOut ? "timeout" : "aborted";
        return buildRunResult({ reason: finalReason, durationMs: Date.now() - context.started, session: context.prepared.session, baseMessageCount: context.prepared.baseMessageCount, missingTools: context.prepared.missingTools, thinkingLevel: context.prepared.thinkingLevel });
      }
      const result = await this.executeAttempt(context);
      finalReason = result.reason;
      return result;
    } catch (error) {
      finalReason = runReason(budget.timedOut, context.state.reported, controller.signal.aborted, true);
      return buildRunResult({
        reason: finalReason,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - context.started,
        session: context.prepared?.session ?? context.state.session,
        baseMessageCount: context.prepared?.baseMessageCount ?? 0,
        missingTools: context.prepared?.missingTools ?? [],
        thinkingLevel: context.prepared?.thinkingLevel,
      });
    } finally {
      this.finalizeAttempt(context, finalReason);
    }
  }

  private async prepareAttempt(context: AttemptContext): Promise<PreparedAttempt> {
    const { request, controller, candidate, state, sessionManager, model } = context;
    if (!model || !sessionManager) throw new Error("shadow attempt was not initialized");
    const boot = await this.bootstrapSession(request, model, controller, state, sessionManager, candidate.thinkingLevel);
    state.session = boot.session;
    const prepared: PreparedAttempt = {
      session: boot.session,
      missingTools: boot.missingTools,
      baseMessageCount: boot.session.messages.length,
      thinkingLevel: boot.thinkingLevel,
    };
    this.controllers.set(request.runId, { controller, session: boot.session });
    return prepared;
  }

  private async executeAttempt(context: AttemptContext): Promise<ShadowRunResult> {
    const { request, controller, trajectory, budget, state, started } = context;
    const attempt = context.prepared;
    if (!attempt) throw new Error("shadow attempt was not prepared");
    if (controller.signal.aborted) {
      const reason = budget.timedOut ? "timeout" : "aborted";
      return buildRunResult({ reason, durationMs: Date.now() - started, session: attempt.session, baseMessageCount: attempt.baseMessageCount, missingTools: attempt.missingTools, thinkingLevel: attempt.thinkingLevel });
    }
    if (!budget.timer) {
      budget.timer = setTimeout(() => {
        budget.timedOut = true;
        controller.abort();
        void this.controllers.get(request.runId)?.session?.abort();
      }, budget.timeoutMs);
    }
    attempt.abortHandler = () => void attempt.session.abort();
    controller.signal.addEventListener("abort", attempt.abortHandler, { once: true });
    await attempt.session.prompt(buildShadowRequest(trajectory, request.shadow));
    await attempt.session.waitForIdle();
    const error = findAssistantRunError(attempt.session.messages.slice(attempt.baseMessageCount));
    const reason = runReason(budget.timedOut, state.reported, controller.signal.aborted, error !== undefined);
    return buildRunResult({ reason, ...(error !== undefined ? { error } : {}), durationMs: Date.now() - started, session: attempt.session, baseMessageCount: attempt.baseMessageCount, missingTools: attempt.missingTools, thinkingLevel: attempt.thinkingLevel });
  }

  private finalizeAttempt(context: AttemptContext, reason: ShadowRunResult["reason"]): void {
    const { request, controller, state, sessionManager, model, prepared, attemptIndex, started } = context;
    if (prepared?.abortHandler) controller.signal.removeEventListener("abort", prepared.abortHandler);
    sessionManager?.appendCustomEntry("shadow-mind-run-end", {
      runId: request.runId,
      epoch: request.epoch,
      shadowId: request.shadow.id,
      attempt: attemptIndex + 1,
      reason,
      durationMs: Date.now() - started,
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
    });
    state.session?.dispose();
    const current = this.controllers.get(request.runId);
    if (current?.controller === controller && current.session === state.session) {
      this.controllers.set(request.runId, { controller });
    }
  }

  /** Build the shadow AgentSession (loader, report tool, allowlist) and validate it. */
  private async bootstrapSession(
    request: ShadowRunRequest,
    model: Model<any>,
    controller: AbortController,
    state: RunState,
    sessionManager: SessionManager,
    thinkingLevelOverride?: ThinkingLevel,
  ): Promise<{ session: ShadowSession; missingTools: string[]; thinkingLevel: string }> {
    const thinkingLevel = resolveRunThinkingLevel(model, request, thinkingLevelOverride);
    const settingsManager = SettingsManager.create(request.cwd, request.agentDir);
    settingsManager.applyOverrides({
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 15000,
        provider: { maxRetries: 0, maxRetryDelayMs: 0 },
      },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: request.agentDir,
      settingsManager,
      systemPrompt: buildShadowSystemPrompt(request.mainSystemPrompt),
      // The inherited main system prompt already embeds APPEND_SYSTEM.md,
      // AGENTS.md and skills; keep the loader from re-discovering them so the
      // shadow context stays a strict subset (no duplication).
      appendSystemPrompt: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) =>
          !isSelfExtension(extension.resolvedPath) && !isPiRetryExtension(extension.resolvedPath)),
      }),
    });
    const reportTool = createReportTool((content) => {
      if (state.reported || controller.signal.aborted) return;
      state.reported = true;
      request.onReport({
        shadowId: request.shadow.id,
        shadowName: request.shadow.name,
        content,
        epoch: request.epoch,
        runId: request.runId,
      });
      queueMicrotask(() => void state.session?.abort());
    });
    const tools = [...new Set(request.tools)];
    const created = await createAgentSession({
      cwd: request.cwd,
      agentDir: request.agentDir,
      model,
      thinkingLevel,
      tools,
      customTools: [reportTool],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const missingTools = tools.filter((name) => !created.session.getActiveToolNames().includes(name));
    return { session: created.session, missingTools, thinkingLevel };
  }

  abort(runId: string): void {
    this.controllers.get(runId)?.controller.abort();
  }

  abortAll(): void {
    for (const { controller } of this.controllers.values()) controller.abort();
  }
}

export function toolMetrics(messages: readonly { role?: string; toolName?: string; isError?: boolean }[]): { toolCalls: number; toolFailures: number; toolStats: ToolStat[] } {
  const stats = new Map<string, ToolStat>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const tool = message.toolName ?? "unknown";
    const entry = stats.get(tool) ?? { tool, calls: 0, failures: 0 };
    entry.calls += 1;
    if (message.isError) entry.failures += 1;
    stats.set(tool, entry);
  }
  const toolStats = [...stats.values()].sort((a, b) => b.calls - a.calls);
  return {
    toolCalls: toolStats.reduce((sum, stat) => sum + stat.calls, 0),
    toolFailures: toolStats.reduce((sum, stat) => sum + stat.failures, 0),
    toolStats,
  };
}

function findAssistantRunError(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const assistant = message as { stopReason?: unknown; errorMessage?: unknown };
    if (assistant.stopReason !== "error") return undefined;
    return typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
      ? assistant.errorMessage
      : "shadow model returned an error";
  }
  return undefined;
}

function createReportTool(onReport: (content: string) => void): ToolDefinition {
  return {
    name: "report_to_main",
    label: "Report to Main",
    description: "Report a concrete finding or completed result to the main agent and immediately end this Shadow Mind run.",
    promptSnippet: "Report a useful result to the main agent and end this run",
    parameters: Type.Object({ content: Type.String({ description: "The complete report for the main agent" }) }),
    async execute(_toolCallId, params) {
      const content = (params as { content: string }).content;
      onReport(content);
      return { content: [{ type: "text", text: "Report delivered." }], details: {}, terminate: true };
    },
  };
}

async function createShadowSessionManager(request: ShadowRunRequest, attemptIndex: number, model: Model<any>): Promise<SessionManager> {
  if (!request.shadow.debug) return SessionManager.inMemory(request.cwd);
  const directory = join(request.agentDir, "shadow-minds", "logs", request.shadow.id);
  await mkdir(directory, { recursive: true });
  const manager = SessionManager.create(request.cwd, directory);
  manager.appendCustomEntry("shadow-mind-run", {
    runId: request.runId,
    epoch: request.epoch,
    shadowId: request.shadow.id,
    attempt: attemptIndex + 1,
    model: `${model.provider}/${model.id}`,
  });
  return manager;
}

function resolveRunModel(request: ShadowRunRequest): Model<any> {
  const fullId = request.shadow.runWithModel ?? request.config.defaultShadowModel;
  if (!fullId) return request.mainModel;
  return resolveConfiguredModel(fullId, request);
}

function resolveFallbackModel(request: ShadowRunRequest): Model<any> {
  const fullId = request.shadow.fallbackModel;
  if (!fullId) throw new Error("fallback model is not configured");
  return resolveConfiguredModel(fullId, request);
}

function resolveConfiguredModel(fullId: string, request: ShadowRunRequest): Model<any> {
  const model = request.resolveModel(fullId);
  if (!model) throw new Error(`shadow model not found: ${fullId}`);
  return model;
}

function assertShadowModelAuth(model: Model<any>, request: ShadowRunRequest): void {
  if (request.modelAuthOk && !request.modelAuthOk(model)) {
    throw new Error(`shadow model ${model.provider}/${model.id} has no configured auth`);
  }
}

/**
 * Resolve the thinking level for this run: shadow config → plugin default →
 * the main session's effective level. The first candidate the model supports
 * (per its thinkingLevelMap; null marks unsupported, a missing key or map means
 * provider default, i.e. supported) wins. Fails only when none are supported.
 */
export function resolveRunThinkingLevel(model: Model<any>, request: ShadowRunRequest, thinkingLevelOverride = request.shadow.thinkingLevel): ThinkingLevel {
  const candidates = [thinkingLevelOverride, request.config.defaultThinkingLevel, request.mainThinkingLevel]
    .filter((level): level is ThinkingLevel => level !== undefined);
  for (const level of candidates) {
    if (model.thinkingLevelMap?.[level] !== null) return level;
  }
  throw new Error(`no supported thinking level for ${model.provider}/${model.id} (tried: ${candidates.join(", ") || "none"})`);
}

function assertTrajectoryFits(model: Model<any>, messages: readonly unknown[]): void {
  const chars = messages.reduce<number>((sum, message) => sum + (JSON.stringify(message)?.length ?? 0), 0);
  const estimated = Math.ceil(chars / 2);
  if (estimated > model.contextWindow) {
    throw new Error(`trajectory ~${estimated} tokens exceeds ${model.provider}/${model.id} context window (${model.contextWindow})`);
  }
}

function isSelfExtension(candidate: string): boolean {
  const normalized = normalize(resolve(candidate));
  if (normalized === SELF_PATH) return true;
  const sourceDirectory = normalize(resolve(dirname(SELF_PATH)));
  return dirname(normalized) === sourceDirectory && (basename(normalized) === "index.ts" || basename(normalized) === "index.js");
}

function isPiRetryExtension(candidate: string): boolean {
  return normalize(resolve(candidate)).toLowerCase().split(/[\\/]/).includes("pi-retry");
}
