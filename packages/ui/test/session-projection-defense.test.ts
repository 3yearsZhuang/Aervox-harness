import { afterEach, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { defineComponent, inject } from 'vue';
import AervoxWorkbench from '../src/components/AervoxWorkbench.vue';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '../src/composables/workbench-context';

const streams = vi.hoisted(() => ({ callbacks: [] as any[], finish: [] as Array<() => void> }));
vi.mock('@aervox/api-client', async (original) => {
  const actual = await original<any>();
  return { ...actual, streamAervoxTurn: vi.fn((_text, callbacks) => {
    streams.callbacks.push(callbacks);
    return new Promise<void>((resolve) => streams.finish.push(resolve));
  }) };
});
afterEach(() => { vi.unstubAllGlobals(); streams.callbacks.length = 0; streams.finish.length = 0; });

it('挂载真实工作台：A→B→A 后旧流不能污染新消息，旧结束不能解除新流状态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], plugins: [], sessions: [], pages: [], projects: [] }), { status: 200 })));
  let ctx!: WorkbenchContext;
  const Capture = defineComponent({ setup() { ctx = inject(WORKBENCH_CONTEXT_KEY)!; return () => null; } });
  const wrapper = shallowMount(AervoxWorkbench, { global: { stubs: { ComposerDock: Capture } } });
  try {
    await flushPromises();
    ctx.sessions.activeSessionId.value = 'A'; await flushPromises();
    const oldRun = ctx.sendMessage('old question');
    await flushPromises(); expect(streams.callbacks).toHaveLength(1);
    ctx.sessions.activeSessionId.value = 'B'; await flushPromises();
    ctx.sessions.activeSessionId.value = 'A'; await flushPromises();
    const newRun = ctx.sendMessage('new question');
    await flushPromises(); expect(streams.callbacks).toHaveLength(2);
    streams.callbacks[0].onDelta('OLD'); streams.callbacks[0].onDone(); streams.finish[0]();
    await oldRun; await flushPromises();
    expect(ctx.conversation.streaming.value).toBe(true);
    expect(ctx.conversation.story.value.map((line) => line.text).join('')).not.toContain('OLD');
    streams.callbacks[1].onDelta('NEW'); streams.callbacks[1].onDone(); streams.finish[1]();
    await newRun; await flushPromises();
    expect(ctx.conversation.streaming.value).toBe(false);
    expect(ctx.conversation.story.value.map((line) => line.text).join('')).toContain('NEW');
  } finally { streams.finish.forEach((resolve) => resolve()); wrapper.unmount(); }
});
