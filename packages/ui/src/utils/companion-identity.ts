/**
 * Aervox｜思隅 @aervox/ui — 陪伴身份模型（ADR-027）
 *
 * 命名分层：思隅 = 空间与介质（固定软件名）；companionName = 陪伴角色名（可改）；
 * userAddress = 角色对用户的称呼（可改）。旧设置的 assistantName 语义并入
 * companionName——值恰为「思隅」时视为早期误命名，回默认「小隅」。
 */

export interface CompanionIdentity {
  companionName: string;
  userAddress: string;
}

export const COMPANION_DEFAULT_NAME = '小隅';
export const USER_DEFAULT_ADDRESS = '你';
/** 空间名固定为「思隅」，不可配置 */
export const SPACE_NAME = '思隅';

const SETTINGS_KEY = 'aervox-settings';

export function readCompanionIdentity(storage?: Pick<Storage, 'getItem'>): CompanionIdentity {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!store) return { companionName: COMPANION_DEFAULT_NAME, userAddress: USER_DEFAULT_ADDRESS };
  try {
    const raw = store.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const legacy = typeof parsed.assistantName === 'string' ? parsed.assistantName.trim() : '';
    const saved = typeof parsed.companionName === 'string' ? parsed.companionName.trim() : '';
    const address = typeof parsed.userAddress === 'string' ? parsed.userAddress.trim() : '';
    return {
      companionName: saved || (legacy && legacy !== SPACE_NAME ? legacy : '') || COMPANION_DEFAULT_NAME,
      userAddress: address || USER_DEFAULT_ADDRESS,
    };
  } catch {
    return { companionName: COMPANION_DEFAULT_NAME, userAddress: USER_DEFAULT_ADDRESS };
  }
}

export function saveCompanionIdentity(patch: Partial<CompanionIdentity>, storage?: Pick<Storage, 'getItem' | 'setItem'>): CompanionIdentity {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const current = readCompanionIdentity(store);
  const next: CompanionIdentity = {
    companionName: patch.companionName?.trim() || current.companionName,
    userAddress: patch.userAddress?.trim() || current.userAddress,
  };
  if (!store) return next;
  try {
    const raw = store.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    delete parsed.assistantName;
    store.setItem(SETTINGS_KEY, JSON.stringify({
      ...parsed,
      companionName: next.companionName,
      userAddress: next.userAddress,
    }));
  } catch {
    // 存储不可用时仅返回内存值
  }
  return next;
}
