import { getClientTransport } from './client-context.js';
/**
 * Aervox｜思隅 @aervox/api-client — Skill 组合式 API（CAP-020）
 *
 * Web / Desktop 共用：通过统一 Transport 访问系统级 Skill 列表、内容读取、启停、安装与删除。
 */
import { ref } from 'vue';
import { skillsApi, type SkillInstallResponse, type SkillRegistrationResponse } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { type AervoxTransport } from './transport';

export type SkillDto = SkillRegistrationResponse;
export type SkillInstallResultDto = SkillInstallResponse;

export function useAervoxSkills(transport: AervoxTransport = getClientTransport()) {
  const skills = ref<SkillDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadSkills = async (activeOnly = false, source?: string): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await requestEndpoint(transport, skillsApi.list, undefined, undefined, {
        activeOnly: activeOnly ? 'true' : undefined, source: source || undefined,
      });
      skills.value = res.items;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载技能列表失败';
    } finally {
      loading.value = false;
    }
  };

  const getSkill = async (name: string): Promise<SkillDto> =>
    requestEndpoint(transport, skillsApi.get, undefined, { skillName: name });

  const getSkillContent = async (name: string) =>
    requestEndpoint(transport, skillsApi.content, undefined, { skillName: name });

  const setSkillActive = async (name: string, active: boolean): Promise<SkillDto> => {
    const res = await requestEndpoint(transport, skillsApi.setActive, { active }, { skillName: name });
    await loadSkills();
    return res;
  };

  const installSkillZip = async (
    zipBase64: string,
    options?: { name?: string; overwrite?: boolean },
  ): Promise<SkillInstallResultDto> => {
    const res = await requestEndpoint(transport, skillsApi.install, {
      zipBase64,
      name: options?.name,
      overwrite: options?.overwrite,
    });
    await loadSkills();
    return res;
  };

  const deleteSkill = async (name: string): Promise<void> => {
    await requestEndpoint(transport, skillsApi.delete, undefined, { skillName: name });
    await loadSkills();
  };

  const getSkillPrompt = async (): Promise<string> => {
    const res = await requestEndpoint(transport, skillsApi.prompt);
    return res.prompt;
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
