import { afterAll } from "vitest";

// A worker may be terminated after a test file, before Node's exit hooks run.
// Only createInMemoryDatabase registers this cleanup event.
afterAll(() => {
  const events: NodeJS.EventEmitter = process;
  events.emit("aervox:cleanup-temporary-databases");
});
