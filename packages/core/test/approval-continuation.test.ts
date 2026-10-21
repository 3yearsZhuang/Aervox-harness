import { describe, expect, it } from "vitest";
import { executeTurn, defaultContextBuilder, InMemoryExecutionStore, buildResumeHistory } from "../src/index.js";
import type { ExecuteTurnResumeInput, ModelProviderPort, ToolProviderPort } from "../src/index.js";
const input = { turnId: "turn", attemptId: "new", sessionId: "session", userMessage: "save" };
const provider: ModelProviderPort = { id: "final", async *stream() { yield { text: "done", isFinal: true }; } };
function setup() {
  const execution = new InMemoryExecutionStore();
  execution.seedAttempt({id:"new",turnId:"turn"});
  const history = buildResumeHistory({ userMessage:"save",events:[{sequence:1,eventType:"tool_request",data:{invocationId:"model-call",executionId:"old:1:1",name:"save",arguments:{content:"data"}}}] }).history;
  const resume: ExecuteTurnResumeInput = {expectedFencingToken:0,lastSequence:1,lastStep:1,messageId:"message",history,
    pendingApprovalResolution:{approvalId:"approval",decision:"granted",invocationId:"old:1:1",toolCall:{id:"model-call",name:"save",arguments:{content:"data"}}}};
  return { execution, resume };
}
describe("approval continuation execution guards",()=>{
  it.each(["deletion","cancel"] as const)("checks %s before any resumed side effect",async kind=>{
    const {execution,resume}=setup();let writes=0;
    if(kind==="cancel") { const claim=execution.claimTurnAttempt.bind(execution);execution.claimTurnAttempt=async i=>{const result=await claim(i);await execution.requestCancelAttempt(i);return result;}; }
    const result=await executeTurn({execution,provider,contextBuilder:defaultContextBuilder,
      tools:{tools:[{name:"save",description:"save",readOnly:false}],async execute(){writes++;return {ok:true};}},
      deletionGate:kind==="deletion"?{async isBlocked(){return true;}}:undefined,options:{resume}},input);
    expect(writes).toBe(0);expect(result.status).toBe(kind==="deletion"?"interrupted":"cancelled");
  });
  it("matches original model call IDs and rejects a model request to repeat the resolved action",async()=>{
    const {execution,resume}=setup();let writes=0;let calls=0;
    const strict:ModelProviderPort={id:"strict",async *stream(i){
      const request=i.context.messages.find(m=>m.toolCalls)?.toolCalls?.[0];
      const result=i.context.messages.find(m=>m.role==="tool");
      expect(request?.id).toBe("model-call");expect(result?.toolCallId).toBe(request?.id);
      if(calls++===0)yield {text:"",isFinal:true,toolCalls:[{id:"repeat",name:"save",arguments:{content:"data"}}]};else yield {text:"done",isFinal:true};
    }};
    const result=await executeTurn({execution,provider:strict,contextBuilder:defaultContextBuilder,
      tools:{tools:[{name:"save",description:"save",readOnly:false}],async execute(){writes++;return {ok:true};}},options:{resume}},input);
    expect(result).toMatchObject({status:"completed"});expect(writes).toBe(1);
  });
  it("aborts an uncooperative resumed tool on the normal tool timeout",async()=>{
    const {execution,resume}=setup();let signal:AbortSignal|undefined;
    const result=await executeTurn({execution,provider,contextBuilder:defaultContextBuilder,
      tools:{tools:[{name:"save",description:"save",readOnly:false}],async execute(i){signal=i.signal;return new Promise(()=>{});}},options:{resume,toolTimeoutMs:5}},input);
    expect(signal?.aborted).toBe(true);expect(result.status).toBe("completed");
    expect((await execution.listEvents("turn")).find(e=>e.eventType==="tool_result")?.data).toMatchObject({ok:false,error:"tool_timeout"});
  });
  it("retains pending approval when tool authorization changes before dispatch",async()=>{
    const {execution,resume}=setup();
    const tools:ToolProviderPort={tools:[{name:"save",description:"save",readOnly:false}],async execute(){return {ok:false,needsApproval:{approvalId:"new-approval",toolName:"save",argumentsHash:"new-hash"}};}};
    const result=await executeTurn({execution,provider,tools,contextBuilder:defaultContextBuilder,options:{resume}},input);
    expect(result).toMatchObject({status:"interrupted",reason:"pending_approval"});
    expect((await execution.listEvents("turn")).some(e=>e.eventType==="tool_result")).toBe(false);
    expect((await execution.listEvents("turn")).find(e=>e.eventType==="tool_approval_required")?.data).toMatchObject({approvalId:"new-approval",toolCallId:"model-call"});
  });
});
