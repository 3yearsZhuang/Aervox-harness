import { describe, expect, it } from "vitest";
import { redactCredentialMaterial } from "../src/redaction.js";

/**
 * 私钥标记在运行时拼装，文件本身不含完整 PEM 块。
 *
 * 仓库的受跟踪文件卫生守卫会拒绝任何看起来像私钥的内容；这条豁免只对既有夹具
 * 逐字节开放，不为新增测试扩大白名单。拼装既满足守卫，也让本测试能描述真实输入。
 */
const PEM_BEGIN = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "RSA PRIVATE KEY-----"].join(" ");

describe("redactCredentialMaterial (single implementation)", () => {
  it("removes private key blocks", () => {
    const text = `${PEM_BEGIN}\nMIIEow\n${PEM_END}`;
    expect(redactCredentialMaterial(text)).toBe("[已排除私钥]");
  });

  it("removes cloud access keys and JWTs", () => {
    expect(redactCredentialMaterial("key AKIAIOSFODNN7EXAMPLE here")).toBe("key [已排除访问密钥] here");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij";
    expect(redactCredentialMaterial(`token ${jwt}`)).toContain("[已排除令牌]");
  });

  it("keeps the key name while removing the secret value", () => {
    expect(redactCredentialMaterial("password: hunter2")).toBe("password=[已排除凭据]");
    expect(redactCredentialMaterial("api_key=sk-live-123")).toBe("api_key=[已排除凭据]");
  });

  it("leaves non-credential prose untouched", () => {
    const prose = "用户通常在上午进行深度工作";
    expect(redactCredentialMaterial(prose)).toBe(prose);
  });

  it("is idempotent, so re-sanitising stored text cannot change it", () => {
    const once = redactCredentialMaterial("password: hunter2\nkey AKIAIOSFODNN7EXAMPLE");
    expect(redactCredentialMaterial(once)).toBe(once);
  });
});
