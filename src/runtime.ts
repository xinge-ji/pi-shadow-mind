import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import { ConfigStore } from "./config.js";
import { EntityStore } from "./entity-store.js";
import { registerManagementTools } from "./management-tools.js";
import { ShadowRegistry } from "./registry.js";
import { ReportBatcher, formatReportBatch } from "./report-batcher.js";
import { createRandom } from "./random.js";
import { shouldEvaluateHeartbeat } from "./scheduler.js";
import { calculateTurnWeight } from "./turn-weight.js";
import { SessionLifetime } from "./session-lifetime.js";
import { ShadowDispatchCoordinator, type ShadowDispatchEnvironment } from "./shadow-dispatch-coordinator.js";
import type { ShadowDispatchRequest } from "./shadow-dispatcher.js";
import { ShadowRunner, resolveShadowTools, type ShadowRunResult } from "./shadow-runner.js";
import { waitForSettled } from "./shutdown-drain.js";
import type { RegistrySnapshot, RuntimeEvent, ShadowDefinition, ShadowReport } from "./types.js";

export class ShadowMindRuntime {
  private readonly agentDir = getAgentDir();
  private readonly configStore = new ConfigStore(this.agentDir);
  private readonly registry = new ShadowRegistry(this.agentDir);
  private readonly entityStore = new EntityStore(this.registry, this.configStore.configPath);
  private readonly runner: ShadowRunner;
  private readonly active = new Map<string, { shadow: ShadowDefinition; epoch: number }>();
  private readonly dispatchCoordinator: ShadowDispatchCoordinator;
  private readonly recentEvents: RuntimeEvent[] = [];
  private readonly batcher: ReportBatcher;
  private readonly sessionLifetime = new SessionLifetime();
  private bufferedReports: ShadowReport[] = [];
  private compactionGeneration = 0;
  private compactionInProgress = false;
  private epoch = 0;
  private modelCalls = 0;
  private paused = false;
  private panelVisible = false;
  private latestContext?: ExtensionContext;
  private diagnostics: string[] = [];
  private shadowCount = 0;
  private random: () => number = Math.random;

  constructor(private readonly pi: ExtensionAPI, runner = new ShadowRunner()) {
    this.runner = runner;
    this.dispatchCoordinator = new ShadowDispatchCoordinator({
      getCurrentEpoch: () => this.epoch,
      loadEnvironment: () => this.loadDispatchEnvironment(),
      launch: (request) => this.launchShadow(request),
      onError: (error) => this.record("forced-service-error", { error: error instanceof Error ? error.message : String(error) }),
    });
    this.batcher = new ReportBatcher(this.configStore.current.resultBatchWindowMs, (reports) => this.deliverReports(reports));
  }

  register(): void {
    registerManagementTools(this.pi, this.entityStore, () => this.configStore.current);
    this.registerEvents();
    this.registerUi();
  }

