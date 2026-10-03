/**
 * Aervox｜思隅 @aervox/ui — 工作台启动期决策（CR-060）
 *
 * 宿主启动期有两件事必须按**确定顺序**发生：
 * 1. 先同步插件（插件在其 `setup()` 阶段经通用接缝表达启动期诉求，如 `quietStartup`）；
 * 2. 再判定是否执行首开日记生成（会抢占卡片槽位，属打扰性动作）。
 *
 * 这两步此前写在同一次 `onMounted` 的两个独立异步 IIFE 里，读取早于写入，
 * 使插件诉求永远观察不到（CR-060 评审 D 项）。此处把顺序与判定收敛为可单测的单元，
 * 宿主组件不再自行编排该时序。
 */

/** 启动期日记生成所需的宿主依赖 */
export interface StartupDiaryDeps<T> {
  /** 插件已表达的启动期静默诉求（`layout.quietStartup`） */
  quietStartup: boolean;
  /** 首开标记键（同一天只生成一次） */
  markerKey: string;
  /** 本地存储（注入以便测试） */
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** 生成今日日记 */
  generateToday: () => Promise<T | undefined | null>;
  /** 生成成功且有正文时的落位动作（抢占卡片槽位等） */
  applyGenerated: (result: T) => void;
}

export type StartupDiaryOutcome =
  | 'skipped-quiet-startup'
  | 'skipped-already-generated'
  | 'generated'
  | 'failed';

/**
 * 在插件同步完成后读取启动期静默诉求。
 *
 * 顺序即契约：插件只能在自身 `setup()` 期间表达诉求，因此宿主必须先 `await` 插件同步，
 * 再读取该标志；反过来读永远是初始值（这正是此前的缺陷）。
 */
export async function resolveStartupQuiet(
  pluginStartup: Promise<unknown>,
  readQuietStartup: () => boolean,
): Promise<boolean> {
  // 插件同步失败不得阻断宿主启动，也不得让启动期静默失效（失败时按未诉求处理）
  await pluginStartup.catch(() => undefined);
  return readQuietStartup();
}

/**
 * 执行首开日记生成。
 *
 * 尊重插件诉求：已表达启动期静默时**不生成**，也不写标记（下一轮仍可生成）。
 */
export async function runStartupDiary<T>(
  deps: StartupDiaryDeps<T>,
): Promise<StartupDiaryOutcome> {
  if (deps.quietStartup) return 'skipped-quiet-startup';
  if (deps.storage.getItem(deps.markerKey)) return 'skipped-already-generated';

  try {
    const result = await deps.generateToday();
    if (result && (result as { content?: string | null }).content) {
      deps.applyGenerated(result);
    }
    deps.storage.setItem(deps.markerKey, '1');
    return 'generated';
  } catch {
    // 失败不写标记，允许下一轮重试
    return 'failed';
  }
}
