import { eq, inArray } from "drizzle-orm";
import { botDeliveries, botInbox, botSessionBindings } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";

/** Retain only the event identity so platform retries cannot resurrect deleted conversations. */
export async function deleteBotConversationData(
  tx: Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0],
  target: { sessionId: string } | { turnIds: string[] },
): Promise<void> {
  if ("turnIds" in target && target.turnIds.length === 0) return;
  const condition = "sessionId" in target ? eq(botInbox.sessionId, target.sessionId) : inArray(botInbox.turnId, target.turnIds);
  await tx.delete(botDeliveries).where(inArray(botDeliveries.inboxId, tx.select({ id: botInbox.id }).from(botInbox).where(condition)));
  await tx.update(botInbox).set({ messageJson: "{}", state: "deleted", lastError: null }).where(condition);
  if ("sessionId" in target) await tx.delete(botSessionBindings).where(eq(botSessionBindings.sessionId, target.sessionId));
}
