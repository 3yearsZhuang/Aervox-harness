/**
 * 已确认事实的时间区间判定。区间采用 [validFrom, validTo)；来源入库时间
 * recordedAt 与事实生效时间 validFrom 分开保存，不能互相替代。
 *
 * 本模块只给出写入决策，不执行数据库写入或自动确认模型推断。
 */
export interface TemporalFact {
  id: string;
  subjectId: string;
  predicate: string;
  value: string;
  validFrom: string;
  validTo: string | null;
  sourceRevisionId: string;
  recordedAt: string;
}

export type VerifiedFactInput = Omit<TemporalFact, "validTo"> & {
  verificationStatus: "verified";
};

export type TemporalFactDecision =
  | { kind: "insert"; fact: TemporalFact }
  | { kind: "corroborate"; factId: string; sourceRevisionId: string }
  | { kind: "replace"; closeFactId: string; validTo: string; fact: TemporalFact }
  | { kind: "review"; reason: "out_of_order" | "same_time_conflict" | "source_revision_conflict"; factId: string };

function assertInstant(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp`);
  }
}

/**
 * 对一个 subject/predicate 的最新有效事实做单步判定。
 * 调用方必须在同一事务中锁定当前事实、落实决策并附加来源证据。
 * 迟到或同刻矛盾的输入交由人工/后续策略复核，不能静默改写历史。
 */
export function decideTemporalFact(
  current: TemporalFact | null,
  incoming: VerifiedFactInput,
): TemporalFactDecision {
  if (incoming.verificationStatus !== "verified") {
    throw new Error("only verified facts can enter the temporal projection");
  }
  assertInstant(incoming.validFrom, "validFrom");
  assertInstant(incoming.recordedAt, "recordedAt");
  if (!incoming.id || !incoming.subjectId || !incoming.predicate || !incoming.sourceRevisionId) {
    throw new Error("fact identity and source revision are required");
  }

  const fact: TemporalFact = {
    id: incoming.id,
    subjectId: incoming.subjectId,
    predicate: incoming.predicate,
    value: incoming.value,
    validFrom: incoming.validFrom,
    validTo: null,
    sourceRevisionId: incoming.sourceRevisionId,
    recordedAt: incoming.recordedAt,
  };
  if (!current) return { kind: "insert", fact };
  assertInstant(current.validFrom, "current.validFrom");
  if (current.validTo !== null) {
    throw new Error("current fact must have an open validity interval");
  }
  if (current.subjectId !== incoming.subjectId || current.predicate !== incoming.predicate) {
    throw new Error("facts must share a subject and predicate");
  }
  if (incoming.id === current.id && incoming.value !== current.value) {
    throw new Error("a changed fact requires a new id");
  }
  if (incoming.sourceRevisionId === current.sourceRevisionId && incoming.value !== current.value) {
    return { kind: "review", reason: "source_revision_conflict", factId: current.id };
  }
  if (incoming.validFrom < current.validFrom) {
    return { kind: "review", reason: "out_of_order", factId: current.id };
  }
  if (incoming.value === current.value) {
    return { kind: "corroborate", factId: current.id, sourceRevisionId: incoming.sourceRevisionId };
  }
  if (incoming.validFrom === current.validFrom) {
    return { kind: "review", reason: "same_time_conflict", factId: current.id };
  }
  return {
    kind: "replace",
    closeFactId: current.id,
    validTo: incoming.validFrom,
    fact,
  };
}
