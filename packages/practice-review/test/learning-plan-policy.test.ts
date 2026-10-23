import { expect, it } from "vitest";
import { deriveMilestoneStatuses } from "../src/index.js";
it("completes contiguous milestones, activates the first incomplete one and locks successors", () => {
  const milestones = [{id:"a",order:0,status:"active"},{id:"b",order:1,status:"locked"},{id:"c",order:2,status:"locked"}];
  expect(deriveMilestoneStatuses(milestones,[{milestoneId:"a",status:"done"},{milestoneId:"c",status:"done"}])).toEqual([{id:"a",status:"completed"},{id:"b",status:"active"}]);
  expect(deriveMilestoneStatuses([{id:"a",order:0,status:"completed"}],[{milestoneId:"a",status:"todo"}])).toEqual([{id:"a",status:"active"}]);
});
