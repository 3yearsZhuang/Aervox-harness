/**
 * Aervox｜思隅 @aervox/ui — 桌宠虚拟形象资产包加载与语义动作解析器
 */
import {
  avatarManifestSchema,
  type AvatarManifest,
  type AvatarSemanticMotionKind,
  type AvatarPose,
} from '@aervox/contracts';

export class AvatarBundle {
  constructor(
    readonly manifest: AvatarManifest,
    readonly baseUrl: string,
  ) {}

  /** 解析模型入口文件的完整解析路径 */
  get entrypointUrl(): string {
    return new URL(this.manifest.entrypoint, this.baseUrl).toString();
  }

  /** 获取指定语义的动作列表（如 "happy", "think"），若未定义返回空数组 */
  getMotions(kind: AvatarSemanticMotionKind | string): string[] {
    return this.manifest.semanticMotions[kind] ?? [];
  }

  /** 获取指定语义的组合姿态列表（motion + expression） */
  getPoses(kind: AvatarSemanticMotionKind | string): AvatarPose[] {
    return this.manifest.poses?.[kind] ?? [];
  }

  /** 随机选取指定语义的动作名称 */
  pickMotion(kind: AvatarSemanticMotionKind | string): string | undefined {
    const pool = this.getMotions(kind);
    if (pool.length === 0) return undefined;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 随机选取指定语义的组合姿态 */
  pickPose(kind: AvatarSemanticMotionKind | string, previous?: AvatarPose): AvatarPose | undefined {
    const pool = this.getPoses(kind);
    if (pool.length === 0) return undefined;
    if (pool.length === 1) return pool[0];
    let picked = pool[Math.floor(Math.random() * pool.length)];
    if (previous && picked.motion === previous.motion && picked.expression === previous.expression) {
      picked = pool[(pool.indexOf(picked) + 1) % pool.length];
    }
    return picked;
  }
}

/** 校验并解析 avatar.manifest.json 内容 */
export function parseAvatarManifest(raw: unknown, baseUrl: string): AvatarBundle {
  const manifest = avatarManifestSchema.parse(raw);
  return new AvatarBundle(manifest, baseUrl);
}
