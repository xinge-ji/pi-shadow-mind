import {
  buildSessionContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ShadowDefinition } from "./types.js";

export interface ShadowDispatchRequest {
  ctx: ExtensionContext;
  shadow: ShadowDefinition;
  mainModel: Model<any>;
  fullModelId: string;
  context: ReturnType<typeof buildSessionContext>;
  availableTools: Set<string>;
}

/** Shared launch preparation for heartbeat and slot-release dispatch paths. */
export function dispatchShadows(options: {
  ctx: ExtensionContext;
  shadows: readonly ShadowDefinition[];
  mainModel: Model<any>;
  fullModelId: string;
  getAvailableTools(): Set<string>;
  launch(request: ShadowDispatchRequest): void;
}): void {
  if (!options.shadows.length) return;
  const context = buildSessionContext(options.ctx.sessionManager.getEntries(), options.ctx.sessionManager.getLeafId());
  const availableTools = options.getAvailableTools();
  for (const shadow of options.shadows) {
    options.launch({
      ctx: options.ctx,
      shadow,
      mainModel: options.mainModel,
      fullModelId: options.fullModelId,
      context,
      availableTools,
    });
  }
}
