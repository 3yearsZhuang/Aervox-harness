/**
 * Aervox｜思隅 @aervox/api-client — SSE 帧解析的唯一实现。
 *
 * 三处消费方（Web 传输、桌面传输、desktop 主进程的主动事件常驻订阅）此前各自解析
 * 帧并给出不同结果：一处只剥单个前导空格、一处 `.trim()`、一处还用 `join('')`
 * 把多行 `data:` 粘连。多行载荷在 JSON 场景下恰好无损，因此差异长期不可见；
 * 一旦上游发送非 JSON 分段就会静默损坏。这里提供一份按 SSE 规范处理的结果，
 * 调用方只负责在解析后做各自的类型校验。
 */

/** 单个 `data:` 字段去掉一个前导空格（规范只允许剥一个，其余空白属于数据）。 */
function fieldValue(line: string): string {
  const value = line.slice(5);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/**
 * 从一个已按 `\n\n` 切分的事件块中取出 `data` 载荷。
 *
 * 多个 `data:` 行按规范以 `\n` 连接；`event:`、`id:`、`retry:` 与注释行不进入载荷。
 * 返回空串表示该块没有数据字段（心跳或纯注释），调用方据此走心跳分支。
 */
export function parseSseData(block: string): string {
  const lines = block.split('\n');
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    data.push(fieldValue(line));
  }
  return data.join('\n');
}

/**
 * 解析一个 SSE 事件块为 JSON 值。
 *
 * 无数据字段或数据不是合法 JSON 时返回 `undefined`；调用方需要区分「心跳」
 * 与「畸形帧」时，先用 `parseSseData` 判断是否为空串。
 */
export function parseSseJson(block: string): unknown {
  const data = parseSseData(block);
  if (data.length === 0) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
