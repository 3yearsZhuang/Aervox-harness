import { awaitWithSignal, ControlContext, createComposedContextBuilder, executeTurn } from "@aervox/core";
import type { DeletionGatePort, ExecutionStorePort, ModelProviderPort, ExecuteResult } from "@aervox/core";
import type { ClaimableTurn, TurnSourcePort } from "./agent-host.js";

/** Opt-in recovery: only continue from committed results, without new tools or lifecycle hooks. */
export async function resumeCommittedTurns(deps: {
  source: TurnSourcePort;
  baseSystemPrompt?: import("@aervox/core").BaseSystemPromptOptions;
  createStore(turn: ClaimableTurn): ExecutionStorePort;
  /** Must enforce control.localProcessingOnly before selecting a provider. */
  createProvider(turn: ClaimableTurn, control: ControlContext): Promise<ModelProviderPort>;
  deletionGate: DeletionGatePort;
  signal?: AbortSignal;
  limit?: number;
}): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  const turns = await awaitWithSignal(deps.source.listClaimable(Math.min(10, Math.max(0, deps.limit ?? 10))), deps.signal);
  for (const turn of turns) {
    if (deps.signal?.aborted) break;
    if (!turn.resume || await deps.deletionGate.isBlocked(turn)) continue;
    const control = new ControlContext({ ...turn, abortSignal: deps.signal, localProcessingOnly: true, deadlineEpochMs: Date.now() + 30_000 });
    try {
      const provider = await awaitWithSignal(deps.createProvider(turn, control), control.abortSignal);
      control.abortSignal.throwIfAborted();
      results.push(await executeTurn({
        execution: deps.createStore(turn), provider, controlContext: control, deletionGate: deps.deletionGate,
        contextBuilder: createComposedContextBuilder({ baseSystemPrompt: { ...deps.baseSystemPrompt, extraSections: ["Continue using the committed tool results. No tools are available during recovery; explain any remaining work without claiming it was performed."] } }),
        options: { resume: turn.resume, maxSteps: turn.resume.lastStep + 1, maxModelRetries: 0 },
      }, turn));
    } catch {
      // Failed admission leaves the original expired attempt for the Worker to interrupt.
      results.push({ status: "skipped", attemptId: turn.attemptId, reason: "not_runnable" });
    } finally { control.dispose(); }
  }
  return results;
}
