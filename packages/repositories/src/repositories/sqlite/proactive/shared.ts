/**
 * Aervox｜思隅 @aervox/repositories — 主动画像仓储共享工具（常量/行类型/跨 Store 模型转换）
 *
 * 机械拆分自 proactive-profile-repository.ts：仅收纳被多个 Store 复用的
 * 模块级元素；单使用方的 mapper 与常量跟随其所属 Store 文件。
 */
import {
  proactiveActivationLeases,
  proactiveSourceGrants,
} from "@aervox/schema";
import { DomainConflictError } from "../../../errors.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type {
  ProactiveActivationLeaseModel,
  ProactiveSourceGrantModel,
} from "../../types/index.js";
import { decodeWithCipher } from "./crypto.js";

export const MAX_LIST_LIMIT = 500;

export const ACTION_SCOPES = new Set(["action.local", "action.external", "action.privileged", "action.irreversible"]);

export type SourceRow = typeof proactiveSourceGrants.$inferSelect;
export type LeaseRow = typeof proactiveActivationLeases.$inferSelect;

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringify(value: unknown, fallback = "{}"): string {
  if (value === undefined) return fallback;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : encoded;
  } catch {
    return fallback;
  }
}

export function clampLimit(value: number | undefined, fallback = 100): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value!)));
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function localBoundary(value: string): "local_only" {
  if (value !== "local_only") throw new DomainConflictError("proactive record is outside the local-only boundary");
  return "local_only";
}

export function datePlusMs(iso: string, ms: number): string {
  const timestamp = Date.parse(iso);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(base + ms).toISOString();
}

export function parseActionScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item.length > 0))];
}

export function toSource(row: SourceRow, cipher?: ProactiveVaultCipher): ProactiveSourceGrantModel {
  return {
    id: row.id,
    revisionId: row.revisionId,
    sourceKey: row.sourceKey,
    purpose: row.purpose,
    scope: row.scope,
    osCapability: row.osCapability,
    state: row.state as ProactiveSourceGrantModel["state"],
    mandatory: bool(row.mandatory),
    processingBoundary: localBoundary(row.processingBoundary),
    grantVersion: row.grantVersion,
    metadata: parseJson(decodeWithCipher(row.metadataJson, cipher, `source:${row.id}`), {}),
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toLease(row: LeaseRow): ProactiveActivationLeaseModel {
  return {
    id: row.id,
    revisionId: row.revisionId,
    deviceId: row.deviceId,
    epoch: row.epoch,
    status: row.status as ProactiveActivationLeaseModel["status"],
    localReady: bool(row.localReady),
    fullAccessSnapshot: bool(row.fullAccessSnapshot),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    heartbeatAt: row.heartbeatAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    metadata: parseJson(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
