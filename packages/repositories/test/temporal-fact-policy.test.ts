import { describe, expect, it } from "vitest";
import { decideTemporalFact, type TemporalFact, type VerifiedFactInput } from "../src/temporal-fact-policy.js";

const beijing: TemporalFact = {
  id: "fact_beijing",
  subjectId: "user_1",
  predicate: "residence_city",
  value: "北京",
  validFrom: "2025-01-01T00:00:00.000Z",
  validTo: null,
  sourceRevisionId: "source_1",
  recordedAt: "2025-01-03T00:00:00.000Z",
};

function input(overrides: Partial<VerifiedFactInput> = {}): VerifiedFactInput {
  return {
    id: "fact_shanghai",
    subjectId: "user_1",
    predicate: "residence_city",
    value: "上海",
    validFrom: "2026-03-01T00:00:00.000Z",
    sourceRevisionId: "source_2",
    recordedAt: "2026-03-05T00:00:00.000Z",
    verificationStatus: "verified",
    ...overrides,
  };
}

describe("已确认事实的时间判定", () => {
  it("首次出现时创建开放的有效区间，同时保留独立的来源入库时间", () => {
    expect(decideTemporalFact(null, input())).toEqual({
      kind: "insert",
      fact: {
        id: "fact_shanghai", subjectId: "user_1", predicate: "residence_city", value: "上海",
        validFrom: "2026-03-01T00:00:00.000Z", validTo: null,
        sourceRevisionId: "source_2", recordedAt: "2026-03-05T00:00:00.000Z",
      },
    });
  });

  it("较新的不同事实关闭旧区间，旧事实仍可用于历史查询", () => {
    expect(decideTemporalFact(beijing, input())).toEqual({
      kind: "replace",
      closeFactId: beijing.id,
      validTo: "2026-03-01T00:00:00.000Z",
      fact: {
        id: "fact_shanghai", subjectId: "user_1", predicate: "residence_city", value: "上海",
        validFrom: "2026-03-01T00:00:00.000Z", validTo: null,
        sourceRevisionId: "source_2", recordedAt: "2026-03-05T00:00:00.000Z",
      },
    });
    expect(beijing.validTo).toBeNull();
  });

  it("重复事实只增加证据，不重置生效时间", () => {
    expect(decideTemporalFact(beijing, input({ value: "北京" }))).toEqual({
      kind: "corroborate", factId: beijing.id, sourceRevisionId: "source_2",
    });
  });

  it("同刻矛盾和迟到事实均要求复核", () => {
    expect(decideTemporalFact(beijing, input({ validFrom: beijing.validFrom }))).toEqual({
      kind: "review", reason: "same_time_conflict", factId: beijing.id,
    });
    expect(decideTemporalFact(beijing, input({ validFrom: "2024-12-01T00:00:00.000Z" }))).toEqual({
      kind: "review", reason: "out_of_order", factId: beijing.id,
    });
    expect(decideTemporalFact(beijing, input({ sourceRevisionId: "source_1" }))).toEqual({
      kind: "review", reason: "source_revision_conflict", factId: beijing.id,
    });
  });

  it("拒绝跨主体比较、已关闭区间和非规范时间", () => {
    expect(() => decideTemporalFact(beijing, input({ subjectId: "user_2" }))).toThrow("subject and predicate");
    expect(() => decideTemporalFact({ ...beijing, validTo: "2026-01-01T00:00:00.000Z" }, input())).toThrow("open validity interval");
    expect(() => decideTemporalFact(beijing, input({ validFrom: "2026-03-01" }))).toThrow("canonical UTC");
    expect(() => decideTemporalFact(beijing, { ...input(), verificationStatus: "unverified" } as unknown as VerifiedFactInput)).toThrow("only verified facts");
  });
});