  private registerEvents(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      this.sessionLifetime.activate();
      this.latestContext = ctx;
      this.resetCompactionState();
      this.modelCalls = 0;
      this.dispatchCoordinator.clear();
      await this.configStore.initialize();
      this.random = createRandom(this.configStore.current.randomSeed);
      await this.registry.initialize();
      await this.refresh(ctx);
      this.record("session-config", { randomSeed: this.configStore.current.randomSeed ?? "random" });
      this.updateStatus(ctx);
    });

    this.pi.on("input", (event, ctx) => {
      this.latestContext = ctx;
      if (event.source === "extension") return;
      this.epoch += 1;
      this.dispatchCoordinator.clear();
      this.abortAll("new-user-input");
    });

    this.pi.on("after_provider_response", (_event, ctx) => {
      this.latestContext = ctx;
      this.modelCalls += 1;
    });

    this.pi.on("turn_end", async (event, ctx) => {
      this.latestContext = ctx;
      if (!shouldEvaluateHeartbeat(event.toolResults)) {
        this.record("heartbeat-skipped", { reason: "no-tool-activity", modelCalls: this.modelCalls });
        return;
      }
      await this.onHeartbeat(ctx, event.toolResults);
    });

    this.pi.on("session_before_compact", (event, ctx) => {
      this.latestContext = ctx;
      this.beginCompaction(event.signal);
    });

    this.pi.on("session_compact", (_event, ctx) => {
      this.latestContext = ctx;
      this.finishCompaction();
    });

    // Pi versions that expose the failure event can release buffered reports after
    // failed compaction too. Older versions still release on success or abort.
    const onCompactionFailure = this.pi.on.bind(this.pi) as (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) => void;
    onCompactionFailure("session_compact_failed", (_event, ctx) => {
      this.latestContext = ctx;
      this.finishCompaction();
    });

    this.pi.on("session_shutdown", async (event, ctx) => {
      this.latestContext = ctx;
      if (event.reason === "quit" && (ctx.mode === "print" || ctx.mode === "json")) {
        await this.drainHeadless(ctx);
      }
      this.epoch += 1;
      this.abortAll("session-shutdown");
      this.dispatchCoordinator.clear();
      this.resetCompactionState();
      ctx.ui.setStatus("shadow-mind", undefined);
      ctx.ui.setWidget("shadow-mind-panel", undefined);
      this.sessionLifetime.deactivate();
    });
  }

  private registerUi(): void {
    this.pi.registerCommand("shadow", {
      description: "Show Shadow Mind status, or toggle/pause/resume it",
      handler: async (args, ctx) => {
        this.latestContext = ctx;
        const command = args.trim().toLowerCase();
        if (command === "pause") {
          this.setPaused(true, ctx);
          return;
        }
        if (command === "resume") {
          this.setPaused(false, ctx);
          return;
        }
        if (command === "toggle") {
          this.setPaused(!this.paused, ctx);
          return;
        }
        if (command === "status") {
          await this.refresh(ctx);
          ctx.ui.notify(this.statusLines().join("\n"), this.diagnostics.length ? "warning" : "info");
        } else if (command === "hide") {
          this.panelVisible = false;
          ctx.ui.setWidget("shadow-mind-panel", undefined);
        } else {
          await this.refresh(ctx);
          this.panelVisible = !this.panelVisible;
        }
        this.updateStatus(ctx);
      },
    });

    this.pi.registerShortcut("alt+s", {
      description: "Pause or resume Shadow Mind",
      handler: (ctx) => {
        this.latestContext = ctx;
        this.setPaused(!this.paused, ctx);
      },
    });

    this.pi.registerMessageRenderer("shadow-report", (message, _options, theme) => {
      const content = typeof message.content === "string" ? message.content : "Shadow report";
      const prefix = theme.fg("accent", "🐙 shadow · ");
      return new Text(`${prefix}${content}`, 0, 0);
    });
  }

  private async onHeartbeat(ctx: ExtensionContext, toolResults: readonly { toolName?: string }[]): Promise<void> {
    const environment = await this.loadDispatchEnvironment(ctx);
    if (!environment) {
      this.record("heartbeat-skipped", { reason: this.paused ? "paused" : ctx.model ? "inactive" : "no-model", modelCalls: this.modelCalls });
      return;
    }
    const turnWeight = calculateTurnWeight(toolResults, environment.config.turnWeights);
    this.dispatchCoordinator.decideAndDispatch(environment, turnWeight, this.random, (decision) => {
      this.record("heartbeat", {
        modelCalls: this.modelCalls,
        turnWeight,
        roll: decision.heartbeatRoll,
        candidates: decision.candidates,
        shadowProgress: environment.shadows.map(({ id, name }) => ({
          id,
          name,
          progress: this.dispatchCoordinator.getProgress(id) ?? 0,
        })),
        activated: decision.activated.map(({ shadow, roll, forced }) => ({ id: shadow.id, ...(roll !== undefined ? { roll } : {}), forced })),
        ...(decision.modelFiltered.length ? { modelFiltered: decision.modelFiltered } : {}),
        ...(decision.runningExcluded.length ? { runningExcluded: decision.runningExcluded } : {}),
        ...(decision.cooldownExcluded.length ? { cooldownExcluded: decision.cooldownExcluded } : {}),
      });
    });
  }

  private launchShadow(request: ShadowDispatchRequest): void {
    const { ctx, shadow, mainModel, fullModelId, context, availableTools } = request;
    const runId = randomUUID();
    const runEpoch = this.epoch;
    const { tools, missing } = resolveShadowTools(shadow.tools, availableTools);
    this.active.set(runId, { shadow, epoch: runEpoch });
    this.record("run-start", {
      runId,
      shadowId: shadow.id,
      shadowName: shadow.name,
      model: shadow.runWithModel ?? this.configStore.current.defaultShadowModel ?? fullModelId,
      ...(missing.length ? { missingTools: missing } : {}),
    });
    this.updateStatus(ctx);
    void this.runner.run({
      shadow: structuredClone(shadow),
      config: structuredClone(this.configStore.current),
      epoch: runEpoch,
      runId,
      cwd: ctx.cwd,
      agentDir: this.agentDir,
      mainSystemPrompt: ctx.getSystemPrompt(),
      messages: context.messages as unknown as Record<string, unknown>[],
      mainModel,
      tools,
      resolveModel: (id) => resolveModel(ctx, id),
      modelAuthOk: (model) => ctx.modelRegistry.hasConfiguredAuth(model) || ctx.modelRegistry.isUsingOAuth(model),
      mainThinkingLevel: ctx.thinkingLevel,
      onReport: (report) => this.acceptReport(report),
    }).then(
      (result) => this.finishShadow(runId, shadow, result),
      (error) => this.finishShadow(runId, shadow, undefined, error),
    );
  }

  private finishShadow(runId: string, shadow: ShadowDefinition, result?: ShadowRunResult, error?: unknown): void {
    const activeRun = this.active.get(runId);
    this.active.delete(runId);
    if (result) {
      this.record("run-end", { runId, shadowId: shadow.id, shadowName: shadow.name, ...result });
    } else {
      this.record("run-end", {
        runId,
        shadowId: shadow.id,
        shadowName: shadow.name,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (activeRun) this.dispatchCoordinator.onRunFinished(shadow.id, activeRun.epoch);
    if (this.latestContext && this.sessionLifetime.isActive) this.updateStatus(this.latestContext);
  }

  private async loadDispatchEnvironment(ctx = this.latestContext, reload = true): Promise<ShadowDispatchEnvironment | undefined> {
    if (!ctx) return undefined;
    const snapshot = reload ? await this.refresh(ctx) : await this.registry.load();
    if (this.paused || !ctx.model || !this.sessionLifetime.isActive) return undefined;
    return {
      epoch: this.epoch,
      ctx,
      config: structuredClone(this.configStore.current),
      shadows: snapshot.shadows,
      active: this.active,
      mainModel: ctx.model,
      fullModelId: `${ctx.model.provider}/${ctx.model.id}`,
      getAvailableTools: () => new Set(this.pi.getAllTools().map((tool) => tool.name)),
    };
  }

  private acceptReport(report: ShadowReport): void {
    if (report.epoch !== this.epoch) return;
    this.batcher.add(report);
  }

  private deliverReports(reports: ShadowReport[]): void {
    const current = reports.filter((report) => report.epoch === this.epoch);
    if (!current.length) return;
    if (this.compactionInProgress) {
      this.bufferedReports.push(...current);
      return;
    }

    const content = formatReportBatch(current);
    this.record("report-delivered", { runIds: current.map((report) => report.runId), count: current.length });
    const idle = this.latestContext?.isIdle() ?? true;
    this.sessionLifetime.run(() => {
      this.pi.sendMessage({
        customType: "shadow-report",
        content,
        display: true,
        details: { reports: current.map(({ shadowId, runId }) => ({ shadowId, runId })) },
      }, { triggerTurn: true, deliverAs: idle ? "followUp" : "steer" });
    });
  }

  private beginCompaction(signal: AbortSignal): void {
    const generation = ++this.compactionGeneration;
    this.compactionInProgress = true;
    signal.addEventListener("abort", () => {
      if (generation === this.compactionGeneration) this.finishCompaction();
    }, { once: true });
  }

  private finishCompaction(): void {
    if (!this.compactionInProgress) return;
    const generation = this.compactionGeneration;
    this.compactionInProgress = false;
    setImmediate(() => {
      if (generation !== this.compactionGeneration || this.compactionInProgress) return;
      const reports = this.bufferedReports;
      this.bufferedReports = [];
      this.deliverReports(reports);
    });
  }

  private resetCompactionState(): void {
    this.compactionGeneration += 1;
    this.compactionInProgress = false;
    this.bufferedReports = [];
  }

  private async refresh(ctx: ExtensionContext): Promise<RegistrySnapshot> {
    const config = await this.configStore.reload();
    const registry = await this.registry.load();
    this.batcher.setWindow(config.config.resultBatchWindowMs);
    this.shadowCount = registry.shadows.length;
    this.diagnostics = [
      ...(config.error ? [`config: ${config.error}`] : []),
      ...registry.diagnostics.map((item) => `${item.filePath}: ${item.message}`),
    ];
    this.updateStatus(ctx);
    return registry;
  }

  private abortAll(reason: string): void {
    this.runner.abortAll();
    this.batcher.clear();
    this.record("runs-aborted", { reason, count: this.active.size });
  }

  private async drainHeadless(ctx: ExtensionContext): Promise<void> {
    if (this.active.size === 0 && !this.batcher.hasPending) return;
    const timeoutMs = this.configStore.current.headlessDrainTimeoutSeconds * 1000;
    this.record("headless-drain-start", { timeoutMs, active: this.active.size });
    const result = await waitForSettled({
      timeoutMs,
      isSettled: () => this.active.size === 0
        && !this.batcher.hasPending
        && ctx.isIdle()
        && !ctx.hasPendingMessages(),
    });
    this.record(result.settled ? "headless-drain-complete" : "headless-drain-timeout", {
      durationMs: result.durationMs,
      active: this.active.size,
    });
    if (!result.settled) this.abortAll("headless-drain-timeout");
  }

  private record(kind: string, data?: Record<string, unknown>): void {
    const event: RuntimeEvent = { at: new Date().toISOString(), kind, epoch: this.epoch, data };
    this.recentEvents.push(event);
    if (this.recentEvents.length > 20) this.recentEvents.shift();
    this.sessionLifetime.run(() => this.pi.appendEntry("shadow-mind-event", event));
  }

  private setPaused(paused: boolean, ctx: ExtensionContext): void {
    this.paused = paused;
    if (paused) this.abortAll("paused");
    ctx.ui.notify(paused ? "Shadow Mind paused" : "Shadow Mind resumed", "info");
    this.updateStatus(ctx);
  }

  private updateStatus(ctx: ExtensionContext): void {
    this.sessionLifetime.run(() => {
      const warning = this.diagnostics.length || this.hasRecentRunErrors() ? " !" : "";
      ctx.ui.setStatus("shadow-mind", this.paused ? `🐙 Paused${warning}` : `🐙 ${this.active.size}${warning}`);
      if (this.panelVisible) ctx.ui.setWidget("shadow-mind-panel", this.statusLines(), { placement: "aboveEditor" });
    });
  }

  private hasRecentRunErrors(): boolean {
    return this.recentEvents.slice(-3).some((event) => event.kind === "run-end" && (event.data?.reason === "error" || event.data?.reason === "timeout"));
  }

  private statusLines(): string[] {
    const config = this.configStore.current;
    return [
      `🐙 Shadow Mind · ${this.paused ? "paused" : "active"} · running ${this.active.size}/${config.maxParallelShadows}`,
      `heartbeat ${formatNumber(config.heartbeatProbability)} · batch ${config.resultBatchWindowMs}ms · timeout ${config.defaultShadowTimeoutSeconds}s · drain ${config.headlessDrainTimeoutSeconds}s · thinking ${config.defaultThinkingLevel}`,
      `definitions: ${this.shadowCount} valid · ${this.diagnostics.length} invalid`,
      ...this.recentEvents.slice(-5).map((event) => {
        const failed = event.kind === "run-end" && (event.data?.reason === "error" || event.data?.reason === "timeout");
        const errorDetail = failed ? ` ${event.data?.error ?? event.data?.reason}` : "";
        const time = new Date(event.at).toLocaleTimeString("en-GB", { hour12: false });
        if (event.kind === "heartbeat") {
          const progress = formatShadowProgress(event.data?.shadowProgress);
          return `${time} heartbeat${progress ? ` [${progress}]` : ""}`;
        }
        const shadowName = typeof event.data?.shadowName === "string" ? `: ${event.data.shadowName}` : "";
        return `${time} ${event.kind}${shadowName}${errorDetail}`;
      }),
      "Shortcut: Alt+S toggle · Commands: /shadow toggle | pause | resume | status | hide",
    ];
  }
}

function resolveModel(ctx: ExtensionContext, fullId: string) {
  const separator = fullId.indexOf("/");
  if (separator <= 0 || separator === fullId.length - 1) return undefined;
  return ctx.modelRegistry.find(fullId.slice(0, separator), fullId.slice(separator + 1));
}

function formatNumber(value: number, digits = 3): string {
  return Number(value.toFixed(digits)).toString();
}

function formatShadowProgress(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    if (typeof data.name !== "string" || typeof data.progress !== "number" || !Number.isFinite(data.progress)) return [];
    return [`${data.name}: ${formatNumber(data.progress, 2)}`];
  });
  return entries.length ? entries.join("; ") : undefined;
}
