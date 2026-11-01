/** Device tools for the first-party agent on Android.
 *
 * Two independent gates protect every call: the native channel only runs verbs
 * the user enabled in settings, and Core's approval policy re-reads that grant
 * before a side effect is invoked. Model output is validated here as untrusted
 * data — integers, enumerations and a package-name shape — so a malformed tool
 * call becomes a refusal instead of an argument.
 */
import type { ApprovalPolicyPort, ToolProviderPort, ToolSpec, ToolExecutionResult } from '@aervox/core/browser';
import { performDeviceAction, readDeviceStatus, type DeviceAction, type DeviceCapability, type DeviceKey, type DeviceStatus } from './native-device';

const KEY_NAMES: readonly DeviceKey[] = ['BACK', 'HOME', 'RECENTS', 'ENTER', 'DEL', 'TAB', 'VOLUME_UP', 'VOLUME_DOWN'];
const MAX_COORDINATE = 20_000;
const packageName = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 150 && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]{1,64}){1,8}$/.test(value);
const integer = (value: unknown, max = MAX_COORDINATE): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

interface DeviceTool { spec: ToolSpec; capability: DeviceCapability; build(args: Record<string, unknown>): DeviceAction | undefined }

const TOOLS: DeviceTool[] = [
  {
    capability: 'control',
    spec: {
      name: 'device_tap', readOnly: false, safetyLevel: 'privileged',
      description: '在当前手机屏幕上点击一个坐标（像素）。仅在用户明确要求操作手机时使用。',
      parameters: { type: 'object', additionalProperties: false, required: ['x', 'y'],
        properties: { x: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE }, y: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE } } },
    },
    build: args => {
      const x = integer(args.x), y = integer(args.y);
      return x === undefined || y === undefined ? undefined : { action: 'tap', x, y };
    },
  },
  {
    capability: 'control',
    spec: {
      name: 'device_swipe', readOnly: false, safetyLevel: 'privileged',
      description: '在手机屏幕上滑动：给出起点、终点坐标和可选时长（毫秒）。',
      parameters: { type: 'object', additionalProperties: false, required: ['x1', 'y1', 'x2', 'y2'],
        properties: { x1: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE }, y1: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE },
          x2: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE }, y2: { type: 'integer', minimum: 0, maximum: MAX_COORDINATE },
          durationMs: { type: 'integer', minimum: 50, maximum: 10_000 } } },
    },
    build: args => {
      const x1 = integer(args.x1), y1 = integer(args.y1), x2 = integer(args.x2), y2 = integer(args.y2);
      const duration = args.durationMs === undefined ? undefined : integer(args.durationMs, 10_000);
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
      if (args.durationMs !== undefined && (duration === undefined || duration < 50)) return undefined;
      return { action: 'swipe', x1, y1, x2, y2, ...(duration === undefined ? {} : { durationMs: duration }) };
    },
  },
  {
    capability: 'control',
    spec: {
      name: 'device_key', readOnly: false, safetyLevel: 'privileged',
      description: '按下系统按键：BACK、HOME、RECENTS、ENTER、DEL、TAB 或音量键。',
      parameters: { type: 'object', additionalProperties: false, required: ['key'],
        properties: { key: { type: 'string', enum: [...KEY_NAMES] } } },
    },
    build: args => typeof args.key === 'string' && KEY_NAMES.includes(args.key as DeviceKey)
      ? { action: 'key', key: args.key as DeviceKey } : undefined,
  },
  {
    capability: 'control',
    spec: {
      name: 'device_text', readOnly: false, safetyLevel: 'privileged',
      description: '向当前输入框键入一段文本。只支持可打印 ASCII 字符，最多 200 个。',
      parameters: { type: 'object', additionalProperties: false, required: ['value'],
        properties: { value: { type: 'string', minLength: 1, maxLength: 200 } } },
    },
    build: args => {
      const value = args.value;
      if (typeof value !== 'string' || !value || value.length > 200) return undefined;
      for (const character of value) if (character < ' ' || character > '~' || character === "'") return undefined;
      return { action: 'text', value };
    },
  },
  {
    capability: 'apps',
    spec: {
      name: 'device_launch_app', readOnly: false, safetyLevel: 'privileged',
      description: '按包名打开一个已安装应用的启动页，例如 com.android.settings。',
      parameters: { type: 'object', additionalProperties: false, required: ['package'],
        properties: { package: { type: 'string', minLength: 3, maxLength: 150 } } },
    },
    build: args => packageName(args.package) ? { action: 'launch', package: args.package } : undefined,
  },
];

const infoTool: ToolSpec = {
  name: 'device_info', readOnly: true, safetyLevel: 'read_only',
  description: '读取这台手机的 Android 版本、型号与 root 可用性。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
};

export interface DeviceTooling {
  provider: ToolProviderPort;
  approval: ApprovalPolicyPort;
  /** Latest observed grants; settings and tool listing share one read. */
  status(): Promise<DeviceStatus>;
}

export function createDeviceTooling(): DeviceTooling {
  const enabled = (status: DeviceStatus, capability: DeviceCapability) => status.root && status.capabilities[capability];
  const provider: ToolProviderPort = {
    tools: [],
    async listTools() {
      let status: DeviceStatus;
      try { status = await readDeviceStatus(); } catch { return []; }
      // Declaring any tool changes the provider request shape, so nothing is
      // offered unless this phone can actually execute a device action.
      if (!status.root) return [];
      const available = TOOLS.filter(tool => status.capabilities[tool.capability]).map(tool => tool.spec);
      return [infoTool, ...available];
    },
    async execute(input): Promise<ToolExecutionResult> {
      if (input.name === 'device_info') {
        try {
          const receipt = await performDeviceAction({ action: 'info' });
          return { ok: true, output: receipt.output };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'DEVICE_UNAVAILABLE' }; }
      }
      const tool = TOOLS.find(item => item.spec.name === input.name);
      if (!tool) return { ok: false, error: 'tool_not_registered' };
      const action = tool.build(record(input.arguments));
      if (!action) return { ok: false, error: 'invalid_arguments' };
      try {
        const receipt = await performDeviceAction(action);
        return { ok: true, output: receipt.output || receipt.action };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'DEVICE_FAILED' }; }
    },
  };
  const approval: ApprovalPolicyPort = {
    async evaluate(request) {
      const tool = TOOLS.find(item => item.spec.name === request.toolName);
      if (!tool) return { action: 'deny', reason: 'device_tool_unknown' };
      const action = tool.build(record(request.arguments));
      if (!action) return { action: 'deny', reason: 'invalid_arguments' };
      try {
        const status = await readDeviceStatus();
        return enabled(status, tool.capability)
          ? { action: 'allow', reason: 'device_capability_granted', metadata: { capability: tool.capability } }
          : { action: 'deny', reason: 'device_capability_disabled' };
      } catch { return { action: 'deny', reason: 'device_unavailable' }; }
    },
  };
  return { provider, approval, status: readDeviceStatus };
}
