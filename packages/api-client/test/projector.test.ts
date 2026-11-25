import { describe, expect, it, vi } from 'vitest';
import { TurnStreamProjector, type DropReason } from '../src/projector.js';
import type { TurnCallbacks } from '../src/transport.js';

describe('TurnStreamProjector (BTD-06 客户端安全投影与防乱序/防复活状态机)', () => {
  const createMockCallbacks = (): TurnCallbacks & { calls: Record<string, any[]> } => {
    const calls: Record<string, any[]> = {
      onDelta: [],
      onDone: [],
      onError: [],
      onEmote: [],
      onReasoning: [],
      onUserQuestion: [],
      onPluginEvent: [],
      onToolApproval: [],
    };
    return {
      calls,
      onDelta: vi.fn((text: string) => calls.onDelta.push(text)),
      onDone: vi.fn(() => calls.onDone.push(true)),
      onError: vi.fn((err: unknown) => calls.onError.push(err)),
      onEmote: vi.fn((cmd) => calls.onEmote.push(cmd)),
      onReasoning: vi.fn((text) => calls.onReasoning.push(text)),
      onUserQuestion: vi.fn((q) => calls.onUserQuestion.push(q)),
      onToolApproval: vi.fn((a) => calls.onToolApproval.push(a)),
      onPluginEvent: vi.fn((type: string, data: unknown) => calls.onPluginEvent.push({ type, data })),
    };
  };

  it('保序流式事件正常依次分发', () => {
    const projector = new TurnStreamProjector({ expectedTurnId: 'turn_1' });
    const cbs = createMockCallbacks();

    const r1 = projector.project(
      { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'Hello ' } },
      cbs,
    );
    const r2 = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', payloadVersion: 1, data: { text: 'world!' } },
      cbs,
    );
    const r3 = projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'done', payloadVersion: 1, data: { status: 'Completed' } },
      cbs,
    );

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(cbs.calls.onDelta).toEqual(['Hello ', 'world!']);
    expect(cbs.calls.onDone).toHaveLength(1);
    expect(projector.finalized).toBe(true);
    expect(projector.currentSequence).toBe(3);
  });

  it('防乱序：丢弃 sequence 逆序的迟到事件', () => {
    const dropped: Array<{ reason: DropReason; event: unknown }> = [];
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_1',
      onDropped: (reason, event) => dropped.push({ reason, event }),
    });
    const cbs = createMockCallbacks();

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'A' } }, cbs);
    projector.project({ turnId: 'turn_1', sequence: 3, eventType: 'delta', payloadVersion: 1, data: { text: 'C' } }, cbs);
    // 迟到的 sequence 2
    const rLate = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', payloadVersion: 1, data: { text: 'B (late)' } },
      cbs,
    );

    expect(rLate).toBe(false);
    expect(cbs.calls.onDelta).toEqual(['A', 'C']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('out_of_order');
  });

  it('防重发：丢弃相同 sequence 的重复事件', () => {
    const dropped: Array<{ reason: DropReason; event: unknown }> = [];
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_1',
      onDropped: (reason, event) => dropped.push({ reason, event }),
    });
    const cbs = createMockCallbacks();

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'First' } }, cbs);
    const rDup = projector.project(
      { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'First (dup)' } },
      cbs,
    );

    expect(rDup).toBe(false);
    expect(cbs.calls.onDelta).toEqual(['First']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('duplicate');
  });

  it('终态不可逆：done 终态后到达的迟到 delta 绝不复活状态', () => {
    const dropped: Array<{ reason: DropReason; event: unknown }> = [];
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_1',
      onDropped: (reason, event) => dropped.push({ reason, event }),
    });
    const cbs = createMockCallbacks();

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'Ready' } }, cbs);
    projector.project({ turnId: 'turn_1', sequence: 2, eventType: 'done', payloadVersion: 1, data: {} }, cbs);
    expect(projector.finalized).toBe(true);

    // 终态后网络抖动迟到推送的暂态事件
    const rPost1 = projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'delta', payloadVersion: 1, data: { text: 'Ghost delta' } },
      cbs,
    );
    const rPost2 = projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'reasoning_delta', payloadVersion: 1, data: { text: 'Ghost thought' } },
      cbs,
    );

    expect(rPost1).toBe(false);
    expect(rPost2).toBe(false);
    expect(cbs.calls.onDelta).toEqual(['Ready']);
    expect(cbs.calls.onReasoning).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]?.reason).toBe('post_terminal');
    expect(dropped[1]?.reason).toBe('post_terminal');
  });

  it('终态不可逆：error 终态后到达的迟到事件同样被严格拦截', () => {
    const dropped: Array<{ reason: DropReason; event: unknown }> = [];
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_1',
      onDropped: (reason, event) => dropped.push({ reason, event }),
    });
    const cbs = createMockCallbacks();

    projector.project(
      { turnId: 'turn_1', sequence: 1, eventType: 'error', payloadVersion: 1, data: { message: 'Provider timeout' } },
      cbs,
    );
    expect(projector.finalized).toBe(true);
    expect(cbs.calls.onError).toHaveLength(1);

    const rLate = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', payloadVersion: 1, data: { text: 'Late text' } },
      cbs,
    );
    expect(rLate).toBe(false);
    expect(cbs.calls.onDelta).toEqual([]);
    expect(dropped[0]?.reason).toBe('post_terminal');
  });

  it('身份隔离：跨 Turn 或迟到旧 Turn 的事件被丢弃', () => {
    const dropped: Array<{ reason: DropReason; event: unknown }> = [];
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_target',
      onDropped: (reason, event) => dropped.push({ reason, event }),
    });
    const cbs = createMockCallbacks();

    // 属于其它 Turn 的事件
    const rForeign = projector.project(
      { turnId: 'turn_stray', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'Stray' } },
      cbs,
    );
    expect(rForeign).toBe(false);
    expect(cbs.calls.onDelta).toEqual([]);
    expect(dropped[0]?.reason).toBe('wrong_turn');

    // 属于目标 Turn 的事件
    const rOk = projector.project(
      { turnId: 'turn_target', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'Correct' } },
      cbs,
    );
    expect(rOk).toBe(true);
    expect(cbs.calls.onDelta).toEqual(['Correct']);
  });

  it('重连游标水位：初始 sequence 水位以下的重放历史自动去重', () => {
    // 客户端携带 lastEventId 重连，服务端补发 sequence 3 起始，但重发中包含了 sequence 3
    const projector = new TurnStreamProjector({
      expectedTurnId: 'turn_1',
      initialSequence: 3,
    });
    const cbs = createMockCallbacks();

    const r3 = projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'delta', payloadVersion: 1, data: { text: 'Already seen' } },
      cbs,
    );
    const r4 = projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'delta', payloadVersion: 1, data: { text: 'New delta' } },
      cbs,
    );

    expect(r3).toBe(false);
    expect(r4).toBe(true);
    expect(cbs.calls.onDelta).toEqual(['New delta']);
  });

  it('完整分发各类安全业务事件', () => {
    const projector = new TurnStreamProjector();
    const cbs = createMockCallbacks();

    projector.project(
      { turnId: 'turn_1', sequence: 1, eventType: 'reasoning_delta', payloadVersion: 1, data: { text: 'Thinking...' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'emote', payloadVersion: 1, data: { type: 'wave' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'user_question_required', payloadVersion: 1, data: { turnId: 'turn_1', questions: [] } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'tool_approval_required', payloadVersion: 1, data: { approvalId: 'app_1', toolName: 'test' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 5, eventType: 'terms_extracted', payloadVersion: 1, data: { terms: [] } },
      cbs,
    );

    expect(cbs.calls.onReasoning).toEqual(['Thinking...']);
    expect(cbs.calls.onEmote).toEqual([{ type: 'wave' }]);
    expect(cbs.calls.onUserQuestion).toHaveLength(1);
    expect(cbs.calls.onToolApproval).toHaveLength(1);
    expect(cbs.calls.onToolApproval[0]?.turnId).toBe('turn_1');
    // CR-060：插件自有事件类型经通用出口透传
    expect(cbs.calls.onPluginEvent).toHaveLength(1);
    expect(cbs.calls.onPluginEvent[0]?.type).toBe('terms_extracted');
  });

  it('CR-060：内核事件不得经通用插件出口外泄给插件', () => {
    const projector = new TurnStreamProjector();
    const cbs = createMockCallbacks();

    for (const [index, eventType] of ['message', 'redacted', 'user_question_answered', 'tool_request', 'tool_result'].entries()) {
      projector.project(
        { turnId: 'turn_1', sequence: index + 1, eventType, data: { internal: '不应外泄' } },
        cbs,
      );
    }

    // 内核事件不进入插件通道
    expect(cbs.calls.onPluginEvent).toHaveLength(0);

    // 真正的插件自有事件仍然透传
    projector.project(
      { turnId: 'turn_1', sequence: 6, eventType: 'plugin_own_event', payloadVersion: 1, data: { ok: true } },
      cbs,
    );
    expect(cbs.calls.onPluginEvent).toHaveLength(1);
    expect(cbs.calls.onPluginEvent[0]?.type).toBe('plugin_own_event');
  });

  /**
   * STREAMING_PROTOCOL §5.5：客户端收到未知 payloadVersion 必须停止渲染并请求
   * 兼容降级，不得猜测字段含义。缺省该字段同样拒绝——它不是可选装饰，而是
   * 决定能否安全解释 data 的前提。
   */
  describe('信封版本准入', () => {
    const cases: Array<[string, unknown]> = [
      ['未知更高版本', 2],
      ['零', 0],
      ['负数', -1],
      ['非整数', 1.5],
      ['字符串', '1'],
      ['缺省', undefined],
    ];

    it.each(cases)('拒绝%s的事件，不渲染任何内容', (_label, payloadVersion) => {
      const projector = new TurnStreamProjector({ expectedTurnId: 'turn_1' });
      const cbs = createMockCallbacks();
      const dropped: DropReason[] = [];
      const gated = new TurnStreamProjector({
        expectedTurnId: 'turn_1',
        onDropped: reason => dropped.push(reason),
      });
      const accepted = gated.project(
        { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: payloadVersion as number, data: { text: 'x' } },
        cbs,
      );
      expect(accepted).toBe(false);
      expect(cbs.calls.onDelta).toHaveLength(0);
      expect(dropped).toEqual(['unsupported_version']);
      // 被拒绝的事件不得推进水位，否则后续合法事件会被误判为乱序。
      expect(gated.currentSequence).toBe(0);
      expect(projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'ok' } }, cbs)).toBe(true);
    });

    it('把观测到的未知版本暴露给调用方，供其决定降级动作', () => {
      // STREAMING_PROTOCOL §5.5 要求"请求兼容降级"，但协议层尚未定义降级形态；
      // 客户端至少要让调用方看见事实，而不是丢弃后界面无故空白。
      const projector = new TurnStreamProjector({ expectedTurnId: 'turn_1' });
      const cbs = createMockCallbacks();
      expect(projector.unsupportedVersion).toBeUndefined();
      projector.project(
        { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 7, data: { text: 'x' } },
        cbs,
      );
      expect(projector.unsupportedVersion).toBe(7);
      // 后续更低或更高的未知版本不覆盖首次观测值。
      projector.project(
        { turnId: 'turn_1', sequence: 2, eventType: 'delta', payloadVersion: 9, data: { text: 'y' } },
        cbs,
      );
      expect(projector.unsupportedVersion).toBe(7);
      expect(cbs.calls.onDelta).toHaveLength(0);
    });

    it('支持版本通过后不留下未知版本记录', () => {
      const projector = new TurnStreamProjector({ expectedTurnId: 'turn_1' });
      const cbs = createMockCallbacks();
      projector.project(
        { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'ok' } },
        cbs,
      );
      expect(projector.unsupportedVersion).toBeUndefined();
      expect(cbs.calls.onDelta).toEqual(['ok']);
    });

    it('允许当前支持版本通过，且事件被正常分发', () => {
      const projector = new TurnStreamProjector({ expectedTurnId: 'turn_1' });
      const cbs = createMockCallbacks();
      expect(projector.project(
        { turnId: 'turn_1', sequence: 1, eventType: 'delta', payloadVersion: 1, data: { text: 'hi' } },
        cbs,
      )).toBe(true);
      expect(cbs.calls.onDelta).toEqual(['hi']);
    });
  });
});
