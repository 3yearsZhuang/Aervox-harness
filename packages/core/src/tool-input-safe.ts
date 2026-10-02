/**
 * Aervox｜思隅 @aervox/core — 工具调用入参沙箱安全校验（B4-B）
 *
 * 规则依据：AVX-HAR-001 §9「工具执行前做参数校验、沙箱守卫与防御性拦截」。
 * 在调用任何工具（不管是 read_only、write_with_approval 还是 privileged）前执行：
 * - 空字节截断注入（\0）防御；
 * - 路径穿越防御：路径类键先做迭代 URL 解码归一化（覆盖 %2e%2e、混合编码与双重编码），
 *   再按路径分段判定上跳序列（../, ..\, ....// 等），敏感系统根目录逃逸检查对
 *   所有「整值恰为绝对路径」的字符串生效（不依赖键名白名单）；
 * - 危险命令启发式拦截（针对应含 shell/exec 的参数）：覆盖破坏性原语与管道投递；
 *   刻意不筑 shell 元字符墙——已获审批的合法复合命令（管道/顺序执行）必须放行，
 *   命令执行的真实防线是 PET-05 审批门与幂等账本；
 * - 递归深度限制与循环引用防御。
 * 边界说明：本检查为 reject-only 静态启发式，不触文件系统；符号链接逃逸
 * 由宿主工具 handler 在解析 realpath 时自行防御。
 */

export interface InspectToolInputOptions {
  /** 允许递归遍历的最大深度；默认 10 */
  maxDepth?: number;
  /** 允许的最大字符串长度；默认 65536 字符 */
  maxStringLength?: number;
}

export interface InspectedToolInput {
  safe: boolean;
  reason?: string;
  violatingKey?: string;
}

/** 路径类参数键名正则（不区分大小写） */
const PATH_KEY_PATTERN =
  /^(path|filepath|file_path|targetpath|target_path|file|filename|dir|directory|dest|destination|source|target|folder|outputpath|output_path|inputpath|input_path|savepath|save_path|uploadfile|upload_file)$/i;

/** 命令/脚本类参数键名正则（不区分大小写） */
const COMMAND_KEY_PATTERN = /^(command|cmd|script|exec|shell_cmd|shell_command|bash|sh)$/i;

/**
 * 路径分段穿越判定：任意由分隔符界定的「纯点段」（≥2 个点，含 ../、..、....// 等）。
 * 仅对已归一化（解码 + 分隔符统一）的路径类键值使用，避免误伤散文中的普通文本。
 */
const PATH_SEGMENT_TRAVERSAL_PATTERN = /(?:^|\/)\.{2,}(?:\/|$)/;

/** 敏感系统根目录穿越模式（前导斜杠折叠后判定，覆盖 //etc 与 C:\Windows 等） */
const SENSITIVE_SYSTEM_PATH_PATTERN =
  /^(?:[a-z]:)?\/+(?:etc|proc|sys|dev|root|boot|windows|system32)(?:\/|$)/i;

/**
 * 危险命令注入启发式模式：破坏性原语（任意旗标组合的递归/强制 rm、mkfs、dd 落盘、
 * 整盘重定向、关机重启、sudo 提权破坏）与管道投递（任意命令 | sh、xargs rm）。
 */
const DANGEROUS_COMMAND_PATTERN =
  /(?:;\s*rm(?:\s+-[a-zA-Z]*f|\s+-[a-zA-Z]*r)|\brm\s+(?:-{1,2}[a-z-]+\s+)*-{1,2}[a-z]*[rf][a-z]*(?:\s|$)|\|\s*(?:ba|z|da)?sh\b|\bxargs\b[^;&|]*\brm\b|\bsudo\s+(?:rm|dd|mkfs)\b|\bmkfs(?:\.\w+)?\b|\bdd\b[^;&|]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|hd|disk)|\b(?:shutdown|reboot|halt|poweroff)\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:)/i;

