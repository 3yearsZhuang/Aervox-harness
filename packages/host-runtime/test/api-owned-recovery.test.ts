import { expect, it, vi } from "vitest";
import type { SqliteConversationRepository } from "@aervox/repositories";
import { recoverApiOwnedTurn } from "../src/modules/companion/conversation/api-owned-recovery.js";
import { turnStreamHub } from "../src/modules/companion/conversation/stream-hub.js";

it("does not publish settlement when a retry replaces the terminal attempt during reconciliation", async () => {
  const publish = vi.spyOn(turnStreamHub, "publishSettled");
  const events = vi.fn();
  const repo = {
    listTurnAttempts: vi.fn(async () => [{ id: "old-attempt", status: "Completed" }]),
    synchronizeTurnWithLatestAttempt: vi.fn(async () => null),
    getTurn: vi.fn(async () => ({ status: "Running", lastSequence: 4 })),
    getStreamEvents: events,
  } as unknown as SqliteConversationRepository;
  try {
    expect(await recoverApiOwnedTurn(repo, "turn")).toBe("active");
    expect(events).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally { publish.mockRestore(); }
});
