/**
 * Aervox｜思隅 @aervox/agent-loop — 工具调用入参沙箱安全校验（B4-B）
 *
 * 规则依据：AVX-HAR-001 §9「工具执行前做参数校验、沙箱守卫与防御性拦截」。
 * 在调用任何工具（不管是 read_only、write_with_approval 还是 privileged）前执行：
 * - 空字节截断注入（\0）防御；
 * - 路径穿越（../, ..\, %2e%2e）防御与敏感目录逃逸防护；
 * - 危险命令注入启发式拦截（针对应含 shell/exec 的参数）；
 * - 递归深度限制与循环引用防御。
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

/** 路径穿越序列正则（含标准分段与常用 URL 编码） */
const PATH_TRAVERSAL_PATTERN =
  /(?:^|[\\/])\.\.(?:[\\/]|$)|%2e%2e[\\/]|%2e%2e%2f|%2e%2e%5c|\.\.%2f|\.\.%5c|%252e%252e/i;

/** 敏感系统根目录穿越模式 */
const SENSITIVE_SYSTEM_PATH_PATTERN =
  /^(?:\/|[a-zA-Z]:[\\/])(?:etc|proc|sys|dev|root|boot|Windows|System32)(?:[\\/]|$)/i;

/** 危险命令注入启发式模式 */
const DANGEROUS_COMMAND_PATTERN =
  /(?:;\s*rm(?:\s+-[a-zA-Z]*f|\s+-[a-zA-Z]*r)|\brm\s+-rf\b|\bcurl\s+.*\|\s*(?:ba)?sh\b|\bwget\s+.*\|\s*(?:ba)?sh\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:)/i;

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

      // 2. 针对路径类参数的严格沙箱穿越校验
      if (isPathKey) {
        if (PATH_TRAVERSAL_PATTERN.test(val)) {
          return {
            safe: false,
            reason: "path_traversal_sequence",
            violatingKey: keyPath,
          };
        }
        if (SENSITIVE_SYSTEM_PATH_PATTERN.test(val.trim())) {
          return {
            safe: false,
            reason: "sensitive_system_path_escape",
            violatingKey: keyPath,
          };
        }
      } else {
        // 非路径键，但若出现明显的连续上跳特征（如 ../../ 或 /etc/passwd）依然拦截
        if (/(?:\.\.[\\/]){2,}/.test(val) || PATH_TRAVERSAL_PATTERN.test(val) && SENSITIVE_SYSTEM_PATH_PATTERN.test(val)) {
          return {
            safe: false,
            reason: "path_traversal_sequence",
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
