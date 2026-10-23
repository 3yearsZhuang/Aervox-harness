import { afterEach, expect, it, vi } from "vitest";
import { createFetchTransport } from "../src/transport";
import { desktopTransport } from "../src/desktop-transport";
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
  const transport = createFetchTransport("http://api.test");
  expect(await transport.decideToolApproval("turn","approval","granted")).toEqual(response);
  const onDelta=vi.fn(),onDone=vi.fn();
  await transport.observeTurn!("turn",{onDelta,onDone},{afterEventId:"decision"});
  expect(fetch.mock.calls.map(args=>args[0])).toEqual(["http://api.test/v1/turns/turn/tool-approvals","http://api.test/v1/turns/turn/events?after=decision"]);
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("continued");expect(onDone).toHaveBeenCalledOnce();
});
it("desktop approval uses typed Turn observation with the same projection",async()=>{
  let callback:((message:unknown)=>void)|undefined;const stop=vi.fn();const streamTurn=vi.fn();
  const apiRequest=vi.fn().mockResolvedValue({status:200,ok:true,json:response,text:""});
  const observeTurn=vi.fn((_id:string,_options:unknown,cb:(message:unknown)=>void)=>{callback=cb;return stop;});
  vi.stubGlobal("window",{fairyDesktop:{apiRequest,observeTurn,streamTurn}});
  const transport = desktopTransport;
  expect(await transport.decideToolApproval("turn","approval","granted")).toEqual(response);
  const onDelta=vi.fn(),onDone=vi.fn();
  const watching=transport.observeTurn!("turn",{onDelta,onDone},{afterEventId:"decision"});
  for(const event of events)callback?.({type:"event",event});
  callback?.({type:"closed"});
  await watching;
  expect(observeTurn).toHaveBeenCalledWith("turn",expect.objectContaining({afterEventId:"decision"}),expect.any(Function));
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("continued");expect(onDone).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();expect(streamTurn).not.toHaveBeenCalled();
});
it("propagates resumed model failures instead of swallowing the terminal callback error",async()=>{
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({turnId:"turn",sequence:20,eventType:"error",data:{message:"model_failed"}})}\n\n`)));
  const transport = createFetchTransport("http://api.test");
  await expect(transport.observeTurn!("turn",{onDelta:vi.fn(),onDone:vi.fn(),onError:error=>{throw error;}},{afterEventId:"decision"})).rejects.toThrow("model_failed");
});
