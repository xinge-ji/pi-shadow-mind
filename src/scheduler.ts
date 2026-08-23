import type { HeartbeatDecision, ShadowDefinition, ShadowScheduleState } from "./types.js";

/**
 * Pure conversation turns do not create useful new evidence for repository-oriented
 * Shadows. Requiring at least one completed Main tool call also prevents a silent
 * Shadow report response from recursively scheduling more Shadows.
 */
export function shouldEvaluateHeartbeat(toolResults: readonly unknown[]): boolean {
  return toolResults.length > 0;
}

export function decideHeartbeat(options: {
  heartbeatProbability: number;
  availableSlots: number;
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  scheduleStates?: ReadonlyMap<string, ShadowScheduleState>;
  random?: () => number;
}): HeartbeatDecision {
  const random = options.random ?? Math.random;
  const heartbeatRoll = random();
  const classification = classifyShadows(options);
  const forcedCandidates = classification.eligible.filter(({ forced }) => forced);
  const heartbeatHit = heartbeatRoll < options.heartbeatProbability;
  const base = {
    heartbeatRoll,
    modelFiltered: classification.modelFiltered,
    runningExcluded: classification.runningExcluded,
    cooldownExcluded: classification.cooldownExcluded,
  };

  if (options.availableSlots <= 0) {
    return {
      ...base,
      activated: [],
      candidates: forcedCandidates.map(({ shadow }) => ({ shadowId: shadow.id, selected: false, forced: true })),
    };
  }
  if (forcedCandidates.length === 0 && !heartbeatHit) {
    return { ...base, activated: [], candidates: [] };
  }

  const forcedSelected = forcedCandidates.slice(0, options.availableSlots);
  const selectedIds = new Set(forcedSelected.map(({ shadow }) => shadow.id));
  const remainingSlots = Math.max(0, options.availableSlots - forcedSelected.length);
  const normalRolls = heartbeatHit && remainingSlots > 0
    ? classification.eligible
      .filter(({ forced }) => !forced)
      .map(({ shadow }) => ({ shadow, roll: random() }))
    : [];
  const normalHits = normalRolls.filter(({ shadow, roll }) => roll < shadow.activationProbability);
  const normalSelected = sample(normalHits, Math.min(remainingSlots, normalHits.length), random);
  for (const { shadow } of normalSelected) selectedIds.add(shadow.id);

  const candidates = classification.eligible.flatMap(({ shadow, forced }) => {
    if (forced) return [{ shadowId: shadow.id, selected: selectedIds.has(shadow.id), forced: true }];
    const rolled = normalRolls.find(({ shadow: candidate }) => candidate.id === shadow.id);
    return rolled ? [{ shadowId: shadow.id, roll: rolled.roll, selected: selectedIds.has(shadow.id), forced: false }] : [];
  });
  return {
    ...base,
    activated: [
      ...forcedSelected.map(({ shadow }) => ({ shadow, forced: true })),
      ...normalSelected.map(({ shadow, roll }) => ({ shadow, roll, forced: false })),
    ],
    candidates,
  };
}

/** Select due/pending Shadows when a slot is released, without probability rolls. */
export function selectForcedPending(options: {
  availableSlots: number;
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  scheduleStates?: ReadonlyMap<string, ShadowScheduleState>;
}): ShadowDefinition[] {
  if (options.availableSlots <= 0) return [];
  const forced = classifyShadows(options).eligible.filter(({ forced }) => forced);
  return forced.slice(0, options.availableSlots).map(({ shadow }) => shadow);
}

interface ClassifiedShadow {
  shadow: ShadowDefinition;
  forced: boolean;
}

function classifyShadows(options: {
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  scheduleStates?: ReadonlyMap<string, ShadowScheduleState>;
}): {
  eligible: ClassifiedShadow[];
  modelFiltered: string[];
  runningExcluded: string[];
  cooldownExcluded: string[];
} {
  const modelFiltered: string[] = [];
  const runningExcluded: string[] = [];
  const cooldownExcluded: string[] = [];
  const eligible: ClassifiedShadow[] = [];

  for (const shadow of options.shadows) {
    if (!shadow.enabled) continue;
    if (options.activeShadowIds.has(shadow.id)) {
      runningExcluded.push(shadow.id);
      continue;
    }
    if (!matchesModel(shadow, options.mainModelId)) {
      modelFiltered.push(shadow.id);
      continue;
    }
    const disposition = options.scheduleStates?.get(shadow.id)?.disposition ?? "normal";
    if (disposition === "cooldown") {
      cooldownExcluded.push(shadow.id);
      continue;
    }
    eligible.push({ shadow, forced: disposition === "forced" });
  }

  return { eligible, modelFiltered, runningExcluded, cooldownExcluded };
}

export function matchesModel(shadow: ShadowDefinition, fullModelId: string): boolean {
  return shadow.activeForModels.includes("*") || shadow.activeForModels.includes(fullModelId);
}

function sample<T>(values: readonly T[], count: number, random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}
