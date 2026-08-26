/**
 * Aervox｜思隅 @aervox/api-client — Persona 组合式 API
 *
 * Web / Desktop 共用：通过统一 Transport 访问系统级 Persona CRUD、激活、导入与导出。
 */
import { ref } from 'vue';
import { getTransport } from './transport';

export interface PersonaDto {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description: string;
  source: string;
  status: string;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaRevisionConfigDto {
  systemPromptAppend: string;
  allowedSkillNames?: string[];
  allowedMcpToolIds?: string[];
  voice?: {
    enabled: boolean;
    providerId: string;
    modelId: string;
    speakerId?: string;
    settings?: Record<string, string | number | boolean>;
  };
}

export interface PersonaRevisionDto {
  id: string;
  personaId: string;
  revision: number;
  config: PersonaRevisionConfigDto;
  checksum: string;
  createdAt: string;
}

export interface ActivePersonaSelectionDto {
  id?: string;
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  revisionId: string;
  selectedAt: string;
}

export interface ToolItemDto {
  id: string;
  name: string;
  description: string;
  category?: string;
  safetyLevel?: string;
  enabled?: number;
}

export interface SkillItemDto {
  id: string;
  name: string;
  description: string;
  active?: number;
  source?: string;
}

export interface CreatePersonaInputDto {
  name: string;
  description?: string;
  config: PersonaRevisionConfigDto;
}

export interface UpdatePersonaInputDto {
  expectedRevision: number;
  name?: string;
  description?: string;
  config: PersonaRevisionConfigDto;
}

export function useAervoxPersonas() {
  const transport = getTransport();
  const personas = ref<PersonaDto[]>([]);
  const activePersona = ref<ActivePersonaSelectionDto | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadPersonas = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await transport.request<{
        personas: PersonaDto[];
        active: ActivePersonaSelectionDto | null;
      }>('GET', '/v1/personas');
      personas.value = res.personas ?? [];
      activePersona.value = res.active ?? null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载人格列表失败';
    } finally {
      loading.value = false;
    }
  };

  const getPersonaDetail = async (
    personaId: string,
  ): Promise<{ persona: PersonaDto; revision: PersonaRevisionDto | null; active: boolean }> =>
    transport.request<{ persona: PersonaDto; revision: PersonaRevisionDto | null; active: boolean }>(
      'GET',
      `/v1/personas/${encodeURIComponent(personaId)}`,
    );

  const createPersona = async (
    input: CreatePersonaInputDto,
  ): Promise<{ persona: PersonaDto; revision: PersonaRevisionDto }> => {
    const res = await transport.request<{ persona: PersonaDto; revision: PersonaRevisionDto }>(
      'POST',
      '/v1/personas',
      input,
    );
    await loadPersonas();
    return res;
  };

  const updatePersona = async (
    personaId: string,
    input: UpdatePersonaInputDto,
  ): Promise<{ persona: PersonaDto; revision: PersonaRevisionDto }> => {
    const res = await transport.request<{ persona: PersonaDto; revision: PersonaRevisionDto }>(
      'PATCH',
      `/v1/personas/${encodeURIComponent(personaId)}`,
      input,
    );
    await loadPersonas();
    return res;
  };

  const deletePersona = async (personaId: string): Promise<boolean> => {
    const res = await transport.request<{ deleted: boolean }>(
      'DELETE',
      `/v1/personas/${encodeURIComponent(personaId)}`,
    );
    await loadPersonas();
    return res.deleted;
  };

  const activatePersona = async (
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionDto> => {
    const res = await transport.request<ActivePersonaSelectionDto>(
      'POST',
      `/v1/personas/${encodeURIComponent(personaId)}/activate`,
      revisionId ? { revisionId } : {},
    );
    await loadPersonas();
    return res;
  };

  const exportPersona = async (
    personaId: string,
  ): Promise<{ bundleBase64: string; fileName: string; skillNames: string[]; missingDependencies: string[] }> =>
    transport.request<{
      bundleBase64: string;
      fileName: string;
      skillNames: string[];
      missingDependencies: string[];
    }>('POST', `/v1/personas/${encodeURIComponent(personaId)}/export`);

  const importPersona = async (
    bundleBase64: string,
    conflictResolution: 'error' | 'replace' = 'error',
  ): Promise<{ persona: PersonaDto; revision: PersonaRevisionDto; skills: Array<{ name: string }>; missingDependencies: string[] }> => {
    const res = await transport.request<{
      persona: PersonaDto;
      revision: PersonaRevisionDto;
      skills: Array<{ name: string }>;
      missingDependencies: string[];
    }>('POST', '/v1/personas/import', { bundleBase64, conflictResolution });
    await loadPersonas();
    return res;
  };

  const loadAvailableTools = async (): Promise<ToolItemDto[]> => {
    try {
      const res = await transport.request<{ items: ToolItemDto[] }>('GET', '/v1/tools');
      return res.items ?? [];
    } catch {
      return [];
    }
  };

  const loadAvailableSkills = async (): Promise<SkillItemDto[]> => {
    try {
      const res = await transport.request<{ items: SkillItemDto[] }>('GET', '/v1/skills');
      return res.items ?? [];
    } catch {
      return [];
    }
  };

  return {
    personas,
    activePersona,
    loading,
    error,
    loadPersonas,
    getPersonaDetail,
    createPersona,
    updatePersona,
    deletePersona,
    activatePersona,
    exportPersona,
    importPersona,
    loadAvailableTools,
    loadAvailableSkills,
  };
}
