import { describe, expect, it } from "vitest";
import { redactCredentialMaterial } from "../src/redaction.js";

describe("redactCredentialMaterial (single implementation)", () => {
  it("removes private key blocks", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
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
