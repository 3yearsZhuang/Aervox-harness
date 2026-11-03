import { beforeEach, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));
import { createDeviceTooling } from '../src/mobile/native-tools';

const status = (control: boolean, apps: boolean, root = true, advanced = false, shizuku?: boolean) => ({ kind: 'device_status', root, ...(shizuku === undefined ? {} : { shizuku }), capabilities: { control, apps, advanced } });
const call = (name: string, args: unknown) => ({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', name, arguments: args });
beforeEach(() => { request.mockReset(); });

it('lists device tools only for capability grants the user actually made', async () => {
  request.mockResolvedValue(status(false, false));
  const tooling = createDeviceTooling();
  expect((await tooling.provider.listTools!()).map(tool => tool.name)).toEqual(['device_info']);
  request.mockResolvedValue(status(true, false));
  expect((await tooling.provider.listTools!()).map(tool => tool.name))
    .toEqual(['device_info', 'device_tap', 'device_swipe', 'device_key', 'device_text']);
  request.mockResolvedValue(status(true, true));
  expect((await tooling.provider.listTools!()).map(tool => tool.name))
    .toEqual(['device_info', 'device_tap', 'device_swipe', 'device_key', 'device_text', 'device_launch_app']);
  request.mockResolvedValue(status(true, true, true, true));
  expect((await tooling.provider.listTools!()).map(tool => tool.name))
    .toEqual(['device_info', 'device_tap', 'device_swipe', 'device_key', 'device_text', 'device_launch_app', 'device_command']);
});

it('offers device tools over an authorized Shizuku channel without root', async () => {
  request.mockResolvedValue({ kind: 'device_status', root: false, shizuku: true, capabilities: { control: true, apps: false, advanced: false } });
  const tooling = createDeviceTooling();
  expect((await tooling.provider.listTools!()).map(tool => tool.name))
    .toEqual(['device_info', 'device_tap', 'device_swipe', 'device_key', 'device_text']);
});

it('rejects device_command arguments without a shell line', async () => {
  const tooling = createDeviceTooling();
  expect(await tooling.provider.execute(call('device_command', { line: '   ' }))).toEqual({ ok: false, error: 'invalid_arguments' });
  expect(await tooling.provider.execute(call('device_command', {}))).toEqual({ ok: false, error: 'invalid_arguments' });
  expect(request).not.toHaveBeenCalled();
});

it('declares no device tools at all when root is unavailable', async () => {
  request.mockResolvedValue(status(true, true, false));
  const tooling = createDeviceTooling();
  expect(await tooling.provider.listTools!()).toEqual([]);
  request.mockRejectedValue(new Error('DEVICE_UNAVAILABLE'));
  expect(await tooling.provider.listTools!()).toEqual([]);
});

it('refuses model-supplied arguments that do not match the fixed shape', async () => {
  const tooling = createDeviceTooling();
  for (const [name, args] of [
    ['device_tap', { x: -1, y: 10 }],
    ['device_tap', { x: 1.5, y: 10 }],
    ['device_swipe', { x1: 0, y1: 0, x2: 10, y2: 10, durationMs: 10 }],
    ['device_key', { key: 'REBOOT' }],
    ['device_text', { value: '中文' }],
    ['device_launch_app', { package: 'com.example; reboot' }],
    ['device_launch_app', { package: 'https://example.com' }],
    ['device_command', { line: 42 }],
  ] as const) {
    expect(await tooling.provider.execute(call(name, args))).toEqual({ ok: false, error: 'invalid_arguments' });
  }
  expect(request).not.toHaveBeenCalled();
});

it('runs an accepted action through the native channel and returns only its bounded receipt', async () => {
  request.mockResolvedValue({ kind: 'device_result', ok: true, action: 'tap 12,34', output: 'shown' });
  const tooling = createDeviceTooling();
  expect(await tooling.provider.execute(call('device_tap', { x: 12, y: 34 }))).toEqual({ ok: true, output: 'shown' });
  expect(request).toHaveBeenCalledWith({ op: 'device', operation: 'perform', action: 'tap', x: 12, y: 34 });
});

it('reports a definite native refusal instead of a fabricated success', async () => {
  request.mockRejectedValue(new Error('ROOT_UNAVAILABLE'));
  const tooling = createDeviceTooling();
  expect(await tooling.provider.execute(call('device_key', { key: 'HOME' }))).toEqual({ ok: false, error: 'ROOT_UNAVAILABLE' });
});

it('reads device info as a read-only tool without any capability grant', async () => {
  request.mockResolvedValue({ kind: 'device_result', ok: true, action: 'device info', output: 'Android 17 (API 37)' });
  const tooling = createDeviceTooling();
  expect(await tooling.provider.execute(call('device_info', {}))).toEqual({ ok: true, output: 'Android 17 (API 37)' });
});

it('re-checks the native grant before approving a side effect', async () => {
  const tooling = createDeviceTooling();
  request.mockResolvedValue(status(true, false));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_tap', arguments: { x: 1, y: 2 } }))
    .toEqual({ action: 'allow', reason: 'device_capability_granted', metadata: { capability: 'control' } });
  request.mockResolvedValue(status(false, false));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_tap', arguments: { x: 1, y: 2 } }))
    .toEqual({ action: 'deny', reason: 'device_capability_disabled' });
  request.mockRejectedValue(new Error('DEVICE_UNAVAILABLE'));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_tap', arguments: { x: 1, y: 2 } }))
    .toEqual({ action: 'deny', reason: 'device_unavailable' });
});

it('denies unknown tools and malformed arguments before any native call', async () => {
  const tooling = createDeviceTooling();
  request.mockResolvedValue(status(true, true));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'shell_exec', arguments: {} }))
    .toEqual({ action: 'deny', reason: 'device_tool_unknown' });
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_tap', arguments: 'nope' }))
    .toEqual({ action: 'deny', reason: 'invalid_arguments' });
  expect(request).not.toHaveBeenCalled();
});

