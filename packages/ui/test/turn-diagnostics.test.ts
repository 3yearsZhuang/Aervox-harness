import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { TurnDiagnostics as Report } from '@aervox/contracts';
import TurnDiagnostics from '../src/components/workbench/TurnDiagnostics.vue';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@aervox/api-client', () => ({ useAervoxTurnDiagnostics: () => ({ get }) }));
const Dialog = defineComponent({ props: ['modelValue'], template: '<section v-if="modelValue" role="dialog"><slot /></section>' });
const makeReport = (id = 'at_new'): Report => ({
  turnId: 'turn_actual', sessionId: 'session', status: 'Completed', observedAt: 'now', selectedAttemptId: id,
  attempts: [{ id: 'at_new', attempt: 2, status: 'Completed', startedAt: 'now', finishedAt: 'now' }, { id: 'at_old', attempt: 1, status: 'Interrupted', startedAt: 'now', finishedAt: 'now' }],
  terminationReason: null, modelRuns: [], tools: [], approvals: [],
  truncated: { attempts: false, modelRuns: false, tools: false, approvals: false }, unavailable: ['context_pruning'],
});
const create = () => mount(TurnDiagnostics, { props: { turnId: 'turn_actual' }, global: { stubs: { AervoxDialog: Dialog } } });

describe('reply run details', () => {
  beforeEach(() => get.mockReset());
  it('loads only when opened, selects an Attempt and shows missing/truncated records explicitly', async () => {
    get.mockResolvedValueOnce(makeReport()).mockResolvedValueOnce({ ...makeReport('at_old'), terminationReason: 'pending_approval', tools: [{ name: 'save', invocationId: 'call', status: 'pending_approval', startedAt: 'now', finishedAt: 'now' }], truncated: { attempts: false, modelRuns: true, tools: false, approvals: false } });
    const wrapper = create(); expect(get).not.toHaveBeenCalled();
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(get).toHaveBeenCalledWith('turn_actual', undefined);
    expect(wrapper.text()).toContain('暂无记录');
    await wrapper.get('select').setValue('at_old'); await flushPromises();
    expect(get).toHaveBeenLastCalledWith('turn_actual', 'at_old');
    expect(wrapper.text()).toContain('等待审批'); expect(wrapper.text()).toContain('仅展示部分记录'); wrapper.unmount();
  });
  it('ignores an older Attempt request after opening another reply and closes on identity changes', async () => {
    let release!: (value: Report) => void;
    get.mockResolvedValueOnce(makeReport()).mockReturnValueOnce(new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ ...makeReport(), turnId: 'another_turn' });
    const wrapper = create(); await wrapper.get('button').trigger('click'); await flushPromises();
    await wrapper.get('select').setValue('at_old');
    await wrapper.setProps({ turnId: 'another_turn' }); await flushPromises();
    await wrapper.get('button').trigger('click'); await flushPromises();
    release({ ...makeReport('at_old'), terminationReason: 'pending_approval' }); await flushPromises();
    expect(wrapper.get('select').element.value).toBe('at_new');
    expect(wrapper.text()).not.toContain('等待审批');
    expect(get).toHaveBeenLastCalledWith('another_turn', undefined);
    await wrapper.setProps({ turnId: 'third_turn' }); await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false); wrapper.unmount();
  });
  it('shows a retryable error without displaying raw server errors, and revalidates deletion before export', async () => {
    get.mockRejectedValueOnce(new Error('SECRET server error')).mockResolvedValueOnce(makeReport()).mockRejectedValueOnce(new Error('deleted'));
    const wrapper = create(); await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取'); expect(wrapper.text()).not.toContain('SECRET');
    await wrapper.findAll('button').find(button => button.text().includes('刷新'))!.trigger('click'); await flushPromises();
    await wrapper.findAll('button').find(button => button.text().includes('导出诊断摘要'))!.trigger('click'); await flushPromises();
    expect(get).toHaveBeenLastCalledWith('turn_actual', 'at_new');
    expect(wrapper.get('[role="alert"]').text()).toContain('导出失败'); wrapper.unmount();
  });
});
