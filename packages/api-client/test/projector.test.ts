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
      { turnId: 'turn_1', sequence: 1, eventType: 'delta', data: { text: 'Hello ' } },
      cbs,
    );
    const r2 = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', data: { text: 'world!' } },
      cbs,
    );
    const r3 = projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'done', data: { status: 'Completed' } },
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

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', data: { text: 'A' } }, cbs);
    projector.project({ turnId: 'turn_1', sequence: 3, eventType: 'delta', data: { text: 'C' } }, cbs);
    // 迟到的 sequence 2
    const rLate = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', data: { text: 'B (late)' } },
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

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', data: { text: 'First' } }, cbs);
    const rDup = projector.project(
      { turnId: 'turn_1', sequence: 1, eventType: 'delta', data: { text: 'First (dup)' } },
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

    projector.project({ turnId: 'turn_1', sequence: 1, eventType: 'delta', data: { text: 'Ready' } }, cbs);
    projector.project({ turnId: 'turn_1', sequence: 2, eventType: 'done', data: {} }, cbs);
    expect(projector.finalized).toBe(true);

    // 终态后网络抖动迟到推送的暂态事件
    const rPost1 = projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'delta', data: { text: 'Ghost delta' } },
      cbs,
    );
    const rPost2 = projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'reasoning_delta', data: { text: 'Ghost thought' } },
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
      { turnId: 'turn_1', sequence: 1, eventType: 'error', data: { message: 'Provider timeout' } },
      cbs,
    );
    expect(projector.finalized).toBe(true);
    expect(cbs.calls.onError).toHaveLength(1);

    const rLate = projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'delta', data: { text: 'Late text' } },
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
      { turnId: 'turn_stray', sequence: 1, eventType: 'delta', data: { text: 'Stray' } },
      cbs,
    );
    expect(rForeign).toBe(false);
    expect(cbs.calls.onDelta).toEqual([]);
    expect(dropped[0]?.reason).toBe('wrong_turn');

    // 属于目标 Turn 的事件
    const rOk = projector.project(
      { turnId: 'turn_target', sequence: 1, eventType: 'delta', data: { text: 'Correct' } },
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
      { turnId: 'turn_1', sequence: 3, eventType: 'delta', data: { text: 'Already seen' } },
      cbs,
    );
    const r4 = projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'delta', data: { text: 'New delta' } },
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
      { turnId: 'turn_1', sequence: 1, eventType: 'reasoning_delta', data: { text: 'Thinking...' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 2, eventType: 'emote', data: { type: 'wave' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 3, eventType: 'user_question_required', data: { turnId: 'turn_1', questions: [] } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 4, eventType: 'tool_approval_required', data: { approvalId: 'app_1', toolName: 'test' } },
      cbs,
    );
    projector.project(
      { turnId: 'turn_1', sequence: 5, eventType: 'terms_extracted', data: { terms: [] } },
      cbs,
    );

    expect(cbs.calls.onReasoning).toEqual(['Thinking...']);
    expect(cbs.calls.onEmote).toEqual([{ type: 'wave' }]);
    expect(cbs.calls.onUserQuestion).toHaveLength(1);
    expect(cbs.calls.onToolApproval).toHaveLength(1);
    expect(cbs.calls.onToolApproval[0]?.turnId).toBe('turn_1');
    // CR-060：内核未专门分发的事件经通用插件事件出口透传（此处为插件自有事件类型）
    expect(cbs.calls.onPluginEvent).toHaveLength(1);
    expect(cbs.calls.onPluginEvent[0]?.type).toBe('terms_extracted');
  });
});