/**
 * 归一化候选路径串：迭代 URL 解码（≤2 轮，覆盖 %2e%2e 单层与 %252e%252e 双重编码、
 * .%2e 混合编码）并统一反斜杠为正斜杠；解码失败（非法序列）回退原文。
 */
function normalizePathLike(raw: string): string {
  let s = raw.trim();
  for (let round = 0; round < 2 && /%[0-9a-f]{2}/i.test(s); round++) {
    try {
      s = decodeURIComponent(s);
    } catch {
      break;
    }
  }
  return s.replace(/\\/g, "/");
}

/**
 * 递归安全检查工具入参
 */
export function inspectToolInput(
  input: { name: string; arguments: unknown },
  options?: InspectToolInputOptions,
): InspectedToolInput {
  const maxDepth = options?.maxDepth ?? 10;
  const maxStringLength = options?.maxStringLength ?? 65536;
  const seen = new WeakSet<object>();

  function validateValue(
    val: unknown,
    keyPath: string,
    currentKey: string,
    depth: number,
  ): InspectedToolInput | null {
    if (depth > maxDepth) {
      return {
        safe: false,
        reason: "max_nesting_depth_exceeded",
        violatingKey: keyPath,
      };
    }

    if (val === null || val === undefined) {
      return null;
    }

    if (typeof val === "string") {
      if (val.length > maxStringLength) {
        return {
          safe: false,
          reason: "argument_string_too_long",
          violatingKey: keyPath,
        };
      }

      // 1. 空字节注入检查（普遍应用于所有字符串字段）
      if (val.includes("\0") || val.includes("\u0000")) {
        return {
          safe: false,
          reason: "null_byte_injection",
          violatingKey: keyPath,
        };
      }

      const isPathKey = PATH_KEY_PATTERN.test(currentKey);

      // 2. 针对路径类参数的严格沙箱穿越校验（归一化后按分段判定，覆盖混合/双重编码）
      if (isPathKey) {
        const normalized = normalizePathLike(val);
        if (PATH_SEGMENT_TRAVERSAL_PATTERN.test(normalized)) {
          return {
            safe: false,
            reason: "path_traversal_sequence",
            violatingKey: keyPath,
          };
        }
        if (SENSITIVE_SYSTEM_PATH_PATTERN.test(normalized)) {
          return {
            safe: false,
            reason: "sensitive_system_path_escape",
            violatingKey: keyPath,
          };
        }
      } else {
        // 非路径键保守兜底：连续上跳特征（如 ../../）依然拦截；
        // 整值恰为敏感系统绝对路径时同样拦截（不依赖键名命名，覆盖 db_file 等白名单外路径键）
        if (/(?:\.\.[\\/]){2,}/.test(val)) {
          return {
            safe: false,
            reason: "path_traversal_sequence",
            violatingKey: keyPath,
          };
        }
        if (SENSITIVE_SYSTEM_PATH_PATTERN.test(normalizePathLike(val))) {
          return {
            safe: false,
            reason: "sensitive_system_path_escape",
            violatingKey: keyPath,
          };
        }
      }

      // 3. 针对命令类参数的危险注入拦截
      if (COMMAND_KEY_PATTERN.test(currentKey)) {
        if (DANGEROUS_COMMAND_PATTERN.test(val)) {
          return {
            safe: false,
            reason: "dangerous_command_injection",
            violatingKey: keyPath,
          };
        }
      }

      return null;
    }

    if (typeof val === "object") {
      if (seen.has(val)) {
        return {
          safe: false,
          reason: "circular_reference_detected",
          violatingKey: keyPath,
        };
      }
      seen.add(val);

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const itemKey = `${keyPath}[${i}]`;
          const violation = validateValue(val[i], itemKey, currentKey, depth + 1);
          if (violation) return violation;
        }
      } else {
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          const childPath = keyPath ? `${keyPath}.${k}` : k;
          const violation = validateValue(v, childPath, k, depth + 1);
          if (violation) return violation;
        }
      }
    }

    return null;
  }

  const violation = validateValue(input.arguments, "", "", 0);
  if (violation) {
    return violation;
  }

  return { safe: true };
}
