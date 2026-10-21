import { afterEach, expect, it, vi } from "vitest";
import { configureAervoxClient, createFetchTransport } from "../src/transport";
import { desktopTransport } from "../src/desktop-transport";
import { decideToolApproval, watchAervoxTurnContinuation } from "../src/useAervoxTurn";
const response = {approvalId:"approval",state:"granted",continuation:{attemptId:"attempt2",afterEventId:"decision"}};
const events = [
  {turnId:"wrong",sequence:10,eventType:"done",data:{}},
  {turnId:"turn",sequence:11,eventType:"delta",data:{text:"continued"}},
  {turnId:"turn",sequence:12,eventType:"done",data:{status:"Completed"}},
  {turnId:"turn",sequence:13,eventType:"delta",data:{text:"late"}},
];
afterEach(()=>{vi.unstubAllGlobals();});
it("fetch approval returns a cursor and subscribes without creating a second Turn",async()=>{
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response)))
    .mockResolvedValueOnce(new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("")));
  vi.stubGlobal("fetch",fetch);
  configureAervoxClient({transport:createFetchTransport("http://api.test")});
  expect(await decideToolApproval("turn","approval","granted")).toEqual(response);
  const onDelta=vi.fn(),onDone=vi.fn();
  await watchAervoxTurnContinuation("turn","decision",{onDelta,onDone});
  expect(fetch.mock.calls.map(args=>args[0])).toEqual(["http://api.test/v1/turns/turn/tool-approvals","http://api.test/v1/turns/turn/events?after=decision"]);
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("continued");expect(onDone).toHaveBeenCalledOnce();
});
it("desktop approval uses its authenticated generic event bridge with the same projection",async()=>{
  let callback:((message:unknown)=>void)|undefined;const stop=vi.fn();const streamTurn=vi.fn();
  const apiRequest=vi.fn().mockResolvedValue({status:200,ok:true,json:response,text:""});
  const streamEvents=vi.fn((_path:string,cb:(message:unknown)=>void)=>{callback=cb;return stop;});
  vi.stubGlobal("window",{fairyDesktop:{apiRequest,streamEvents,streamTurn}});
  configureAervoxClient({transport:desktopTransport});
  expect(await decideToolApproval("turn","approval","granted")).toEqual(response);
  const onDelta=vi.fn(),onDone=vi.fn();
  const watching=watchAervoxTurnContinuation("turn","decision",{onDelta,onDone});
  for(const event of events)callback?.({type:"event",event});
  await watching;
  expect(streamEvents).toHaveBeenCalledWith("/v1/turns/turn/events?after=decision",expect.any(Function));
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("continued");expect(onDone).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();expect(streamTurn).not.toHaveBeenCalled();
});
it("propagates resumed model failures instead of swallowing the terminal callback error",async()=>{
  const streamEvents=vi.fn(async (_path:string,callbacks:{onEvent:(event:unknown)=>void})=>{
    callbacks.onEvent({turnId:"turn",sequence:20,eventType:"error",data:{message:"model_failed"}});
  });
  configureAervoxClient({transport:{...createFetchTransport("http://api.test"),streamEvents}});
  await expect(watchAervoxTurnContinuation("turn","decision",{onDelta:vi.fn(),onDone:vi.fn(),onError:error=>{throw error;}})).rejects.toThrow("model_failed");
});
