/** Node compatibility entry. Portable backup/DDL use the neutral implementation. */
import { nodeConversationHost } from "../conversation-host-node.js";
import * as portable from "./fts-neutral.js";
export { initFtsTables, deleteMessageFts, deleteMemoryFts } from "./fts-neutral.js";
export type { FtsConnection, FtsSearchResult, ProjectionWriter, ProjectionClient } from "./fts-neutral.js";
export const rebuildMessageFts = (...args: Parameters<typeof portable.rebuildMessageFts>) =>
  portable.rebuildMessageFts(args[0], args[1] ?? nodeConversationHost);
export const rebuildSearchProjections = (...args: Parameters<typeof portable.rebuildSearchProjections>) =>
  portable.rebuildSearchProjections(args[0], args[1] ?? nodeConversationHost);
export const indexMessageFts = (...args: Parameters<typeof portable.indexMessageFts>) =>
  portable.indexMessageFts(args[0], args[1], args[2], args[3] ?? nodeConversationHost);
export const indexMemoryFts = (...args: Parameters<typeof portable.indexMemoryFts>) =>
  portable.indexMemoryFts(args[0], args[1], args[2], args[3] ?? nodeConversationHost);
export const searchMessagesFts = (...args: Parameters<typeof portable.searchMessagesFts>) =>
  portable.searchMessagesFts(args[0], args[1], args[2], args[3], args[4] ?? nodeConversationHost);
export const searchMemoriesFts = (...args: Parameters<typeof portable.searchMemoriesFts>) =>
  portable.searchMemoriesFts(args[0], args[1], args[2], args[3], args[4] ?? nodeConversationHost);
