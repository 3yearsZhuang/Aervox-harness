/**
 * Aervox｜思隅 @aervox/api-client — Skill 组合式 API（CAP-020）
 *
 * Web / Desktop 共用：通过统一 Transport 访问系统级 Skill 列表、内容读取、启停、安装与删除。
 */
import { ref } from 'vue';
import { getTransport } from './transport';

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  source: 'local' | 'plugin' | 'ai_authored' | string;
  active: number | boolean;
  readonly: number | boolean;
  version?: string;
  checksum?: string;
  pluginId?: string | null;
  contentPath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillInstallResultDto {
  installed: Array<{
    id?: string;
    name: string;
    description: string;
    source: string;
    active?: boolean | number;
    readonly?: boolean | number;
    contentPath?: string;
  }>;
}

export function useAervoxSkills() {
  const transport = getTransport();
  const skills = ref<SkillDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadSkills = async (activeOnly = false, source?: string): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      if (activeOnly) params.set('activeOnly', 'true');
      if (source) params.set('source', source);
      const query = params.toString() ? `?${params.toString()}` : '';
      const res = await transport.request<{ items: SkillDto[] }>('GET', `/v1/skills${query}`);
      skills.value = res.items ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载技能列表失败';
    } finally {
      loading.value = false;
    }
  };

  const getSkill = async (name: string): Promise<SkillDto> =>
    transport.request<SkillDto>('GET', `/v1/skills/${encodeURIComponent(name)}`);

  const getSkillContent = async (name: string): Promise<{ name: string; content: string }> =>
    transport.request<{ name: string; content: string }>('GET', `/v1/skills/${encodeURIComponent(name)}/content`);

  const setSkillActive = async (name: string, active: boolean): Promise<SkillDto> => {
    const res = await transport.request<SkillDto>('PATCH', `/v1/skills/${encodeURIComponent(name)}`, { active });
    await loadSkills();
    return res;
  };

  const installSkillZip = async (
    zipBase64: string,
    options?: { name?: string; overwrite?: boolean },
  ): Promise<SkillInstallResultDto> => {
    const res = await transport.request<SkillInstallResultDto>('POST', '/v1/skills', {
      zipBase64,
      name: options?.name,
      overwrite: options?.overwrite,
    });
    await loadSkills();
    return res;
  };

  const deleteSkill = async (name: string): Promise<void> => {
    await transport.request('DELETE', `/v1/skills/${encodeURIComponent(name)}`);
    await loadSkills();
  };

  const getSkillPrompt = async (): Promise<string> => {
    const res = await transport.request<{ prompt: string }>('GET', '/v1/skills/prompt');
    return res.prompt ?? '';
  };

  return {
    skills,
    loading,
    error,
    loadSkills,
    getSkill,
    getSkillContent,
    setSkillActive,
    installSkillZip,
    deleteSkill,
    getSkillPrompt,
  };
}
