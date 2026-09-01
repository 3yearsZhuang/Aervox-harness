/**
 * Aervox｜思隅 @aervox/ui — 插件安装表单纯函数校验（CAP-020 扩展中心）
 *
 * 与 PluginInstallDialog.vue 解耦以便单测：只做结构与 JSON 合法性校验，
 * 不做安全裁决——permissions/tools 的授权与越权边界在 API 侧工具注册表
 * （PET-05 安全级别）与 ADR-009 沙箱约束，表单只负责把声明原样提交。
 */

export interface PluginInstallFormValues {
  id: string;
  publisher: string;
  version: string;
  /** 权限声明 JSON 文本（可空；缺省由 API 落 []） */
  rawPermissions: string;
  /** 声明工具 JSON 数组文本（可空） */
  rawTools: string;
  /** 声明技能 JSON 数组文本（可空；每项须含 name + content） */
  rawSkills: string;
}

export interface PluginInstallPayload {
  id: string;
  publisher: string;
  version: string;
  permissions?: unknown;
  tools?: unknown[];
  skills?: Array<{ name: string; description?: string; content: string }>;
}

export type PluginInstallFormResult =
  | { ok: true; payload: PluginInstallPayload }
  | { ok: false; message: string };

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** 校验安装表单并产出 POST /v1/plugins 载荷（installSource 由调用方附加） */
export function validatePluginInstallForm(values: PluginInstallFormValues): PluginInstallFormResult {
  const id = values.id.trim();
  const publisher = values.publisher.trim();
  const version = values.version.trim();
  if (!id || !publisher || !version) {
    return { ok: false, message: '请填写插件 ID、发布者与版本号' };
  }

  let permissions: unknown;
  if (values.rawPermissions.trim()) {
    const parsed = parseJson(values.rawPermissions);
    if (!parsed.ok) return { ok: false, message: '权限声明 JSON 格式不合法' };
    permissions = parsed.value;
  }

  let tools: unknown[] | undefined;
  if (values.rawTools.trim()) {
    const parsed = parseJson(values.rawTools);
    if (!parsed.ok) return { ok: false, message: '声明工具 JSON 格式不合法' };
    if (!Array.isArray(parsed.value)) {
      return { ok: false, message: '声明工具必须是数组（每项含 name/description/category）' };
    }
    for (const tool of parsed.value) {
      if (typeof tool !== 'object' || tool === null || typeof (tool as {name?: unknown}).name !== 'string') {
        return { ok: false, message: '声明工具每项必须含字符串 name 字段' };
      }
    }
    tools = parsed.value;
  }

  let skills: Array<{ name: string; description?: string; content: string }> | undefined;
  if (values.rawSkills.trim()) {
    const parsed = parseJson(values.rawSkills);
    if (!parsed.ok) return { ok: false, message: '声明技能 JSON 格式不合法' };
    if (!Array.isArray(parsed.value)) {
      return { ok: false, message: '声明技能必须是数组（每项含 name/content）' };
    }
    const normalized: Array<{ name: string; description?: string; content: string }> = [];
    for (const skill of parsed.value) {
      if (typeof skill !== 'object' || skill === null) {
        return { ok: false, message: '声明技能每项必须是对象' };
      }
      const name = (skill as {name?: unknown}).name;
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, message: '声明技能每项必须含字符串 name 字段' };
      }
      const content = (skill as {content?: unknown}).content;
      if (typeof content !== 'string') {
        return { ok: false, message: `技能 ${name} 缺少 content 字段（SKILL.md 全文）` };
      }
      const description = (skill as {description?: unknown}).description;
      normalized.push(
        typeof description === 'string' ? { name, description, content } : { name, content },
      );
    }
    skills = normalized;
  }

  return {
    ok: true,
    payload: {
      id,
      publisher,
      version,
      ...(permissions !== undefined ? { permissions } : {}),
      ...(tools ? { tools } : {}),
      ...(skills ? { skills } : {}),
    },
  };
}
