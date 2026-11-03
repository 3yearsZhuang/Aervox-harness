/** Typed access to the fixed native device channel. Every action is a bounded
 * verb from the native allowlist; the WebView can never supply a shell line,
 * a path or a verb the settings have not enabled. */
import { nativeRequest } from './native-channel';

export type DeviceCapability = 'control' | 'apps' | 'advanced';
export type DeviceKey = 'BACK' | 'HOME' | 'RECENTS' | 'ENTER' | 'DEL' | 'TAB' | 'VOLUME_UP' | 'VOLUME_DOWN';
export interface DeviceStatus { root: boolean; shizuku?: boolean; capabilities: Record<DeviceCapability, boolean>; busy?: boolean; sdk?: number; device?: string }
export type DeviceAction =
  | { action: 'info' }
  | { action: 'command'; line: string }
  | { action: 'tap'; x: number; y: number }
  | { action: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: 'key'; key: DeviceKey }
  | { action: 'text'; value: string }
  | { action: 'launch'; package: string };
export interface DeviceReceipt { ok: true; action: string; output: string }
const invalid = () => new Error('INVALID_DEVICE_RECEIPT');
function status(value: unknown): DeviceStatus {
  if (!value || typeof value !== 'object') throw invalid();
  const item = value as Partial<DeviceStatus> & { kind?: string };
  if (item.kind !== 'device_status' || typeof item.root !== 'boolean' || !item.capabilities
    || typeof item.capabilities.control !== 'boolean' || typeof item.capabilities.apps !== 'boolean'
    || typeof item.capabilities.advanced !== 'boolean') throw invalid();
  return { root: item.root, ...(typeof item.shizuku === 'boolean' ? { shizuku: item.shizuku } : {}), capabilities: { control: item.capabilities.control, apps: item.capabilities.apps, advanced: item.capabilities.advanced },
    ...(typeof item.busy === 'boolean' ? { busy: item.busy } : {}),
    ...(typeof item.sdk === 'number' ? { sdk: item.sdk } : {}),
    ...(typeof item.device === 'string' ? { device: item.device } : {}) };
}
export async function readDeviceStatus(): Promise<DeviceStatus> {
  return status(await nativeRequest({ op: 'device', operation: 'status' }));
}
export async function grantDeviceCapability(capability: DeviceCapability, enabled: boolean): Promise<DeviceStatus> {
  return status(await nativeRequest({ op: 'device', operation: 'grant', capability, enabled }));
}
export async function performDeviceAction(action: DeviceAction): Promise<DeviceReceipt> {
  const value = await nativeRequest({ op: 'device', operation: 'perform', ...action });
  if (!value || typeof value !== 'object') throw invalid();
  const item = value as Partial<DeviceReceipt> & { kind?: string };
  if (item.kind !== 'device_result' || item.ok !== true || typeof item.action !== 'string' || typeof item.output !== 'string') throw invalid();
  return { ok: true, action: item.action, output: item.output };
}
/** Fixed reasons the user can act on; raw native diagnostics stay native. */
export function deviceError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'ROOT_UNAVAILABLE': return '设备操作需要 root 或已授权的 Shizuku。请确认 su 可用、或安装并授权 Shizuku 后重试。';
    case 'DEVICE_CAPABILITY_DISABLED': return '这项设备操作没有在设置中开启。';
    case 'DEVICE_BUSY': return '上一条设备操作还没结束，请稍后再试。';
    case 'COMMAND_TIMEOUT': return '设备操作超时，系统没有确认结果。';
    case 'UNSUPPORTED_DEVICE_ACTION': return '不支持这项设备操作。';
    case 'INVALID_ARGUMENT': return '设备操作的参数不合法。';
    case 'NOT_FOREGROUND': return '设备操作只在应用位于前台时可用。';
    default: return '设备操作没有完成，可以稍后重试。';
  }
}
