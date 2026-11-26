/**
 * Aervox｜思隅 @aervox/contracts — 凭据材料脱敏的唯一实现。
 *
 * 桌面主进程的画像来源采集与 Worker 的主动提炼都会把外部文本写入本地画像，
 * 两者此前各持一份逐字相同的正则集合。这是安全红线：任一侧新增一类凭据却
 * 忘记同步另一侧，就会产生一条真实的泄漏路径。正则只在此处维护。
 *
 * 该函数只删除可直接用于认证的材料（私钥块、云访问密钥、JWT、键值对形式的
 * 口令/令牌），不判断「私人内容」——那属于画像策略，不是脱敏。
 */

const PRIVATE_KEY = "[已排除私钥]";
const ACCESS_KEY = "[已排除访问密钥]";
const TOKEN = "[已排除令牌]";
const SECRET_SUFFIX = "=[已排除凭据]";

/**
 * 删除文本中可直接用于认证的材料。
 *
 * 幂等：对已脱敏文本再次调用不会改变结果，占位符不匹配任何模式。
 */
export function redactCredentialMaterial(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
      PRIVATE_KEY,
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, ACCESS_KEY)
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, TOKEN)
    .replace(
      /\b(password|passwd|passcode|token|api[_-]?key|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi,
      (_match, key: string) => `${key}${SECRET_SUFFIX}`,
    );
}
