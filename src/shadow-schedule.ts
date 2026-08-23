import type { ShadowDefinition, ShadowScheduleState } from "./types.js";

const INITIAL_STATE: ShadowScheduleState = { progressSinceEnd: 0, forcedPending: false, disposition: "normal" };

/**
 * Owns per-Shadow scheduling state for the current Main session. Definitions
 * remain immutable registry data; this state is deliberately in-memory only.
 */
export class ShadowSchedule {
  private readonly states = new Map<string, ShadowScheduleState>();

  clear(): void {
    this.states.clear();
  }

  /** Drop state for removed definitions or definitions without scheduling policy. */
  sync(shadows: readonly ShadowDefinition[]): void {
    const activeIds = new Set(shadows.map((shadow) => shadow.id));
    for (const id of this.states.keys()) {
      if (!activeIds.has(id)) this.states.delete(id);
    }
    for (const shadow of shadows) {
      if (!shadow.enabled || !hasSchedulePolicy(shadow)) {
        this.states.delete(shadow.id);
        continue;
      }
      const state = this.states.get(shadow.id);
      if (state) this.states.set(shadow.id, refreshState(shadow, state));
    }
  }

  /** Advance one eligible Main turn for every non-running configured Shadow. */
  advance(shadows: readonly ShadowDefinition[], activeShadowIds: ReadonlySet<string>, progress: number): void {
    for (const shadow of shadows) {
      if (!shadow.enabled || !hasSchedulePolicy(shadow) || activeShadowIds.has(shadow.id)) continue;
      const previous = this.states.get(shadow.id) ?? INITIAL_STATE;
      this.states.set(shadow.id, refreshState(shadow, {
        ...previous,
        progressSinceEnd: previous.progressSinceEnd + progress,
      }));
    }
  }

  /** Reset the interval after a Shadow run has ended. */
  finish(shadowId: string): void {
    this.states.delete(shadowId);
  }

  /** Clear a pending-forced marker when the Shadow is actually launched. */
  markStarted(shadowId: string): void {
    const state = this.states.get(shadowId);
    if (!state) return;
    this.states.set(shadowId, { ...state, forcedPending: false, disposition: "normal" });
  }

  get(shadowId: string): ShadowScheduleState | undefined {
    return this.states.get(shadowId);
  }

  snapshot(): ReadonlyMap<string, ShadowScheduleState> {
    return this.states;
  }
}

function hasSchedulePolicy(shadow: ShadowDefinition): boolean {
  return shadow.minRoundsAfterEnd !== undefined || shadow.maxRoundsAfterEnd !== undefined;
}

function refreshState(shadow: ShadowDefinition, state: ShadowScheduleState): ShadowScheduleState {
  const forcedPending = shadow.maxRoundsAfterEnd !== undefined
    && (state.forcedPending || state.progressSinceEnd >= shadow.maxRoundsAfterEnd);
  const disposition = forcedPending
    ? "forced"
    : shadow.minRoundsAfterEnd !== undefined
      && shadow.minRoundsAfterEnd > 0
      && state.progressSinceEnd <= shadow.minRoundsAfterEnd
      ? "cooldown"
      : "normal";
  return { ...state, forcedPending, disposition };
}
