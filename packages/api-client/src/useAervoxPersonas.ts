import { getClientTransport } from './client-context.js';
/**
 * Aervox｜思隅 @aervox/api-client — Persona 组合式 API
 *
 * Web / Desktop 共用：通过统一 Transport 访问系统级 Persona CRUD、激活、导入与导出。
 */
import { ref } from 'vue';
import { personaApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import { createResource } from './resource.js';

import type {
  Persona as PersonaDto,
  PersonaRevisionConfig as PersonaRevisionConfigDto,
  PersonaRevision as PersonaRevisionDto,
  ActivePersonaSelection as ActivePersonaSelectionDto,
  CreatePersonaRequest as CreatePersonaInputDto,
  UpdatePersonaRequest as UpdatePersonaInputDto,
  PersonaDetailResponse, PersonaMutationResponse, PersonaImportResponse, PersonaBundleResponse,
} from '@aervox/contracts';

export type {
  PersonaDto,
  PersonaRevisionConfigDto,
  PersonaRevisionDto,
  ActivePersonaSelectionDto,
  CreatePersonaInputDto, UpdatePersonaInputDto,
};


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

export function useAervoxPersonas() {
  const transport = getClientTransport();
  const personas = ref<PersonaDto[]>([]);
  const activePersona = ref<ActivePersonaSelectionDto | null>(null);
  const resource = createResource(() => requestEndpoint(transport, personaApi.list), response => {
    personas.value = response.personas;
    activePersona.value = response.active;
  });
  const { loading, error } = resource;

  const loadPersonas = async (): Promise<void> => {
    try { await resource.load(); }
    catch { /* Failed refresh retains the last validated projection and error. */ }
  };

  const getPersonaDetail = async (
    personaId: string,
  ): Promise<PersonaDetailResponse> =>
    requestEndpoint(transport, personaApi.get, undefined, { personaId });

  const createPersona = async (
    input: CreatePersonaInputDto,
  ): Promise<PersonaMutationResponse> => {
    const res = await requestEndpoint(transport, personaApi.create, input);
    resource.invalidate();
    await loadPersonas();
    return res;
  };

  const updatePersona = async (
    personaId: string,
    input: UpdatePersonaInputDto,
  ): Promise<PersonaMutationResponse> => {
    const res = await requestEndpoint(transport, personaApi.update, input, { personaId });
    resource.invalidate();
    await loadPersonas();
    return res;
  };

  const deletePersona = async (personaId: string): Promise<boolean> => {
    const res = await requestEndpoint(transport, personaApi.delete, undefined, { personaId });
    resource.invalidate();
    await loadPersonas();
    return res.deleted;
  };

  const activatePersona = async (
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionDto> => {
    const res = await requestEndpoint(transport, personaApi.activate, revisionId ? { revisionId } : {}, { personaId });
    resource.invalidate();
    await loadPersonas();
    return res;
  };

  const exportPersona = async (
    personaId: string,
  ): Promise<PersonaBundleResponse> =>
    requestEndpoint(transport, personaApi.export, undefined, { personaId });

  const importPersona = async (
    bundleBase64: string,
    conflictResolution: 'error' | 'replace' = 'error',
  ): Promise<PersonaImportResponse> => {
    const res = await requestEndpoint(transport, personaApi.import, { bundleBase64, conflictResolution });
    resource.invalidate();
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
