import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideHeartbeat, selectForcedPending } from "./scheduler.js";
import { dispatchShadows, type ShadowDispatchRequest } from "./shadow-dispatcher.js";
import { ShadowSchedule } from "./shadow-schedule.js";
import type { HeartbeatDecision, ShadowConfig, ShadowDefinition } from "./types.js";

export interface ShadowDispatchEnvironment {
  epoch: number;
  ctx: ExtensionContext;
  config: ShadowConfig;
  shadows: readonly ShadowDefinition[];
  active: ReadonlyMap<string, { shadow: ShadowDefinition; epoch: number }>;
  mainModel: Model<any>;
  fullModelId: string;
  getAvailableTools(): Set<string>;
}

export interface ShadowDispatchCoordinatorOptions {
  getCurrentEpoch(): number;
  loadEnvironment(): Promise<ShadowDispatchEnvironment | undefined>;
  launch(request: ShadowDispatchRequest): void;
  onError?(error: unknown): void;
}

/**
 * Owns Shadow selection and slot-release dispatch for the current Main session.
 * Runtime only supplies the current environment and handles the actual runner.
 */
export class ShadowDispatchCoordinator {
  private readonly schedule = new ShadowSchedule();
  private forcedServiceQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly options: ShadowDispatchCoordinatorOptions) {}

  clear(): void {
    this.schedule.clear();
    this.generation += 1;
    this.forcedServiceQueue = Promise.resolve();
  }

  decideAndDispatch(
    environment: ShadowDispatchEnvironment,
    turnWeight: number,
    random: () => number,
    beforeDispatch?: (decision: HeartbeatDecision) => void,
  ): HeartbeatDecision {
    const activeShadowIds = new Set([...environment.active.values()].map(({ shadow }) => shadow.id));
    this.schedule.sync(environment.shadows);
    this.schedule.advance(environment.shadows, activeShadowIds, turnWeight);
    const decision = decideHeartbeat({
      heartbeatProbability: environment.config.heartbeatProbability,
      availableSlots: Math.max(0, environment.config.maxParallelShadows - environment.active.size),
      shadows: environment.shadows,
      activeShadowIds,
      mainModelId: environment.fullModelId,
      scheduleStates: this.schedule.snapshot(),
      random,
    });
    beforeDispatch?.(decision);
    this.dispatch(environment, decision.activated.map(({ shadow }) => shadow));
    return decision;
  }

  getProgress(shadowId: string): number | undefined {
    return this.schedule.get(shadowId)?.progressSinceEnd;
  }

  onRunFinished(shadowId: string, runEpoch: number): void {
    if (runEpoch !== this.options.getCurrentEpoch()) return;
    this.schedule.finish(shadowId);
    this.queueForcedPending(runEpoch, this.generation);
  }

  private dispatch(environment: ShadowDispatchEnvironment, shadows: readonly ShadowDefinition[]): void {
    dispatchShadows({
      ctx: environment.ctx,
      shadows,
      mainModel: environment.mainModel,
      fullModelId: environment.fullModelId,
      getAvailableTools: environment.getAvailableTools,
      launch: (request) => {
        this.schedule.markStarted(request.shadow.id);
        this.options.launch(request);
      },
    });
  }

  private queueForcedPending(epoch: number, generation: number): void {
    this.forcedServiceQueue = this.forcedServiceQueue
      .then(async () => {
        if (generation !== this.generation || epoch !== this.options.getCurrentEpoch()) return;
        const environment = await this.options.loadEnvironment();
        if (generation !== this.generation || !environment || environment.epoch !== epoch || epoch !== this.options.getCurrentEpoch()) return;
        const activeShadowIds = new Set([...environment.active.values()].map(({ shadow }) => shadow.id));
        this.schedule.sync(environment.shadows);
        const forced = selectForcedPending({
          availableSlots: Math.max(0, environment.config.maxParallelShadows - environment.active.size),
          shadows: environment.shadows,
          activeShadowIds,
          mainModelId: environment.fullModelId,
          scheduleStates: this.schedule.snapshot(),
        });
        this.dispatch(environment, forced);
      })
      .catch((error) => this.options.onError?.(error));
  }
}
