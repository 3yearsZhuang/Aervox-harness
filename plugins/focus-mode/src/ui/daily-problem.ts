/**
 * Aervox｜思隅 plugins/focus-mode — 「每日一题」外部入口（CR-060 §B9b 自宿主迁入）
 *
 * 该入口原在宿主 `useWorkbenchCards` 内硬编码第三方刷题平台地址，而消费者只有本插件的
 * 学习卡片——属产品域内容误置宿主。迁入后宿主不再感知该地址。
 */

/** 每日一题（第三方刷题平台） */
export const DAILY_PROBLEM_URL = 'https://www.nowcoder.com/problem/tracker';

/**
 * 在系统浏览器打开每日一题。
 *
 * 说明：宿主原实现附带宠物表情反馈与活动埋点，二者均依赖宿主内部设施（宠物反应组合式
 * 函数与活动记录回调），且未提供领域中立的通用接缝，故解耦时一并去除——它们不承载
 * 功能语义。若后续确需恢复，应新增通用接缝而不是让插件反向依赖宿主内部模块。
 */
export function openDailyProblem(): void {
  const desktopBridge = (window as Window & {
    fairyDesktop?: { openExternal?: (url: string) => Promise<void> };
  }).fairyDesktop;
  if (desktopBridge?.openExternal) void desktopBridge.openExternal(DAILY_PROBLEM_URL);
  else window.open(DAILY_PROBLEM_URL, '_blank', 'noopener,noreferrer');
}
