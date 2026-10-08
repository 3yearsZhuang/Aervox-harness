import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import * as lightweight from "../src/core.js";

describe("public entrypoints", () => {
  it("retains the consumer facade while hiding execution internals", () => {
    for (const name of ["executeTurn", "ControlContext", "HostToolRuntime", "InMemoryExecutionStore", "createOpenAICompatProvider", "createComposedContextBuilder", "decideResume"]) expect(core).toHaveProperty(name);
    for (const name of ["StepCollector", "runToolExecution", "settleToolLedger", "createTurnTerminator", "safeStringify", "dedupeKey"]) expect(core).not.toHaveProperty(name);
    expect(lightweight.executeTurn).toBe(core.executeTurn);
  });
});