it('never blocks the question tool, which has no side effect', async () => {
  const tooling = createDeviceTooling();
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'ask_user_question', arguments: { questions: [] } }))
    .toEqual({ action: 'allow', reason: 'question_tool_read_only' });
  expect(request).not.toHaveBeenCalled();
});

it('allows the read-only device info tool only while root is available', async () => {
  const tooling = createDeviceTooling();
  request.mockResolvedValue(status(true, true));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_info', arguments: {} }))
    .toEqual({ action: 'allow', reason: 'device_info_read_only' });
  request.mockResolvedValue(status(true, true, false));
  expect(await tooling.approval.evaluate({ turnId: 'turn', attemptId: 'attempt', invocationId: 'invocation', toolName: 'device_info', arguments: {} }))
    .toEqual({ action: 'deny', reason: 'root_unavailable' });
});

it('asks the ledger before every new granted action and reuses prior grants', async () => {
  request.mockResolvedValue(status(true, false));
  const requestApproval = vi.fn(async () => ({ action: 'ask_user' as const, approvalId: 'tapp_1', argumentsHash: 'hash' }));
  const tooling = createDeviceTooling({ requestApproval });
  const decision = await tooling.approval.evaluate({
    turnId: 'turn_1', attemptId: 'attempt_1', invocationId: 'inv_1',
    toolName: 'device_tap', arguments: { x: 10, y: 20 }, safetyLevel: 'privileged',
  });
  expect(decision).toEqual({ action: 'ask_user', approvalId: 'tapp_1', argumentsHash: 'hash' });
  expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'device_tap' }));

  requestApproval.mockResolvedValueOnce({ action: 'allow', reason: 'device_action_previously_approved' });
  const reused = await tooling.approval.evaluate({
    turnId: 'turn_1', attemptId: 'attempt_1', invocationId: 'inv_2',
    toolName: 'device_tap', arguments: { x: 10, y: 20 }, safetyLevel: 'privileged',
  });
  expect(reused).toMatchObject({ action: 'allow', reason: 'device_action_previously_approved' });
});
